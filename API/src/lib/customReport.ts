import { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { territoryWhere } from './territory';
import { chooseEta, incomingFor } from './eta';
import { listStatuses } from './productStatuses';

// Custom reports: pick a dataset, the columns, filters, and (optionally) how to add it up. Nothing the browser sends
// goes into SQL as text: datasets, columns and filters are checked against the lists below, and values are parameters.
// What a person can see follows the same territory rule as the rest of the app.

export type ColType = 'text' | 'number' | 'money' | 'date';
export type Col = { key: string; label: string; type: ColType; dim?: boolean };   // dim: can be grouped by
export type DatasetKey = 'sales' | 'products' | 'customers';
export type Filters = {
  from?: string; to?: string; brands?: string[]; states?: string[]; categories?: string[]; statuses?: string[]; reps?: string[];
  realOrdersOnly?: boolean; inStockOnly?: boolean; includeArchived?: boolean;
};
export type Definition = { dataset: DatasetKey; columns: string[]; filters: Filters; groupBy: string[]; sort?: { key: string; dir: 'asc' | 'desc' } };
export type Rep = { id: string; role: string };

export const DATASETS: Record<DatasetKey, { label: string; blurb: string; filters: (keyof Filters)[]; columns: Col[] }> = {
  sales: {
    label: 'Order lines',
    blurb: 'Every product line on every order, by order date. (Sales Data counts invoices, so its totals can differ.)',
    filters: ['from', 'to', 'brands', 'states', 'categories', 'realOrdersOnly'],
    columns: [
      { key: 'orderDate', label: 'Order date', type: 'date', dim: true },
      { key: 'orderMonth', label: 'Order month', type: 'text', dim: true },
      { key: 'orderNo', label: 'Order no', type: 'text', dim: true },
      { key: 'status', label: 'Order status', type: 'text', dim: true },
      { key: 'customer', label: 'Customer', type: 'text', dim: true },
      { key: 'state', label: 'State', type: 'text', dim: true },
      { key: 'category', label: 'Customer category', type: 'text', dim: true },
      { key: 'rep', label: 'Rep', type: 'text', dim: true },
      { key: 'brand', label: 'Brand', type: 'text', dim: true },
      { key: 'sku', label: 'SKU', type: 'text', dim: true },
      { key: 'product', label: 'Product', type: 'text', dim: true },
      { key: 'qty', label: 'Qty', type: 'number' },
      { key: 'unitPrice', label: 'Unit price', type: 'money' },
      { key: 'discount', label: 'Discount %', type: 'number' },
      { key: 'lineTotal', label: 'Line total ex GST', type: 'money' },
    ],
  },
  products: {
    label: 'Products and stock',
    blurb: 'Every product with stock, prices, status and ETA.',
    filters: ['brands', 'categories', 'statuses', 'inStockOnly'],
    columns: [
      { key: 'sku', label: 'SKU', type: 'text', dim: true },
      { key: 'name', label: 'Product', type: 'text', dim: true },
      { key: 'brand', label: 'Brand', type: 'text', dim: true },
      { key: 'category', label: 'Category', type: 'text', dim: true },
      { key: 'status', label: 'Status', type: 'text', dim: true },
      { key: 'onHand', label: 'On hand', type: 'number' },
      { key: 'allocated', label: 'Allocated', type: 'number' },
      { key: 'available', label: 'Available', type: 'number' },
      { key: 'onOrder', label: 'On order', type: 'number' },
      { key: 'eta', label: 'ETA', type: 'date', dim: true },
      { key: 'etaSource', label: 'ETA from', type: 'text', dim: true },
      { key: 'wholesale', label: 'Wholesale (ex GST)', type: 'money' },
      { key: 'rrp', label: 'RRP (ex GST)', type: 'money' },
      { key: 'stockValue', label: 'Stock value at wholesale', type: 'money' },
      { key: 'photo', label: 'Photo link', type: 'text' },
    ],
  },
  customers: {
    label: 'Customers and accounts',
    blurb: 'Every account you can see, with its status, contact details and spend.',
    filters: ['states', 'categories', 'statuses', 'reps', 'includeArchived'],
    columns: [
      { key: 'name', label: 'Account', type: 'text', dim: true },
      { key: 'state', label: 'State', type: 'text', dim: true },
      { key: 'category', label: 'Category', type: 'text', dim: true },
      { key: 'rep', label: 'Rep', type: 'text', dim: true },
      { key: 'status', label: 'Status', type: 'text', dim: true },
      { key: 'contact', label: 'Contact', type: 'text' },
      { key: 'phone', label: 'Phone', type: 'text' },
      { key: 'email', label: 'Email', type: 'text' },
      { key: 'spend30', label: 'Spend 30 days', type: 'money' },
      { key: 'spend90', label: 'Spend 90 days', type: 'money' },
      { key: 'spend365', label: 'Spend 365 days', type: 'money' },
      { key: 'lastOrder', label: 'Last order', type: 'date', dim: true },
    ],
  },
};
export const CUSTOMER_STATUSES = ['Active', 'Inactive', 'New Lead', 'Prospect'];
export const MAX_ROWS = 50000;

// A mistake in what was asked for, with a message that is safe to show (unlike a database error).
export class ReportInputError extends Error {}

// ---- Checking what the browser sent ----
const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
const strings = (v: unknown, max = 200) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 200).slice(0, max) : []);

