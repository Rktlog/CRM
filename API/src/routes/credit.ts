import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { canSeeAccount, territoryWhere } from '../lib/territory';
import { dearGet } from '../sync/dearClient';
import { readDearPayments, type DearPayments } from '../lib/dearPayments';
import { settleCents } from '../lib/receivables';

// Credit.
//   - Reservations: the team sets credit aside by hand: a name, an amount, the credit
//     note number, the sales order / quote number (blank = their next order) and a
//     note. It shows on the account as Reserved. When the sync sees DEAR apply that
//     credit note for a similar amount, the SAME reservation is marked used (no new
//     row), and it records which order it went to.
//   - The Credit page: every credit note on account, every reservation (one row each,
//     with its status) and every credit movement (issued, applied, refunded).
// The credit itself is always applied in DEAR; the CRM only records the plan.
// Prepaid money can be reserved from ANY order, open or finished, except an order that is complete in full (its
// prepayment has been used by that order). Money on an open order is checked against DEAR itself before it is reserved.
// An order the customer no longer wants (for example a backorder they have dropped) can also be RELEASED: it then
// moves to "To apply in DEAR" to be applied or refunded. Releasing is checked against DEAR itself too.

export const creditRouter = Router();

const cents = (n: number) => Math.round(n * 100) / 100;

type Rep = { id: string; role: string };
export type CreditFilters = { regions?: string[]; q?: string; status?: string; type?: string; from?: string; to?: string; limit?: number; offset?: number };

// "NSW,ACT" from the state filter ("Unknown,INTL" is Others).
export const regionsParam = (v: unknown) => (typeof v === 'string' && v ? v.split(',').map(s => s.trim()).filter(Boolean) : undefined);

// null = sees everything (managers).
async function scopeIds(rep: Rep): Promise<string[] | null> {
  if (rep.role === 'manager') return null;
  return (await prisma.account.findMany({ where: await territoryWhere(rep as any), select: { id: true } })).map(a => a.id);
}

// Marks reservations used when DEAR shows the credit applied. Harmless if the
// function isn't installed yet (credit-section.sql).
async function reconcile() {
  try { await prisma.$queryRaw`select crm.reconcile_credit_reservations()`; }
  catch (e) { console.error('reservation check skipped:', (e as Error)?.message); }
}

function scopeWhere(ids: string[] | null, regions?: string[], alias = 'a'): Prisma.Sql {
  const a = Prisma.raw(alias);
  const w: Prisma.Sql[] = [];
  if (ids) w.push(Prisma.sql`${a}.id = any(${ids}::uuid[])`);
  if (regions?.length) w.push(Prisma.sql`${a}.region = any(${regions})`);
  return w.length ? Prisma.join(w, ' and ') : Prisma.sql`true`;
}

// ---------- Credit notes on account ----------
const NOTES_FROM = Prisma.sql`
  from crm.quotes q
  join crm.accounts a on a.id = q.account_id
  left join crm.reps rp on rp.id = a.rep_id
  cross join lateral jsonb_array_elements(q.credit_notes) c
  left join lateral (
    select coalesce(sum(amount), 0)::float8 as amt,
           string_agg(coalesce(nullif(order_ref, ''), 'next order'), ', ' order by created_at) as refs
    from crm.credit_reservations
    where credit_no = c->>'number' and status = 'reserved' and from_account_id = a.id
  ) r on true`;

function notesWhere(ids: string[] | null, f: CreditFilters, accountId?: string) {
  const w: Prisma.Sql[] = [
    Prisma.sql`q.source <> 'rhino-history' and q.number not like 'Q%'`,
    Prisma.sql`c->>'number' is not null and upper(coalesce(c->>'status', '')) <> 'VOIDED'`,
  ];
  if (accountId) w.push(Prisma.sql`a.id = ${accountId}::uuid`);
  if (ids) w.push(Prisma.sql`a.id = any(${ids}::uuid[])`);
  if (f.regions?.length) w.push(Prisma.sql`a.region = any(${f.regions})`);
  if (f.q) {
    const like = `%${f.q}%`;
    w.push(Prisma.sql`(a.name ilike ${like} or c->>'number' ilike ${like} or q.number ilike ${like} or coalesce(r.refs, '') ilike ${like})`);
  }
  if (f.status === 'open') w.push(Prisma.sql`coalesce((c->>'onAccount')::float8, 0) - r.amt > 0.005`);
  if (f.status === 'reserved') w.push(Prisma.sql`r.amt > 0.005`);
  if (f.status === 'used') w.push(Prisma.sql`coalesce((c->>'onAccount')::float8, 0) <= 0.005`);
  return Prisma.join(w, ' and ');
}

export type CreditNoteRow = {
  accountId: string; account: string; region: string; rep: string | null; orderNo: string; creditNo: string; date: string | null;
  total: number; applied: number; refunded: number; onAccount: number;
  reservedAmount: number; reservedFor: string | null; free: number;
};

export async function loadCreditNotes(rep: Rep, f: CreditFilters, accountId?: string): Promise<CreditNoteRow[]> {
  const ids = await scopeIds(rep);
  const rows = await prisma.$queryRaw<Omit<CreditNoteRow, 'free'>[]>`
    select a.id as "accountId", a.name as "account", a.region as "region", rp.name as "rep",
           q.number as "orderNo", c->>'number' as "creditNo", c->>'date' as "date",
           coalesce((c->>'total')::float8, 0) as "total", coalesce((c->>'applied')::float8, 0) as "applied",
           coalesce((c->>'refunded')::float8, 0) as "refunded", coalesce((c->>'onAccount')::float8, 0) as "onAccount",
           r.amt as "reservedAmount", r.refs as "reservedFor"
    ${NOTES_FROM}
    where ${notesWhere(ids, f, accountId)}
    order by (coalesce((c->>'onAccount')::float8, 0) > 0.005) desc, c->>'date' desc nulls last, c->>'number' desc
    limit 5000`;
  return rows.map(r => ({
    ...r,
    date: r.date ? String(r.date).slice(0, 10) : null,
    reservedAmount: cents(r.reservedAmount),
    free: cents(Math.max(0, r.onAccount - r.reservedAmount)),
  }));
}

