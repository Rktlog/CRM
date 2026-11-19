import { Router } from 'express';
import * as XLSX from 'xlsx';
import { prisma } from '../lib/prisma';
import { canSeeAccount, assignedRegions, hiddenAccountIds } from '../lib/territory';

// Promos: the list of promos the sales team gives (managers set it up). A promo is given to a customer on the customer's page, and from there allocated to
// that customer's orders (SQ numbers). For each promo: every order that used it, and every customer it was given to.
//   GET  /promos                                every promo with how many orders and units redeemed it, and how many customers were given it
//   POST /promos                                { name, matchText?, startsOn?, endsOn? }   (managers)
//   POST /promos/:id                            { name?, matchText?, startsOn?, endsOn?, active? }   (managers)
//   POST /promos/:id/delete                     only while no order and no customer has it (managers); otherwise turn it off
//   GET  /promos/:id/orders                     the orders that redeemed it and the customers given it, with totals     GET /promos/:id/export  the orders as Excel
//   GET  /promos/order/:orderId                 the promos allocated to one order (read only: they are changed on the customer's page)
//   GET  /promos/account/:accountId             the customer's promos with their allocations, the customer's orders, and the promos still to give
//   POST /promos/account/:accountId             { promoId, qty|null }   give the promo to the customer, or change how many
//   POST /promos/account/:accountId/remove      { promoId }   take it back, only while nothing is allocated
//   POST /promos/account/:accountId/allocate    { promoId, orderId, qty }   allocate it to one of the customer's orders (or change the quantity)
//   POST /promos/account/:accountId/unallocate  { promoId, orderId }
export const promosRouter = Router();
const UUID = /^[0-9a-f-]{36}$/i;
const manager = (req: any) => req.rep?.role === 'manager';
const text = (v: unknown, max = 200) => String(v ?? '').trim().slice(0, max);
const day = (v: unknown): string | null => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const r2 = (n: number) => Math.round(n * 100) / 100;
const dup = (e: unknown) => /23505|duplicate key/i.test(String((e as any)?.message ?? e));

// Whoever can see the account can see (and change) its promos, the same rule as the order's log.
async function orderAccess(req: any, res: any, orderId: string): Promise<boolean> {
  if (!UUID.test(orderId)) { res.status(400).json({ error: 'Bad order' }); return false; }
  const [o] = await prisma.$queryRaw<any[]>`select q.id, a.id as "accountId", a.region, a.rep_id as "repId" from crm.quotes q join crm.accounts a on a.id = q.account_id where q.id = ${orderId}::uuid`;
  if (!o) { res.status(404).json({ error: 'Order not found' }); return false; }
  if (!(await canSeeAccount(req.rep!, { id: o.accountId, repId: o.repId, region: o.region } as any))) { res.status(403).json({ error: 'This order is outside your states' }); return false; }
  return true;
}

async function accountAccess(req: any, res: any, accountId: string): Promise<boolean> {
  if (!UUID.test(accountId)) { res.status(400).json({ error: 'Bad account' }); return false; }
  const [a] = await prisma.$queryRaw<any[]>`select id, region, rep_id as "repId" from crm.accounts where id = ${accountId}::uuid`;
  if (!a) { res.status(404).json({ error: 'Account not found' }); return false; }
  if (!(await canSeeAccount(req.rep!, { id: a.id, repId: a.repId, region: a.region } as any))) { res.status(403).json({ error: 'This account is outside your states' }); return false; }
  return true;
}

// The quantity given to a customer: a whole number from 1 to 9999, or nothing for "no set number".
function givenQty(v: unknown): number | null | undefined {
  if (v === null || v === undefined || v === '') return null;
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 1 && n <= 9999 ? n : undefined;
}

promosRouter.get('/', async (_req, res) => {
  const rows = await prisma.$queryRaw<any[]>`
    select p.id::text as id, p.name, p.match_text as "matchText", p.starts_on::text as "startsOn", p.ends_on::text as "endsOn", p.active,
           count(o.id)::int as orders, coalesce(sum(o.qty), 0)::int as units,
           (select count(*) from crm.account_promos g where g.promo_id = p.id)::int as customers
    from crm.promos p left join crm.order_promos o on o.promo_id = p.id
    group by p.id order by p.active desc, coalesce(p.starts_on, p.created_at::date) desc, p.name`;
  res.json({ promos: rows });
});

