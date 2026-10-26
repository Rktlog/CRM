import { forecastSeries, fillMonths, addMonths, type Confidence } from './aiForecast';

// The ordering plan for ONE product: how much to order now so the stock lasts through the lead time and a cover period after it.
// Pure arithmetic on facts read from the database (no database calls here), so it can be tested on its own.
//
//   demand      what customers are expected to order over (lead time + cover), from the same forecast the Assistant uses
//   position    stock available now + already on order - customers waiting on a backorder
//   to order    demand - position, rounded UP to the supplier's order increment (carton size)
//
// A forecast is only as good as the order history behind it. It cannot know about a promotion, a new range, a lost customer or a stock-out
// that held orders back, so each row carries how well the method predicted recent months, and a note when the history is short.

export type Status = 'now' | 'soon' | 'later' | 'ok' | 'overstock' | 'no_sales' | 'stopped';
export const NO_REORDER = ['eol', 'discontinued', 'phasing_out', 'customer_only'];   // stages that are not reordered
export type PlanSettings = { lead: number; cover: number; plan: 'expected' | 'high' };

export type Facts = {
  sku: string; product: string; brand: string | null; category: string | null; stage: string | null; supplier: string | null;
  onHand: number; allocated: number; available: number; backordered: number; onOrder: number; nextArrival: string | null; onQuotes: number;
  increment: number | null;
};
export type Series = { y: number[]; months: string[]; forecast: number[]; high: number[]; method: string; confidence: Confidence; wape: number | null; warnings: string[] };

export type OrderRow = Facts & {
  last3Avg: number; last12: number; monthsOfHistory: number; history12: number[]; forecast6: number[];
  forecastPerMonth: number; demand: number; method: string; confidence: Confidence; accuracyPct: number | null;
  runOutMonths: number | null; coverMonths: number | null; suggested: number; status: Status; out: boolean; notes: string | null;
};

const r1 = (n: number) => Math.round(n * 10) / 10;
// The first `months` months of a series; a part month counts as that fraction of the next one.
export function demandOver(a: number[], months: number): number {
  const whole = Math.floor(months); let t = 0;
  for (let i = 0; i < whole && i < a.length; i++) t += a[i];
  if (whole < a.length) t += (months - whole) * a[whole];
  return t;
}

// Turns each product's monthly units into a 12 month forecast. Done once per history length and kept, because the backtest is the slow part.
export function buildSeries(rows: { sku: string; month: string; qty: number }[], lastFull: string): Map<string, Series> {
  const by = new Map<string, { month: string; qty: number }[]>();
  for (const r of rows) { const l = by.get(r.sku) ?? []; l.push({ month: r.month, qty: r.qty }); by.set(r.sku, l); }
  const lastMonthNo = Number(lastFull.slice(5)), out = new Map<string, Series>();
  for (const [sku, points] of by) {
    const { months, y } = fillMonths(points, lastFull), f = forecastSeries(y, 12, lastMonthNo);
    out.set(sku, { y, months, forecast: f.forecast, high: f.high, method: f.method, confidence: f.confidence, wape: f.wape, warnings: f.warnings });
  }
  return out;
}

export function planRow(f: Facts, s: Series | undefined, set: PlanSettings): OrderRow {
  const y = s?.y ?? [], horizon = set.lead + set.cover;
  const exp = s?.forecast ?? Array(12).fill(0), basis = set.plan === 'high' ? s?.high ?? exp : exp;
  const demand = demandOver(basis, horizon), perMonth = horizon > 0 ? demandOver(exp, horizon) / horizon : 0;
  const last3 = y.slice(-3), last3Avg = last3.length ? last3.reduce((t, v) => t + v, 0) / last3.length : 0;
  const stock = Math.max(f.available, 0), position = stock + f.onOrder - f.backordered;
  const need = demand + f.backordered - stock - f.onOrder;
  const inc = f.increment && f.increment > 1 ? f.increment : 1;
  const stopped = !!f.stage && NO_REORDER.includes(f.stage);
  const suggested = stopped || need <= 0 ? 0 : Math.ceil(need / inc - 1e-9) * inc;
  const runOut = perMonth > 0 ? Math.max(stock - f.backordered, 0) / perMonth : null;
  const cover = perMonth > 0 ? position / perMonth : null;
  const notes: string[] = [];
  let status: Status;
  if (stopped) { status = 'stopped'; if (f.backordered > stock + f.onOrder) notes.push(`${Math.round(f.backordered - stock - f.onOrder)} units owed to customers, but this product is not reordered.`); }
  else if (!s || perMonth <= 0) {
    if (suggested > 0) status = 'now';                                                 // nothing forecast, but customers are waiting
    else status = f.available > 0 || f.onHand > 0 ? 'no_sales' : 'ok';
    if (suggested > 0) notes.push('No sales to forecast from; this is only what customers are waiting for.');
  } else if (suggested > 0) status = runOut! < set.lead ? 'now' : runOut! < set.lead + 1 ? 'soon' : 'later';
  else status = cover! > 12 ? 'overstock' : 'ok';
  if (s) { for (const w of s.warnings) notes.push(w); if (f.stage === 'new' || y.length < 3) notes.push('New or short history: check by hand.'); }
  return {
    ...f, last3Avg: r1(last3Avg), last12: Math.round(y.slice(-12).reduce((t, v) => t + v, 0)), monthsOfHistory: y.length,
    history12: y.slice(-12).map(Math.round), forecast6: exp.slice(0, 6).map(Math.round),
    forecastPerMonth: r1(perMonth), demand: Math.round(demand), method: s?.method ?? 'No sales to go on', confidence: s?.confidence ?? 'Low',
    accuracyPct: s?.wape == null ? null : Math.round((1 - Math.min(1, s.wape)) * 100),
    runOutMonths: runOut == null ? null : r1(runOut), coverMonths: cover == null ? null : r1(cover), suggested, status,
    out: f.available <= 0 && perMonth > 0, notes: notes.join(' ') || null,
  };
}

export const ORDER_STATUS_RANK: Record<Status, number> = { now: 0, soon: 1, later: 2, overstock: 3, no_sales: 4, ok: 5, stopped: 6 };
export { addMonths };