// ---------- Reservations (one row each, with its status) ----------
export type ReservationRow = {
  id: string; name: string; accountId: string; account: string; region: string; rep: string | null;
  amount: number; creditNo: string | null; orderRef: string | null; usedOnOrder: string | null; note: string | null;
  sourceKind: 'credit_note' | 'prepayment'; sourceOrder: string | null; toAccountId: string; forAccount: string;
  status: 'reserved' | 'used' | 'cancelled'; createdAt: string; createdBy: string | null; resolvedAt: string | null; resolvedBy: string | null;
};

export async function loadReservations(rep: Rep, f: CreditFilters): Promise<ReservationRow[]> {
  const ids = await scopeIds(rep);
  const w: Prisma.Sql[] = [scopeWhere(ids, f.regions)];
  if (f.status === 'reserved' || f.status === 'used' || f.status === 'cancelled') w.push(Prisma.sql`r.status = ${f.status}`);
  if (f.q) {
    const like = `%${f.q}%`;
    w.push(Prisma.sql`(a.name ilike ${like} or coalesce(r.name, '') ilike ${like} or coalesce(r.credit_no, '') ilike ${like}
                      or coalesce(r.order_ref, '') ilike ${like} or coalesce(r.note, '') ilike ${like} or coalesce(r.source_order, '') ilike ${like})`);
  }
  const rows = await prisma.$queryRaw<ReservationRow[]>`
    select r.id, coalesce(nullif(r.name, ''), a.name) as "name", a.id as "accountId", a.name as "account", a.region as "region", rp.name as "rep",
           r.amount::float8 as "amount", r.credit_no as "creditNo", nullif(r.order_ref, '') as "orderRef", r.used_on_order as "usedOnOrder",
           r.source_kind as "sourceKind", r.source_order as "sourceOrder", r.to_account_id as "toAccountId", ta.name as "forAccount",
           r.note, r.status, r.created_at as "createdAt", cb.name as "createdBy", r.resolved_at as "resolvedAt",
           case when r.status = 'used' then coalesce(rb.name, 'Found in DEAR') else rb.name end as "resolvedBy"
    from crm.credit_reservations r
    join crm.accounts a on a.id = r.from_account_id
    join crm.accounts ta on ta.id = r.to_account_id
    left join crm.reps rp on rp.id = a.rep_id
    left join crm.reps cb on cb.id = r.created_by
    left join crm.reps rb on rb.id = r.resolved_by
    where ${Prisma.join(w, ' and ')}
    order by (r.status = 'reserved') desc, r.created_at desc
    limit 5000`;
  return rows.map(r => ({ ...r, amount: cents(r.amount) }));
}

// ---------- Movements: the credit itself (issued, applied, refunded) ----------
export type MovementRow = {
  date: string | null; type: string; accountId: string; account: string; region: string; rep: string | null;
  creditNo: string | null; reference: string | null; amount: number; by: string | null;
};
const TYPES = ['Credit note issued', 'Applied to invoice', 'Refunded to customer'];

export async function loadMovements(rep: Rep, f: CreditFilters): Promise<{ rows: MovementRow[]; total: number }> {
  const ids = await scopeIds(rep);
  const scopeSql = scopeWhere(ids, f.regions);

  const outer: Prisma.Sql[] = [];
  if (f.type && TYPES.includes(f.type)) outer.push(Prisma.sql`type = ${f.type}`);
  if (f.from) outer.push(Prisma.sql`date >= ${f.from}::date`);
  if (f.to) outer.push(Prisma.sql`date <= ${f.to}::date`);
  if (f.q) {
    const like = `%${f.q}%`;
    outer.push(Prisma.sql`(account ilike ${like} or coalesce("creditNo", '') ilike ${like} or coalesce(reference, '') ilike ${like})`);
  }
  const outerSql = outer.length ? Prisma.sql`where ${Prisma.join(outer, ' and ')}` : Prisma.empty;
  const limit = Math.min(Math.max(f.limit ?? 100, 1), 20000);
  const offset = Math.max(f.offset ?? 0, 0);

  const rows = await prisma.$queryRaw<(MovementRow & { n: bigint })[]>`
    with notes as (
      select a.id as account_id, a.name as account, a.region, rp.name as rep, q.number as order_no, c
      from crm.quotes q
      join crm.accounts a on a.id = q.account_id
      left join crm.reps rp on rp.id = a.rep_id
      cross join lateral jsonb_array_elements(q.credit_notes) c
      where q.source <> 'rhino-history' and q.number not like 'Q%' and c->>'number' is not null
        and upper(coalesce(c->>'status', '')) <> 'VOIDED' and ${scopeSql}
    ), moves as (
      select (c->>'date')::date as date, 'Credit note issued' as type, account_id, account, region, rep,
             c->>'number' as "creditNo", order_no as reference, coalesce((c->>'total')::float8, 0) as amount, null::text as by
      from notes
      union all
      select nullif(al->>'date', '')::date, 'Applied to invoice', account_id, account, region, rep,
             c->>'number', concat_ws(' on ', al->>'invoice', ord.number), -coalesce((al->>'amount')::float8, 0), null
      from notes
      cross join lateral jsonb_array_elements(coalesce(c->'allocations', '[]'::jsonb)) al
      left join lateral (select q2.number from crm.quotes q2
                         where q2.invoices @> jsonb_build_array(jsonb_build_object('number', al->>'invoice')) limit 1) ord on true
      union all
      select nullif(rf->>'date', '')::date, 'Refunded to customer', account_id, account, region, rep,
             c->>'number', order_no, -coalesce((rf->>'amount')::float8, 0), null
      from notes
      cross join lateral jsonb_array_elements(coalesce(c->'refundsPaid', '[]'::jsonb)) rf
    )
    select *, count(*) over() as n
    from moves
    ${outerSql}
    order by date desc nulls last, type
    limit ${limit} offset ${offset}`;

  return {
    total: rows.length ? Number(rows[0].n) : 0,
    rows: rows.map(({ n, ...r }: any) => ({ ...r, accountId: r.account_id, date: r.date ? new Date(r.date).toISOString().slice(0, 10) : null, amount: cents(r.amount) })),
  };
}