promosRouter.post('/', async (req, res) => {
  if (!manager(req)) return res.status(403).json({ error: 'Only managers set up promos.' });
  const name = text(req.body?.name, 120);
  if (!name) return res.status(400).json({ error: 'Give the promo a name.' });
  try {
    const [r] = await prisma.$queryRaw<any[]>`insert into crm.promos (name, match_text, starts_on, ends_on) values (${name}, ${text(req.body?.matchText, 120) || null}, ${day(req.body?.startsOn)}::date, ${day(req.body?.endsOn)}::date) returning id::text as id`;
    res.status(201).json({ id: r.id });
  } catch (e) { if (dup(e)) return res.status(409).json({ error: 'There is already a promo with that name.' }); throw e; }
});

// The fixed addresses go before /:id.
promosRouter.get('/order/:orderId', async (req, res) => {
  if (!(await orderAccess(req, res, req.params.orderId))) return;
  const rows = await prisma.$queryRaw<any[]>`
    select p.id::text as id, p.name, p.active, o.qty::int as qty
    from crm.order_promos o join crm.promos p on p.id = o.promo_id
    where o.quote_id = ${req.params.orderId}::uuid order by p.name`;
  res.json({ promos: rows });
});

// A promo shows on a customer's page once it was given to them, or once one of their orders used it (allocations from before promos lived on the customer).
promosRouter.get('/account/:accountId', async (req, res) => {
  const accountId = req.params.accountId;
  if (!(await accountAccess(req, res, accountId))) return;
  const [promos, orders, available] = await Promise.all([
    prisma.$queryRaw<any[]>`
      with alloc as (
        select o.promo_id, o.quote_id, o.qty, q.number, q.sent_at
        from crm.order_promos o join crm.quotes q on q.id = o.quote_id
        where q.account_id = ${accountId}::uuid)
      select p.id::text as id, p.name, p.active, p.starts_on::text as "startsOn", p.ends_on::text as "endsOn",
             (g.id is not null) as "isGiven", g.qty::int as given,
             coalesce((select json_agg(json_build_object(
                 'orderId', a.quote_id::text, 'number', a.number, 'qty', a.qty,
                 'date', (((a.sent_at at time zone 'UTC') at time zone 'Australia/Melbourne')::date)::text) order by a.sent_at desc, a.number desc)
               from alloc a where a.promo_id = p.id), '[]'::json) as allocations
      from crm.promos p left join crm.account_promos g on g.promo_id = p.id and g.account_id = ${accountId}::uuid
      where g.id is not null or exists (select 1 from alloc a where a.promo_id = p.id)
      order by p.active desc, p.name`,
    prisma.$queryRaw<any[]>`
      select id::text as id, number, (((sent_at at time zone 'UTC') at time zone 'Australia/Melbourne')::date)::text as date, coalesce(fulfillment_status, '') as status
      from crm.quotes
      where account_id = ${accountId}::uuid and source <> 'rhino-history' and number not like 'Q%'
      order by sent_at desc, number desc limit 100`,
    prisma.$queryRaw<any[]>`
      select p.id::text as id, p.name from crm.promos p
      where p.active
        and not exists (select 1 from crm.account_promos g where g.promo_id = p.id and g.account_id = ${accountId}::uuid)
        and not exists (select 1 from crm.order_promos o join crm.quotes q on q.id = o.quote_id where o.promo_id = p.id and q.account_id = ${accountId}::uuid)
      order by p.name`,
  ]);
  res.json({
    promos: promos.map(p => {
      const allocated = (p.allocations as { qty: number }[]).reduce((s, a) => s + Number(a.qty), 0);
      return { ...p, allocated, left: p.given == null ? null : p.given - allocated };
    }),
    orders, available,
  });
});