export function parseDefinition(raw: unknown): Definition {
  const o = (raw ?? {}) as any;
  const ds = DATASETS[o.dataset as DatasetKey];
  if (!ds) throw new ReportInputError('Pick what the report is about');
  const keys = ds.columns.map(c => c.key);
  const columns = strings(o.columns).filter(k => keys.includes(k));
  if (!columns.length) throw new ReportInputError('Tick at least one column');
  const groupBy = strings(o.groupBy).filter(k => ds.columns.find(c => c.key === k)?.dim);
  const f = (o.filters ?? {}) as any;
  const filters: Filters = {};
  if (ds.filters.includes('from') && isDay(f.from)) filters.from = f.from;
  if (ds.filters.includes('to') && isDay(f.to)) filters.to = f.to;
  if (filters.from && filters.to && filters.from > filters.to) throw new ReportInputError('The "from" date is after the "to" date');
  for (const k of ['brands', 'states', 'categories', 'reps'] as const) if (ds.filters.includes(k) && strings(f[k]).length) filters[k] = strings(f[k]);
  if (ds.filters.includes('statuses') && strings(f.statuses).length) {
    // Product statuses are managers' to add and remove, so a key is only checked for being shaped like one here; one that no longer
    // exists simply matches nothing when the report runs.
    filters.statuses = o.dataset === 'products' ? strings(f.statuses).filter(s => s === 'none' || /^[a-z0-9_]{1,40}$/.test(s)) : strings(f.statuses).filter(s => CUSTOMER_STATUSES.includes(s));
  }
  for (const k of ['realOrdersOnly', 'inStockOnly', 'includeArchived'] as const) if (ds.filters.includes(k) && typeof f[k] === 'boolean') filters[k] = f[k];
  const sort = o.sort && keys.includes(o.sort.key) ? { key: String(o.sort.key), dir: (o.sort.dir === 'desc' ? 'desc' : 'asc') as 'asc' | 'desc' } : undefined;
  return { dataset: o.dataset, columns, filters, groupBy, sort };
}

// ---- Loading rows ----
type Row = Record<string, string | number | null>;
const r2 = (n: number) => Math.round(n * 100) / 100;
const dayStr = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : null);

async function scopeIds(rep: Rep): Promise<string[] | null> {
  if (rep.role === 'manager') return null;
  return (await prisma.account.findMany({ where: await territoryWhere(rep as any), select: { id: true } })).map(a => a.id);
}
const and = (parts: Prisma.Sql[]) => (parts.length ? Prisma.sql`and ${Prisma.join(parts, ' and ')}` : Prisma.empty);

async function loadSales(f: Filters, rep: Rep): Promise<Row[]> {
  const ids = await scopeIds(rep);
  const w: Prisma.Sql[] = [];
  if (ids) w.push(Prisma.sql`a.id = any(${ids}::uuid[])`);
  if (f.from) w.push(Prisma.sql`(q.sent_at at time zone 'Australia/Melbourne')::date >= ${f.from}::date`);
  if (f.to) w.push(Prisma.sql`(q.sent_at at time zone 'Australia/Melbourne')::date <= ${f.to}::date`);
  if (f.brands?.length) w.push(Prisma.sql`l.brand = any(${f.brands}::text[])`);
  if (f.states?.length) w.push(Prisma.sql`a.region = any(${f.states}::text[])`);
  if (f.categories?.length) w.push(Prisma.sql`coalesce(nullif(a.category, ''), 'Uncategorized') = any(${f.categories}::text[])`);
  if (f.realOrdersOnly !== false) w.push(Prisma.sql`upper(coalesce(q.fulfillment_status, '')) not in ('DRAFT', 'ESTIMATING', 'ESTIMATED', 'ORDERING', 'VOIDED', 'CREDITED')`);
  const rows = await prisma.$queryRaw<any[]>(Prisma.sql`
    select (q.sent_at at time zone 'Australia/Melbourne')::date::text as order_date, q.number as order_no,
           coalesce(q.fulfillment_status, '') as status, a.name as customer, a.region as state,
           coalesce(nullif(a.category, ''), 'Uncategorized') as category, rp.name as rep,
           l.brand, l.sku, l.product_name as product, l.quantity::float8 as qty, l.unit_price::float8 as unit_price,
           l.discount::float8 as discount, l.line_total::float8 as line_total
    from crm.quote_lines l
    join crm.quotes q on q.id = l.quote_id
    join crm.accounts a on a.id = q.account_id
    left join crm.reps rp on rp.id = a.rep_id
    where q.source <> 'rhino-history' and q.number not like 'Q%' ${and(w)}
    order by q.sent_at desc, q.number, l.sku
    limit ${MAX_ROWS + 1}`);
  return rows.map(r => ({
    orderDate: r.order_date, orderMonth: String(r.order_date).slice(0, 7), orderNo: r.order_no, status: r.status.charAt(0) + r.status.slice(1).toLowerCase(),
    customer: r.customer, state: r.state, category: r.category, rep: r.rep ?? '', brand: r.brand ?? '', sku: r.sku, product: r.product,
    qty: r.qty, unitPrice: r.unit_price, discount: r.discount, lineTotal: r.line_total,
  }));
}