// ---------- Money held on orders that is NOT a credit note ----------
// The sync also counts a prepayment that hasn't been applied to an invoice yet (a customer
// who paid up front for an order) and an order that is overpaid. One row per order and kind.
//   Any prepayment can be RESERVED for this customer's next order, whatever state the order is in (open, part
//   shipped, backordered, credited, closed, voided), EXCEPT on an order that is complete in full: that order has
//   used its prepayment. Overpaid money is shown but not reservable. A prepayment on an open order is checked
//   against DEAR before it is reserved, and the order stops counting it as paid (see Open Quotes).
export type HeldRow = {
  id: string; number: string; accountId: string; account: string; region: string; rep: string | null;
  status: string; orderDate: string | null; kind: 'Prepayment' | 'Overpaid'; amount: number;
  finished: boolean;     // completed, credited, closed, cancelled or released: the order no longer needs the money
  cancelled: boolean;
  completeInFull: boolean;   // the order is completed: its prepayment has been used by it
  reservable: boolean;   // a prepayment on any order that is not complete in full
  reserved: number;      // of this prepayment, set aside and not yet used or released
  free: number;          // still free to reserve
  released: boolean;     // an open order the customer no longer wants: its prepayment has been freed by hand
  releaseNote: string | null;
  dearSaleId: string | null;
  orderTotal: number | null;   // what the order comes to (inc GST)
  remaining: number | null;    // still to be paid on the order, counting this prepayment (what is reserved out of it is not counted). null once there is no order left to pay: credited, closed, voided or released
};
const isCancelled = (status: string) => /^VOIDED/i.test(status.trim());
const isFinished = (status: string) => /^(COMPLETED|CREDITED|CLOSED|VOIDED)/i.test(status.trim());
const isComplete = (status: string) => /^COMPLETED/i.test(status.trim());   // complete in full

export async function loadHeld(rep: Rep, f: CreditFilters, accountId?: string): Promise<HeldRow[]> {
  const ids = await scopeIds(rep);
  const w: Prisma.Sql[] = [scopeWhere(ids, f.regions)];
  if (accountId) w.push(Prisma.sql`a.id = ${accountId}::uuid`);
  if (f.q) {
    const like = `%${f.q}%`;
    w.push(Prisma.sql`(a.name ilike ${like} or q.number ilike ${like})`);
  }
  const rows = await prisma.$queryRaw<(Omit<HeldRow, 'finished' | 'cancelled' | 'completeInFull' | 'reservable' | 'free' | 'orderDate'> & { orderDate: Date | null })[]>`
    with o as (
      select q.id, q.number, a.id as account_id, a.name as account, a.region, rp.name as rep,
             coalesce(q.fulfillment_status, '') as status, q.sent_at as order_date,
             greatest(coalesce(q.unapplied_credit, 0)::numeric
               - coalesce((select sum((c->>'onAccount')::numeric) from jsonb_array_elements(q.credit_notes) c), 0), 0) as prepayment,
             greatest(-coalesce(q.amount_due, 0)::numeric, 0) as overpaid,
             coalesce(rv.taken, 0) as taken,
             q.dear_sale_id as dear_sale_id, (q.prepay_released_at is not null) as released, q.prepay_release_note as release_note,
             coalesce(q.total, q.amount)::numeric as order_total, coalesce(q.amount_paid, 0)::numeric as cash_paid,
             (q.amount_due is not null and q.amount_due <= 0.005 and coalesce(q.invoiced_total, 0) >= coalesce(q.total, q.amount) - 0.005) as settled
      from crm.quotes q
      join crm.accounts a on a.id = q.account_id
      left join crm.reps rp on rp.id = a.rep_id
      -- what has already been reserved out of this order's prepayment (a use in the last 2 days still counts until the sync catches up)
      left join lateral (
        select sum(r.amount) as taken from crm.credit_reservations r
        where r.source_kind = 'prepayment' and r.source_order = q.number and r.from_account_id = a.id
          and (r.status = 'reserved' or (r.status = 'used' and r.resolved_at > now() - interval '2 days'))
      ) rv on true
      where q.source <> 'rhino-history' and q.number not like 'Q%' and ${Prisma.join(w, ' and ')}
    )
    select id, number, account_id as "accountId", account, region, rep, status, order_date as "orderDate", 'Prepayment' as kind, prepayment::float8 as amount, least(taken, prepayment)::float8 as reserved,
           dear_sale_id as "dearSaleId", released, release_note as "releaseNote", order_total::float8 as "orderTotal",
           -- the same sum Open Quotes uses: cash applied + the prepayment still held (less what is reserved), or the whole order if it is invoiced in full with nothing due
           greatest(order_total - (case when settled then greatest(cash_paid + greatest(prepayment - least(taken, prepayment), 0), order_total) else cash_paid + greatest(prepayment - least(taken, prepayment), 0) end), 0)::float8 as remaining
    from o where prepayment > 0.005
    union all
    select id, number, account_id, account, region, rep, status, order_date, 'Overpaid', overpaid::float8, 0::float8, dear_sale_id, released, release_note, order_total::float8, null::float8
    from o where overpaid > 0.005
    order by amount desc
    limit 5000`;
  return rows.map(r => {
    // A released order counts as finished: its prepayment is to be applied or refunded in DEAR.
    // Any prepayment can be reserved unless the order is complete in full.
    const finished = isFinished(r.status) || (r.kind === 'Prepayment' && r.released), completeInFull = isComplete(r.status), reservable = r.kind === 'Prepayment' && !completeInFull;
    const amount = cents(r.amount), reserved = reservable ? cents(r.reserved) : 0;
    const noOrderLeft = /^(VOIDED|CREDITED|CLOSED)/i.test(r.status.trim()) || r.released;   // nothing left to pay on an order that is gone
    return {
      ...r, amount, finished, cancelled: isCancelled(r.status), completeInFull, reservable, reserved,
      orderTotal: r.orderTotal == null ? null : cents(r.orderTotal),
      remaining: r.kind === 'Prepayment' && !noOrderLeft && r.remaining != null ? settleCents(r.orderTotal ?? 0, cents(r.remaining)) : null,   // cents of GST rounding are not owed
      free: reservable ? cents(Math.max(0, amount - reserved)) : 0,
      orderDate: r.orderDate ? new Date(r.orderDate).toISOString().slice(0, 10) : null,
    };
  });
}

