/**
 * Merge one account into another.
 *
 * The usual case: a rep takes a lead under the name the customer gave, and later DEAR sets the customer up under their trading name, so the CRM
 * has two accounts for one business. The manager opens the account to KEEP and merges the duplicate into it. Everything that points at the
 * duplicate (logs, tasks, orders, emails, comments, credit reservations, marketing contacts, and anything added later) moves to the kept account,
 * the duplicate's name is kept as a "former name" so searching either name finds the account, and the duplicate is deleted.
 *
 * Which tables point at an account is read from the database itself (every uuid column named account_id, accountId, from_account_id or
 * to_account_id), so a table added later is moved too, and nothing is missed by a list going out of date. If anything still points at the
 * duplicate when it is deleted, the delete fails and the caller's transaction rolls back: nothing is half merged.
 *
 * Written against a tiny Db interface so it runs inside a Prisma transaction in the API and on a plain Postgres in tests.
 */

export type Db = {
  query: <T = any>(sql: string, params?: any[]) => Promise<T[]>;
  exec: (sql: string, params?: any[]) => Promise<number>;
};

export class MergeError extends Error {
  status: number;
  constructor(message: string, status = 409) { super(message); this.status = status; }
}

export const COLD_LEAD_REASON = 'Cold lead: does not want to be contacted';   // also used when an account is set to Cold lead (routes/accounts.ts)

const REF_COLUMNS = ['account_id', 'accountId', 'from_account_id', 'to_account_id'];
const SKIP_TABLES = new Set(['account_merges']);   // the audit trail names both accounts and must keep pointing at them
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STAGES = ['new_lead', 'approached', 'quote_sent', 'payment_cleared', 'dispatched'];
const NOT_REAL_ORDERS = ['DRAFT', 'ESTIMATING', 'ESTIMATED', 'ORDERING', 'VOIDED', 'CREDITED'];   // the same list the sales sync uses for spend and last order

type Row = Record<string, any>;
const blank = (v: any) => v === null || v === undefined || String(v).trim() === '';
const take = (a: any, b: any) => (!blank(a) ? a : blank(b) ? null : b);

/** What the merged account is: Cold lead wins (the safe side: no contact), then Customer, then Lead, then Prospect. */
export function mergedType(keep: string, from: string): string {
  if (keep === 'cold_lead' || from === 'cold_lead') return 'cold_lead';
  if (keep === 'customer' || from === 'customer') return 'customer';
  if (keep === 'lead' || from === 'lead') return 'lead';
  return 'prospect';
}
const furtherStage = (a: string, b: string) => (STAGES.indexOf(a) >= STAGES.indexOf(b) ? a : b);

const TYPE_WORD: Record<string, string> = { customer: 'Customer', lead: 'Lead', prospect: 'Prospect', cold_lead: 'Cold lead' };
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-AU')} ${n === 1 ? one : many}`;

async function loadAccount(db: Db, id: string, lock: boolean): Promise<Row | null> {
  const rows = await db.query(
    `select a.id::text as id, a.name, a.region, a.rep_id::text as rep_id, r.name as rep_name, a.type::text as type, a.stage::text as stage, a.credit::text as credit,
            a.dear_customer_id, a.contact_name, a.phone, a.email, a.address, a.category, a.payment_terms, a.postcode, a.council, a.next_follow_up_at,
            a.archived, a.dear_linked_at, a.dear_created_at, a.last_order_at
     from crm.accounts a left join crm.reps r on r.id = a.rep_id where a.id = $1::uuid ${lock ? 'for update of a' : ''}`, [id]);
  return rows[0] ?? null;
}

type Ref = { table: string; column: string };
async function references(db: Db): Promise<Ref[]> {
  const rows = await db.query<{ table: string; column: string }>(
    `select c.table_name as "table", c.column_name as "column"
     from information_schema.columns c
     join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
     where c.table_schema = 'crm' and c.data_type = 'uuid' and c.column_name = any($1::text[]) order by 1, 2`, [REF_COLUMNS]);
  return rows.filter(r => IDENT.test(r.table) && IDENT.test(r.column) && !SKIP_TABLES.has(r.table) && r.table !== 'accounts');
}

async function countRefs(db: Db, refs: Ref[], id: string) {
  const out: { table: string; column: string; n: number }[] = [];
  for (const r of refs) {
    const [x] = await db.query<{ n: number }>(`select count(*)::int as n from crm."${r.table}" where "${r.column}" = $1::uuid`, [id]);
    if (x?.n) out.push({ ...r, n: x.n });
  }
  return out;
}

