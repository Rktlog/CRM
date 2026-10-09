import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { canSeeAccount, territoryWhere } from '../lib/territory';

// Credit.
//   - Reservations: the team sets a customer's credit note aside for an order
//     (credit note no + order / sales quote no). Nobody has to mark it used: the
//     sync reads DEAR and, once DEAR shows that credit applied to that order,
//     marks it used by itself.
//   - The Credit page: every credit note on account, and every credit movement
//     (issued, applied, refunded, reserved, used, released).
// The credit itself is always applied in DEAR; the CRM only records the plan.

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

// ---------- Credit notes on account ----------
const NOTES_FROM = Prisma.sql`
  from crm.quotes q
  join crm.accounts a on a.id = q.account_id
  left join crm.reps rp on rp.id = a.rep_id
  cross join lateral jsonb_array_elements(q.credit_notes) c
  left join lateral (
    select id, order_ref from crm.credit_reservations
    where credit_no = c->>'number' and status = 'reserved' order by created_at desc limit 1
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
    w.push(Prisma.sql`(a.name ilike ${like} or c->>'number' ilike ${like} or q.number ilike ${like} or r.order_ref ilike ${like})`);
  }
  if (f.status === 'open') w.push(Prisma.sql`coalesce((c->>'onAccount')::float8, 0) > 0.005 and r.id is null`);
  if (f.status === 'reserved') w.push(Prisma.sql`r.id is not null`);
  if (f.status === 'used') w.push(Prisma.sql`coalesce((c->>'onAccount')::float8, 0) <= 0.005`);
  return Prisma.join(w, ' and ');
}

export type CreditNoteRow = {
  accountId: string; account: string; region: string; rep: string | null; orderNo: string; creditNo: string; date: string | null;
  total: number; applied: number; refunded: number; onAccount: number; reservationId: string | null; reservedFor: string | null;
};

export async function loadCreditNotes(rep: Rep, f: CreditFilters, accountId?: string): Promise<CreditNoteRow[]> {
  const ids = await scopeIds(rep);
  const rows = await prisma.$queryRaw<CreditNoteRow[]>`
    select a.id as "accountId", a.name as "account", a.region as "region", rp.name as "rep",
           q.number as "orderNo", c->>'number' as "creditNo", c->>'date' as "date",
           coalesce((c->>'total')::float8, 0) as "total", coalesce((c->>'applied')::float8, 0) as "applied",
           coalesce((c->>'refunded')::float8, 0) as "refunded", coalesce((c->>'onAccount')::float8, 0) as "onAccount",
           r.id as "reservationId", r.order_ref as "reservedFor"
    ${NOTES_FROM}
    where ${notesWhere(ids, f, accountId)}
    order by (coalesce((c->>'onAccount')::float8, 0) > 0.005) desc, c->>'date' desc nulls last, c->>'number' desc
    limit 5000`;
  return rows.map(r => ({ ...r, date: r.date ? String(r.date).slice(0, 10) : null }));
}

// ---------- Movements ----------
export type MovementRow = {
  date: string | null; type: string; accountId: string; account: string; region: string; rep: string | null;
  creditNo: string | null; reference: string | null; amount: number; by: string | null;
};
const TYPES = ['Credit note issued', 'Applied to invoice', 'Refunded to customer', 'Reserved', 'Used', 'Released'];

export async function loadMovements(rep: Rep, f: CreditFilters): Promise<{ rows: MovementRow[]; total: number }> {
  const ids = await scopeIds(rep);
  const scope: Prisma.Sql[] = [];
  if (ids) scope.push(Prisma.sql`a.id = any(${ids}::uuid[])`);
  if (f.regions?.length) scope.push(Prisma.sql`a.region = any(${f.regions})`);
  const scopeSql = scope.length ? Prisma.join(scope, ' and ') : Prisma.sql`true`;

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
      union all
      select r.created_at::date, 'Reserved', a.id, a.name, a.region, rp.name,
             r.credit_no, r.order_ref, r.amount, cb.name
      from crm.credit_reservations r
      join crm.accounts a on a.id = r.from_account_id
      left join crm.reps rp on rp.id = a.rep_id
      left join crm.reps cb on cb.id = r.created_by
      where ${scopeSql}
      union all
      select r.resolved_at::date, case when r.status = 'used' then 'Used' else 'Released' end, a.id, a.name, a.region, rp.name,
             r.credit_no, r.order_ref, r.amount, coalesce(rb.name, case when r.status = 'used' then 'Found in DEAR' else null end)
      from crm.credit_reservations r
      join crm.accounts a on a.id = r.from_account_id
      left join crm.reps rp on rp.id = a.rep_id
      left join crm.reps rb on rb.id = r.resolved_by
      where r.status in ('used', 'cancelled') and r.resolved_at is not null and ${scopeSql}
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

// ---------- Credit in DEAR for one account (unused credit notes, unapplied prepayments, overpayments) ----------
async function creditInDear(accountId: string): Promise<number> {
  const [r] = await prisma.$queryRaw<{ credit: number }[]>`
    select (coalesce(sum(case when unapplied_credit > 0 then unapplied_credit else 0 end), 0)
          + coalesce(sum(case when amount_due < 0 then -amount_due else 0 end), 0))::float8 as credit
    from crm.quotes
    where account_id = ${accountId}::uuid and source <> 'rhino-history' and number not like 'Q%'`;
  return cents(r?.credit ?? 0);
}

async function reservedFrom(accountId: string): Promise<number> {
  const [r] = await prisma.$queryRaw<{ total: number }[]>`
    select coalesce(sum(amount), 0)::float8 as total
    from crm.credit_reservations where from_account_id = ${accountId}::uuid and status = 'reserved'`;
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
// Credit in DEAR, what's reserved, the account's credit notes, and its reservations.
creditRouter.get('/account/:id', async (req, res) => {
  try {
    const v = await visibleAccount(req.rep!, req.params.id);
    if ('error' in v) { const d = denied(v.error!); return res.status(d.status).json(d.body); }
    await reconcile();

    const [credit, reserved, notes] = await Promise.all([creditInDear(v.account.id), reservedFrom(v.account.id), loadCreditNotes(req.rep!, {}, v.account.id)]);
    const rows = await prisma.$queryRaw<any[]>`
      select c.id, c.amount, c.order_ref as "orderRef", c.credit_no as "creditNo", c.note, c.status,
             c.created_at as "createdAt", c.resolved_at as "resolvedAt",
             c.from_account_id as "fromAccountId", fa.name as "fromName",
             c.to_account_id as "toAccountId", ta.name as "toName",
             cr.name as "createdBy", rr.name as "resolvedBy"
      from crm.credit_reservations c
      join crm.accounts fa on fa.id = c.from_account_id
      join crm.accounts ta on ta.id = c.to_account_id
      left join crm.reps cr on cr.id = c.created_by
      left join crm.reps rr on rr.id = c.resolved_by
      where c.from_account_id = ${v.account.id}::uuid or c.to_account_id = ${v.account.id}::uuid
      order by (c.status = 'reserved') desc, c.created_at desc
      limit 50`;

    const onAccountOf = new Map(notes.map(n => [n.creditNo, n.onAccount]));
    res.json({
      creditInDear: credit,
      reserved,
      available: cents(Math.max(0, credit - reserved)),
      // credit notes with credit still on account and not yet reserved: what can be reserved
      reservable: notes.filter(n => n.onAccount > 0.005 && !n.reservationId)
        .map(n => ({ creditNo: n.creditNo, date: n.date, onAccount: cents(n.onAccount) })),
      notes: notes.map(n => ({ ...n, onAccount: cents(n.onAccount), total: cents(n.total) })),
      reservations: rows.map(r => ({
        ...r,
        amount: cents(r.amount),
        direction: r.fromAccountId === r.toAccountId ? 'own' : r.fromAccountId === v.account.id ? 'out' : 'in',
        // reserved, but the credit note has since changed in DEAR (applied elsewhere, refunded)
        stale: r.status === 'reserved' && r.creditNo != null && (onAccountOf.get(r.creditNo) ?? 0) < r.amount - 0.005,
      })),
    });
  } catch (e) {
    console.error('credit account failed', e);
    res.status(500).json({ error: (e as Error).message });
  }
});

// ---------- POST /credit/account/:id/reserve ----------
// { creditNo, orderNo, note? }: set a credit note aside for an order or sales quote.
// Only this customer's own credit, for their own order.
creditRouter.post('/account/:id/reserve', async (req, res) => {
  try {
    const v = await visibleAccount(req.rep!, req.params.id);
    if ('error' in v) { const d = denied(v.error!); return res.status(d.status).json(d.body); }

    const creditNo = String(req.body?.creditNo ?? '').trim().toUpperCase();
    const orderNo = String(req.body?.orderNo ?? '').trim().toUpperCase();
    if (!creditNo) return res.status(400).json({ error: 'Choose the credit note' });
    if (!/^SQ\d{3,}$/.test(orderNo)) return res.status(400).json({ error: 'Enter the order or sales quote number, like SQ37512' });

    const note = (await loadCreditNotes(req.rep!, {}, v.account.id)).find(n => n.creditNo.toUpperCase() === creditNo);
    if (!note) return res.status(400).json({ error: `${creditNo} isn't a credit note on this account` });
    if (note.onAccount <= 0.005) return res.status(400).json({ error: `${creditNo} has no credit left on account` });
    if (note.reservationId) return res.status(400).json({ error: `${creditNo} is already reserved for ${note.reservedFor}` });

    // If the order is already in the CRM it must be this customer's, and not voided.
    const order = await prisma.quote.findFirst({ where: { number: orderNo }, select: { accountId: true, fulfillmentStatus: true } });
    if (order && order.accountId !== v.account.id) return res.status(400).json({ error: `${orderNo} belongs to a different customer` });
    if (order && (order.fulfillmentStatus ?? '').toUpperCase() === 'VOIDED') return res.status(400).json({ error: `${orderNo} is voided` });

    const text = typeof req.body?.note === 'string' && req.body.note.trim() ? req.body.note.trim().slice(0, 1000) : null;
    const [row] = await prisma.$queryRaw<{ id: string }[]>`
      insert into crm.credit_reservations (from_account_id, to_account_id, amount, order_ref, credit_no, note, created_by)
      values (${v.account.id}::uuid, ${v.account.id}::uuid, ${note.onAccount}, ${orderNo}, ${note.creditNo}, ${text}, ${req.rep!.id}::uuid)
      returning id`;
    await reconcile();   // the order may already show the credit applied
    res.status(201).json({ id: row.id });
  } catch (e) {
    console.error('credit reserve failed', e);
    res.status(500).json({ error: (e as Error).message });
  }
});

// ---------- PATCH /credit/reservations/:id ----------
// { status: 'cancelled' | 'used' }. Cancelled releases the credit. 'used' is only
// needed if DEAR can't show it; normally the sync marks it by itself.
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
creditRouter.get('/notes', async (req, res) => {
  try {
    await reconcile();
    const rows = await loadCreditNotes(req.rep!, { regions: regionsParam(req.query.region), q: String(req.query.q ?? '').trim() || undefined, status: String(req.query.status ?? '') });
    const open = rows.filter(r => r.onAccount > 0.005);
    const onAccount = cents(open.reduce((s, r) => s + r.onAccount, 0));
    const reserved = cents(open.filter(r => r.reservationId).reduce((s, r) => s + r.onAccount, 0));
    res.json({
      totals: { onAccount, reserved, free: cents(onAccount - reserved), openNotes: open.length, customers: new Set(open.map(r => r.accountId)).size },
      rows,
    });
  } catch (e) {
    console.error('credit notes failed', e);
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