const heldTotal = (rows: { amount: number }[]) => cents(rows.reduce((t, r) => t + r.amount, 0));

const notesTotal = (notes: { onAccount: number }[]) => cents(notes.reduce((t, n) => t + (n.onAccount > 0.005 ? n.onAccount : 0), 0));

// Open reservations out of this customer's credit. `notes` = from credit notes (and manual ones), `prepaid` = from prepayments.
async function reservedFrom(accountId: string, kind: 'notes' | 'prepaid' | 'all' = 'all'): Promise<number> {
  const [r] = await prisma.$queryRaw<{ total: number }[]>`
    select coalesce(sum(amount), 0)::float8 as total
    from crm.credit_reservations
    where from_account_id = ${accountId}::uuid and status = 'reserved'
      and (${kind} = 'all' or (${kind} = 'prepaid') = (source_kind = 'prepayment'))`;
  return cents(r?.total ?? 0);
}

async function visibleAccount(rep: Rep, id: string) {
  const account = await prisma.account.findUnique({ where: { id }, select: { id: true, name: true, repId: true, region: true } });
  if (!account) return { error: 404 as const };
  if (!(await canSeeAccount(rep as any, account))) return { error: 403 as const };
  return { account };
}
const denied = (e: 404 | 403) => ({ status: e, body: { error: e === 404 ? 'Account not found' : 'This account is outside your states' } });

// ---------- GET /credit/account/:id ----------
creditRouter.get('/account/:id', async (req, res) => {
  try {
    const v = await visibleAccount(req.rep!, req.params.id);
    if ('error' in v) { const d = denied(v.error!); return res.status(d.status).json(d.body); }
    await reconcile();

    const [reservedNotes, reservedPrepaid, notes, heldRows] = await Promise.all([
      reservedFrom(v.account.id, 'notes'), reservedFrom(v.account.id, 'prepaid'), loadCreditNotes(req.rep!, {}, v.account.id), loadHeld(req.rep!, {}, v.account.id),
    ]);
    const credit = notesTotal(notes);                          // credit notes on account
    const prepaid = heldRows.filter(h => h.reservable);        // prepaid money on any order that is not complete in full: reservable like a credit note
    const prepaidFree = cents(prepaid.reduce((t, h) => t + h.free, 0));
    const held = heldTotal(heldRows.filter(h => !h.reservable));   // held on orders complete in full, or overpaid: not free
    const rows = await prisma.$queryRaw<any[]>`
      select c.id, coalesce(nullif(c.name, ''), ${v.account.name}) as "name", c.amount, nullif(c.order_ref, '') as "orderRef",
             c.credit_no as "creditNo", c.source_kind as "sourceKind", c.source_order as "sourceOrder", c.used_on_order as "usedOnOrder", c.note, c.status,
             c.created_at as "createdAt", c.resolved_at as "resolvedAt",
             c.from_account_id as "fromAccountId", fa.name as "fromName",
             c.to_account_id as "toAccountId", ta.name as "toName",
             cr.name as "createdBy",
             case when c.status = 'used' then coalesce(rr.name, 'Found in DEAR') else rr.name end as "resolvedBy"
      from crm.credit_reservations c
      join crm.accounts fa on fa.id = c.from_account_id
      join crm.accounts ta on ta.id = c.to_account_id
      left join crm.reps cr on cr.id = c.created_by
      left join crm.reps rr on rr.id = c.resolved_by
      where c.from_account_id = ${v.account.id}::uuid or c.to_account_id = ${v.account.id}::uuid
      order by (c.status = 'reserved') desc, c.created_at desc
      limit 100`;

    const onAccountOf = new Map(notes.map(n => [n.creditNo.toUpperCase(), n.onAccount]));
    res.json({
      creditInDear: credit,
      otherCredit: held,
      reserved: cents(reservedNotes + reservedPrepaid), reservedNotes, reservedPrepaid,
      available: cents(Math.max(0, credit - reservedNotes)),           // credit notes free to use
      prepaid: prepaid.map(h => ({ orderNo: h.number, orderId: h.id, status: h.status, cancelled: h.cancelled, released: h.released, orderDate: h.orderDate, amount: h.amount, reserved: h.reserved, free: h.free, orderTotal: h.orderTotal, leftToPay: h.remaining })),
      prepaidHeld: heldTotal(prepaid), prepaidFree,                    // prepaid money free to use
      // credit notes with credit left that is not already reserved: what can be reserved
      reservable: notes.filter(n => n.free > 0.005).map(n => ({ creditNo: n.creditNo, date: n.date, onAccount: cents(n.onAccount), free: n.free })),
      notes,
      reservations: rows.map(r => ({
        ...r,
        amount: cents(r.amount),
        direction: r.fromAccountId === r.toAccountId ? 'own' : r.fromAccountId === v.account.id ? 'out' : 'in',
        // still reserved, but the credit note has less on account in DEAR than was reserved
        stale: r.status === 'reserved' && !!r.creditNo && onAccountOf.has(String(r.creditNo).toUpperCase())
          && (onAccountOf.get(String(r.creditNo).toUpperCase()) ?? 0) < r.amount - 0.005,
      })),
    });
  } catch (e) {
    console.error('credit account failed', e);
    res.status(500).json({ error: (e as Error).message });
  }
});