async function loadProducts(f: Filters, today: string): Promise<Row[]> {
  const w: any[] = [{ OR: [{ status: null }, { status: { not: 'Deprecated' } }] }];
  if (f.brands?.length) w.push({ brand: { in: f.brands } });
  if (f.categories?.length) w.push({ category: { in: f.categories } });
  if (f.inStockOnly) w.push({ available: { gt: 0 } });
  const statusList = await listStatuses();
  if (f.statuses?.length) {
    const keys = f.statuses.filter(k => statusList.some(s => s.key === k));
    w.push({ OR: [...(keys.length ? [{ lifecycle: { in: keys } }] : []), ...(f.statuses.includes('none') ? [{ lifecycle: null }] : [])] });
  }
  const products = await prisma.product.findMany({ where: { AND: w }, orderBy: [{ brand: 'asc' }, { sku: 'asc' }], take: MAX_ROWS + 1 });
  const incoming = await incomingFor(products.map(p => p.sku));
  const price = (prices: any, re: RegExp) => { const hit = Object.entries((prices ?? {}) as Record<string, number>).find(([n]) => re.test(n)); return hit ? hit[1] : null; };
  return products.map(p => {
    const eta = chooseEta(p.eta, p.onOrder, incoming.get(p.sku) ?? [], today);
    const wholesale = price(p.prices, /^wholesale$/i);
    return {
      sku: p.sku, name: p.name, brand: p.brand ?? '', category: p.category ?? '', status: statusList.find(s => s.key === p.lifecycle)?.label ?? '',
      onHand: p.onHand, allocated: p.allocated, available: p.available, onOrder: p.onOrder,
      eta: eta?.date ?? null, etaSource: eta ? (eta.source === 'manual' ? 'Set by hand' : eta.ref ? `PO ${eta.ref}` : 'Incoming order') : '',
      wholesale, rrp: price(p.prices, /retail|rrp/i), stockValue: wholesale != null ? r2(p.available * wholesale) : null, photo: p.imageUrl ?? '',
    };
  });
}

async function loadCustomers(f: Filters, rep: Rep): Promise<Row[]> {
  const ids = await scopeIds(rep);
  const w: Prisma.Sql[] = [];
  if (ids) w.push(Prisma.sql`a.id = any(${ids}::uuid[])`);
  if (!f.includeArchived) w.push(Prisma.sql`a.archived = false and a.misc = false`);
  if (f.states?.length) w.push(Prisma.sql`a.region = any(${f.states}::text[])`);
  if (f.categories?.length) w.push(Prisma.sql`coalesce(nullif(a.category, ''), 'Uncategorized') = any(${f.categories}::text[])`);
  if (f.statuses?.length) w.push(Prisma.sql`s.status = any(${f.statuses}::text[])`);
  if (f.reps?.length) w.push(Prisma.sql`rp.name = any(${f.reps}::text[])`);
  const rows = await prisma.$queryRaw<any[]>(Prisma.sql`
    select a.name, a.region as state, coalesce(nullif(a.category, ''), 'Uncategorized') as category, rp.name as rep, s.status,
           a.contact_name as contact, a.phone, a.email, a.spend_30::float8 as spend30, a.spend_90::float8 as spend90,
           a.spend_365::float8 as spend365, (s.last_order at time zone 'Australia/Melbourne')::date::text as last_order
    from crm.accounts a
    left join crm.account_status s on s.account_id = a.id
    left join crm.reps rp on rp.id = a.rep_id
    where true ${and(w)}
    order by a.name
    limit ${MAX_ROWS + 1}`);
  return rows.map(r => ({
    name: r.name, state: r.state, category: r.category, rep: r.rep ?? '', status: r.status ?? '', contact: r.contact ?? '', phone: r.phone ?? '', email: r.email ?? '',
    spend30: r.spend30, spend90: r.spend90, spend365: r.spend365, lastOrder: r.last_order ?? null,
  }));
}

