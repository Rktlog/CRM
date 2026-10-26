// Types, filtering and the CSV export for the Ordering page.
export type Status = 'now' | 'soon' | 'later' | 'ok' | 'overstock' | 'no_sales' | 'stopped';
export type OrderRow = {
  sku: string; product: string; brand: string | null; category: string | null; stage: string | null; supplier: string | null;
  onHand: number; allocated: number; available: number; backordered: number; onOrder: number; nextArrival: string | null; onQuotes: number; increment: number | null;
  last3Avg: number; last12: number; monthsOfHistory: number; history12: number[]; forecast6: number[]; forecastPerMonth: number; demand: number;
  method: string; confidence: 'High' | 'Medium' | 'Low'; accuracyPct: number | null; runOutMonths: number | null; coverMonths: number | null;
  suggested: number; status: Status; out: boolean; notes: string | null;
};
export type Settings = { lead: number; cover: number; plan: 'expected' | 'high'; history: number };
export type Summary = {
  skus: number; now: number; soon: number; later: number; overstock: number; noSales: number; ok: number; stopped: number; unitsToOrder: number; skusToOrder: number;
  backorderedUnits: number; backorderedSkus: number; outOfStockSelling: number; basis: string;
};
export type OrderingData = { asOf: string; settings: Settings; stockSyncedAt: string | null; stages: { key: string; label: string }[]; summary: Summary; rows: OrderRow[]; truncated: boolean };

export const STATUS_LABEL: Record<Status, string> = { now: 'Order now', soon: 'Order soon', later: 'Order later', ok: 'OK', overstock: 'Overstock', no_sales: 'No sales', stopped: 'Not reordered' };
export const STATUS_TONE: Record<Status, string> = { now: 'rust', soon: 'amber', later: 'neutral', ok: 'teal', overstock: 'amber', no_sales: 'neutral', stopped: 'neutral' };

// The tabs: which statuses each one shows.
export type Tab = 'to_order' | 'now' | 'soon' | 'later' | 'overstock' | 'no_sales' | 'ok' | 'stopped' | 'all';
export const TABS: { key: Tab; label: string; statuses: Status[] | null }[] = [
  { key: 'to_order', label: 'To order', statuses: ['now', 'soon', 'later'] },
  { key: 'now', label: 'Order now', statuses: ['now'] },
  { key: 'soon', label: 'Order soon', statuses: ['soon'] },
  { key: 'later', label: 'Order later', statuses: ['later'] },
  { key: 'overstock', label: 'Overstock', statuses: ['overstock'] },
  { key: 'no_sales', label: 'No sales', statuses: ['no_sales'] },
  { key: 'ok', label: 'OK', statuses: ['ok'] },
  { key: 'stopped', label: 'Not reordered', statuses: ['stopped'] },
  { key: 'all', label: 'All', statuses: null },
];

export type Filters = { tab: Tab; search: string; brand: string; category: string; stage: string; supplier: string; outOnly: boolean; waitingOnly: boolean };
export const NO_FILTERS: Filters = { tab: 'to_order', search: '', brand: '', category: '', stage: '', supplier: '', outOnly: false, waitingOnly: false };

export function filterRows(rows: OrderRow[], f: Filters): OrderRow[] {
  const statuses = TABS.find(t => t.key === f.tab)?.statuses ?? null, needle = f.search.trim().toLowerCase();
  return rows.filter(r =>
    (!statuses || statuses.includes(r.status)) && (!f.brand || r.brand === f.brand) && (!f.category || r.category === f.category)
    && (!f.stage || (f.stage === '__none' ? !r.stage : r.stage === f.stage)) && (!f.supplier || r.supplier === f.supplier)
    && (!f.outOnly || r.out) && (!f.waitingOnly || r.backordered > 0)
    && (!needle || r.sku.toLowerCase().includes(needle) || r.product.toLowerCase().includes(needle) || (r.brand ?? '').toLowerCase().includes(needle)));
}
export const distinct = (rows: OrderRow[], pick: (r: OrderRow) => string | null): string[] =>
  [...new Set(rows.map(pick).filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b));

// A spreadsheet treats a cell starting with = + - or @ as a formula, so those get a leading apostrophe.
const cell = (v: unknown): string => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
export function toCsv(rows: OrderRow[], stageLabel: (k: string | null) => string): string {
  const head = ['SKU', 'Product', 'Brand', 'Category', 'Stage', 'Supplier', 'On hand', 'Allocated', 'Available', 'Customers waiting (backordered)', 'On order', 'Next arrival', 'On open quotes',
    'Units last 12 months', 'Avg units/month (last 3)', 'Forecast units/month', 'Expected demand (lead time + cover)', 'Months of cover', 'Months until stock runs out', 'Suggested order', 'Order increment', 'Status', 'Confidence', 'Method', 'Notes'];
  const lines = rows.map(r => [r.sku, r.product, r.brand, r.category, stageLabel(r.stage), r.supplier, r.onHand, r.allocated, r.available, r.backordered, r.onOrder, r.nextArrival, r.onQuotes,
    r.last12, r.last3Avg, r.forecastPerMonth, r.demand, r.coverMonths, r.runOutMonths, r.suggested, r.increment, STATUS_LABEL[r.status], r.confidence, r.method, r.notes].map(cell).join(','));
  return [head.map(cell).join(','), ...lines].join('\r\n') + '\r\n';
}