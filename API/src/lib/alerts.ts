// Email alerts from the company mailbox (sales@) to the addresses a manager has typed in Settings, and the supplier contacts.
// - Every list starts OFF. Nothing is sent to anyone until a manager turns that list on.
// - An alert only ever goes to the addresses in its Settings list: never to a customer, never to an address that came from anywhere else.
// - The sandbox never emails real people: it sends only to ALERT_TEST_ADDRESS (and to nobody if that is not set).
// - It never throws into what called it: a failed alert is written to the alert log, and the request or sync that caused it carries on.
// - The same alert is never sent twice, and no more than HOURLY_LIMIT are sent in an hour, so a mistake can never flood anyone.
import { prisma } from './prisma';
import { accessTokenFrom, buildRawMessage, canDraft, cleanAddress } from './gmail/google';
import { decrypt } from './gmail/crypto';
import { sendRawMessage } from './gmail/alertSend';
import type { RequestItem } from './productRequests';

export const KINDS = ['new_request', 'shipment_booked', 'shipment_landed', 'sales_pack'] as const;
export type Kind = typeof KINDS[number];
export const KIND_INFO: Record<Kind, { label: string; about: string }> = {
  new_request: { label: 'New product requests', about: 'When the sales team asks for a product on the Product Requests page.' },
  shipment_booked: { label: 'Shipment booked', about: 'When a new incoming shipment is booked: the items, the due date and the sales information.' },
  shipment_landed: { label: 'Shipment landed', about: 'When a shipment has arrived and is ready to sell.' },
  sales_pack: { label: 'Sales pack', about: 'The sales pack Radar prepares when a brand lands.' },
};
export const MAX_ADDRESSES = 20;
export const HOURLY_LIMIT = 30;
export const isKind = (k: unknown): k is Kind => (KINDS as readonly unknown[]).includes(k);
export const isSandbox = () => process.env.APP_ENV === 'staging';
export const sandboxTestAddress = (): string | null => cleanAddress(process.env.ALERT_TEST_ADDRESS);

export class AlertError extends Error { status: number; constructor(message: string, status = 400) { super(message); this.status = status; } }
const tableMissing = (e: any) => e?.code === '42P01' || e?.meta?.code === '42P01' || (/alert_lists|supplier_contacts|alert_log|\b42P01\b/.test(String(e?.message ?? e)) && /does not exist|relation/i.test(String(e?.message ?? e)));
const NOT_SET_UP = 'Email alerts are not set up in the database yet. Ask whoever looks after Radar to run email-alerts.sql.';

/** A list of addresses typed in (a list, or text separated by lines, commas, semicolons or spaces): cleaned, lower case, no repeats, or the problem in words. */
export function parseAddresses(input: unknown): { addresses: string[] } | { error: string } {
  const raw = Array.isArray(input) ? input : typeof input === 'string' ? input.split(/[\s,;]+/) : null;
  if (!raw) return { error: 'Give the addresses as a list.' };
  const out: string[] = [], seen = new Set<string>(), bad: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') return { error: 'Every address must be text.' };
    const t = v.trim();
    if (!t) continue;
    const a = cleanAddress(t);
    if (!a) { bad.push(t.slice(0, 40)); continue; }
    const k = a.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(k); }
  }
  if (bad.length) return { error: `These do not look like email addresses: ${bad.slice(0, 3).join(', ')}${bad.length > 3 ? ' and more' : ''}.` };
  if (out.length > MAX_ADDRESSES) return { error: `A list can hold at most ${MAX_ADDRESSES} addresses.` };
  return { addresses: out };
}

const oneLine = (s: string, max = 150) => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** The email for a new product request. */
export function newRequestMessage(i: RequestItem): { subject: string; body: string } {
  const what = i.kind === 'new' ? `New item: ${i.itemName}${i.brand ? ` (${i.brand})` : ''}` : `${i.itemName} (${i.sku ?? ''}${i.brand ? `, ${i.brand}` : ''})`;
  const lines = [
    'A new product request was made in Radar.', '',
    `Product: ${what}`,
    `Asked by: ${i.requestedBy.name ?? 'someone who has left'}`,
    `How many: ${i.qty ? `${i.qty.toLocaleString('en-AU')} units` : 'not given'}`,
    `For: ${i.customer ?? 'no store given'}`,
    `Needed by: ${i.neededBy ?? 'no date given'}`,
  ];
  if (i.stock) lines.push(`Stock now: ${i.stock.available.toLocaleString('en-AU')} available, ${i.stock.onOrder.toLocaleString('en-AU')} on order`);
  if (i.supplier) lines.push(`Supplier suggested: ${i.supplier}`);
  if (i.link) lines.push(`Link: ${i.link}`);
  if (i.notes) lines.push('', 'Notes:', i.notes);
  lines.push('', 'To answer it, open Order Forecast & Procurement in Radar and find it in the Special requests section.');
  return { subject: `[Radar] New product request: ${oneLine(i.itemName, 80)}${i.qty ? ` (${i.qty} units)` : ''}`, body: lines.join('\n') };
}