promosRouter.post('/account/:accountId', async (req, res) => {
  const accountId = req.params.accountId;
  if (!(await accountAccess(req, res, accountId))) return;
  const promoId = String(req.body?.promoId ?? '');
  if (!UUID.test(promoId)) return res.status(400).json({ error: 'Bad promo' });
  const qty = givenQty(req.body?.qty);
  if (qty === undefined) return res.status(400).json({ error: 'The quantity must be a whole number from 1 to 9999, or left empty.' });
  const [c] = await prisma.$queryRaw<any[]>`
    select p.active,
           exists (select 1 from crm.account_promos g where g.promo_id = p.id and g.account_id = ${accountId}::uuid) as "isGiven",
           coalesce((select sum(o.qty) from crm.order_promos o join crm.quotes q on q.id = o.quote_id
                     where o.promo_id = p.id and q.account_id = ${accountId}::uuid), 0)::int as used
    from crm.promos p where p.id = ${promoId}::uuid`;
  if (!c) return res.status(400).json({ error: 'That promo no longer exists.' });
  if (!c.active && !c.isGiven) return res.status(400).json({ error: 'That promo is turned off.' });
  if (qty !== null && c.used > qty) return res.status(400).json({ error: `${c.used} already allocated to this customer's orders, so the quantity cannot be less than ${c.used}.` });
  await prisma.$queryRaw`insert into crm.account_promos (promo_id, account_id, qty, rep_id) values (${promoId}::uuid, ${accountId}::uuid, ${qty}::int, ${req.rep!.id}::uuid)
    on conflict (promo_id, account_id) do update set qty = excluded.qty`;
  res.json({ ok: true });
});

promosRouter.post('/account/:accountId/remove', async (req, res) => {
  const accountId = req.params.accountId;
  if (!(await accountAccess(req, res, accountId))) return;
  const promoId = String(req.body?.promoId ?? '');
  if (!UUID.test(promoId)) return res.status(400).json({ error: 'Bad promo' });
  const [u] = await prisma.$queryRaw<{ n: number }[]>`
    select count(*)::int as n from crm.order_promos o join crm.quotes q on q.id = o.quote_id where o.promo_id = ${promoId}::uuid and q.account_id = ${accountId}::uuid`;
  if (u.n > 0) return res.status(409).json({ error: `This promo is allocated to ${u.n} of this customer's order${u.n === 1 ? '' : 's'}. Take it off ${u.n === 1 ? 'that order' : 'those orders'} first.` });
  await prisma.$queryRaw`delete from crm.account_promos where promo_id = ${promoId}::uuid and account_id = ${accountId}::uuid`;
  res.json({ ok: true });
});

promosRouter.post('/account/:accountId/allocate', async (req, res) => {
  const accountId = req.params.accountId;
  if (!(await accountAccess(req, res, accountId))) return;
  const promoId = String(req.body?.promoId ?? ''), orderId = String(req.body?.orderId ?? '');
  if (!UUID.test(promoId)) return res.status(400).json({ error: 'Bad promo' });
  if (!UUID.test(orderId)) return res.status(400).json({ error: 'Choose an order.' });
  const qty = Math.round(Number(req.body?.qty ?? 1));
  if (!Number.isFinite(qty) || qty < 1 || qty > 9999) return res.status(400).json({ error: 'The quantity must be a whole number from 1 to 9999.' });
  const [c] = await prisma.$queryRaw<any[]>`
    select (select q.account_id = ${accountId}::uuid from crm.quotes q where q.id = ${orderId}::uuid) as "ownOrder",
           (select p.active from crm.promos p where p.id = ${promoId}::uuid) as active,
           exists (select 1 from crm.account_promos g where g.promo_id = ${promoId}::uuid and g.account_id = ${accountId}::uuid) as "isGiven",
           (select g.qty from crm.account_promos g where g.promo_id = ${promoId}::uuid and g.account_id = ${accountId}::uuid)::int as given,
           coalesce((select sum(o.qty) from crm.order_promos o join crm.quotes q on q.id = o.quote_id
                     where o.promo_id = ${promoId}::uuid and q.account_id = ${accountId}::uuid and o.quote_id <> ${orderId}::uuid), 0)::int as "otherUsed"`;
  if (!c.ownOrder) return res.status(400).json({ error: "That order is not this customer's." });
  if (c.active === null) return res.status(400).json({ error: 'That promo no longer exists.' });
  if (!c.isGiven && !c.active) return res.status(400).json({ error: 'That promo is turned off.' });
  if (c.given != null && c.otherUsed + qty > c.given) {
    const left = Math.max(0, c.given - c.otherUsed);
    return res.status(400).json({ error: left ? `Only ${left} left for this customer. Give them more first if they should have more.` : 'None left for this customer. Give them more first if they should have more.' });
  }
  if (!c.isGiven) {
    await prisma.$queryRaw`insert into crm.account_promos (promo_id, account_id, qty, rep_id) values (${promoId}::uuid, ${accountId}::uuid, null, ${req.rep!.id}::uuid)
      on conflict (promo_id, account_id) do nothing`;
  }
  await prisma.$queryRaw`insert into crm.order_promos (promo_id, quote_id, qty, rep_id) values (${promoId}::uuid, ${orderId}::uuid, ${qty}::int, ${req.rep!.id}::uuid)
    on conflict (promo_id, quote_id) do update set qty = excluded.qty`;
  res.json({ ok: true });
});

