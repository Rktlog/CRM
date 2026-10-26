import { prisma } from './prisma';

// The nine ordering reports as CSV files, worked out from the CRM database (DEAR is synced into it), so nothing has to be exported from DEAR by hand.
// They follow your export settings: all brands with a Brand column; no status filter (every status is included, with a Status column, and a
// "Counts as a sale" column so nothing is double counted); amounts as stored from DEAR in base currency; the date ranges you choose.
// Dates are calendar days exactly as DEAR gives them (no time zone shifting), and a range includes both its first and last day.

export type Range = { from: string; to: string };
export type Cell = string | number | null;
export type Table = { header: string[]; rows: Cell[][]; capped: boolean };
export type ReportKey = 'availability' | 'sale-order-details' | 'customer-orders-by-product' | 'sale-overview' | 'sale-backorder-details' | 'sale-outstanding-quotes' | 'inventory-movement-details' | 'pending-purchase-orders' | 'purchase-order-details';
export type Basis = 'now' | 'period' | 'year';

export const REPORTS: { key: ReportKey; no: number; title: string; file: string; basis: Basis; note: string }[] = [
  { key: 'availability', no: 1, title: 'Availability Report', file: 'availability-report', basis: 'now', note: 'Today, every product including zero stock, one row per location.' },
  { key: 'sale-order-details', no: 2, title: 'Sale Order Details', file: 'sale-order-details', basis: 'period', note: 'One row per order line, by order date, every status.' },
  { key: 'customer-orders-by-product', no: 3, title: 'Customer Orders by Product', file: 'customer-orders-by-product', basis: 'period', note: 'Each customer and product: orders, units and value. Quotes, drafts and voided orders are not counted.' },
  { key: 'sale-overview', no: 4, title: 'Sale Overview', file: 'sale-overview', basis: 'period', note: 'One row per order with its status, totals and payments, every status.' },
  { key: 'sale-backorder-details', no: 5, title: 'Sale Backorder Details', file: 'sale-backorder-details', basis: 'now', note: 'As at today: units customers are waiting for on open orders.' },
  { key: 'sale-outstanding-quotes', no: 6, title: 'Sale Outstanding Quotes', file: 'sale-outstanding-quotes', basis: 'year', note: 'Quotes and drafts not yet orders, one row per line, by quote date.' },
  { key: 'inventory-movement-details', no: 7, title: 'Inventory Movement Details', file: 'inventory-movement-details', basis: 'year', note: 'Sales invoiced, purchases received and stock adjustments, by movement date.' },
  { key: 'pending-purchase-orders', no: 8, title: 'Pending Purchase Orders', file: 'pending-purchase-orders', basis: 'year', note: 'Purchase order lines still to arrive, by order date.' },
  { key: 'purchase-order-details', no: 9, title: 'Purchase Order Details', file: 'purchase-order-details', basis: 'year', note: 'Every purchase order line, by order date, with what has arrived.' },
];

// ---- dates (calendar days as text, YYYY-MM-DD) ----
export const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;
const dayMs = (d: string) => Date.parse(d + 'T00:00:00Z');
export const addDays = (d: string, n: number) => new Date(dayMs(d) + n * 86400000).toISOString().slice(0, 10);
export const melbourneToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Melbourne' });
// The default ranges: the sales reports from the start of the financial year (1 July) to today; the others the last 12 months to today.
export function exportDefaults(today: string): { period: Range; year: Range } {
  const y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7));
  const yearAgo = `${y - 1}-${today.slice(5)}`;
  return { period: { from: `${m >= 7 ? y : y - 1}-07-01`, to: today }, year: { from: isDay(yearAgo) ? yearAgo : `${y - 1}-02-28`, to: today } };
}
export function checkRange(from: unknown, to: unknown): { range?: Range; error?: string } {
  if (!isDay(from) || !isDay(to)) return { error: 'Dates must look like 2026-10-31' };
  if (to < from) return { error: 'The end date is before the start date' };
  if ((dayMs(to) - dayMs(from)) / 86400000 > 1100) return { error: 'A range can be at most 3 years' };
  return { range: { from, to } };
}

