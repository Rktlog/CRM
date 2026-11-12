// Email from Radar: a rep writes an email on an account or an abandoned cart, reviews it, presses Send, and it goes out from THEIR OWN Gmail, with the log written for them.
// - Nothing changes for anyone until a rep switches on "Let Radar send emails I write here" (it reuses the compose permission they gave for drafts: no new Google screen).
// - It only ever sends when a rep presses Send on a reviewed email. An address that is not already known for that customer must be confirmed first.
// - Pressing Send twice sends once (each email has an id made by the page). At most 30 an hour and 150 a day per rep.
// - The email text is never kept: the log gets who it went to, the subject and the first 400 characters, and the record of sends keeps no text at all.
// - On an account the log is an "Email" activity with the same effects as logging one by hand (a new lead becomes approached; "follow up in 3 weeks" sets the reminder).
//   On an abandoned cart it is an "Emailed" entry in that cart's log.
// The sending itself is the one small function in lib/gmail/alertSend.ts, which this and lib/alerts.ts are the only users of.
import { prisma } from './prisma';
import { accessTokenFrom, buildRawMessage, canDraft, cleanAddress, GoogleApiError } from './gmail/google';
import { decrypt } from './gmail/crypto';
import { sendRawMessage } from './gmail/alertSend';
import { canSeeAccount } from './territory';
import { parseFollowUp } from './followup';

export type Flags = { needsConnect?: boolean; needsDrafts?: boolean; needsAllowSend?: boolean; unknown?: string[] };
export class SendError extends Error { status: number; flags: Flags; constructor(message: string, status = 400, flags: Flags = {}) { super(message); this.status = status; this.flags = flags; } }
export type Rep = { id: string; role: string };
export const SENDS_PER_HOUR = 30;
export const SENDS_PER_DAY = 150;
export const MAX_PEOPLE = 10;
export const MAX_SIGNATURE = 600;
export const PREVIEW_CHARS = 400;
const tableMissing = (e: any) => e?.code === '42P01' || e?.meta?.code === '42P01' || e?.code === '42703' || (/email_sends|allow_send|signature/.test(String(e?.message ?? e)) && /does not exist|relation|column/i.test(String(e?.message ?? e)));
const NOT_SET_UP = 'Sending email from Radar is not set up in the database yet. Ask whoever looks after Radar to run send-email.sql.';
const uuidOk = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

