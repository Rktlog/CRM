import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { addMonths, buildSeries, planRow, ORDER_STATUS_RANK, type Facts, type OrderRow, type Series, type Status } from '../lib/orderingPlan';
import { REPORTS, checkRange, exportDefaults, fileName, makeZip, melbourneToday, readme, runReport, toCsv, type Range, type ReportKey } from '../lib/orderingExport';

export const orderingRouter = Router();

// The Ordering page. Everything comes from the CRM database (DEAR is synced into it), so nothing is exported or pasted:
//   stock                  crm.products            what is on hand, allocated, available, on order, the stage and the order increment
//   what customers order   crm.quote_lines         units per month by order date: the same history and rules as the Assistant's sales forecast
//   customers waiting      open orders             units on orders not yet shipped that DEAR has marked as backordered
//   quotes not yet orders  crm.quotes              units on quotes, drafts and orders still at Ordering from the last 180 days (shown, not counted as demand)
//   stock on order         crm.purchase_lines      what is still to arrive on purchase orders, and when it is required
//   supplier               crm.purchases           the supplier on the most recent purchase order for the product
// The forecast is worked out by code (backtested, with a confidence rating) and kept for 20 minutes. The stock and plan are worked out fresh every time.

const melDay = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Melbourne' });
const num = (v: unknown, d: number, lo: number, hi: number) => { const n = Number(v); return v !== undefined && v !== '' && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const dayOf = (d: Date | string | null) => (d ? new Date(d).toISOString().slice(0, 10) : null);

// The forecast kept for 20 minutes (the slow part), per history length. Two people asking at once share one calculation.
const KEEP_MS = 20 * 60_000;
const kept = new Map<string, { at: number; v: Map<string, Series> }>(), working = new Map<string, Promise<Map<string, Series>>>();
async function cachedSeries(key: string, load: () => Promise<Map<string, Series>>): Promise<Map<string, Series>> {
  const hit = kept.get(key);
  if (hit && Date.now() - hit.at < KEEP_MS) return hit.v;
  let p = working.get(key);
  if (!p) {
    p = load().then(v => { kept.set(key, { at: Date.now(), v }); if (kept.size > 6) kept.delete(kept.keys().next().value as string); return v; }).finally(() => working.delete(key));   // a failure is never kept
    working.set(key, p);
  }
  return p;
}

// The stage names (EOL, Discontinued, ...) a manager can edit under Settings. If that table is not there, the standard ones are used.
const STANDARD_STAGES = [{ key: 'eol', label: 'EOL' }, { key: 'discontinued', label: 'Discontinued' }, { key: 'preorder_only', label: 'Preorder Only' }, { key: 'new', label: 'New' }, { key: 'ranging', label: 'Confirmed for Ranging' }, { key: 'customer_only', label: 'For Customer Only Then Cease' }, { key: 'phasing_out', label: 'Phasing Out' }];
const stageList = async () => { try { return await prisma.$queryRaw<{ key: string; label: string }[]>`select key, label from crm.product_statuses order by sort_order, lower(label)`; } catch { return STANDARD_STAGES; } };

orderingRouter.get('/', async (req, res) => {
  try {
  if (req.rep!.role !== 'manager') return res.status(403).json({ error: 'Ordering is for managers' });
  const history = Math.round(num(req.query.history, 24, 12, 36));
  const lead = num(req.query.lead, 3, 0, 11.5), cover = Math.min(num(req.query.cover, 3, 0.5, 12), 12 - lead);
  const plan = req.query.plan === 'high' ? 'high' as const : 'expected' as const;
  const today = melDay(), thisMonth = today.slice(0, 7), lastFull = addMonths(thisMonth, -1), startMonth = addMonths(lastFull, -(history - 1));

  const series = await cachedSeries(`${history}|${lastFull}`, async () => buildSeries(await prisma.$queryRaw<{ sku: string; month: string; qty: number }[]>`
    select l.sku, to_char((q.sent_at at time zone 'UTC') at time zone 'Australia/Melbourne', 'YYYY-MM') as month, sum(l.quantity)::float8 as qty   -- the order's Melbourne day, so an order on the 1st is counted in its own month (some stored dates are Melbourne midnight as UTC, the day before in UTC)
    from crm.quote_lines l join crm.quotes q on q.id = l.quote_id
    where q.source <> 'rhino-history' and q.number not like 'Q%' and q.misc_type is null
      and upper(coalesce(q.fulfillment_status, '')) not in ('DRAFT', 'ESTIMATING', 'ESTIMATED', 'ORDERING', 'VOIDED', 'CREDITED')
      and ((q.sent_at at time zone 'UTC') at time zone 'Australia/Melbourne') >= (${startMonth} || '-01')::date
      and ((q.sent_at at time zone 'UTC') at time zone 'Australia/Melbourne') < (${thisMonth} || '-01')::date
    group by l.sku, 2 limit 250000`, lastFull));

  const [products, backordered, quoted, pos, suppliers, stages, stockRun] = await Promise.all([
    prisma.$queryRaw<{ sku: string; name: string; brand: string | null; category: string | null; lifecycle: string | null; on_hand: number; allocated: number; available: number; on_order: number; eta: Date | null; order_increment: number | null; stock_synced_at: Date | null }[]>`
      select sku, name, brand, category, lifecycle, on_hand::float8, allocated::float8, available::float8, on_order::float8, eta, order_increment, stock_synced_at from crm.products`,
    // Units customers are waiting for: on each open order, what DEAR says is backordered, never more than is still to ship.
    prisma.$queryRaw<{ sku: string; qty: number }[]>`
      with lines as (
        select q.id, l.sku, max(q.line_fulfilment::text)::jsonb as lf, sum(l.quantity) as qty
        from crm.quotes q join crm.quote_lines l on l.quote_id = q.id
        where q.source <> 'rhino-history' and q.number not like 'Q%' and q.misc_type is null
          and upper(coalesce(q.fulfillment_status, '')) not in ('COMPLETED', 'VOIDED', 'CREDITED', 'DRAFT', 'ESTIMATING', 'ESTIMATED', 'QUOTE', 'ORDERING')
          and upper(coalesce(q.shipping_status, '')) <> 'SHIPPED'
        group by q.id, l.sku)
      select sku, sum(least(coalesce(nullif(lf -> sku ->> 'backordered', '')::float8, 0), greatest(qty - coalesce(nullif(lf -> sku ->> 'shipped', '')::float8, 0), 0)))::float8 as qty
      from lines group by sku`,
    prisma.$queryRaw<{ sku: string; qty: number }[]>`
      select l.sku, sum(l.quantity)::float8 as qty from crm.quotes q join crm.quote_lines l on l.quote_id = q.id
      where q.source <> 'rhino-history' and q.number not like 'Q%' and q.misc_type is null
        and upper(coalesce(q.fulfillment_status, '')) in ('DRAFT', 'ESTIMATING', 'ESTIMATED', 'QUOTE', 'ORDERING') and q.sent_at >= now() - interval '180 days'
      group by l.sku`,
    prisma.$queryRaw<{ sku: string; outstanding: number; next_by: Date | null }[]>`
      select l.sku, sum(greatest(l.quantity_ordered - l.quantity_received, 0))::float8 as outstanding, min(p.required_by) as next_by
      from crm.purchase_lines l join crm.purchases p on p.id = l.purchase_id
      where upper(coalesce(p.status, '')) not in ('VOIDED', 'CREDITED', 'DRAFT')
        and not (upper(coalesce(p.receiving_status, '')) like '%FULLY RECEIVED%' or upper(coalesce(p.status, '')) like 'COMPLETED%' or upper(coalesce(p.status, '')) = 'RECEIVED')
        and l.quantity_ordered - l.quantity_received > 0
      group by l.sku`,
    prisma.$queryRaw<{ sku: string; supplier: string }[]>`
      select distinct on (l.sku) l.sku, p.supplier from crm.purchase_lines l join crm.purchases p on p.id = l.purchase_id
      where p.supplier is not null and btrim(p.supplier) <> '' and upper(coalesce(p.status, '')) not in ('VOIDED', 'CREDITED', 'DRAFT')
      order by l.sku, p.order_date desc nulls last`,
    stageList(),
    // When the stock sync last RAN (the same record the Products page shows). A product row is only stamped when its own figures change, so on a quiet
    // weekend the newest row can be days old while the sync is running fine.
    prisma.$queryRaw<{ t: Date }[]>`select last_synced_at as t from crm.sync_state where key = 'stock'`.catch(() => [] as { t: Date }[]),
  ]);
  const by = <T extends { sku: string }>(rows: T[]) => new Map(rows.map(r => [r.sku, r]));
  const back = by(backordered), quotes = by(quoted), po = by(pos), sup = by(suppliers);

  const rows: OrderRow[] = [];
  for (const p of products) {
    const bo = back.get(p.sku)?.qty ?? 0, open = po.get(p.sku), s = series.get(p.sku);
    const onOrder = open ? open.outstanding : p.on_order;      // the purchase orders when there is one, otherwise what DEAR says is on order
    const stopped = !!p.lifecycle && ['eol', 'discontinued', 'phasing_out', 'customer_only'].includes(p.lifecycle);
    // Left out: nothing in stock, nothing coming, nobody waiting, and (for products on their way out) no recent sales.
    const live = p.on_hand > 0 || p.available > 0 || onOrder > 0 || bo > 0;
    if (!live && (!s || stopped)) continue;
    const facts: Facts = {
      sku: p.sku, product: p.name, brand: p.brand, category: p.category, stage: p.lifecycle, supplier: sup.get(p.sku)?.supplier ?? null,
      onHand: p.on_hand, allocated: p.allocated, available: p.available, backordered: bo, onOrder, nextArrival: dayOf(open?.next_by ?? null) ?? dayOf(p.eta),
      onQuotes: quotes.get(p.sku)?.qty ?? 0, increment: p.order_increment,
    };
    rows.push(planRow(facts, s, { lead, cover, plan }));
  }
  rows.sort((a, b) => ORDER_STATUS_RANK[a.status] - ORDER_STATUS_RANK[b.status] || b.suggested - a.suggested || b.forecastPerMonth - a.forecastPerMonth || a.sku.localeCompare(b.sku));

  const count = (st: Status) => rows.filter(r => r.status === st).length;
  const toOrder = rows.filter(r => r.suggested > 0);
  const synced = [...products.map(p => p.stock_synced_at), stockRun[0]?.t ?? null].filter((d): d is Date => !!d).sort((a, b) => +b - +a)[0];   // the latest sign the stock was brought up to date
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], label = (ym: string) => `${MON[Number(ym.slice(5)) - 1]} ${ym.slice(0, 4)}`;
  res.json({
    asOf: today, settings: { lead, cover, plan, history },
    stockSyncedAt: synced ? synced.toISOString() : null,
    stages: stages.map(s => ({ key: s.key, label: s.label })),
    summary: {
      skus: rows.length, now: count('now'), soon: count('soon'), later: count('later'), overstock: count('overstock'), noSales: count('no_sales'), ok: count('ok'), stopped: count('stopped'),
      unitsToOrder: toOrder.reduce((t, r) => t + r.suggested, 0), skusToOrder: toOrder.length,
      backorderedUnits: Math.round(rows.reduce((t, r) => t + r.backordered, 0)), backorderedSkus: rows.filter(r => r.backordered > 0).length,
      outOfStockSelling: rows.filter(r => r.out && r.status !== 'stopped').length,
      basis: `Units customers ordered each month, ${label(startMonth)} to ${label(lastFull)} (full months, by order date), forecast by code with the method that predicted the latest months best.`,
    },
    rows: rows.slice(0, 6000), truncated: rows.length > 6000,
  });
  } catch (e) {
    // Never let one bad request stop the server: say what went wrong as a normal error.
    res.status(500).json({ error: `Could not work out the ordering plan: ${String((e as Error)?.message ?? e).slice(0, 200)}` });
  }
});