// ---------- POST /credit/account/:id/reserve ----------
// One credit note:      { name?, amount, creditNo?, orderNo?, note? }
// One prepayment:       { name?, amount?, prepaidOrder: "SQ37327", orderNo?, note? }
// Several at once:      { name?, orderNo?, note?, items: [{ creditNo | prepaidOrder, amount? }, ...] }
// The money comes from THIS customer: a credit note, or a prepayment held on any of their orders except one that
// is complete in full (a prepayment on an open order is checked against DEAR first). It can be set aside for this customer's next order or for a specific
// order of theirs, never for a different customer. One reservation is made per source, so each is marked used
// by itself (credit notes: when DEAR shows them applied; prepayments: by hand), and all are made or none.
creditRouter.post('/account/:id/reserve', async (req, res) => {
  try {
    const v = await visibleAccount(req.rep!, req.params.id);
    if ('error' in v) { const d = denied(v.error!); return res.status(d.status).json(d.body); }

    // Credit stays with the customer it belongs to: it can be set aside for a different ORDER of theirs,
    // never for a different customer.
    const target = { id: v.account.id, name: v.account.name };
    const toId = typeof req.body?.toAccountId === 'string' ? req.body.toAccountId.trim() : '';
    if (toId && toId !== v.account.id) return res.status(400).json({ error: 'Credit can only be reserved for the customer it belongs to, not for a different customer' });

    const orderText = String(req.body?.orderNo ?? '').trim().toUpperCase();
    if (orderText && !/^SQ\d{3,}$/.test(orderText)) return res.status(400).json({ error: 'Enter the sales order or quote number like SQ37512, or leave it blank for their next order' });
    const orderNo = orderText || null;
    const name = String(req.body?.name ?? '').trim().slice(0, 120) || target.name;
    const text = typeof req.body?.note === 'string' && req.body.note.trim() ? req.body.note.trim().slice(0, 1000) : null;

    const many = Array.isArray(req.body?.items);
    const rawItems: { creditNo?: unknown; prepaidOrder?: unknown; amount?: unknown }[] = many ? req.body.items : [{ creditNo: req.body?.creditNo, prepaidOrder: req.body?.prepaidOrder, amount: req.body?.amount }];
    if (many && !rawItems.length) return res.status(400).json({ error: 'Tick at least one credit note or prepayment' });
    if (rawItems.length > 25) return res.status(400).json({ error: 'That is too many at once' });

    const notes = await loadCreditNotes(req.rep!, {}, v.account.id);
    const allHeld = await loadHeld(req.rep!, {}, v.account.id);
    const prepaid = allHeld.filter(h => h.reservable);
    const seen = new Set<string>();
    const planned: { creditNo: string | null; amount: number; cn?: CreditNoteRow; pp?: HeldRow }[] = [];
    for (const it of rawItems) {
      const creditNo = String(it.creditNo ?? '').trim().toUpperCase().slice(0, 40);
      const ppNo = String(it.prepaidOrder ?? '').trim().toUpperCase().slice(0, 40);
      if (creditNo && ppNo) return res.status(400).json({ error: 'Choose a credit note or a prepayment for each, not both' });
      if (many && !creditNo && !ppNo) return res.status(400).json({ error: 'Each item needs a credit note or a prepayment' });
      const key = ppNo ? `PP:${ppNo}` : creditNo;
      if (key) {
        if (seen.has(key)) return res.status(400).json({ error: `${ppNo || creditNo} is listed twice` });
        seen.add(key);
      }
      const pp = ppNo ? prepaid.find(h => h.number.toUpperCase() === ppNo) : undefined;
      if (ppNo && !pp) {
        const held = allHeld.find(h => h.number.toUpperCase() === ppNo && h.kind === 'Prepayment');
        return res.status(400).json({ error: held?.completeInFull ? `${ppNo} is complete in full, so its prepaid money was used by that order and can't be reserved` : `${ppNo} has no prepaid money held for this customer` });
      }
      const cn = creditNo ? notes.find(n => n.creditNo.toUpperCase() === creditNo) : undefined;
      // A number that looks like a credit note must be one of this customer's.
      if (creditNo && !cn && /^CR\d+$/.test(creditNo)) return res.status(400).json({ error: `${creditNo} isn't a credit note on this account` });

      const source = pp ?? cn;
      const given = it.amount;
      let amount = given === undefined || given === null || given === '' ? (source ? source.free : NaN) : Number(given);
      if (!Number.isFinite(amount)) return res.status(400).json({ error: 'Enter the amount' });
      amount = cents(amount);
      if (amount <= 0.005) return res.status(400).json({ error: 'Enter an amount above zero' });
      planned.push({ creditNo: creditNo || null, amount, cn, pp });
    }

    // Credit notes (and manual amounts) come out of the credit notes; each prepayment out of its own order.
    const reservedNotes = await reservedFrom(v.account.id, 'notes');
    const free = cents(Math.max(0, notesTotal(notes) - reservedNotes));
    const noteAmount = cents(planned.filter(p => !p.pp).reduce((t, p) => t + p.amount, 0));
    if (noteAmount > free + 0.005) return res.status(400).json({ error: `Only ${free.toFixed(2)} of this customer's credit is free to reserve` });
    for (const p of planned) {
      if (p.cn && p.amount > p.cn.free + 0.005) return res.status(400).json({ error: `${p.cn.creditNo} has only ${p.cn.free.toFixed(2)} left to reserve` });
      if (p.pp && p.amount > p.pp.free + 0.005) return res.status(400).json({ error: `${p.pp.number} has only ${p.pp.free.toFixed(2)} of prepaid money left to reserve` });
    }

    // Money on an open order is checked against DEAR itself, so the CRM never sets aside more than DEAR holds.
    // (Money on a credited, closed or voided order has no order left to use it, so it is not asked about.)
    for (const p of planned) {
      if (!p.pp || isFinished(p.pp.status)) continue;
      const live = await liveDear(p.pp.dearSaleId);
      if (!live.ok) {
        if (p.pp.releaseNote?.includes(NO_CHECK)) continue;   // it was released on the person's word, DEAR could not be asked
        return res.status(502).json({ error: `Couldn't confirm ${p.pp.number} with DEAR: ${live.reason}. Try again in a minute.` });
      }
      if (p.amount + p.pp.reserved > live.data.held + 0.005) {
        return res.status(400).json({ error: `DEAR shows ${live.data.held.toFixed(2)} still held on ${p.pp.number}${p.pp.reserved > 0.005 ? `, and ${p.pp.reserved.toFixed(2)} of it is already reserved` : ''}` });
      }
    }

    // If the order is already in the CRM it must belong to who this is for, and not be voided.
    const order = orderNo ? await prisma.quote.findFirst({ where: { number: orderNo }, select: { accountId: true, fulfillmentStatus: true } }) : null;
    if (order && order.accountId !== target.id) return res.status(400).json({ error: `${orderNo} belongs to a different customer` });
    if (order && (order.fulfillmentStatus ?? '').toUpperCase() === 'VOIDED') return res.status(400).json({ error: `${orderNo} is voided` });

    // One statement, so all of them are made or none.
    const tuples = planned.map(p => Prisma.sql`(${v.account.id}::uuid, ${target.id}::uuid, ${p.amount}, ${orderNo}, ${p.creditNo}, ${p.pp ? 'prepayment' : 'credit_note'}, ${p.pp ? p.pp.number : null}, ${name}, ${text}, ${req.rep!.id}::uuid)`);
    const made = await prisma.$queryRaw<{ id: string }[]>`
      insert into crm.credit_reservations (from_account_id, to_account_id, amount, order_ref, credit_no, source_kind, source_order, name, note, created_by)
      values ${Prisma.join(tuples)}
      returning id`;
    await reconcile();   // DEAR may already show a credit note applied
    res.status(201).json({ id: made[0].id, ids: made.map(m => m.id), count: made.length, total: cents(planned.reduce((t, p) => t + p.amount, 0)) });
  } catch (e) {
    console.error('credit reserve failed', e);
    res.status(500).json({ error: (e as Error).message });
  }
});

