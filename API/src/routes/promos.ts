import { Router } from 'express';
import * as XLSX from 'xlsx';
import { prisma } from '../lib/prisma';
import { canSeeAccount, assignedRegions, hiddenAccountIds } from '../lib/territory';

// Promos: the list of promos the sales team gives (managers set it up), a tick box on each order for the promos it redeemed, and for each promo every order that did.
//   GET  /promos                      every promo with how many orders and units redeemed it
//   POST /promos                      { name, matchText?, startsOn?, endsOn? }   (managers)
//   POST /promos/:id                  { name?, matchText?, startsOn?, endsOn?, active? }   (managers)
//   POST /promos/:id/delete           only while no order has used it (managers); otherwise turn it off
//   GET  /promos/:id/orders           the orders that redeemed it, with totals     GET /promos/:id/export  the same as Excel
//   GET  /promos/order/:orderId       the promos to tick on one order, with what is ticked now
//   POST /promos/order/:orderId       { promos: [{ id, qty }] }  the ticked ones (everything else is un-ticked)
export const promosRouter = Router();
const UUID = /^[0-9a-f-]{36}$/i;
const manager = (req: any) => req.rep?.role === 'manager';
const text = (v: unknown, max = 200) => String(v ?? '').trim().slice(0, max);
const day = (v: unknown): string | null => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const r2 = (n: number) => Math.round(n * 100) / 100;
const dup = (e: unknown) => /23505|duplicate key/i.test(String((e as any)?.message ?? e));

// Whoever can see the account can see (and tick) its orders' promos, the same rule as the order's log.
async function orderAccess(req: any, res: any, orderId: string): Promise<boolean> {
  if (!UUID.test(orderId)) { res.status(400).json({ error: 'Bad order' }); return false; }
  const [o] = await prisma.$queryRaw<any[]>`select q.id, a.id as "accountId", a.region, a.rep_id as "repId" from crm.quotes q join crm.accounts a on a.id = q.account_id where q.id = ${orderId}::uuid`;
  if (!o) { res.status(404).json({ error: 'Order not found' }); return false; }
  if (!(await canSeeAccount(req.rep!, { id: o.accountId, repId: o.repId, region: o.region } as any))) { res.status(403).json({ error: 'This order is outside your states' }); return false; }
  return true;
}

