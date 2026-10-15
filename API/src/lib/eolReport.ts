// The EOL (end-of-life) sell-through report: what has sold since the start date, and what stock is left, for the
// brands being cleared. Pure functions, no database: exports.ts loads the orders and stock and hands them in.
//
// Sheets (same names and order as the Google Sheet it replaces): raw, CUSTOMER_Summary, CUSTOMER_Sales by SKU,
// CUSTOMER_Purchase, STAFF_Purchase, Remaining Stock, plus a Notes sheet.

export const EOL_BRANDS = ['Pantone Living', 'Rubbabu', 'Nuuroo', 'Jaclyn & Matisse', 'WWF Plush', 'Picca Loulou', 'Bink', 'Zenith', 'Maison Deux', 'Ki ET LA', 'Engelite Peppa Pig'];
// WWF Plush is only being cleared on these products.
const WWF_SKUS = new Set(['IBTT16170001', 'IBTT16170002', 'IBTT16182001', 'IBTT16183010', 'IBTT16183011', 'IBTT16183012', 'IBTT16183013', 'IBTT16183014', 'IBTT16191001', 'IBTT16191006', 'IBTT16191008', 'IBTT16193002', 'IBTT16193003', 'IBTT16193014', 'IBTT16194001', 'IBTT16196002', 'IBTT16202002', 'IBTT16214010', 'IBTT16214013', 'IBTT16215004', 'IBTT16215005', 'IBTT16215006', 'IBTT16215007']);
export const STAFF_CUSTOMER = 'RHINO RHINO TEST';   // staff purchases are kept apart from customer sales
export const DEFAULT_START = '2026-05-22';
export const DEFAULT_CHECKPOINTS = ['2026-06-16', '2026-07-01', '2026-07-17', '2026-07-29', '2026-08-12', '2026-08-26', '2026-09-09', '2026-09-23', '2026-10-14'];

// Is this product part of the clearance? Maison Deux excludes the Miffy, Smiley and Peanuts licensed lines.
export function isEolProduct(brand: string | null | undefined, sku: string, product: string): boolean {
  if (!brand || !EOL_BRANDS.includes(brand)) return false;
  if (brand === 'Maison Deux' && /Miffy|Smiley|Peanuts/.test(product)) return false;
  if (brand === 'WWF Plush' && !WWF_SKUS.has(sku)) return false;
  return true;
}

export type EolLine = {
  orderDate: string; status: string; customer: string; state: string; category: string; contact: string; email: string; phone: string;
  brand: string; sku: string; product: string; qty: number; unitPrice: number; discount: number; lineTotal: number;
  invoiceNo: string | null; invoiceDate: string | null;   // dates are YYYY-MM-DD
  match: '' | 'exact' | 'by shipment' | 'check' | 'not shipped yet';
};
export type EolStock = { sku: string; name: string; brand: string; available: number; rrp: number | null; wholesale: number | null };
export type Sheet = { name: string; aoa: any[][]; merges?: { s: { r: number; c: number }; e: { r: number; c: number } }[]; widths?: number[]; moneyCols?: number[] };

// ---- Which invoice is each order line on? ----
// DEAR's own report knows this line by line. The CRM keeps the order's invoices and its shipments, not the link, so:
//   no invoice yet                      -> not invoiced
//   one shipment per invoice            -> the k-th shipment is the k-th invoice; what shipped is what was invoiced
//   one invoice, order completed        -> every line is on it
//   anything else                       -> all lines on the first invoice, flagged "check"
export type EolOrder = {
  orderDate: string; status: string; completed: boolean;
  account: { name: string; state: string; category: string; contact: string; email: string; phone: string };
  invoices: { number: string | null; date: string | null; status?: string | null }[];
  fulfilments: { shippedAt?: string | null; lines?: { sku: string; qty?: number; quantity?: number }[] }[];
  lines: { sku: string; product: string; brand: string | null; qty: number; unitPrice: number; discount: number; lineTotal: number }[];
};
const r2 = (n: number) => Math.round(n * 100) / 100;