function summarise(counts: { table: string; n: number }[]) {
  const sum = (pred: (t: string) => boolean) => counts.filter(c => pred(c.table)).reduce((s, c) => s + c.n, 0);
  const known = ['activity', 'tasks', 'quotes', 'email_log', 'account_aliases'];
  return { logs: sum(t => t === 'activity'), tasks: sum(t => t === 'tasks'), orders: sum(t => t === 'quotes'), emails: sum(t => t === 'email_log'), other: sum(t => !known.includes(t)) };
}

const brief = (a: Row) => ({ id: a.id, name: a.name, type: a.type, region: a.region, repName: a.rep_name ?? null, dearLinked: !!a.dear_customer_id, archived: !!a.archived, lastOrderAt: a.last_order_at ?? null });

export type MergeCheck = {
  keep: ReturnType<typeof brief>; from: ReturnType<typeof brief>;
  canMerge: boolean; reason: string | null;
  moves: ReturnType<typeof summarise>;
  becomes: { type: string; dearLinked: boolean };
  warnings: string[];
};

async function inspect(db: Db, keepId: string, fromId: string, lock: boolean) {
  if (!UUID.test(keepId) || !UUID.test(fromId)) throw new MergeError('Account not found', 404);
  const keep = await loadAccount(db, keepId, lock);
  const from = await loadAccount(db, fromId, lock);
  if (!keep || !from) throw new MergeError('Account not found', 404);

  let reason: string | null = null;
  if (keep.id === from.id) reason = 'Pick a different account to merge in.';
  else if (keep.dear_customer_id && from.dear_customer_id) {
    reason = `Both accounts are linked to a DEAR customer ("${keep.name}" and "${from.name}"). They are two customers in DEAR, so merge them in DEAR first, or archive one of these accounts instead.`;
  }

  const refs = await references(db);
  const counts = await countRefs(db, refs, from.id);
  const type = mergedType(keep.type, from.type);
  const takesDear = !keep.dear_customer_id && !!from.dear_customer_id;

  const warnings: string[] = [];
  if (from.rep_id !== keep.rep_id) warnings.push(`"${from.name}" belongs to ${from.rep_name ?? 'another rep'}. The merged account stays with ${keep.rep_name ?? 'its current rep'}.`);
  if (from.region !== keep.region) warnings.push(`The state stays ${keep.region} (the other account is in ${from.region}).`);
  if (takesDear) warnings.push(`"${from.name}" is linked to a DEAR customer. That link, its payment terms and category move to this account, which becomes a customer.`);
  if (type !== keep.type) warnings.push(`This account's type becomes ${TYPE_WORD[type] ?? type}.`);
  if (type === 'cold_lead' && keep.type !== 'cold_lead') warnings.push('Because one of them is a Cold lead, the merged account is a Cold lead, and its email addresses come off the marketing lists.');
  if (keep.archived) warnings.push('The account you are keeping is archived.');

  return {
    keep, from, refs, counts,
    check: { keep: brief(keep), from: brief(from), canMerge: !reason, reason, moves: summarise(counts), becomes: { type, dearLinked: !!(keep.dear_customer_id || from.dear_customer_id) }, warnings } as MergeCheck,
  };
}

/** What a merge would do, for the confirmation window. Changes nothing. */
export async function mergeCheck(db: Db, keepId: string, fromId: string): Promise<MergeCheck> {
  return (await inspect(db, keepId, fromId, false)).check;
}

/** Spend, usual reorder gap and last order, from the account's real orders: the same rule the sales sync uses (no drafts, quotes, Ordering, voided, credited, marketing or warranty orders). */
export function figures(sent: number[], amounts: number[], now: number) {
  const sum = (days: number) => amounts.reduce((t, a, i) => (now - sent[i] <= days * 86400000 ? t + a : t), 0);
  const sorted = [...sent].sort((a, b) => a - b);
  const roundStarts: number[] = [];   // orders within 7 days of a round's first order are one round (several branches on one account)
  for (const t of sorted) if (!roundStarts.length || t - roundStarts[roundStarts.length - 1] > 7 * 86400000) roundStarts.push(t);
  let autoGap: number | null = null;
  if (roundStarts.length >= 2) {
    const gaps = roundStarts.slice(1).map((t, i) => (t - roundStarts[i]) / 86400000).sort((a, b) => a - b);
    const mid = Math.floor(gaps.length / 2);
    autoGap = Math.round(gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2);
  }
  return { spend30: sum(30), spend90: sum(90), spend365: sum(365), autoGap, last: sorted.length ? new Date(sorted[sorted.length - 1]) : null };
}