promosRouter.post('/account/:accountId/unallocate', async (req, res) => {
  const accountId = req.params.accountId;
  if (!(await accountAccess(req, res, accountId))) return;
  const promoId = String(req.body?.promoId ?? ''), orderId = String(req.body?.orderId ?? '');
  if (!UUID.test(promoId) || !UUID.test(orderId)) return res.status(400).json({ error: 'Bad promo or order' });
  await prisma.$queryRaw`delete from crm.order_promos o using crm.quotes q
    where q.id = o.quote_id and q.account_id = ${accountId}::uuid and o.promo_id = ${promoId}::uuid and o.quote_id = ${orderId}::uuid`;
  res.json({ ok: true });
});

promosRouter.post('/:id', async (req, res) => {
  if (!manager(req)) return res.status(403).json({ error: 'Only managers change promos.' });
  if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'Bad promo' });
  const [cur] = await prisma.$queryRaw<any[]>`select name, match_text as "matchText", starts_on::text as "startsOn", ends_on::text as "endsOn", active from crm.promos where id = ${req.params.id}::uuid`;
  if (!cur) return res.status(404).json({ error: 'Promo not found' });
  const b = req.body ?? {};
  const name = 'name' in b ? text(b.name, 120) : cur.name;
  if (!name) return res.status(400).json({ error: 'Give the promo a name.' });
  const matchText = 'matchText' in b ? text(b.matchText, 120) || null : cur.matchText;
  const startsOn = 'startsOn' in b ? day(b.startsOn) : cur.startsOn;
  const endsOn = 'endsOn' in b ? day(b.endsOn) : cur.endsOn;
  const active = 'active' in b ? !!b.active : cur.active;
  try {
    await prisma.$queryRaw`update crm.promos set name = ${name}, match_text = ${matchText}, starts_on = ${startsOn}::date, ends_on = ${endsOn}::date, active = ${active} where id = ${req.params.id}::uuid`;
  } catch (e) { if (dup(e)) return res.status(409).json({ error: 'There is already a promo with that name.' }); throw e; }
  res.json({ ok: true });
});

promosRouter.post('/:id/delete', async (req, res) => {
  if (!manager(req)) return res.status(403).json({ error: 'Only managers delete promos.' });
  if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'Bad promo' });
  const [n] = await prisma.$queryRaw<{ orders: number; customers: number }[]>`
    select (select count(*) from crm.order_promos where promo_id = ${req.params.id}::uuid)::int as orders,
           (select count(*) from crm.account_promos where promo_id = ${req.params.id}::uuid)::int as customers`;
  if (n.orders > 0) return res.status(409).json({ error: `${n.orders} order${n.orders === 1 ? ' has' : 's have'} used this promo, so it cannot be deleted. Turn it off instead.` });
  if (n.customers > 0) return res.status(409).json({ error: `This promo was given to ${n.customers} customer${n.customers === 1 ? '' : 's'}, so it cannot be deleted. Turn it off instead.` });
  await prisma.$queryRaw`delete from crm.promos where id = ${req.params.id}::uuid`;
  res.json({ ok: true });
});