export function allocateInvoices(o: EolOrder): EolLine[] {
  const make = (l: EolOrder['lines'][number], inv: { number: string | null; date: string | null } | null, match: EolLine['match'], qty: number, total: number): EolLine => ({
    orderDate: o.orderDate, status: o.status, customer: o.account.name, state: o.account.state, category: o.account.category,
    contact: o.account.contact, email: o.account.email, phone: o.account.phone,
    brand: l.brand ?? '', sku: l.sku, product: l.product, qty, unitPrice: l.unitPrice, discount: l.discount, lineTotal: r2(total),
    invoiceNo: inv?.number ?? null, invoiceDate: inv?.date ?? null, match,
  });
  const invs = o.invoices
    .filter(i => i.date && !/^VOIDED/i.test(i.status ?? ''))
    .sort((a, b) => a.date!.localeCompare(b.date!) || String(a.number).localeCompare(String(b.number)));
  if (!invs.length) return o.lines.map(l => make(l, null, '', l.qty, l.lineTotal));

  const qtyOf = (x: { qty?: number; quantity?: number }) => Number(x.qty ?? x.quantity ?? 0);
  const ships = o.fulfilments
    .filter(f => f.shippedAt && (f.lines ?? []).some(x => qtyOf(x) > 0))
    .sort((a, b) => a.shippedAt!.localeCompare(b.shippedAt!));

  if (ships.length === invs.length) {
    const left = ships.map(s => {
      const m = new Map<string, number>();
      for (const x of s.lines ?? []) m.set(x.sku, (m.get(x.sku) ?? 0) + qtyOf(x));
      return m;
    });
    const out: EolLine[] = [];
    for (const l of o.lines) {
      if (!(l.qty > 0)) { out.push(make(l, invs[0], 'by shipment', l.qty, l.lineTotal)); continue; }
      let rest = l.qty;
      invs.forEach((inv, k) => {
        if (rest <= 0) return;
        const take = Math.min(rest, left[k].get(l.sku) ?? 0);
        if (take > 0) {
          left[k].set(l.sku, left[k].get(l.sku)! - take);
          out.push(make(l, inv, 'by shipment', take, (l.lineTotal * take) / l.qty));
          rest -= take;
        }
      });
      if (rest > 0) out.push(make(l, null, 'not shipped yet', rest, (l.lineTotal * rest) / l.qty));
    }
    return out;
  }
  if (invs.length === 1 && o.completed) return o.lines.map(l => make(l, invs[0], 'exact', l.qty, l.lineTotal));
  return o.lines.map(l => make(l, invs[0], 'check', l.qty, l.lineTotal));
}

