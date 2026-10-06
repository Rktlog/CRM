import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { canSeeAccount } from '../lib/territory';

// Credit reservations: the team's plan for a customer's credit, for their
// own next order or for another customer, shown on both accounts. The CRM
// only records the plan; the credit itself is applied in DEAR by the
// accounts team, after which the reservation is marked "used".

export const creditRouter = Router();

const cents = (n: number) => Math.round(n * 100) / 100;

// Credit the customer has in DEAR right now: unused credit notes and
// unapplied prepayments, plus overpaid orders (balance below zero).
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

async function visibleAccount(rep: { id: string; role: string }, id: string) {
  const account = await prisma.account.findUnique({ where: { id }, select: { id: true, name: true, repId: true, region: true } });
  if (!account) return { error: 404 as const };
  if (!(await canSeeAccount(rep as any, account))) return { error: 403 as const };
  return { account };
}

// ---------- GET /credit/account/:id ----------
// Credit in DEAR, what's reserved, what's free, and every reservation
// involving this account (giving or receiving).
creditRouter.get('/account/:id', async (req, res) => {
  const v = await visibleAccount(req.rep!, req.params.id);
  if ('error' in v) return res.status(v.error!).json({ error: v.error === 404 ? 'Account not found' : 'This account is outside your states' });

  const [credit, reserved] = await Promise.all([creditInDear(v.account.id), reservedFrom(v.account.id)]);
  const rows = await prisma.$queryRaw<any[]>`
    select c.id, c.amount, c.order_ref as "orderRef", c.note, c.status,
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

  const incoming = cents(rows
    .filter(r => r.status === 'reserved' && r.toAccountId === v.account.id && r.fromAccountId !== v.account.id)
    .reduce((s, r) => s + r.amount, 0));

  res.json({
    creditInDear: credit,
    reserved,
    available: cents(Math.max(0, credit - reserved)),
    incoming,
    // DEAR's credit dropped below what's reserved (applied differently in DEAR?).
    overReserved: reserved > credit + 0.005,
    reservations: rows.map(r => ({
      ...r,
      amount: cents(r.amount),
      direction: r.fromAccountId === r.toAccountId ? 'own' : r.fromAccountId === v.account.id ? 'out' : 'in',
    })),
  });
});

// ---------- POST /credit/account/:id/reserve ----------
// { amount, toAccountId?, orderRef?, note? }. toAccountId defaults to this
// account (its own next order). Can't reserve more than is free.
creditRouter.post('/account/:id/reserve', async (req, res) => {
  const v = await visibleAccount(req.rep!, req.params.id);
  if ('error' in v) return res.status(v.error!).json({ error: v.error === 404 ? 'Account not found' : 'This account is outside your states' });

  const amount = cents(Number(req.body?.amount));
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Enter an amount above $0' });

  const toId = typeof req.body?.toAccountId === 'string' && req.body.toAccountId ? req.body.toAccountId : v.account.id;
  const to = await prisma.account.findUnique({ where: { id: toId }, select: { id: true, name: true } });
  if (!to) return res.status(400).json({ error: 'Customer to give the credit to not found' });

  const available = cents((await creditInDear(v.account.id)) - (await reservedFrom(v.account.id)));
  if (amount > available + 0.005) {
    return res.status(400).json({ error: `Only $${Math.max(0, available).toFixed(2)} of credit is free to reserve` });
  }

  const orderRef = typeof req.body?.orderRef === 'string' && req.body.orderRef.trim() ? req.body.orderRef.trim().slice(0, 200) : null;
  const note = typeof req.body?.note === 'string' && req.body.note.trim() ? req.body.note.trim().slice(0, 1000) : null;
  const [row] = await prisma.$queryRaw<{ id: string }[]>`
    insert into crm.credit_reservations (from_account_id, to_account_id, amount, order_ref, note, created_by)
    values (${v.account.id}::uuid, ${to.id}::uuid, ${amount}, ${orderRef}, ${note}, ${req.rep!.id}::uuid)
    returning id`;
  res.status(201).json({ id: row.id });
});

// ---------- PATCH /credit/reservations/:id ----------
// { status: 'used' | 'cancelled' }. Used = applied in DEAR. Cancelled =
// reversed, so the credit is free again. Either account's team can do it.
creditRouter.patch('/reservations/:id', async (req, res) => {
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
});