type Mailbox = { email: string; problem: string | null; conn: { refresh_token_enc: string } | null };
/** The company mailbox (the one the payment reminder drafts use) and whether it can send. */
async function mailbox(): Promise<Mailbox> {
  let email = 'sales@rhinorhino.com.au';
  try { const [s] = await prisma.$queryRaw<{ mailbox_email: string }[]>`select mailbox_email from crm.followup_draft_settings where id = 1`; if (s?.mailbox_email) email = s.mailbox_email; } catch { /* that table may not be there: use the usual address */ }
  const [c] = await prisma.$queryRaw<{ refresh_token_enc: string; scope: string | null; status: string }[]>`select refresh_token_enc, scope, status from crm.gmail_connections where lower(email) = lower(${email})`;
  if (!c) return { email, problem: `${email} is not connected to Gmail. Sign in as that person and press Connect Gmail in Settings, and tick Allow drafts.`, conn: null };
  if (c.status !== 'ok') return { email, problem: `${email} needs to be connected again (its Google sign-in has expired). Press Connect Gmail in Settings, and tick Allow drafts.`, conn: null };
  if (!canDraft(c.scope)) return { email, problem: `${email} is connected without the permission alerts need. Press Allow drafts in the Gmail card in Settings (the same permission also lets alerts send).`, conn: null };
  return { email, problem: null, conn: { refresh_token_enc: c.refresh_token_enc } };
}

async function logAlert(kind: string, relatedId: string | undefined, to: string[], subject: string, ok: boolean, error: string | null, messageId?: string) {
  await prisma.$queryRaw`insert into crm.alert_log (kind, related_id, to_addresses, subject, ok, error, message_id) values (${kind}, ${relatedId ?? null}, ${to}::text[], ${oneLine(subject, 200)}, ${ok}, ${error}, ${messageId ?? null})`;
}

/** Send one alert. Never throws: it says whether it was sent, and why not. `test` sends to the given address only and ignores the list's on/off switch. */
export async function sendAlert(kind: Kind, msg: { subject: string; body: string }, o: { relatedId?: string; to?: string[]; test?: boolean } = {}): Promise<{ sent: boolean; reason: string }> {
  const logKind = o.test ? 'test' : kind;
  let to = o.to ?? [], subject = msg.subject;
  try {
    const [list] = await prisma.$queryRaw<{ enabled: boolean; addresses: string[] }[]>`select enabled, addresses from crm.alert_lists where kind = ${kind}`;
    if (!o.test) { if (!list?.enabled || !list.addresses.length) return { sent: false, reason: 'off' }; to = list.addresses; }
    if (!to.length) return { sent: false, reason: 'no address' };
    if (isSandbox()) {
      const t = sandboxTestAddress();
      if (!t) return { sent: false, reason: 'The sandbox has no test address, so nothing is sent.' };
      to = [t]; subject = '[SANDBOX] ' + subject;
    }
    if (o.relatedId && !o.test) {
      const dup = await prisma.$queryRaw<{ one: number }[]>`select 1 as one from crm.alert_log where kind = ${kind} and related_id = ${o.relatedId} and ok limit 1`;
      if (dup[0]) return { sent: false, reason: 'already sent' };
    }
    const [lim] = await prisma.$queryRaw<{ n: number }[]>`select count(*)::int as n from crm.alert_log where ok and created_at > now() - interval '1 hour'`;
    if ((lim?.n ?? 0) >= HOURLY_LIMIT) { await logAlert(logKind, o.relatedId, to, subject, false, `Stopped: ${HOURLY_LIMIT} alert emails have already gone out in the last hour`); return { sent: false, reason: 'rate limit' }; }
    const mb = await mailbox();
    if (mb.problem || !mb.conn) { await logAlert(logKind, o.relatedId, to, subject, false, mb.problem); return { sent: false, reason: mb.problem ?? 'no mailbox' }; }
    const token = await accessTokenFrom(decrypt(mb.conn.refresh_token_enc));
    const sent = await sendRawMessage(token, buildRawMessage({ to, subject: oneLine(subject, 200), body: msg.body }));
    await logAlert(logKind, o.relatedId, to, subject, true, null, sent.id);
    return { sent: true, reason: 'sent' };
  } catch (e) {
    if (tableMissing(e)) return { sent: false, reason: 'not set up' };
    const m = String((e as Error)?.message ?? e).slice(0, 300);
    try { await logAlert(logKind, o.relatedId, to, subject, false, m); } catch { /* the log itself is not available */ }
    return { sent: false, reason: m };
  }
}