// ---------- Live payment info from DEAR ----------
const NO_CHECK = 'released without a live DEAR check';
type Live = { ok: true; data: DearPayments } | { ok: false; reason: string };
async function liveDear(dearSaleId: string | null): Promise<Live> {
  if (!dearSaleId) return { ok: false, reason: 'this order is not linked to DEAR yet' };
  if (!process.env.CIN7_ACCOUNT_ID || !process.env.CIN7_APPLICATION_KEY) return { ok: false, reason: 'the DEAR keys are not set on the API (CIN7_ACCOUNT_ID and CIN7_APPLICATION_KEY)' };
  try {
    const data = readDearPayments(await dearGet('/sale', { ID: dearSaleId }));
    if (!data.prepayments.length && !data.invoices.length) return { ok: false, reason: 'DEAR answered, but no prepayments or invoices were found on the order in the shape expected' };
    return { ok: true, data };
  } catch (e) { return { ok: false, reason: (e as Error).message.slice(0, 200) }; }
}

// One of this person's visible orders, by number.
async function visibleOrder(rep: Rep, raw: unknown) {
  const no = String(raw ?? '').trim().toUpperCase();
  if (!/^SQ\d{3,}$/.test(no)) return { error: 400 as const, message: 'Enter an order number like SQ36807' };
  const q = await prisma.quote.findFirst({ where: { number: no }, select: { id: true, number: true, accountId: true, fulfillmentStatus: true, dearSaleId: true } });
  if (!q) return { error: 404 as const, message: `${no} isn't in the CRM` };
  const v = await visibleAccount(rep, q.accountId);
  if ('error' in v) return { error: v.error!, message: denied(v.error!).body.error };
  return { q, no };
}
const prepaymentOn = async (rep: Rep, accountId: string, no: string) =>
  (await loadHeld(rep, {}, accountId)).find(h => h.number.toUpperCase() === no && h.kind === 'Prepayment');

// ---------- GET /credit/order-dear/:no ----------
// What DEAR says about an order's money, next to what the CRM holds. Asks DEAR live.
creditRouter.get('/order-dear/:no', async (req, res) => {
  try {
    const o = await visibleOrder(req.rep!, req.params.no);
    if (o.error) return res.status(o.error).json({ error: o.message });
    const row = await prepaymentOn(req.rep!, o.q.accountId, o.no);
    const live = await liveDear(o.q.dearSaleId);
    const crmHeld = row?.amount ?? 0;
    res.json({
      order: o.no, status: o.q.fulfillmentStatus, crmHeld, crmReserved: row?.reserved ?? 0, released: row?.released ?? false, releaseNote: row?.releaseNote ?? null,
      live: live.ok ? live.data : null, problem: live.ok ? null : live.reason,
      matches: live.ok ? Math.abs(live.data.held - crmHeld) < 0.02 : null,
    });
  } catch (e) {
    console.error('credit dear check failed', e);
    res.status(500).json({ error: (e as Error).message });
  }
});