promosRouter.get('/', async (_req, res) => {
  const rows = await prisma.$queryRaw<any[]>`
    select p.id::text as id, p.name, p.match_text as "matchText", p.starts_on::text as "startsOn", p.ends_on::text as "endsOn", p.active,
           count(o.id)::int as orders, coalesce(sum(o.qty), 0)::int as units
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

// The two fixed addresses go before /:id.
promosRouter.get('/order/:orderId', async (req, res) => {
  if (!(await orderAccess(req, res, req.params.orderId))) return;
  const rows = await prisma.$queryRaw<any[]>`
    select p.id::text as id, p.name, p.starts_on::text as "startsOn", p.ends_on::text as "endsOn", p.active, (o.id is not null) as ticked, coalesce(o.qty, 1)::int as qty
    from crm.promos p left join crm.order_promos o on o.promo_id = p.id and o.quote_id = ${req.params.orderId}::uuid
    where p.active or o.id is not null order by p.active desc, p.name`;
  res.json({ promos: rows });
});

promosRouter.post('/order/:orderId', async (req, res) => {
  if (!(await orderAccess(req, res, req.params.orderId))) return;
  const orderId = req.params.orderId;
  const asked: { id: string; qty: number }[] = [];
  for (const p of Array.isArray(req.body?.promos) ? req.body.promos : []) {
    const id = String(p?.id ?? '');
    const qty = Math.round(Number(p?.qty ?? 1));
    if (!UUID.test(id)) return res.status(400).json({ error: 'Bad promo' });
    if (!Number.isFinite(qty) || qty < 1 || qty > 9999) return res.status(400).json({ error: 'The quantity must be a whole number from 1 to 9999.' });
    if (!asked.some(a => a.id === id)) asked.push({ id, qty });
  }
  const known = new Set((asked.length ? await prisma.$queryRaw<{ id: string }[]>`select id::text as id from crm.promos where id = any(${asked.map(a => a.id)}::text[]::uuid[])` : []).map(r => r.id));
  if (asked.some(a => !known.has(a.id))) return res.status(400).json({ error: 'One of those promos no longer exists.' });
  if (asked.length) await prisma.$queryRaw`delete from crm.order_promos where quote_id = ${orderId}::uuid and promo_id <> all(${asked.map(a => a.id)}::text[]::uuid[])`;
  else await prisma.$queryRaw`delete from crm.order_promos where quote_id = ${orderId}::uuid`;
  for (const a of asked) {
    await prisma.$queryRaw`insert into crm.order_promos (promo_id, quote_id, qty, rep_id) values (${a.id}::uuid, ${orderId}::uuid, ${a.qty}::int, ${req.rep!.id}::uuid)
      on conflict (promo_id, quote_id) do update set qty = excluded.qty`;
  }
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
  const [n] = await prisma.$queryRaw<{ n: number }[]>`select count(*)::int as n from crm.order_promos where promo_id = ${req.params.id}::uuid`;
  if (n.n > 0) return res.status(409).json({ error: `${n.n} order${n.n === 1 ? ' has' : 's have'} used this promo, so it cannot be deleted. Turn it off instead.` });
  await prisma.$queryRaw`delete from crm.promos where id = ${req.params.id}::uuid`;
  res.json({ ok: true });
});

// The orders that redeemed one promo. Managers see them all; a rep sees the ones in their states (and not those a manager hid), as everywhere else.
async function ordersFor(req: any, promoId: string) {
  const [promo] = await prisma.$queryRaw<any[]>`select id::text as id, name, starts_on::text as "startsOn", ends_on::text as "endsOn", active from crm.promos where id = ${promoId}::uuid`;
  if (!promo) return null;
  const ticks = await prisma.$queryRaw<{ quoteId: string; qty: number; repId: string | null }[]>`select quote_id::text as "quoteId", qty, rep_id::text as "repId" from crm.order_promos where promo_id = ${promoId}::uuid`;
  const quotes = ticks.length ? await prisma.quote.findMany({
    where: { id: { in: ticks.map(t => t.quoteId) } },
    select: { id: true, number: true, sentAt: true, amount: true, goodsTotal: true, taxTotal: true, fulfillmentStatus: true, accountId: true, account: { select: { name: true, region: true } } },
  }) : [];
  const reps = new Map((await prisma.rep.findMany({ select: { id: true, name: true } })).map(r => [r.id, r.name] as [string, string]));
  let allowed: Set<string> | null = null;
  if (!manager(req)) {
    const regions = await assignedRegions(req.rep!.id), hidden = new Set(await hiddenAccountIds(req.rep!.id));
    allowed = new Set(quotes.filter(q => q.account && regions.includes(String(q.account.region)) && !hidden.has(q.accountId)).map(q => q.id));
  }
  const byQuote = new Map(quotes.map(q => [q.id, q] as [string, typeof quotes[number]]));
  const orders = ticks.flatMap(t => {
    const q = byQuote.get(t.quoteId);
    if (!q || (allowed && !allowed.has(q.id))) return [];
    return [{
      id: q.id, number: q.number, date: q.sentAt.toISOString().slice(0, 10), accountId: q.accountId, customer: q.account?.name ?? 'Unknown', region: q.account?.region ?? '',
      qty: t.qty, value: r2(q.goodsTotal ?? q.amount - (q.taxTotal ?? 0)), status: q.fulfillmentStatus ?? '', by: t.repId ? reps.get(t.repId) ?? '' : '',
    }];
  }).sort((a, b) => b.date.localeCompare(a.date) || b.number.localeCompare(a.number));
  return { promo, orders, totals: { orders: orders.length, units: orders.reduce((s, o) => s + o.qty, 0), value: r2(orders.reduce((s, o) => s + o.value, 0)) } };
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