// ---- CSV ----
const CELL_NUMBER = /^-?\d+(\.\d+)?$/;
export function csvCell(v: Cell): string {
  let s = v == null ? '' : typeof v === 'number' ? String(Math.round(v * 10000) / 10000) : v;
  if (/^[=+\-@\t\r]/.test(s) && !CELL_NUMBER.test(s)) s = "'" + s;   // a spreadsheet would treat this as a formula
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
export const toCsv = (t: { header: string[]; rows: Cell[][] }) => '\ufeff' + [t.header.map(csvCell).join(','), ...t.rows.map(r => r.map(csvCell).join(','))].join('\r\n') + '\r\n';

// ---- ZIP (stored, no compression: the files are text and this needs no extra library) ----
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export const crc32 = (b: Buffer) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
export function makeZip(files: { name: string; data: Buffer }[], when = new Date()): Buffer {
  const time = (when.getUTCHours() << 11) | (when.getUTCMinutes() << 5) | (when.getUTCSeconds() >> 1);
  const date = ((Math.max(when.getUTCFullYear(), 1980) - 1980) << 9) | ((when.getUTCMonth() + 1) << 5) | when.getUTCDate();
  const parts: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8'), crc = crc32(f.data), local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8); local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(f.data.length, 18); local.writeUInt32LE(f.data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    parts.push(local, name, f.data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(0, 10); c.writeUInt16LE(time, 12); c.writeUInt16LE(date, 14);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(f.data.length, 20); c.writeUInt32LE(f.data.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, name); offset += 30 + name.length + f.data.length;
  }
  const centralBuf = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(centralBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBuf, end]);
}

// ---- the reports ----
const CAP = 300000;                       // rows per report; if a report reaches it, the README says so
const NOT_SALES = ['DRAFT', 'ESTIMATING', 'ESTIMATED', 'ORDERING', 'VOIDED', 'CREDITED', 'QUOTE'];   // not counted as a sale (the same rule the Assistant's forecast uses, plus QUOTE)
const QUOTES = ['DRAFT', 'ESTIMATING', 'ESTIMATED', 'QUOTE'];
const CLOSED = ['COMPLETED', 'VOIDED', 'CREDITED', ...QUOTES, 'ORDERING'];
const yn = (b: unknown) => (b ? 'Yes' : 'No');
const STANDARD_STAGES: Record<string, string> = { eol: 'EOL', discontinued: 'Discontinued', preorder_only: 'Preorder Only', new: 'New', ranging: 'Confirmed for Ranging', customer_only: 'For Customer Only Then Cease', phasing_out: 'Phasing Out' };
async function stageLabels(): Promise<Map<string, string>> {
  try { return new Map((await prisma.$queryRaw<{ key: string; label: string }[]>`select key, label from crm.product_statuses`).map(s => [s.key, s.label])); }
  catch { return new Map(Object.entries(STANDARD_STAGES)); }
}