// ---- The workbook ----
export function buildEolReport(p: { lines: EolLine[]; stock: EolStock[]; from: string; checkpoints: string[]; asOf: string }): Sheet[] {
  const { from, asOf } = p;
  const checkpoints = [...new Set(p.checkpoints)].sort();
  const isStaff = (c: string) => c.trim().toUpperCase() === STAFF_CUSTOMER;

  const lines = [...p.lines].sort((a, b) => a.orderDate.localeCompare(b.orderDate) || a.customer.localeCompare(b.customer) || a.sku.localeCompare(b.sku));
  // The sales: invoiced lines, invoice dated on or after the start date, EOL brands only.
  const eol = lines
    .filter(l => l.invoiceNo && l.invoiceDate && l.invoiceDate >= from && isEolProduct(l.brand, l.sku, l.product))
    .sort((a, b) => a.invoiceDate!.localeCompare(b.invoiceDate!) || a.customer.localeCompare(b.customer) || a.brand.localeCompare(b.brand) || a.product.localeCompare(b.product));
  const customer = eol.filter(l => !isStaff(l.customer));
  const staff = eol.filter(l => isStaff(l.customer));
  const sum = (ls: EolLine[], f: (l: EolLine) => number) => r2(ls.reduce((s, l) => s + f(l), 0));
  const qty = (ls: EolLine[]) => sum(ls, l => l.qty);
  const sales = (ls: EolLine[]) => sum(ls, l => l.lineTotal);

  const stock = p.stock
    .filter(s => s.available > 0 && isEolProduct(s.brand, s.sku, s.name))
    .sort((a, b) => a.brand.localeCompare(b.brand) || a.sku.localeCompare(b.sku));
  const stockValue = (s: EolStock) => r2(s.available * (s.wholesale ?? 0));

  // raw
  const rawHead = ['Order Date', 'Status', 'Customer', 'State', 'Business Category', 'Contact Name', 'Email', 'Phone', 'Brand', 'SKU', 'Product', 'Qty', 'Unit Price', 'Discount %', 'Line Total ex GST', 'Invoice #', 'Invoice Date', 'Invoice match'];
  const raw: Sheet = {
    name: 'raw',
    aoa: [rawHead, ...lines.map(l => [l.orderDate, l.status, l.customer, l.state, l.category, l.contact, l.email, l.phone, l.brand, l.sku, l.product, l.qty, l.unitPrice, l.discount, l.lineTotal, l.invoiceNo ?? '', l.invoiceDate ?? '', l.match])],
    widths: [12, 13, 30, 7, 28, 20, 26, 14, 18, 16, 40, 6, 10, 10, 14, 12, 12, 14], moneyCols: [12, 14],
  };

  // CUSTOMER_Summary: by brand, cumulative as at each checkpoint date
  const head1: any[] = ['', '', '', ''];
  const head2: any[] = ['Brand', 'Remaining Stock Qty', 'Remaining Stock Value', ''];
  const merges: Sheet['merges'] = [];
  checkpoints.forEach((cp, i) => {
    head1.push(cp, ''); head2.push('Total Qty', 'Total Sales');
    merges.push({ s: { r: 0, c: 4 + i * 2 }, e: { r: 0, c: 5 + i * 2 } });
  });
  const brandRows = EOL_BRANDS.map(b => {
    const st = stock.filter(s => s.brand === b);
    const row: any[] = [b, sum(st as any, (s: any) => s.available), r2(st.reduce((t, s) => t + stockValue(s), 0)), ''];
    for (const cp of checkpoints) {
      const ls = customer.filter(l => l.brand === b && l.invoiceDate! <= cp);
      row.push(qty(ls), sales(ls));
    }
    return row;
  });
  const total: any[] = ['TOTAL'];
  for (let c = 1; c < head2.length; c++) total.push(c === 3 ? '' : r2(brandRows.reduce((t, r) => t + Number(r[c] || 0), 0)));
  const byCustomer = [...new Set(customer.map(l => l.customer))]
    .map(c => { const ls = customer.filter(l => l.customer === c); return [c, qty(ls), sales(ls)]; })
    .sort((a, b) => Number(b[2]) - Number(a[2]) || String(a[0]).localeCompare(String(b[0])));
  const summary: Sheet = {
    name: 'CUSTOMER_Summary',
    aoa: [head1, head2, ...brandRows, total, [], [], ['BY CUSTOMER', 'Total Qty', 'Total Sales'], ['TOTAL', qty(customer), sales(customer)], ...byCustomer],
    merges, widths: [34, 18, 20, 3, ...checkpoints.flatMap(() => [11, 13])],
    moneyCols: [2, ...checkpoints.map((_, i) => 5 + i * 2)],
  };

  // CUSTOMER_Sales by SKU
  const bySku = new Map<string, { product: string; sku: string; brand: string; qty: number; sales: number }>();
  for (const l of customer) {
    const e = bySku.get(l.sku) ?? { product: l.product, sku: l.sku, brand: l.brand, qty: 0, sales: 0 };
    e.qty += l.qty; e.sales += l.lineTotal; bySku.set(l.sku, e);
  }
  const skuRows = [...bySku.values()].sort((a, b) => b.sales - a.sales || a.sku.localeCompare(b.sku));
  const skuSheet: Sheet = {
    name: 'CUSTOMER_Sales by SKU',
    aoa: [['', '', 'TOTAL', qty(customer), sales(customer)], ['Product', 'SKU', 'Brand', 'Total Qty', 'Total Sales'], ...skuRows.map(s => [s.product, s.sku, s.brand, r2(s.qty), r2(s.sales)])],
    widths: [44, 18, 18, 11, 13], moneyCols: [4],
  };

  // CUSTOMER_Purchase and STAFF_Purchase
  const purchaseHead = ['Customer', 'Customer additional attribute 3', 'Brand', 'Product', 'SKU', 'Order Date', 'Invoice Date', 'TotalQty2026', 'TotalSales2026', 'Discount %', 'Invoice #', 'Invoice match'];
  const purchase = (name: string, ls: EolLine[]): Sheet => ({
    name,
    aoa: [['', '', '', '', '', '', 'TOTAL', qty(ls), sales(ls)], purchaseHead, ...ls.map(l => [l.customer, l.category, l.brand, l.product, l.sku, l.orderDate, l.invoiceDate, l.qty, l.lineTotal, l.discount, l.invoiceNo, l.match])],
    widths: [30, 30, 18, 42, 16, 12, 12, 13, 14, 10, 12, 14], moneyCols: [8],
  });

  // Remaining Stock
  const stockSheet: Sheet = {
    name: 'Remaining Stock',
    aoa: [['', '', 'TOTAL', r2(stock.reduce((t, s) => t + s.available, 0)), '', '', r2(stock.reduce((t, s) => t + stockValue(s), 0))],
      ['SKU', 'Product Name', 'Brand', 'Available', 'RRP (ex GST)', 'Wholesale (ex GST)', 'Total'],
      ...stock.map(s => [s.sku, s.name, s.brand, s.available, s.rrp ?? '', s.wholesale ?? '', stockValue(s)])],
    widths: [20, 44, 18, 10, 13, 17, 13], moneyCols: [4, 5, 6],
  };

  const checkLines = eol.filter(l => l.match === 'check');
  const notes: Sheet = {
    name: 'Notes',
    aoa: [
      ['EOL report, how it is worked out'],
      [`Start date: invoices dated ${from} or later. Report built ${asOf}. Column dates in CUSTOMER_Summary are running totals up to that date.`],
      [`Brands: ${EOL_BRANDS.join(', ')}.`],
      ['Maison Deux leaves out Miffy, Smiley and Peanuts products. WWF Plush is only the 23 listed SKUs.'],
      ['Sales are invoiced lines only, ex GST, after discount (the line total). Credit notes are not taken off.'],
      [`Staff purchases (${STAFF_CUSTOMER}) are on STAFF_Purchase and are not in the customer totals.`],
      ['Stock is what is available now (above zero), valued at the wholesale price ex GST.'],
      ['Invoice match: the CRM keeps an order\'s invoices and shipments, not which line is on which invoice. "exact" = completed order with one invoice. "by shipment" = worked out from what shipped on each invoice. "check" = could not be worked out, all lines put on the first invoice.'],
      [`Lines marked check in this report: ${checkLines.length} (${qty(checkLines)} units, $${sales(checkLines).toFixed(2)}).`],
    ],
    widths: [140],
  };
  return [raw, summary, skuSheet, purchase('CUSTOMER_Purchase', customer), purchase('STAFF_Purchase', staff), stockSheet, notes];
}