// ---------- POST /credit/release-order  { orderNo, note, confirmedInDear? } ----------
// The customer no longer wants this open order (for example they have dropped a backorder), so its prepayment is
// moved to "To apply in DEAR" (apply or refund). It can be reserved with or without this. DEAR is asked first: if it holds less than the CRM shows, nothing is released. If DEAR
// can't be asked, the person can confirm they have looked in DEAR themselves.
// The backordered lines must also be cancelled in DEAR, or the stock may still ship and use this money.
creditRouter.post('/release-order', async (req, res) => {
  try {
    const o = await visibleOrder(req.rep!, req.body?.orderNo);
    if (o.error) return res.status(o.error).json({ error: o.message });
    const note = String(req.body?.note ?? '').trim().slice(0, 500);
    if (note.length < 3) return res.status(400).json({ error: 'Say why, for example: customer cancelled the backorder' });
    const row = await prepaymentOn(req.rep!, o.q.accountId, o.no);
    if (!row) return res.status(400).json({ error: `${o.no} has no prepayment held on it` });
    if (row.finished) return res.status(400).json({ error: `${o.no} is already ${row.released ? 'released' : 'finished or cancelled'}` });

    const live = await liveDear(o.q.dearSaleId);
    if (!live.ok && req.body?.confirmedInDear !== true) return res.status(409).json({ error: `Couldn't confirm with DEAR: ${live.reason}` });
    if (live.ok && live.data.held + 0.02 < row.amount) {
      return res.status(409).json({ error: `DEAR shows only ${live.data.held.toFixed(2)} held on ${o.no}, but the CRM shows ${row.amount.toFixed(2)}. Check the order in DEAR first.` });
    }
    const stamp = live.ok ? `${note} (DEAR shows ${live.data.held.toFixed(2)} held)` : `${note} (${NO_CHECK})`;
    await prisma.$executeRaw`update crm.quotes set prepay_released_at = now(), prepay_released_by = ${req.rep!.id}::uuid, prepay_release_note = ${stamp} where id = ${o.q.id}::uuid`;
    res.json({ ok: true, order: o.no, amount: row.amount, checkedInDear: live.ok });
  } catch (e) {
    console.error('credit release failed', e);
    res.status(500).json({ error: (e as Error).message });
  }
});

// ---------- POST /credit/unrelease-order  { orderNo } ----------
// Puts the money back with the order. Not while some of it is still reserved.
creditRouter.post('/unrelease-order', async (req, res) => {
  try {
    const o = await visibleOrder(req.rep!, req.body?.orderNo);
    if (o.error) return res.status(o.error).json({ error: o.message });
    const [r] = await prisma.$queryRaw<{ n: number }[]>`
      select count(*)::int as n from crm.credit_reservations where source_kind = 'prepayment' and source_order = ${o.no} and status = 'reserved'`;
    if (r.n > 0) return res.status(400).json({ error: `Release the ${r.n} open reservation${r.n === 1 ? '' : 's'} from ${o.no} first` });
    await prisma.$executeRaw`update crm.quotes set prepay_released_at = null, prepay_released_by = null, prepay_release_note = null where id = ${o.q.id}::uuid`;
    res.json({ ok: true });
  } catch (e) {
    console.error('credit unrelease failed', e);
    res.status(500).json({ error: (e as Error).message });
  }
});

// ---------- GET /credit/account/:id/order/:no ----------
// What an order is worth and what is still to pay, so the reserve form can show how the credit
// being set aside lines up with the order. { found: false } if it isn't in the CRM (yet).
creditRouter.get('/account/:id/order/:no', async (req, res) => {
  try {
    const v = await visibleAccount(req.rep!, req.params.id);
    if ('error' in v) { const d = denied(v.error!); return res.status(d.status).json(d.body); }
    const no = String(req.params.no ?? '').trim().toUpperCase();
    if (!/^SQ\d{3,}$/.test(no)) return res.status(400).json({ error: 'Enter an order number like SQ37512' });
    const q = await prisma.quote.findFirst({
      where: { number: no },
      select: { accountId: true, fulfillmentStatus: true, total: true, amount: true, amountDue: true, amountPaid: true },
    });
    if (!q) return res.json({ found: false, number: no });
    if (q.accountId !== v.account.id) return res.status(400).json({ error: `${no} belongs to a different customer` });
    const total = cents(q.total ?? q.amount ?? 0);
    const toPay = cents(q.amountDue != null ? Math.max(0, q.amountDue) : Math.max(0, total - (q.amountPaid ?? 0)));
    res.json({ found: true, number: no, status: q.fulfillmentStatus ?? '', total, toPay });
  } catch (e) {
    console.error('credit order lookup failed', e);
    res.status(500).json({ error: (e as Error).message });
  }
});

// ---------- PATCH /credit/reservations/:id ----------
// { status: 'cancelled' | 'used' }. Cancelled releases the credit. 'used' is only needed
// when there is no credit note number to match; otherwise the sync marks it by itself.
creditRouter.patch('/reservations/:id', async (req, res) => {
  try {
    const status = req.body?.status;
    if (status !== 'used' && status !== 'cancelled') return res.status(400).json({ error: 'Status must be used or cancelled' });

    const [r] = await prisma.$queryRaw<{ id: string; from_account_id: string; to_account_id: string; status: string }[]>`
      select id, from_account_id, to_account_id, status from crm.credit_reservations where id = ${req.params.id}::uuid`;
    if (!r) return res.status(404).json({ error: 'Reservation not found' });
    if (r.status !== 'reserved') return res.status(400).json({ error: 'This reservation is already closed' });

    const from = await visibleAccount(req.rep!, r.from_account_id);
    const to = await visibleAccount(req.rep!, r.to_account_id);
    if ('error' in from && 'error' in to) return res.status(403).json({ error: 'Neither account is in your states' });

    await prisma.$executeRaw`
      update crm.credit_reservations
      set status = ${status}, resolved_by = ${req.rep!.id}::uuid, resolved_at = now()
      where id = ${r.id}::uuid and status = 'reserved'`;
    res.json({ ok: true });
  } catch (e) {
    console.error('credit update failed', e);
    res.status(500).json({ error: (e as Error).message });
  }
});