export async function runReport(key: ReportKey, r: Range): Promise<Table> {
  const finish = (header: string[], rows: Cell[][]): Table => ({ header, rows, capped: rows.length >= CAP });
  switch (key) {
    case 'availability': {
      const [products, stages] = await Promise.all([prisma.$queryRaw<any[]>`
        select sku, name, brand, category, lifecycle, uom, on_hand::float8 as on_hand, allocated::float8 as allocated, available::float8 as available, on_order::float8 as on_order, locations,
               to_char(eta, 'YYYY-MM-DD') as eta, order_increment, barcode, to_char(stock_synced_at, 'YYYY-MM-DD HH24:MI') as synced
        from crm.products order by brand nulls last, sku limit ${CAP}`, stageLabels()]);
      const rows: Cell[][] = [];
      for (const p of products) {
        const locs: any[] = Array.isArray(p.locations) && p.locations.length ? p.locations : [null];
        for (const l of locs) rows.push([p.sku, p.name, p.brand, p.category, p.lifecycle ? stages.get(p.lifecycle) ?? p.lifecycle : '', p.uom, l?.location ?? '', l ? l.onHand : p.on_hand, l ? l.allocated : p.allocated, l ? l.available : p.available, l ? l.onOrder : p.on_order,
          p.on_hand, p.available, p.eta, p.order_increment, p.barcode, p.synced]);
      }
      return finish(['SKU', 'Product', 'Brand', 'Category', 'Stage', 'Unit', 'Location', 'On hand', 'Allocated', 'Available', 'On order', 'Product on hand (all locations)', 'Product available (all locations)', 'Next arrival', 'Order increment', 'Barcode', 'Stock last synced'], rows);
    }
    case 'sale-order-details': {
      const x = await prisma.$queryRaw<any[]>`
        select q.number, to_char(q.sent_at, 'YYYY-MM-DD') as odate, to_char(q.invoice_date, 'YYYY-MM-DD') as idate, a.name as customer, a.region, q.reference, q.fulfillment_status as status, q.shipping_status, q.payment_status, q.source,
               l.sku, l.product_name, l.brand, l.quantity::float8 as qty, l.unit_price::float8 as price, l.discount::float8 as discount, l.tax::float8 as tax, l.line_total::float8 as total
        from crm.quotes q join crm.accounts a on a.id = q.account_id join crm.quote_lines l on l.quote_id = q.id
        where q.sent_at >= ${r.from}::date and q.sent_at < (${r.to}::date + 1) order by q.sent_at, q.number, l.sku limit ${CAP}`;
      return finish(['Order no', 'Order date', 'Invoice date', 'Customer', 'State', 'Customer reference', 'Order status', 'Shipping status', 'Payment status', 'Counts as a sale', 'Source', 'SKU', 'Product', 'Brand', 'Quantity', 'Unit price', 'Discount', 'Tax', 'Line total'],
        x.map(o => [o.number, o.odate, o.idate, o.customer, o.region, o.reference, o.status, o.shipping_status, o.payment_status, yn(!NOT_SALES.includes(String(o.status ?? '').toUpperCase())), o.source, o.sku, o.product_name, o.brand, o.qty, o.price, o.discount, o.tax, o.total]));
    }
    case 'customer-orders-by-product': {
      const x = await prisma.$queryRaw<any[]>`
        select a.name as customer, a.region, l.sku, max(l.product_name) as product, max(l.brand) as brand, count(distinct q.id)::int as orders, sum(l.quantity)::float8 as qty, sum(l.line_total)::float8 as total,
               to_char(min(q.sent_at), 'YYYY-MM-DD') as first_order, to_char(max(q.sent_at), 'YYYY-MM-DD') as last_order
        from crm.quotes q join crm.accounts a on a.id = q.account_id join crm.quote_lines l on l.quote_id = q.id
        where q.sent_at >= ${r.from}::date and q.sent_at < (${r.to}::date + 1) and upper(coalesce(q.fulfillment_status, '')) <> all(${NOT_SALES}::text[])
        group by a.name, a.region, l.sku order by a.name, l.sku limit ${CAP}`;
      return finish(['Customer', 'State', 'SKU', 'Product', 'Brand', 'Orders', 'Quantity', 'Value', 'First order', 'Last order'], x.map(o => [o.customer, o.region, o.sku, o.product, o.brand, o.orders, o.qty, o.total, o.first_order, o.last_order]));
    }
    case 'sale-overview': {
      const x = await prisma.$queryRaw<any[]>`
        select q.number, to_char(q.sent_at, 'YYYY-MM-DD') as odate, to_char(q.invoice_date, 'YYYY-MM-DD') as idate, q.invoice_number, a.name as customer, a.region, rp.name as rep, q.reference, q.fulfillment_status as status, q.picking_status, q.shipping_status, q.payment_status,
               q.source, q.goods_total::float8 as goods, q.tax_total::float8 as tax, coalesce(q.total, q.amount)::float8 as total, q.invoiced_total::float8 as invoiced, q.credited_total::float8 as credited, q.amount_paid::float8 as paid, q.amount_due::float8 as due, to_char(q.paid_at, 'YYYY-MM-DD') as paid_on
        from crm.quotes q join crm.accounts a on a.id = q.account_id left join crm.reps rp on rp.id = a.rep_id
        where q.sent_at >= ${r.from}::date and q.sent_at < (${r.to}::date + 1) order by q.sent_at, q.number limit ${CAP}`;
      return finish(['Order no', 'Order date', 'Invoice date', 'Invoice no', 'Customer', 'State', 'Rep', 'Customer reference', 'Order status', 'Picking status', 'Shipping status', 'Payment status', 'Counts as a sale', 'Source', 'Goods total', 'Tax', 'Total', 'Invoiced total', 'Credited', 'Amount paid', 'Amount due', 'Paid on'],
        x.map(o => [o.number, o.odate, o.idate, o.invoice_number, o.customer, o.region, o.rep, o.reference, o.status, o.picking_status, o.shipping_status, o.payment_status, yn(!NOT_SALES.includes(String(o.status ?? '').toUpperCase())), o.source, o.goods, o.tax, o.total, o.invoiced, o.credited, o.paid, o.due, o.paid_on]));
    }
    case 'sale-backorder-details': {
      const x = await prisma.$queryRaw<any[]>`
        with lines as (
          select q.id, q.number, q.sent_at, q.fulfillment_status as status, q.shipping_status, a.name as customer, a.region, l.sku, max(l.product_name) as product, max(l.brand) as brand,
                 sum(l.quantity) as qty, max(q.line_fulfilment::text)::jsonb as lf
          from crm.quotes q join crm.accounts a on a.id = q.account_id join crm.quote_lines l on l.quote_id = q.id
          where q.source <> 'rhino-history' and q.number not like 'Q%' and q.misc_type is null
            and upper(coalesce(q.fulfillment_status, '')) <> all(${CLOSED}::text[]) and upper(coalesce(q.shipping_status, '')) <> 'SHIPPED'
          group by q.id, q.number, q.sent_at, q.fulfillment_status, q.shipping_status, a.name, a.region, l.sku),
        calc as (
          select *, least(coalesce(nullif(lf -> sku ->> 'shipped', '')::float8, 0), qty) as shipped,
                 least(coalesce(nullif(lf -> sku ->> 'backordered', '')::float8, 0), greatest(qty - coalesce(nullif(lf -> sku ->> 'shipped', '')::float8, 0), 0)) as backordered
          from lines)
        select c.number, to_char(c.sent_at, 'YYYY-MM-DD') as odate, c.customer, c.region, c.status, c.shipping_status, c.sku, c.product, c.brand, c.qty::float8 as ordered, c.shipped::float8 as shipped, c.backordered::float8 as backordered,
               p.available::float8 as available, p.on_order::float8 as on_order, to_char(p.eta, 'YYYY-MM-DD') as eta
        from calc c left join crm.products p on p.sku = c.sku where c.backordered > 0 order by c.sent_at, c.number, c.sku limit ${CAP}`;
      return finish(['Order no', 'Order date', 'Customer', 'State', 'Order status', 'Shipping status', 'SKU', 'Product', 'Brand', 'Ordered', 'Shipped', 'Backordered', 'Available now', 'On order', 'Next arrival'],
        x.map(o => [o.number, o.odate, o.customer, o.region, o.status, o.shipping_status, o.sku, o.product, o.brand, o.ordered, o.shipped, o.backordered, o.available, o.on_order, o.eta]));
    }
    case 'sale-outstanding-quotes': {
      const x = await prisma.$queryRaw<any[]>`
        select q.number, to_char(q.sent_at, 'YYYY-MM-DD') as qdate, a.name as customer, a.region, q.fulfillment_status as status, q.reference, l.sku, l.product_name, l.brand, l.quantity::float8 as qty, l.unit_price::float8 as price, l.line_total::float8 as total,
               (current_date - q.sent_at::date)::int as age
        from crm.quotes q join crm.accounts a on a.id = q.account_id join crm.quote_lines l on l.quote_id = q.id
        where q.source <> 'rhino-history' and q.number not like 'Q%' and q.misc_type is null and upper(coalesce(q.fulfillment_status, '')) = any(${QUOTES}::text[])
          and q.sent_at >= ${r.from}::date and q.sent_at < (${r.to}::date + 1) order by q.sent_at, q.number, l.sku limit ${CAP}`;
      return finish(['Quote no', 'Quote date', 'Customer', 'State', 'Status', 'Customer reference', 'SKU', 'Product', 'Brand', 'Quantity', 'Unit price', 'Line total', 'Age (days)'], x.map(o => [o.number, o.qdate, o.customer, o.region, o.status, o.reference, o.sku, o.product_name, o.brand, o.qty, o.price, o.total, o.age]));
    }
    case 'inventory-movement-details': {
      const x = await prisma.$queryRaw<any[]>`
        select * from (
          select q.invoice_date::date as mdate, 'Sale invoiced' as type, l.sku, l.product_name as product, l.brand, -l.quantity::float8 as qty, q.number as ref, a.name as party, null::text as location, null::float8 as unit_cost
          from crm.quotes q join crm.accounts a on a.id = q.account_id join crm.quote_lines l on l.quote_id = q.id
          where q.invoice_date is not null and upper(coalesce(q.fulfillment_status, '')) <> all(${NOT_SALES}::text[]) and q.invoice_date >= ${r.from}::date and q.invoice_date < (${r.to}::date + 1)
          union all
          select pl.last_received_at::date, 'Purchase received', pl.sku, pl.product_name, p2.brand, pl.quantity_received::float8, p.number, p.supplier, null, null
          from crm.purchase_lines pl join crm.purchases p on p.id = pl.purchase_id left join crm.products p2 on p2.sku = pl.sku
          where pl.quantity_received > 0 and pl.last_received_at >= ${r.from}::date and pl.last_received_at < (${r.to}::date + 1)
          union all
          select sa.effective_date::date, 'Stock adjustment (' || coalesce(al.kind, '') || ')', al.sku, al.product_name, p3.brand, al.quantity::float8, sa.number, coalesce(sa.reference, sa.comment), al.location, al.unit_cost::float8
          from crm.stock_adjustment_lines al join crm.stock_adjustments sa on sa.id = al.adjustment_id left join crm.products p3 on p3.sku = al.sku
          where sa.effective_date >= ${r.from}::date and sa.effective_date < (${r.to}::date + 1) and upper(coalesce(sa.status, '')) <> 'VOIDED') m
        order by mdate, type, sku limit ${CAP}`;
      return finish(['Stock movement date', 'Type', 'SKU', 'Product', 'Brand', 'Quantity (+ in, - out)', 'Reference', 'Customer / supplier / reason', 'Location', 'Unit cost'],
        x.map(o => [o.mdate instanceof Date ? o.mdate.toISOString().slice(0, 10) : o.mdate, o.type, o.sku, o.product, o.brand, o.qty, o.ref, o.party, o.location, o.unit_cost]));
    }
    case 'pending-purchase-orders': {
      const x = await prisma.$queryRaw<any[]>`
        select p.number, p.supplier, p.status, p.receiving_status, to_char(p.order_date, 'YYYY-MM-DD') as odate, to_char(p.required_by, 'YYYY-MM-DD') as required, l.sku, l.product_name, p2.brand,
               l.quantity_ordered::float8 as ordered, l.quantity_received::float8 as received, greatest(l.quantity_ordered - l.quantity_received, 0)::float8 as outstanding,
               case when p.required_by is not null and p.required_by::date < current_date then (current_date - p.required_by::date)::int end as overdue
        from crm.purchase_lines l join crm.purchases p on p.id = l.purchase_id left join crm.products p2 on p2.sku = l.sku
        where upper(coalesce(p.status, '')) not in ('VOIDED', 'CREDITED', 'DRAFT')
          and not (upper(coalesce(p.receiving_status, '')) like '%FULLY RECEIVED%' or upper(coalesce(p.status, '')) like 'COMPLETED%' or upper(coalesce(p.status, '')) = 'RECEIVED')
          and l.quantity_ordered - l.quantity_received > 0 and p.order_date >= ${r.from}::date and p.order_date < (${r.to}::date + 1)
        order by p.required_by nulls last, p.number, l.sku limit ${CAP}`;
      return finish(['PO no', 'Supplier', 'Status', 'Receiving status', 'Order date', 'Required by', 'SKU', 'Product', 'Brand', 'Ordered', 'Received', 'Outstanding', 'Days overdue'],
        x.map(o => [o.number, o.supplier, o.status, o.receiving_status, o.odate, o.required, o.sku, o.product_name, o.brand, o.ordered, o.received, o.outstanding, o.overdue]));
    }
    case 'purchase-order-details': {
      const x = await prisma.$queryRaw<any[]>`
        select p.number, p.supplier, p.status, p.receiving_status, to_char(p.order_date, 'YYYY-MM-DD') as odate, to_char(p.required_by, 'YYYY-MM-DD') as required, l.sku, l.product_name, p2.brand,
               l.quantity_ordered::float8 as ordered, l.quantity_received::float8 as received, greatest(l.quantity_ordered - l.quantity_received, 0)::float8 as outstanding, to_char(l.last_received_at, 'YYYY-MM-DD') as last_received
        from crm.purchase_lines l join crm.purchases p on p.id = l.purchase_id left join crm.products p2 on p2.sku = l.sku
        where p.order_date >= ${r.from}::date and p.order_date < (${r.to}::date + 1) order by p.order_date, p.number, l.sku limit ${CAP}`;
      return finish(['PO no', 'Supplier', 'Status', 'Receiving status', 'Order date', 'Required by', 'SKU', 'Product', 'Brand', 'Ordered', 'Received', 'Outstanding', 'Last received'],
        x.map(o => [o.number, o.supplier, o.status, o.receiving_status, o.odate, o.required, o.sku, o.product_name, o.brand, o.ordered, o.received, o.outstanding, o.last_received]));
    }
  }
}