async function recomputeFigures(db: Db, accountId: string) {
  const rows = await db.query<{ sent_at: Date; amount: number }>(
    `select sent_at, amount::float8 as amount from crm.quotes where account_id = $1::uuid and misc_type is null and upper(coalesce(fulfillment_status, '')) <> all($2::text[])`,
    [accountId, NOT_REAL_ORDERS]);
  const f = figures(rows.map(r => new Date(r.sent_at).getTime()), rows.map(r => Number(r.amount)), Date.now());
  const [a] = await db.query<{ o: number | null }>(`select reorder_gap_override as o from crm.accounts where id = $1::uuid`, [accountId]);
  const gap = a?.o ?? f.autoGap;
  await db.exec(
    `update crm.accounts set spend_30 = $2, spend_90 = $3, spend_365 = $4, reorder_gap_auto = $5::int, avg_order_gap_days = $6::int, last_order_at = $7 where id = $1::uuid`,
    [accountId, f.spend30, f.spend90, f.spend365, f.autoGap, gap, f.last]);
}

const isDuplicate = (e: any) => /duplicate key|unique constraint/i.test(String(e?.message ?? e));
const isForeignKey = (e: any) => /foreign key constraint/i.test(String(e?.message ?? e));

/** Move every row of one table that points at the duplicate. A row the kept account already has an equal of (a unique clash, such as the same rep
 *  excluded from both) is dropped instead, one row at a time, so no other row is lost. Needs to run inside a transaction. */
async function moveRows(db: Db, ref: Ref, keepId: string, fromId: string, n: number): Promise<{ moved: number; dropped: number }> {
  const sp = `merge_${ref.table}_${ref.column}`.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 50);
  await db.exec(`savepoint ${sp}`);
  try {
    const moved = await db.exec(`update crm."${ref.table}" set "${ref.column}" = $1::uuid where "${ref.column}" = $2::uuid`, [keepId, fromId]);
    await db.exec(`release savepoint ${sp}`);
    return { moved, dropped: 0 };
  } catch (e) {
    await db.exec(`rollback to savepoint ${sp}`);
    if (!isDuplicate(e)) throw e;
  }
  let moved = 0, dropped = 0;
  const rows = await db.query<{ ctid: string }>(`select ctid::text as ctid from crm."${ref.table}" where "${ref.column}" = $1::uuid`, [fromId]);
  for (const r of rows) {
    await db.exec(`savepoint ${sp}`);
    try {
      moved += await db.exec(`update crm."${ref.table}" set "${ref.column}" = $1::uuid where ctid = $2::tid`, [keepId, r.ctid]);
    } catch (e) {
      await db.exec(`rollback to savepoint ${sp}`);
      if (!isDuplicate(e)) throw e;
      dropped += await db.exec(`delete from crm."${ref.table}" where ctid = $1::tid`, [r.ctid]);
    }
    await db.exec(`release savepoint ${sp}`);
  }
  return { moved, dropped };
}

export type MergeResult = { moved: Record<string, number>; dropped: Record<string, number>; type: string; formerName: string | null; summary: ReturnType<typeof summarise> };