// The orders that redeemed one promo, and the customers it was given to. Managers see them all; a rep sees the ones in their states (and not those a
// manager hid), as everywhere else.
async function ordersFor(req: any, promoId: string) {
  const [promo] = await prisma.$queryRaw<any[]>`select id::text as id, name, starts_on::text as "startsOn", ends_on::text as "endsOn", active from crm.promos where id = ${promoId}::uuid`;
  if (!promo) return null;
  const [ticks, given] = await Promise.all([
    prisma.$queryRaw<{ quoteId: string; qty: number; repId: string | null }[]>`select quote_id::text as "quoteId", qty, rep_id::text as "repId" from crm.order_promos where promo_id = ${promoId}::uuid`,
    prisma.$queryRaw<{ accountId: string; customer: string; region: string; given: number | null; used: number }[]>`
      select g.account_id::text as "accountId", a.name as customer, coalesce(a.region, '') as region, g.qty::int as given,
             coalesce((select sum(o.qty) from crm.order_promos o join crm.quotes q on q.id = o.quote_id
                       where o.promo_id = g.promo_id and q.account_id = g.account_id), 0)::int as used
      from crm.account_promos g join crm.accounts a on a.id = g.account_id
      where g.promo_id = ${promoId}::uuid order by a.name`,
  ]);
  const quotes = ticks.length ? await prisma.quote.findMany({
    where: { id: { in: ticks.map(t => t.quoteId) } },
    select: { id: true, number: true, sentAt: true, amount: true, goodsTotal: true, taxTotal: true, fulfillmentStatus: true, accountId: true, account: { select: { name: true, region: true } } },
  }) : [];
  const reps = new Map((await prisma.rep.findMany({ select: { id: true, name: true } })).map(r => [r.id, r.name] as [string, string]));
  let canSee = (_accountId: string, _region: string) => true;
  if (!manager(req)) {
    const regions = await assignedRegions(req.rep!.id), hidden = new Set(await hiddenAccountIds(req.rep!.id));
    canSee = (accountId, region) => regions.includes(String(region)) && !hidden.has(accountId);
  }
  const byQuote = new Map(quotes.map(q => [q.id, q] as [string, typeof quotes[number]]));
  const customers = given.filter(g => canSee(g.accountId, g.region)).map(g => ({ ...g, left: g.given == null ? null : g.given - g.used }));
  const orders = ticks.flatMap(t => {
    const q = byQuote.get(t.quoteId);
    if (!q || !q.account || !canSee(q.accountId, String(q.account.region))) return [];
    return [{
      id: q.id, number: q.number, date: q.sentAt.toISOString().slice(0, 10), accountId: q.accountId, customer: q.account?.name ?? 'Unknown', region: q.account?.region ?? '',
      qty: t.qty, value: r2(q.goodsTotal ?? q.amount - (q.taxTotal ?? 0)), status: q.fulfillmentStatus ?? '', by: t.repId ? reps.get(t.repId) ?? '' : '',
    }];
  }).sort((a, b) => b.date.localeCompare(a.date) || b.number.localeCompare(a.number));
  return { promo, orders, customers, totals: { orders: orders.length, units: orders.reduce((s, o) => s + o.qty, 0), value: r2(orders.reduce((s, o) => s + o.value, 0)) } };
}

promosRouter.get('/:id/orders', async (req, res) => {
  if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'Bad promo' });
  const r = await ordersFor(req, req.params.id);
  if (!r) return res.status(404).json({ error: 'Promo not found' });
  res.json(r);
});

promosRouter.get('/:id/export', async (req, res) => {
  if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'Bad promo' });
  const r = await ordersFor(req, req.params.id);
  if (!r) return res.status(404).json({ error: 'Promo not found' });
  const rows = r.orders.map(o => ({ Order: o.number, Date: o.date, Customer: o.customer, State: o.region, Quantity: o.qty, 'Order value (ex GST)': o.value, Status: o.status, 'Ticked by': o.by }));
  const ws = rows.length ? XLSX.utils.json_to_sheet(rows) : XLSX.utils.aoa_to_sheet([['No orders yet']]);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Orders');
  const file = `promo-${r.promo.name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'orders'}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${file}"`);
  res.send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
});