// ---------- GET /credit/notes ----------   (the Credit page)
// ?region=NSW,ACT &q= &status=open|reserved|used
// The tiles are worked out from the same credit notes the table lists, whatever status the
// table is showing, so the figures always add up to what you can see.
creditRouter.get('/notes', async (req, res) => {
  try {
    await reconcile();
    const regions = regionsParam(req.query.region);
    const q = String(req.query.q ?? '').trim() || undefined;
    const status = String(req.query.status ?? '');
    const all = await loadCreditNotes(req.rep!, { regions, q });

    const rows = all.filter(r =>
      status === 'open' ? r.free > 0.005
      : status === 'reserved' ? r.reservedAmount > 0.005
      : status === 'used' ? r.onAccount <= 0.005
      : true);

    // Credit notes on account, and what has been reserved, per customer.
    const open = all.filter(r => r.onAccount > 0.005);
    const onAccountBy = new Map<string, number>();
    for (const r of open) onAccountBy.set(r.accountId, (onAccountBy.get(r.accountId) ?? 0) + r.onAccount);
    const reservedBy = new Map<string, number>();
    for (const r of (await loadReservations(req.rep!, { regions, q, status: 'reserved' })).filter(x => x.sourceKind !== 'prepayment')) reservedBy.set(r.accountId, (reservedBy.get(r.accountId) ?? 0) + r.amount);
    const onAccount = cents([...onAccountBy.values()].reduce((t, n) => t + n, 0));
    const reserved = cents([...reservedBy.values()].reduce((t, n) => t + n, 0));
    const free = cents([...onAccountBy].reduce((t, [id, n]) => t + Math.max(0, n - (reservedBy.get(id) ?? 0)), 0));

    // Money held on orders that is not a credit note (prepayments not yet applied, overpaid
    // orders): not counted above. The same rows as the Prepayments tab.
    const held = await loadHeld(req.rep!, { regions, q });
    const heldOnOrdersTotal = heldTotal(held);
    const toApply = heldTotal(held.filter(h => h.finished));
    const prepaidFree = cents(held.reduce((t, h) => t + h.free, 0));   // prepaid money that can be reserved (any order not complete in full)

    res.json({
      totals: { onAccount, reserved, free, openNotes: open.length, customers: onAccountBy.size, heldOnOrders: heldOnOrdersTotal, toApply, prepaidFree },
      rows,
    });
  } catch (e) {
    console.error('credit notes failed', e);
    res.status(500).json({ error: (e as Error).message });
  }
});

// ---------- GET /credit/prepayments ----------   (the Credit page: Prepayments tab)
// ?region= &q= &view=free|apply|open|all   free = prepaid money that can be reserved right now (any order that is
// not complete in full), apply = finished or cancelled orders still holding money (to apply in DEAR or refund),
// open = held for orders not yet invoiced. The totals ignore the view.
creditRouter.get('/prepayments', async (req, res) => {
  try {
    const all = await loadHeld(req.rep!, { regions: regionsParam(req.query.region), q: String(req.query.q ?? '').trim() || undefined });
    const view = String(req.query.view ?? 'all');
    const apply = all.filter(r => r.finished), open = all.filter(r => !r.finished), free = all.filter(r => r.free > 0.005);
    res.json({
      totals: {
        free: { amount: cents(free.reduce((t, r) => t + r.free, 0)), count: free.length },
        toApply: { amount: heldTotal(apply), count: apply.length },
        open: { amount: heldTotal(open), count: open.length },
        all: { amount: heldTotal(all), count: all.length },
      },
      rows: view === 'free' ? free : view === 'apply' ? apply : view === 'open' ? open : all,
    });
  } catch (e) {
    console.error('credit prepayments failed', e);
    res.status(500).json({ error: (e as Error).message });
  }
});

// ---------- GET /credit/reservations ----------   (the Credit page: one row per reservation)
// ?region= &q= &status=reserved|used|cancelled
creditRouter.get('/reservations', async (req, res) => {
  try {
    await reconcile();
    const rows = await loadReservations(req.rep!, {
      regions: regionsParam(req.query.region), q: String(req.query.q ?? '').trim() || undefined, status: String(req.query.status ?? '') || undefined,
    });
    res.json({ rows });
  } catch (e) {
    console.error('credit reservations failed', e);
    res.status(500).json({ error: (e as Error).message });
  }
});

// ---------- GET /credit/movements ----------
// ?region= &q= &type= &from=YYYY-MM-DD &to= &limit= &offset=
creditRouter.get('/movements', async (req, res) => {
  try {
    await reconcile();
    const date = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
    const out = await loadMovements(req.rep!, {
      regions: regionsParam(req.query.region), q: String(req.query.q ?? '').trim() || undefined, type: String(req.query.type ?? '') || undefined,
      from: date(req.query.from), to: date(req.query.to),
      limit: Number(req.query.limit) || 100, offset: Number(req.query.offset) || 0,
    });
    res.json({ ...out, types: TYPES });
  } catch (e) {
    console.error('credit movements failed', e);
    res.status(500).json({ error: (e as Error).message });
  }
});