/** Do the merge. Must be called inside a transaction: any error leaves both accounts exactly as they were. */
export async function mergeAccounts(db: Db, keepId: string, fromId: string, byRepId: string): Promise<MergeResult> {
  const [have] = await db.query<{ ok: boolean }>(`select (to_regclass('crm.account_aliases') is not null and to_regclass('crm.account_merges') is not null) as ok`);
  if (!have?.ok) throw new MergeError('Merging is not set up yet. Run account-merges.sql in the database first.', 503);

  // Lock both rows, always in the same order, so two merges at once cannot deadlock.
  await db.query(`select id from crm.accounts where id = any($1::uuid[]) order by id for update`, [[keepId, fromId]]);
  const { keep, from, refs, counts, check } = await inspect(db, keepId, fromId, true);
  if (!check.canMerge) throw new MergeError(check.reason ?? 'These accounts cannot be merged.');

  const [by] = await db.query<{ name: string }>(`select name from crm.reps where id = $1::uuid`, [byRepId]);
  const takesDear = !keep.dear_customer_id && !!from.dear_customer_id;

  // 1. The unique DEAR link has to leave the duplicate before the kept account can take it.
  if (takesDear) await db.exec(`update crm.accounts set dear_customer_id = null where id = $1::uuid`, [from.id]);

  // 2. Move everything that points at the duplicate.
  const moved: Record<string, number> = {}, dropped: Record<string, number> = {};
  for (const ref of refs) {
    const n = counts.find(c => c.table === ref.table && c.column === ref.column)?.n ?? 0;
    if (!n) continue;
    const r = await moveRows(db, ref, keep.id, from.id, n);
    moved[ref.table] = (moved[ref.table] ?? 0) + r.moved;
    if (r.dropped) dropped[ref.table] = (dropped[ref.table] ?? 0) + r.dropped;
  }

  // 3. The kept account's own fields: its values stay, and anything it lacks is filled from the duplicate. A DEAR customer's terms and category
  //    come with the DEAR link.
  const type = mergedType(keep.type, from.type);
  await db.exec(
    `update crm.accounts set contact_name = $2, phone = $3, email = $4, address = $5, postcode = $6, council = $7, next_follow_up_at = $8,
        payment_terms = $9, category = $10, credit = $11::crm."CreditTerm", dear_customer_id = $12, dear_linked_at = $13, dear_created_at = $14,
        type = $15::crm."AccountType", stage = $16::crm."Stage", updated_at = now()
     where id = $1::uuid`,
    [keep.id,
      take(keep.contact_name, from.contact_name), take(keep.phone, from.phone), take(keep.email, from.email), take(keep.address, from.address),
      take(keep.postcode, from.postcode), take(keep.council, from.council), take(keep.next_follow_up_at, from.next_follow_up_at),
      takesDear ? take(from.payment_terms, keep.payment_terms) : take(keep.payment_terms, from.payment_terms),
      takesDear ? take(from.category, keep.category) : take(keep.category, from.category),
      takesDear ? from.credit : keep.credit,
      takesDear ? from.dear_customer_id : keep.dear_customer_id,
      takesDear ? from.dear_linked_at : keep.dear_linked_at,
      takesDear ? from.dear_created_at : keep.dear_created_at,
      type, furtherStage(keep.stage, from.stage)]);

  // 4. The duplicate's name stays findable. (Any former names it already had were moved with everything else above.)
  let formerName: string | null = null;
  if (from.name.trim().toLowerCase() !== keep.name.trim().toLowerCase()) {
    formerName = from.name;
    await db.exec(`insert into crm.account_aliases (account_id, alias, merged_from_id, merged_by) values ($1::uuid, $2, $3::uuid, $4::uuid) on conflict (account_id, lower(alias)) do nothing`,
      [keep.id, from.name, from.id, byRepId]);
  }
  await db.exec(`delete from crm.account_aliases where account_id = $1::uuid and lower(alias) = lower($2)`, [keep.id, keep.name]);

  // 5. Spend, reorder gap and last order, now that the orders are together.
  await recomputeFigures(db, keep.id);

  // 6. A Cold lead must never be emailed: when the merge makes the account one, every address it has goes on the suppression list.
  if (type === 'cold_lead' && keep.type !== 'cold_lead') {
    const emails = (await db.query<{ email: string }>(
      `select lower(btrim(email)) as email from crm.accounts where id = $1::uuid and email is not null and btrim(email) <> ''
       union select lower(btrim(email)) from crm.marketing_contacts where account_id = $1::uuid and btrim(email) <> ''`, [keep.id])).map(r => r.email);
    if (emails.length) await db.exec(`insert into crm.marketing_suppressions (email, reason) select unnest($1::text[]), $2 on conflict (email) do nothing`, [emails, COLD_LEAD_REASON]);
  }

  // 7. The trail: a log entry on the kept account that everyone can see, and a row in the merge history.
  const summary = summarise(counts);
  const parts = [
    summary.logs && plural(summary.logs, 'logged activity', 'logged activities'), summary.tasks && plural(summary.tasks, 'task'),
    summary.orders && plural(summary.orders, 'order'), summary.emails && plural(summary.emails, 'logged email'), summary.other && plural(summary.other, 'other record'),
  ].filter(Boolean);
  const note = `Merged "${from.name}" into this account${by?.name ? ` (by ${by.name})` : ''}. Moved: ${parts.length ? parts.join(', ') : 'nothing else'}.${formerName ? ` "${formerName}" is kept as a former name, so either name finds this account.` : ''}`;
  await db.exec(`insert into crm.activity (id, account_id, rep_id, type, note, occurred_at, created_at) values (gen_random_uuid(), $1::uuid, $2::uuid, 'remark'::crm."ActivityType", $3, now(), now())`, [keep.id, byRepId, note]);
  await db.exec(`insert into crm.account_merges (into_account_id, from_account_id, from_name, from_dear_customer_id, merged_by, moved) values ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6::jsonb)`,
    [keep.id, from.id, from.name, from.dear_customer_id ?? null, byRepId, JSON.stringify({ moved, dropped })]);

  // 8. The duplicate goes. If anything still points at it, this fails and the whole merge is undone.
  try {
    await db.exec(`delete from crm.accounts where id = $1::uuid`, [from.id]);
  } catch (e) {
    if (isForeignKey(e)) throw new MergeError(`Something else still points at "${from.name}", so nothing was merged. Tell whoever looks after the CRM: ${String((e as any)?.message ?? e).slice(0, 220)}`);
    throw e;
  }
  return { moved, dropped, type, formerName, summary };
}