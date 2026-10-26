import { prisma } from './prisma';
import { melDay, openQuotes, PREPAYMENT } from './receivables';
import { accessTokenFrom, canDraft, cleanAddress, createDraft, draftLink } from './gmail/google';
import { decrypt } from './gmail/crypto';

// A payment reminder DRAFT in the sales mailbox on a prepayment quote's first follow-up day.
//
// Which quotes: the ones on the Open quotes screen for prepay customers, still unpaid or part paid, whose 1st follow-up is due today (or in the last
// 2 days, so a missed day is caught up, but a quote that has been overdue for weeks is never swept up when this is first switched on).
// The 1st follow-up is the CRM's own rule: a week after the order for a customer who pays first.
// What it does: makes a draft in Gmail, nothing else. It never sends anything, never marks the follow-up done (a person does that after
// chasing), and keeps no copy of the email: only that a draft was made, for which quote, and to whom.
// Gmail needs the mailbox connected with "Allow drafts" (the gmail.compose permission).

export const GRACE_DAYS = 2;                   // a first follow-up that fell due up to this many days ago is still drafted
export const MAX_PER_RUN = 40;                 // a safety stop, so a mistake can never fill the mailbox with drafts

export function firstNameOf(contact: string | null | undefined): string | null {
  const w = String(contact ?? '').trim().split(/\s+/)[0] ?? '';
  if (!/^[\p{L}][\p{L}'’-]{1,29}$/u.test(w)) return null;                         // not a plain first name (a company, an email, initials)
  return w === w.toUpperCase() || w === w.toLowerCase() ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w;
}

// The email: the template exactly as the team wrote it, with the first name and the quote number filled in.
export function reminderMessage(name: string | null, number: string): { subject: string; body: string } {
  return {
    subject: `Friendly Reminder: Payment Due for Sales Quote ${number}`,
    body: [
      `Hi ${name ?? 'there'},`,
      '',
      "Hope you're keeping well.",
      '',
      `Just to follow up and bump this email back up into your inbox with a friendly reminder that payment is past due to secure your stock on Sales Quote ${number} attached for your reference.`,
      '',
      'Please advise if you would like us to reactivate this sales quote and allocate stock for delivery once payment is made?',
      '',
      'If payment has already been processed, please disregard this message.',
      '',
      'Regardless of the status, we would greatly appreciate your response or prompt payment at your earliest convenience.',
      '',
      'Thank you for your attention to this matter.',
    ].join('\n'),
  };
}

type Row = { id: string; number: string; customer: string; payment: string; remaining: number; followUp: { next: { kind: string; date: string } | null } };
const dayMs = (d: string) => Date.parse(d + 'T00:00:00Z');
// The quotes whose first follow-up falls due today, or in the last GRACE_DAYS days.
export function eligibleFirstFollowUps<T extends Row>(rows: T[], today: string, grace = GRACE_DAYS): (T & { dueOn: string; daysOver: number })[] {
  const out: (T & { dueOn: string; daysOver: number })[] = [];
  for (const r of rows) {
    const n = r.followUp?.next;
    if (!n || n.kind !== 'fu1' || !['unpaid', 'part'].includes(r.payment)) continue;
    const over = Math.round((dayMs(today) - dayMs(n.date)) / 86400000);
    if (over >= 0 && over <= grace) out.push({ ...r, dueOn: n.date, daysOver: over });
  }
  return out;
}

export type Preview = { quoteId: string; number: string; customer: string; to: string | null; name: string | null; dueOn: string; daysOver: number; remaining: number };
export type RunResult = {
  enabled: boolean; dryRun: boolean; today: string; mailbox: string; stopped: string | null;
  eligible: number; created: number; failed: number; alreadyDone: number; preview: Preview[];
};

export type Deps = {
  openQuotes: typeof openQuotes; accessTokenFrom: typeof accessTokenFrom; createDraft: typeof createDraft; decrypt: typeof decrypt; today: () => string;
};
const realDeps: Deps = { openQuotes, accessTokenFrom, createDraft, decrypt, today: () => melDay() };

export async function loadSettings(): Promise<{ enabled: boolean; mailbox: string }> {
  const [s] = await prisma.$queryRaw<{ enabled: boolean; mailbox_email: string }[]>`select enabled, mailbox_email from crm.followup_draft_settings where id = 1`;
  return { enabled: !!s?.enabled, mailbox: s?.mailbox_email ?? 'sales@rhinorhino.com.au' };
}

// Where the mailbox stands, in words a manager can act on. null means it is ready to make drafts.
export async function mailboxProblem(mailbox: string): Promise<{ problem: string | null; conn: { rep_id: string; email: string; refresh_token_enc: string } | null }> {
  const [c] = await prisma.$queryRaw<{ rep_id: string; email: string; refresh_token_enc: string; scope: string | null; status: string }[]>`
    select rep_id, email, refresh_token_enc, scope, status from crm.gmail_connections where lower(email) = lower(${mailbox})`;
  if (!c) return { problem: `${mailbox} is not connected to Gmail. Sign in as that person and press Connect Gmail in Settings.`, conn: null };
  if (c.status !== 'ok') return { problem: `${mailbox} needs to be connected again (its Google sign-in has expired). Press Connect Gmail in Settings, and tick Allow drafts.`, conn: null };
  if (!canDraft(c.scope)) return { problem: `${mailbox} is connected without permission to make drafts. Press Allow drafts in the Gmail card in Settings.`, conn: null };
  return { problem: null, conn: c };
}

export async function runFollowUpDrafts(opts: { dryRun?: boolean; deps?: Partial<Deps> } = {}): Promise<RunResult> {
  const d = { ...realDeps, ...opts.deps }, dryRun = !!opts.dryRun, today = d.today();
  const { enabled, mailbox } = await loadSettings();
  const res: RunResult = { enabled, dryRun, today, mailbox, stopped: null, eligible: 0, created: 0, failed: 0, alreadyDone: 0, preview: [] };
  if (!enabled && !dryRun) { res.stopped = 'Switched off'; return res; }

  const all = await d.openQuotes({ id: 'followup-drafts', role: 'manager' }, undefined, [PREPAYMENT]);
  let due = eligibleFirstFollowUps(all.rows as Row[], today);
  if (due.length) {
    const done = await prisma.$queryRaw<{ quote_id: string }[]>`
      select quote_id from crm.followup_drafts where kind = 'fu1' and quote_id = any(${due.map(r => r.id)}::uuid[])
        and (status = 'created' or (status = 'creating' and updated_at > now() - interval '1 hour'))`;
    const skip = new Set(done.map(r => r.quote_id));
    res.alreadyDone = due.filter(r => skip.has(r.id)).length;
    due = due.filter(r => !skip.has(r.id));
  }
  res.eligible = due.length;
  if (!due.length) return res;

  const contacts = await prisma.$queryRaw<{ id: string; order_email: string | null; order_contact: string | null; email: string | null; contact_name: string | null }[]>`
    select q.id, q.order_email, q.order_contact, a.email, a.contact_name from crm.quotes q join crm.accounts a on a.id = q.account_id where q.id = any(${due.map(r => r.id)}::uuid[])`;
  const byId = new Map(contacts.map(c => [c.id, c]));
  const plan = due.slice(0, MAX_PER_RUN).map(r => {
    const c = byId.get(r.id);
    const to = cleanAddress(c?.order_email) ?? cleanAddress(c?.email);
    return { r, to, name: firstNameOf(c?.order_contact) ?? firstNameOf(c?.contact_name) };
  });
  res.preview = plan.map(p => ({ quoteId: p.r.id, number: p.r.number, customer: p.r.customer, to: p.to, name: p.name, dueOn: p.r.dueOn, daysOver: p.r.daysOver, remaining: p.r.remaining }));
  if (due.length > MAX_PER_RUN) res.stopped = `More than ${MAX_PER_RUN} are due: only the first ${MAX_PER_RUN} are drafted in one run`;
  if (dryRun) return res;

  const { problem, conn } = await mailboxProblem(mailbox);
  if (problem || !conn) { res.stopped = problem; return res; }
  let token: string;
  try { token = await d.accessTokenFrom(d.decrypt(conn.refresh_token_enc)); }
  catch (e) { res.stopped = `Could not sign in to ${mailbox}: ${String((e as Error)?.message ?? e).slice(0, 120)}`; return res; }

  for (const p of plan) {
    // Claim the quote first, so two runs at once can never draft it twice. A failed or stuck claim is taken over.
    const [claim] = await prisma.$queryRaw<{ id: string }[]>`
      insert into crm.followup_drafts (quote_id, kind, quote_number, customer, to_addr, status, mailbox) values (${p.r.id}::uuid, 'fu1', ${p.r.number}, ${p.r.customer}, ${p.to}, 'creating', ${mailbox})
      on conflict (quote_id, kind) do update set status = 'creating', attempts = crm.followup_drafts.attempts + 1, to_addr = excluded.to_addr, error = null, updated_at = now()
        where crm.followup_drafts.status = 'failed' or (crm.followup_drafts.status = 'creating' and crm.followup_drafts.updated_at < now() - interval '1 hour')
      returning id`;
    if (!claim) { res.alreadyDone++; res.eligible--; continue; }
    try {
      const m = reminderMessage(p.name, p.r.number);
      const made = await d.createDraft(token, { to: p.to ? [p.to] : [], subject: m.subject, body: m.body, allowEmptyTo: true });
      await prisma.$executeRaw`update crm.followup_drafts set status = 'created', gmail_draft_id = ${made.id}, gmail_message_id = ${made.messageId}, error = null, updated_at = now() where id = ${claim.id}::uuid`;
      res.created++;
    } catch (e) {
      // What went wrong is kept; what the email said never is.
      await prisma.$executeRaw`update crm.followup_drafts set status = 'failed', error = ${String((e as Error)?.message ?? e).slice(0, 300)}, updated_at = now() where id = ${claim.id}::uuid`;
      res.failed++;
    }
  }
  return res;
}

export { draftLink };