// ---- Export: the nine reports as CSV files (managers) ----
// GET /ordering/export                    the list of reports and the default date ranges
// GET /ordering/export/zip?from&to&yfrom&yto   all nine in one zip, with a README (sales reports use from/to, the others yfrom/yto)
// GET /ordering/export/:report?from&to    one report as a CSV file
const managersOnly = (req: any, res: any) => { if (req.rep!.role !== 'manager') { res.status(403).json({ error: 'Ordering is for managers' }); return false; } return true; };
const failed = (res: any, e: unknown) => res.status(500).json({ error: `Could not make the report: ${String((e as Error)?.message ?? e).slice(0, 200)}` });
const rangeFrom = (q: any, fromKey: string, toKey: string, fallback: Range) => checkRange(q[fromKey] ?? fallback.from, q[toKey] ?? fallback.to);

orderingRouter.get('/export', (req, res) => {
  if (!managersOnly(req, res)) return;
  const today = melbourneToday();
  res.json({ today, defaults: exportDefaults(today), reports: REPORTS.map(r => ({ key: r.key, no: r.no, title: r.title, file: r.file, basis: r.basis, note: r.note })) });
});

orderingRouter.get('/export/zip', async (req, res) => {
  if (!managersOnly(req, res)) return;
  try {
    const today = melbourneToday(), d = exportDefaults(today);
    const a = rangeFrom(req.query, 'from', 'to', d.period), b = rangeFrom(req.query, 'yfrom', 'yto', d.year);
    if (a.error || b.error) return res.status(400).json({ error: a.error ?? b.error });
    const files: { name: string; data: Buffer }[] = [], counts: Record<string, { rows: number; capped: boolean }> = {};
    for (const r of REPORTS) {
      const range = r.basis === 'period' ? a.range! : r.basis === 'year' ? b.range! : null, t = await runReport(r.key, range ?? d.period);
      counts[r.key] = { rows: t.rows.length, capped: t.capped };
      files.push({ name: fileName(r.key, range, today), data: Buffer.from(toCsv(t), 'utf8') });
    }
    files.unshift({ name: '00-read-me.txt', data: Buffer.from(readme(today, a.range!, b.range!, counts), 'utf8') });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="ordering-reports_${today}.zip"`);
    res.send(makeZip(files));
  } catch (e) { failed(res, e); }
});

orderingRouter.get('/export/:report', async (req, res) => {
  if (!managersOnly(req, res)) return;
  const def = REPORTS.find(r => r.key === req.params.report);
  if (!def) return res.status(404).json({ error: 'No such report' });
  try {
    const today = melbourneToday(), d = exportDefaults(today), r = rangeFrom(req.query, 'from', 'to', def.basis === 'year' ? d.year : d.period);
    if (r.error) return res.status(400).json({ error: r.error });
    const t = await runReport(def.key as ReportKey, r.range!);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName(def.key as ReportKey, def.basis === 'now' ? null : r.range!, today)}"`);
    res.send(toCsv(t));
  } catch (e) { failed(res, e); }
});