/** Several products asked for the same store at once: one email listing them all, instead of one email each. */
export function newRequestsMessage(items: RequestItem[]): { subject: string; body: string } {
  const f = items[0]!;
  const lines = [
    `${items.length} product requests were made together in Radar, for the same store.`, '',
    `For: ${f.customer ?? 'no store given'}`,
    `Asked by: ${f.requestedBy.name ?? 'someone who has left'}`,
    `Needed by: ${f.neededBy ?? 'no date given'}`, '',
    ...items.map(i => `- ${i.sku ?? ''} ${oneLine(i.itemName, 80)}: ${i.qty ? `${i.qty.toLocaleString('en-AU')} units` : 'quantity not given'}${i.notes ? ` (${oneLine(i.notes, 120)})` : ''}`),
    '', 'To answer them, open Order Forecast & Procurement in Radar and find them in the Special requests section.',
  ];
  return { subject: `[Radar] ${items.length} product requests for ${oneLine(f.customer ?? 'a store', 60)}`, body: lines.join('\n') };
}
/** One email for requests made together (just the usual one if there is only one). It never delays or breaks the requests. */
export async function notifyNewRequests(items: RequestItem[]): Promise<void> {
  if (!items.length) return;
  if (items.length === 1) return notifyNewRequest(items[0]!);
  try { await sendAlert('new_request', newRequestsMessage(items), { relatedId: items[0]!.id }); } catch { /* sendAlert does not throw; this is only a last guard */ }
}
/** A new product request: email the ordering team if a manager has switched that list on. It never delays or breaks the request. */
export async function notifyNewRequest(item: RequestItem): Promise<void> {
  try { await sendAlert('new_request', newRequestMessage(item), { relatedId: item.id }); } catch { /* sendAlert does not throw; this is only a last guard */ }
}

export type ContactRow = { id: string; supplier: string; emails: string[]; cc: string[]; notes: string | null };
export type LogRow = { kind: string; to: string[]; subject: string; ok: boolean; error: string | null; at: string };
export type AlertState = {
  ready: boolean; sandbox: boolean; testAddress: string | null; mailbox: { email: string; ready: boolean; problem: string | null };
  lists: { kind: Kind; label: string; about: string; enabled: boolean; addresses: string[] }[]; contacts: ContactRow[]; recent: LogRow[];
};

export async function getState(): Promise<AlertState> {
  const base = { sandbox: isSandbox(), testAddress: sandboxTestAddress() };
  try {
    const rows = await prisma.$queryRaw<{ kind: Kind; enabled: boolean; addresses: string[] }[]>`select kind, enabled, addresses from crm.alert_lists`;
    const contacts = await prisma.$queryRaw<ContactRow[]>`select id, supplier, emails, cc, notes from crm.supplier_contacts order by lower(supplier)`;
    const log = await prisma.$queryRaw<{ kind: string; to_addresses: string[]; subject: string; ok: boolean; error: string | null; created_at: Date }[]>`select kind, to_addresses, subject, ok, error, created_at from crm.alert_log order by created_at desc limit 15`;
    const mb = await mailbox();
    return {
      ready: true, ...base, mailbox: { email: mb.email, ready: !mb.problem, problem: mb.problem },
      lists: KINDS.map(k => { const r = rows.find(x => x.kind === k); return { kind: k, ...KIND_INFO[k], enabled: !!r?.enabled, addresses: r?.addresses ?? [] }; }),
      contacts, recent: log.map(l => ({ kind: l.kind, to: l.to_addresses, subject: l.subject, ok: l.ok, error: l.error, at: new Date(l.created_at).toISOString() })),
    };
  } catch (e) {
    if (tableMissing(e)) return { ready: false, ...base, mailbox: { email: '', ready: false, problem: NOT_SET_UP }, lists: [], contacts: [], recent: [] };
    throw e;
  }
}

