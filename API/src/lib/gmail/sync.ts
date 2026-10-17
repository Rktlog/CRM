import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { decrypt } from './crypto';
import { accessTokenFrom, getMessageMeta, listMessageIds, listPrivateMessages, privateExclusion, GoogleApiError, GmailMeta } from './google';

// Looks through a rep's mailbox and keeps ONLY the emails that are to or from a customer already in the CRM.
// What is kept: who it was between, the subject, the date, and (if the rep allows) a ~160 character preview.
// Never the body. Newsletters, auto-replies, spam, trash and drafts are skipped. Everything else is ignored.
// An email, or a whole conversation, the rep has labelled Private in Gmail is never kept. If it was kept before it is removed.

const EMAIL_RE = /[A-Z0-9._%+'-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
export function parseAddresses(header: string | undefined | null): string[] {
  const out: string[] = [];
  for (const m of String(header ?? '').matchAll(EMAIL_RE)) { const a = m[0].toLowerCase(); if (!out.includes(a)) out.push(a); }
  return out;
}
const decode = (s: string) => s.replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

export type LogRow = {
  accountId: string; messageId: string; threadId: string; direction: 'in' | 'out'; subject: string; snippet: string | null;
  from: string; to: string[]; cc: string[]; counterparty: string; occurredAt: Date;
};

// Is this email one to keep, and against which account(s)? `known` maps a customer address to its account ids.
export function classify(meta: GmailMeta, me: string, known: Map<string, string[]>, savePreview: boolean, privateThreads: ReadonlySet<string> = new Set()): { rows: LogRow[] } | { skip: string } {
  if (privateThreads.has(meta.threadId)) return { skip: 'private' };   // the rep marked this conversation Private
  const labels = meta.labelIds ?? [];
  if (labels.some(l => l === 'SPAM' || l === 'TRASH' || l === 'DRAFT')) return { skip: 'spam, trash or draft' };
  const h = meta.headers, mine = me.toLowerCase();
  const from = parseAddresses(h['from'])[0];
  if (!from) return { skip: 'no sender' };
  if (h['list-unsubscribe'] || /^(bulk|list|junk)$/i.test((h['precedence'] ?? '').trim())) return { skip: 'newsletter or bulk mail' };
  const out = from === mine;
  const autoSub = (h['auto-submitted'] ?? '').trim().toLowerCase();
  if (!out && autoSub && autoSub !== 'no') return { skip: 'automatic reply' };
  const to = parseAddresses(h['to']), cc = parseAddresses(h['cc']);
  const people = out ? [...to, ...cc].filter(a => a !== mine) : [from];
  const matches = new Map<string, string>();   // account id -> the address it matched on
  for (const a of people) for (const acc of known.get(a) ?? []) if (!matches.has(acc)) matches.set(acc, a);
  if (!matches.size) return { skip: 'not a customer' };
  const snippet = savePreview ? decode(meta.snippet ?? '').trim().slice(0, 160) || null : null;
  const when = new Date(Number(meta.internalDate));
  return { rows: [...matches].map(([accountId, counterparty]) => ({
    accountId, messageId: meta.id, threadId: meta.threadId, direction: out ? 'out' as const : 'in' as const,
    subject: (h['subject'] ?? '').trim().slice(0, 300), snippet, from, to, cc, counterparty, occurredAt: Number.isNaN(when.getTime()) ? new Date() : when,
  })) };
}

// Every address the CRM knows for a customer: the account's email (it may hold several), the order emails,
// and the marketing contacts linked to an account.
const SPLIT = '[;,[:space:]]+';
const VALID = '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$';
export async function loadKnownAddresses(): Promise<Map<string, string[]>> {
  const [t] = await prisma.$queryRaw<{ has: boolean }[]>`select to_regclass('crm.marketing_contacts') is not null as has`;
  const contacts = t?.has ? Prisma.sql`union all select account_id, lower(email) from crm.marketing_contacts where account_id is not null` : Prisma.empty;
  const rows = await prisma.$queryRaw<{ email: string; accounts: string[] }[]>`
    with raw as (
      select a.id as account_id, unnest(regexp_split_to_array(lower(coalesce(a.email, '')), ${SPLIT})) as email
        from crm.accounts a where a.archived = false and a.misc = false
      union all
      select q.account_id, unnest(regexp_split_to_array(lower(coalesce(q.order_email, '')), ${SPLIT}))
        from crm.quotes q where q.order_email is not null and btrim(q.order_email) <> ''
      ${contacts}
    )
    select email, array_agg(distinct account_id::text) as accounts from raw where email ~ ${VALID} group by email`;
  return new Map(rows.map(r => [r.email, r.accounts]));
}

export type SyncResult = {
  rep: string; listed: number; newMessages: number; saved: number; skipped: number; remaining: number; removed: number;
  status: 'ok' | 'needs_reconnect' | 'error' | 'paused' | 'skipped'; error?: string;
};

async function finish(repId: string, status: string, error: string | null, now: Date, syncedAt: Date | null) {
  await prisma.$queryRaw`
    update crm.gmail_connections set status = ${status}, last_error = ${error}, last_run_at = ${now},
           last_sync_at = coalesce(${syncedAt}::timestamp, last_sync_at), updated_at = now() where rep_id = ${repId}::uuid`;
}
// A problem from Google, in words a rep can act on.
function explain(e: unknown): { status: 'needs_reconnect' | 'error'; message: string } {
  if (e instanceof GoogleApiError) {
    if (e.reason === 'invalid_grant' || e.status === 401) return { status: 'needs_reconnect', message: 'Your Google sign-in has expired or was removed. Press Connect Gmail again.' };
    if (e.status === 403 && /insufficient|permission/i.test(e.reason ?? e.message)) return { status: 'needs_reconnect', message: 'Gmail access was not granted. Press Connect Gmail again and tick the box that allows reading email.' };
    if (e.status === 429 || e.status === 403 || e.status >= 500) return { status: 'error', message: 'Google asked us to slow down. It will try again shortly.' };
    return { status: 'error', message: `Google said: ${e.message}`.slice(0, 300) };
  }
  if (/GMAIL_TOKEN_KEY|known format|authenticate data|Unsupported state/i.test(String((e as Error)?.message))) return { status: 'needs_reconnect', message: 'The saved Google sign-in can no longer be read. Press Connect Gmail again.' };
  return { status: 'error', message: String((e as Error)?.message ?? e).slice(0, 300) };
}

export async function syncRep(repId: string, opts: { now?: Date; maxNew?: number; backfillDays?: number } = {}): Promise<SyncResult> {
  const now = opts.now ?? new Date(), maxNew = opts.maxNew ?? 150, backfill = opts.backfillDays ?? (Number(process.env.GMAIL_BACKFILL_DAYS) || 30);
  const [c] = await prisma.$queryRaw<any[]>`
    select c.email, c.refresh_token_enc, c.logging_enabled, c.save_preview, c.last_sync_at, r.name
    from crm.gmail_connections c join crm.reps r on r.id = c.rep_id where c.rep_id = ${repId}::uuid`;
  const res: SyncResult = { rep: c?.name ?? '', listed: 0, newMessages: 0, saved: 0, skipped: 0, remaining: 0, removed: 0, status: 'skipped' };
  if (!c) return res;
  if (!c.logging_enabled) { await prisma.$queryRaw`update crm.gmail_connections set last_run_at = ${now} where rep_id = ${repId}::uuid`; return { ...res, status: 'paused' }; }

  let token: string;
  try { token = await accessTokenFrom(decrypt(c.refresh_token_enc)); }
  catch (e) { const x = explain(e); await finish(repId, x.status, x.message, now, null); return { ...res, status: x.status, error: x.message }; }

  // Look back to just before the last full pass (a 2 day overlap so nothing slips through), or 30 days the first time.
  const since = c.last_sync_at ? new Date(new Date(c.last_sync_at).getTime() - 2 * 86400000) : new Date(now.getTime() - backfill * 86400000);
  const query = `after:${Math.floor(since.getTime() / 1000)} -in:spam -in:trash -in:drafts -category:promotions -category:social ${privateExclusion()}`;
  let problem: unknown = null;
  const rows: LogRow[] = []; const processed: string[] = [];
  let privateThreads = new Set<string>();
  try {
    // Private comes first. If Google can't say what is private, nothing is logged this time.
    const priv = await listPrivateMessages(token);
    privateThreads = new Set(priv.map(m => m.threadId));
    if (priv.length) {
      const gone = await prisma.$queryRaw<{ id: string }[]>`
        delete from crm.email_log where rep_id = ${repId}::uuid and (gmail_message_id = any(${priv.map(m => m.id)}::text[]) or thread_id = any(${[...privateThreads]}::text[])) returning id`;
      res.removed = gone.length;
    }
    const ids = await listMessageIds(token, query);
    res.listed = ids.length;
    const seenRows = ids.length ? await prisma.$queryRaw<{ message_id: string }[]>`select message_id from crm.gmail_seen where rep_id = ${repId}::uuid and message_id = any(${ids}::text[])` : [];
    const seen = new Set(seenRows.map(r => r.message_id));
    const unseen = ids.filter(i => !seen.has(i)); res.newMessages = unseen.length;
    const queue = unseen.slice(0, maxNew);
    const known = queue.length ? await loadKnownAddresses() : new Map<string, string[]>();
    const worker = async () => {
      while (queue.length && !problem) {
        const id = queue.shift()!;
        try {
          const meta = await getMessageMeta(token, id);
          processed.push(id);
          if (!meta) { res.skipped++; continue; }                       // deleted since it was listed
          const r = classify(meta, c.email, known, !!c.save_preview, privateThreads);
          if ('skip' in r) res.skipped++; else rows.push(...r.rows);
        } catch (e) { problem = e; }
      }
    };
    await Promise.all(Array.from({ length: 5 }, worker));
    res.remaining = unseen.length - processed.length;
  } catch (e) { problem = e; }

  // Keep whatever was done, even if Google stopped us part way.
  if (rows.length) {
    const tuples = rows.map(r => Prisma.sql`(${repId}::uuid, ${r.accountId}::uuid, ${r.messageId}, ${r.threadId}, ${r.direction}, ${r.subject}, ${r.snippet}, ${r.from}, ${r.to}::text[], ${r.cc}::text[], ${r.counterparty}, ${r.occurredAt})`);
    const saved = await prisma.$queryRaw<{ id: string }[]>`
      insert into crm.email_log (rep_id, account_id, gmail_message_id, thread_id, direction, subject, snippet, from_addr, to_addrs, cc_addrs, counterparty, occurred_at)
      values ${Prisma.join(tuples)} on conflict do nothing returning id`;
    res.saved = saved.length;
  }
  if (processed.length) await prisma.$queryRaw`insert into crm.gmail_seen (rep_id, message_id) select ${repId}::uuid, unnest(${processed}::text[]) on conflict do nothing`;

  if (problem) {
    const x = explain(problem); await finish(repId, x.status, x.message, now, null);
    return { ...res, status: x.status, error: x.message };
  }
  await finish(repId, 'ok', null, now, res.remaining === 0 ? now : null);   // a full pass is only recorded when nothing is left over
  return { ...res, status: 'ok' };
}

// Everyone who has it on, the one waiting longest first, stopping when the time is up.
export async function syncAll(budgetMs = 50_000): Promise<SyncResult[]> {
  const start = Date.now(); const results: SyncResult[] = [];
  const reps = await prisma.$queryRaw<{ rep_id: string }[]>`select rep_id from crm.gmail_connections where logging_enabled and status <> 'needs_reconnect' order by last_run_at asc nulls first`;
  for (const r of reps) {
    if (Date.now() - start > budgetMs) break;
    try { results.push(await syncRep(r.rep_id)); } catch (e) { results.push({ rep: r.rep_id, listed: 0, newMessages: 0, saved: 0, skipped: 0, remaining: 0, removed: 0, status: 'error', error: String((e as Error).message) }); }
  }
  await prisma.$queryRaw`delete from crm.gmail_seen where seen_at < now() - interval '90 days'`;
  return results;
}