// ---- the file names and the README that goes in the zip ----
export const fileName = (key: ReportKey, range: Range | null, today: string) => {
  const r = REPORTS.find(x => x.key === key)!;
  return `${String(r.no).padStart(2, '0')}-${r.file}${r.basis === 'now' || !range ? `_${today}` : `_${range.from}_to_${range.to}`}.csv`;
};
export function readme(today: string, period: Range, year: Range, counts: Record<string, { rows: number; capped: boolean }>): string {
  const lines = [
    `Rhino Radar ordering reports, made ${today} (Melbourne), from the CRM database. DEAR is synced into it, so nothing here was exported from DEAR by hand.`,
    '',
    'Settings applied to every report',
    '  - All brands, with a Brand column.',
    '  - No status filter: every status is included. Order reports carry a Status column and a "Counts as a sale" column (No for quotes, drafts, estimates and voided or credited orders), so filter on that rather than adding everything up.',
    '  - Amounts are the totals stored from DEAR, in base currency.',
    '  - Dates are calendar days as DEAR gives them. A range includes both its first and last day.',
    `  - Sales reports (2 to 4): ${period.from} to ${period.to}. Quotes, movements and purchase orders (6 to 9): ${year.from} to ${year.to}. Availability and backorders (1 and 5) are as at ${today}.`,
    '',
    'The reports',
    ...REPORTS.map(r => `  ${r.no}. ${r.title}: ${counts[r.key]?.rows.toLocaleString('en-AU') ?? 0} rows${counts[r.key]?.capped ? ' (STOPPED at the row limit: shorten the range)' : ''}. ${r.note}`),
    '',
    'Things to know',
    '  - Inventory Movement Details is built from what the CRM holds, not DEAR\'s full movement ledger: sales by invoice date, purchases by the date they were last received (a line received in several parts shows once, on its last date), and stock adjustments by effective date.',
    '  - Pending Purchase Orders and Purchase Order Details cover the purchase orders synced into the CRM. Check an order is missing from them before assuming it does not exist.',
    '  - Quotes and drafts are listed in Sale Outstanding Quotes and are not demand until they become orders.',
    '  - History imported from the old sales spreadsheet has order numbers starting with Q and the source "rhino-history".',
  ];
  return lines.join('\r\n') + '\r\n';
}