export async function saveList(kind: Kind, enabled: boolean, addressesInput: unknown, managerId: string): Promise<void> {
  const parsed = parseAddresses(addressesInput);
  if ('error' in parsed) throw new AlertError(parsed.error);
  if (enabled && !parsed.addresses.length) throw new AlertError('Add at least one address before turning this on.');
  try {
    await prisma.$queryRaw`update crm.alert_lists set enabled = ${enabled}, addresses = ${parsed.addresses}::text[], updated_by = ${managerId}::uuid, updated_at = now() where kind = ${kind}`;
  } catch (e) { if (tableMissing(e)) throw new AlertError(NOT_SET_UP, 503); throw e; }
}

export async function saveContact(c: { id?: string; supplier: unknown; emails: unknown; cc: unknown; notes: unknown }, managerId: string): Promise<void> {
  const supplier = typeof c.supplier === 'string' ? c.supplier.replace(/\s+/g, ' ').trim() : '';
  if (supplier.length < 2 || supplier.length > 120) throw new AlertError('Type the supplier name (2 to 120 characters).');
  const emails = parseAddresses(c.emails); if ('error' in emails) throw new AlertError(emails.error);
  const cc = parseAddresses(c.cc ?? []); if ('error' in cc) throw new AlertError(cc.error);
  if (!emails.addresses.length) throw new AlertError('Add at least one email address for this supplier.');
  const notes = typeof c.notes === 'string' && c.notes.trim() ? c.notes.trim().slice(0, 500) : null;
  try {
    if (c.id) {
      const r = await prisma.$queryRaw<{ id: string }[]>`update crm.supplier_contacts set supplier = ${supplier}, emails = ${emails.addresses}::text[], cc = ${cc.addresses}::text[], notes = ${notes}, updated_by = ${managerId}::uuid, updated_at = now() where id = ${c.id}::uuid returning id`;
      if (!r[0]) throw new AlertError('That supplier was not found.', 404);
    } else {
      await prisma.$queryRaw`insert into crm.supplier_contacts (supplier, emails, cc, notes, updated_by) values (${supplier}, ${emails.addresses}::text[], ${cc.addresses}::text[], ${notes}, ${managerId}::uuid)`;
    }
  } catch (e) {
    if (e instanceof AlertError) throw e;
    if (tableMissing(e)) throw new AlertError(NOT_SET_UP, 503);
    if (/supplier_contacts_name_idx|duplicate key|unique/i.test(String((e as Error)?.message ?? e))) throw new AlertError('That supplier is already in the list. Edit it instead.', 409);
    throw e;
  }
}

export async function deleteContact(id: string): Promise<void> {
  try { await prisma.$queryRaw`delete from crm.supplier_contacts where id = ${id}::uuid`; }
  catch (e) { if (tableMissing(e)) throw new AlertError(NOT_SET_UP, 503); throw e; }
}

/** "Send me a test": the test email goes to the manager who pressed it, never to the list. `sample` is a real example (shipment alerts); otherwise a plain test message is sent. */
export async function sendTest(kind: Kind, managerEmail: string | null, sample?: { subject: string; body: string }): Promise<{ sent: boolean; reason: string; to: string | null }> {
  const mine = cleanAddress(managerEmail);
  if (!mine && !isSandbox()) throw new AlertError('Radar does not have an email address for you, so it cannot send you a test.');
  const info = KIND_INFO[kind];
  const r = await sendAlert(kind, sample
    ? { subject: sample.subject.replace(/^\[Radar\] /, '[Radar] TEST: '), body: `THIS IS A TEST made from a real purchase order. Nothing was sent to the list.\n\n${sample.body}` }
    : {
      subject: `[Radar] Test: ${info.label} alerts`,
      body: `This is a test of the "${info.label}" alert from Radar.\n\nIf you can read this, alerts from this mailbox are working. Real alerts go to the addresses in the list in Settings, once that list is turned on.`,
    }, { test: true, to: mine ? [mine] : [] });
  return { ...r, to: isSandbox() ? sandboxTestAddress() : mine };
}