// ---- Shaping: add up by group, order, keep the chosen columns ----
export type Shaped = { columns: Col[]; rows: Row[] };
export function shape(def: Definition, rows: Row[]): Shaped {
  const all = DATASETS[def.dataset].columns;
  const chosen = all.filter(c => def.columns.includes(c.key));
  let outCols: Col[] = chosen;
  let out: Row[] = rows;

  if (def.groupBy.length) {
    const dims = all.filter(c => def.groupBy.includes(c.key));
    const measures = chosen.filter(c => (c.type === 'number' || c.type === 'money') && !def.groupBy.includes(c.key));
    const groups = new Map<string, Row>();
    for (const r of rows) {
      const k = dims.map(d => String(r[d.key] ?? '')).join('\u0001');
      let g = groups.get(k);
      if (!g) { g = { ...Object.fromEntries(dims.map(d => [d.key, r[d.key] ?? ''])), rows: 0, ...Object.fromEntries(measures.map(m => [m.key, 0])) }; groups.set(k, g); }
      (g.rows as number) += 1;
      for (const m of measures) g[m.key] = (g[m.key] as number) + (Number(r[m.key]) || 0);
    }
    outCols = [...dims, { key: 'rows', label: 'Rows', type: 'number' as ColType }, ...measures];
    out = [...groups.values()].map(g => { for (const m of measures) g[m.key] = r2(g[m.key] as number); return g; });
  }

  const sortKey = def.sort && outCols.some(c => c.key === def.sort!.key) ? def.sort : undefined;
  if (sortKey) {
    const dir = sortKey.dir === 'desc' ? -1 : 1;
    const isNum = outCols.find(c => c.key === sortKey.key)!.type === 'number' || outCols.find(c => c.key === sortKey.key)!.type === 'money';
    out = [...out].sort((a, b) => {
      const x = a[sortKey.key], y = b[sortKey.key];
      if (x == null && y == null) return 0;
      if (x == null) return 1;   // blanks last, whichever way it sorts
      if (y == null) return -1;
      return dir * (isNum ? Number(x) - Number(y) : String(x).localeCompare(String(y), 'en', { numeric: true }));
    });
  }
  return { columns: outCols, rows: out.map(r => Object.fromEntries(outCols.map(c => [c.key, r[c.key] ?? null]))) };
}

export async function runReport(def: Definition, rep: Rep, today: string): Promise<Shaped & { total: number }> {
  const rows = def.dataset === 'sales' ? await loadSales(def.filters, rep)
    : def.dataset === 'products' ? await loadProducts(def.filters, today)
    : await loadCustomers(def.filters, rep);
  if (rows.length > MAX_ROWS) throw new ReportInputError(`That is more than ${MAX_ROWS.toLocaleString('en-AU')} rows. Add a filter, or add it up by group.`);
  const s = shape(def, rows);
  return { ...s, total: s.rows.length };
}

// What the builder needs to offer: the datasets, and the choices for each filter.
export async function reportMeta(rep: Rep) {
  const statusList = await listStatuses();
  const [brands, productCategories, accountCategories, reps] = await Promise.all([
    prisma.product.findMany({ where: { brand: { not: null } }, select: { brand: true }, distinct: ['brand'], orderBy: { brand: 'asc' } }),
    prisma.product.findMany({ where: { category: { not: null } }, select: { category: true }, distinct: ['category'], orderBy: { category: 'asc' } }),
    prisma.account.findMany({ where: { category: { not: null } }, select: { category: true }, distinct: ['category'], orderBy: { category: 'asc' } }),
    prisma.rep.findMany({ select: { name: true }, orderBy: { name: 'asc' } }),
  ]);
  return {
    datasets: Object.entries(DATASETS).map(([key, d]) => ({ key, label: d.label, blurb: d.blurb, filters: d.filters, columns: d.columns })),
    options: {
      brands: brands.map(b => b.brand as string),
      productCategories: productCategories.map(c => c.category as string),
      accountCategories: [...new Set([...accountCategories.map(c => c.category as string).filter(Boolean), 'Uncategorized'])].sort(),
      states: ['NSW', 'ACT', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'NT', 'NZ', 'NSW/HO', 'VIC/HO', 'INTL', 'Unknown'],
      productStatuses: [...statusList.map(s => ({ key: s.key as string, label: s.label })), { key: 'none', label: 'No status' }],
      customerStatuses: CUSTOMER_STATUSES,
      reps: rep.role === 'manager' ? reps.map(r => r.name) : [],
    },
  };
}