// ---------- the plain rules ----------
/** A list of addresses typed with commas or semicolons (or an array). bad is true if any of them is not a plain address. */
export function parseAddresses(v: unknown): { list: string[]; bad: boolean } {
  const parts = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,;]/) : [];
  const list: string[] = []; let bad = false;
  for (const p of parts) { if (typeof p === 'string' && !p.trim()) continue; const a = cleanAddress(p); if (a) { if (!list.some(x => x.toLowerCase() === a.toLowerCase())) list.push(a); } else bad = true; }
  return { list, bad };
}
export const withSignature = (body: string, signature: string | null | undefined): string => {
  const s = String(signature ?? '').trim();
  return s ? `${body.replace(/\s+$/, '')}\n\n${s}` : body;
};
/** The first part of an email for the log, on a few lines, with ... if it was longer. */
export function preview(body: string, max = PREVIEW_CHARS): string {
  const t = body.replace(/\r\n|\r/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return t.length > max ? `${t.slice(0, max).replace(/\s+\S*$/, '')}...` : t;
}
/** What the log says: who it went to, the subject, and the start of it. Used for the account log and the cart log. */
export function logNote(to: string[], cc: string[], subject: string, body: string): string {
  return `Emailed ${to.join(', ')}${cc.length ? ` (cc ${cc.join(', ')})` : ''}: ${subject}\n\n${preview(body)}`;
}
export const unknownAddresses = (all: string[], known: string[]): string[] => { const k = new Set(known.map(a => a.toLowerCase())); return all.filter(a => !k.has(a.toLowerCase())); };
const cleanSubject = (v: unknown): string | null => { const s = typeof v === 'string' ? v.trim() : ''; return s && !/[\r\n]/.test(s) && s.length <= 300 ? s : null; };
const cartEmailOf = (key: string): string | null => cleanAddress(key.split('|')[1] ?? '')?.toLowerCase() ?? null;

// ---------- who can be emailed, and where from ----------
export type Deps = {
  accessToken: typeof accessTokenFrom; decrypt: typeof decrypt; send: typeof sendRawMessage;
  canSeeAccount: (rep: Rep, a: { id: string; region: string }) => Promise<boolean>;
  canSeeCart: (rep: Rep, cartKey: string) => Promise<boolean>;
};
export const realDeps: Deps = {
  accessToken: accessTokenFrom, decrypt, send: sendRawMessage,
  canSeeAccount: (rep, a) => canSeeAccount(rep as any, a),
  canSeeCart: async (rep, key) => {   // the same rule as the Abandoned carts page: only carts this person can see
    const at = new Date(key.split('|')[0] ?? '');
    if (!key.includes('|') || Number.isNaN(at.getTime())) return false;
    const { loadCarts } = await import('../routes/Abandonedcarts');
    return (await loadCarts(rep, String(Math.ceil((Date.now() - at.getTime()) / 86400000) + 1))).some(c => c.id === key);
  },
};
type Resolved = { kind: 'account'; accountId: string; cartKey: null; known: string[] } | { kind: 'cart'; accountId: null; cartKey: string; known: string[] };
async function resolveTarget(rep: Rep, accountId: unknown, cartKey: unknown, d: Deps): Promise<Resolved> {
  if (accountId != null && accountId !== '' && cartKey != null && cartKey !== '') throw new SendError('Choose an account or a cart, not both.');
  if (accountId != null && accountId !== '') {
    if (!uuidOk(accountId)) throw new SendError('Bad account', 400);
    const [a] = await prisma.$queryRaw<{ id: string; region: string; email: string | null }[]>`select id, region, email from crm.accounts where id = ${accountId}::uuid`;
    if (!a) throw new SendError('Account not found', 404);
    if (!(await d.canSeeAccount(rep, { id: a.id, region: a.region }))) throw new SendError('This account is outside your states', 403);
    const orderEmails = await prisma.$queryRaw<{ e: string | null }[]>`select distinct order_email as e from crm.quotes where account_id = ${accountId}::uuid and order_email is not null and sent_at > now() - interval '36 months' limit 20`;
    const logged = await prisma.$queryRaw<{ e: string | null }[]>`select distinct counterparty as e from crm.email_log where account_id = ${accountId}::uuid limit 20`;
    const known = [...new Set([...parseAddresses(a.email).list, ...orderEmails.flatMap(r => parseAddresses(r.e).list), ...logged.flatMap(r => parseAddresses(r.e).list)].map(x => x.toLowerCase()))];
    return { kind: 'account', accountId, cartKey: null, known };
  }
  if (typeof cartKey === 'string' && cartKey) {
    if (cartKey.length > 400 || !(await d.canSeeCart(rep, cartKey))) throw new SendError('That cart was not found', 404);
    const e = cartEmailOf(cartKey);
    return { kind: 'cart', accountId: null, cartKey, known: e ? [e] : [] };
  }
  throw new SendError('Choose an account or a cart.');
}

// ---------- the rep's settings ----------
export type Status = { configured: boolean; connected: boolean; status: string | null; canCompose: boolean; allowSend: boolean; email: string | null; signature: string };
export async function getStatus(repId: string, configured: boolean): Promise<Status> {
  try {
    const [c] = await prisma.$queryRaw<{ email: string; scope: string | null; status: string; allow_send: boolean; signature: string | null }[]>`select email, scope, status, allow_send, signature from crm.gmail_connections where rep_id = ${repId}::uuid`;
    return { configured, connected: !!c, status: c?.status ?? null, canCompose: !!c && canDraft(c.scope), allowSend: !!c?.allow_send, email: c?.email ?? null, signature: c?.signature ?? '' };
  } catch (e) { if (tableMissing(e)) throw new SendError(NOT_SET_UP, 503); throw e; }
}
export async function setAllow(repId: string, allow: unknown): Promise<void> {
  if (typeof allow !== 'boolean') throw new SendError('Say whether to allow it.');
  try {
    const [c] = await prisma.$queryRaw<{ scope: string | null; status: string }[]>`select scope, status from crm.gmail_connections where rep_id = ${repId}::uuid`;
    if (allow) {
      if (!c) throw new SendError('Connect your Gmail first (Settings).', 400, { needsConnect: true });
      if (c.status !== 'ok') throw new SendError('Your Gmail needs to be connected again (Settings).', 409, { needsConnect: true });
      if (!canDraft(c.scope)) throw new SendError("Allow drafts first: Google asks you to tick a box. Radar then needs your OK to send.", 409, { needsDrafts: true });
    }
    await prisma.$queryRaw`update crm.gmail_connections set allow_send = ${allow}, updated_at = now() where rep_id = ${repId}::uuid`;
  } catch (e) { if (tableMissing(e)) throw new SendError(NOT_SET_UP, 503); throw e; }
}
export async function setSignature(repId: string, text: unknown): Promise<string> {
  const s = typeof text === 'string' ? text.replace(/\r\n|\r/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim() : '';
  if (s.length > MAX_SIGNATURE) throw new SendError(`Keep your signature to ${MAX_SIGNATURE} characters or fewer.`);
  if (s.split('\n').length > 10) throw new SendError('Keep your signature to 10 lines or fewer.');
  try {
    const r = await prisma.$queryRaw<{ rep_id: string }[]>`update crm.gmail_connections set signature = ${s || null}, updated_at = now() where rep_id = ${repId}::uuid returning rep_id`;
    if (!r.length) throw new SendError('Connect your Gmail first (Settings).', 400, { needsConnect: true });
  } catch (e) { if (tableMissing(e)) throw new SendError(NOT_SET_UP, 503); throw e; }
  return s;
}

/** The addresses already known for this account or cart (to fill in To). */
export async function knownFor(rep: Rep, accountId: unknown, cartKey: unknown, d: Deps = realDeps): Promise<string[]> {
  return (await resolveTarget(rep, accountId, cartKey, d)).known;
}
/** Which of these addresses are not already known for this customer: the page asks the rep to confirm them before it sends. */
export async function checkRecipients(rep: Rep, b: { accountId?: unknown; cartKey?: unknown; to?: unknown; cc?: unknown }, d: Deps = realDeps): Promise<{ unknown: string[] }> {
  const to = parseAddresses(b.to), cc = parseAddresses(b.cc);
  if (!to.list.length || to.bad || cc.bad) throw new SendError('Check the email addresses. Use plain addresses like name@shop.com.au, separated by commas.');
  if (to.list.length + cc.list.length > MAX_PEOPLE) throw new SendError(`That is more than ${MAX_PEOPLE} people. Send it to fewer.`);
  const t = await resolveTarget(rep, b.accountId, b.cartKey, d);
  return { unknown: unknownAddresses([...to.list, ...cc.list], t.known) };
}

// ---------- sending ----------
export type SendResult = { ok: true; duplicate: boolean; logged: boolean; messageId: string; activityId: string | null; cartLog: { id: string; method: string; note: string; at: string; by: string | null; mine: boolean } | null; warning: string | null };
type SendRow = { id: string; state: 'sending' | 'sent'; message_id: string | null; logged: boolean; created_at: Date };
export async function sendEmail(rep: Rep, b: Record<string, unknown>, d: Deps = realDeps): Promise<SendResult> {
  const to = parseAddresses(b.to), cc = parseAddresses(b.cc);
  if (!to.list.length || to.bad || cc.bad) throw new SendError('Check the email addresses. Use plain addresses like name@shop.com.au, separated by commas.');
  if (to.list.length + cc.list.length > MAX_PEOPLE) throw new SendError(`That is more than ${MAX_PEOPLE} people. Send it to fewer.`);
  const subject = cleanSubject(b.subject), body = typeof b.body === 'string' ? b.body : '';
  if (!subject) throw new SendError('Write a subject (one line, up to 300 characters).');
  if (!body.trim() || body.length > 20_000) throw new SendError('Write the email (up to 20,000 characters).');
  const clientId = typeof b.clientId === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(b.clientId) ? b.clientId : null;
  if (!clientId) throw new SendError('Something is wrong with this page. Reload it and try again.');
  const target = await resolveTarget(rep, b.accountId, b.cartKey, d);
  try {
    const [c] = await prisma.$queryRaw<{ email: string; refresh_token_enc: string; scope: string | null; status: string; allow_send: boolean; signature: string | null }[]>`select email, refresh_token_enc, scope, status, allow_send, signature from crm.gmail_connections where rep_id = ${rep.id}::uuid`;
    if (!c) throw new SendError('Connect your Gmail first (Settings).', 400, { needsConnect: true });
    if (c.status !== 'ok') throw new SendError('Your Gmail needs to be connected again (Settings).', 409, { needsConnect: true });
    if (!canDraft(c.scope)) throw new SendError('Radar needs your permission to write emails. Press Allow and tick the box on Google\'s page.', 409, { needsDrafts: true });
    if (!c.allow_send) throw new SendError('Switch on "Let Radar send emails I write here" first.', 403, { needsAllowSend: true });
    const unknown = unknownAddresses([...to.list, ...cc.list], target.known);
    if (unknown.length && b.confirmUnknown !== true) throw new SendError(`Radar has not seen ${unknown.join(', ')} for this customer. Check ${unknown.length === 1 ? 'it' : 'them'} and confirm.`, 409, { unknown });
    const [h] = await prisma.$queryRaw<{ hour: number; day: number }[]>`
      select count(*) filter (where created_at > now() - interval '1 hour')::int as hour, count(*)::int as day from crm.email_sends where rep_id = ${rep.id}::uuid and created_at > now() - interval '24 hours'`;
    if ((h?.hour ?? 0) >= SENDS_PER_HOUR) throw new SendError(`That is ${SENDS_PER_HOUR} emails in the last hour. Try again later.`, 429);
    if ((h?.day ?? 0) >= SENDS_PER_DAY) throw new SendError(`That is ${SENDS_PER_DAY} emails in the last 24 hours. Try again tomorrow.`, 429);
    // One row per email: it is what makes pressing Send twice send once.
    const made = await prisma.$queryRaw<{ id: string }[]>`
      insert into crm.email_sends (rep_id, client_id, target_kind, account_id, cart_key, to_addrs, cc_addrs, subject)
      values (${rep.id}::uuid, ${clientId}, ${target.kind}, ${target.accountId}::uuid, ${target.cartKey}, ${to.list}::text[], ${cc.list}::text[], ${subject})
      on conflict (rep_id, client_id) do nothing returning id`;
    if (!made.length) {
      const [old] = await prisma.$queryRaw<SendRow[]>`select id, state, message_id, logged, created_at from crm.email_sends where rep_id = ${rep.id}::uuid and client_id = ${clientId}`;
      if (old?.state === 'sent') return { ok: true, duplicate: true, logged: old.logged, messageId: old.message_id ?? '', activityId: null, cartLog: null, warning: null };
      const stale = old && Date.now() - new Date(old.created_at).getTime() > 120_000;
      throw new SendError(stale ? 'Radar could not confirm that email was sent. Check your Sent folder in Gmail before sending it again.' : 'That email is already being sent. Wait a moment.', 409);
    }
    const rowId = made[0]!.id;
    let sent: { id: string; threadId: string };
    try {
      const raw = buildRawMessage({ to: to.list, cc: cc.list, subject, body: withSignature(body, c.signature) });
      sent = await d.send(await d.accessToken(d.decrypt(c.refresh_token_enc)), raw);
    } catch (e) {
      if (e instanceof GoogleApiError) {   // Google answered with an error: it was not sent, so it can be tried again
        await prisma.$queryRaw`delete from crm.email_sends where id = ${rowId}::uuid`;
        if (e.status === 401 || e.status === 403 || e.reason === 'invalid_grant') throw new SendError('Google would not allow it. Press Allow to connect again, and tick the box.', 409, { needsDrafts: true });
        console.error('email send failed', e.status, String(e.message).slice(0, 120));
        throw new SendError('Gmail would not send it just now. Nothing was sent. Try again in a minute.', 502);
      }
      if (e instanceof Error && /Check the email addresses|line break/.test(e.message)) { await prisma.$queryRaw`delete from crm.email_sends where id = ${rowId}::uuid`; throw new SendError(e.message); }
      console.error('email send unclear', String((e as Error)?.message ?? e).slice(0, 120));   // a timeout or dropped connection: it may have gone, so the row stays and a repeat is held
      throw new SendError('Radar could not confirm that email was sent. Check your Sent folder in Gmail before sending it again.', 502);
    }
    await prisma.$queryRaw`update crm.email_sends set state = 'sent', message_id = ${sent.id}, thread_id = ${sent.threadId}, sent_at = now() where id = ${rowId}::uuid`;
    // The log, written for the rep. If this fails the email has still gone: say so, never claim it failed.
    let activityId: string | null = null, cartLog: SendResult['cartLog'] = null, warning: string | null = null;
    try {
      const note = logNote(to.list, cc.list, subject, body);
      if (target.kind === 'account') activityId = await logOnAccount(rep.id, target.accountId, note, `${subject}\n${body}`);
      else cartLog = await logOnCart(rep.id, target.cartKey, note);
      await prisma.$queryRaw`update crm.email_sends set logged = true where id = ${rowId}::uuid`;
    } catch (e) {
      console.error('email log failed', String((e as Error)?.message ?? e).slice(0, 160));
      warning = `The email was sent, but Radar could not save it in the ${target.kind === 'account' ? 'activity log' : 'cart log'}. Add it by hand.`;
    }
    return { ok: true, duplicate: false, logged: warning === null, messageId: sent.id, activityId, cartLog, warning };
  } catch (e) { if (tableMissing(e)) throw new SendError(NOT_SET_UP, 503); throw e; }
}

/** An Email activity on the account, with what logging one by hand does: a new lead becomes approached, and "follow up in 3 weeks" sets the reminder. */
async function logOnAccount(repId: string, accountId: string, note: string, textForFollowUp: string): Promise<string> {
  const [a] = await prisma.$queryRaw<{ id: string; occurred_at: Date }[]>`
    insert into crm.activity (id, account_id, rep_id, type, note) values (gen_random_uuid(), ${accountId}::uuid, ${repId}::uuid, 'email'::crm."ActivityType", ${note}) returning id, occurred_at`;
  await prisma.$queryRaw`update crm.accounts set stage = 'approached', updated_at = now() where id = ${accountId}::uuid and stage = 'new_lead'`;
  const when = parseFollowUp(textForFollowUp, new Date(a!.occurred_at));
  if (when) await prisma.$queryRaw`update crm.accounts set next_follow_up_at = ${when}::timestamp, updated_at = now() where id = ${accountId}::uuid`;
  return a!.id;
}
async function logOnCart(repId: string, cartKey: string, note: string): Promise<NonNullable<SendResult['cartLog']>> {
  const [r] = await prisma.$queryRaw<{ id: string; created_at: Date; rep_name: string | null }[]>`
    with ins as (insert into crm.abandoned_cart_logs (cart_key, rep_id, method, note) values (${cartKey}, ${repId}::uuid, 'emailed', ${note.slice(0, 2000)}) returning id, created_at)
    select ins.id, ins.created_at, (select name from crm.reps where id = ${repId}::uuid) as rep_name from ins`;
  return { id: r!.id, method: 'emailed', note: note.slice(0, 2000), at: new Date(r!.created_at).toISOString(), by: r!.rep_name, mine: true };
}
