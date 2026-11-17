// Liewood orders: the plain rules, with no database and no DEAR (tested in scripts/test-liewood.ts).
// - Reading Liewood's sales order export (the Excel file that comes with each order confirmation).
// - Building the SKU the way it is set up in DEAR: style, colour code (4 digits), size in capitals, "CU" (LW20534-2598-ONE SIZE-CU).
// - Reading what DEAR has on a purchase order: its lines, Liewood's invoices (each is a shipment, so "confirmed coming"), and the stock received.
// - The tally: for every line of every order, how much is on the PO, invoiced and received, shared out oldest order first.

export class LiewoodError extends Error { status: number; constructor(message: string, status = 400) { super(message); this.status = status; } }

/** A number from a cell: 12, "12", "16.313,04" (Danish), "16,313.04", "25%". null if it is not one. */
export function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  let s = v.replace(/[%\s€]|EUR|AUD/gi, '');
  if (!s) return null;
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s) || /^-?\d+,\d+$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');   // 16.313,04 or 24,00
  else s = s.replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
const text = (v: unknown): string => (v == null ? '' : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).replace(/\s+/g, ' ').trim());
/** A barcode as digits: 5715493531928 (a number in Excel) or "5715493531928". */
export function barcodeOf(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Number.isInteger(v) ? String(v) : null;
  const s = text(v).replace(/\.0+$/, '');
  return /^\d{8,14}$/.test(s) ? s : null;
}
/** The colour code as DEAR uses it in the SKU: four digits (42 becomes 0042). */
export function colourCodeOf(v: unknown): string | null {
  const s = typeof v === 'number' ? (Number.isInteger(v) ? String(v) : '') : text(v).replace(/\.0+$/, '');
  if (!/^\d{1,4}$/.test(s)) return /^[A-Za-z0-9]{1,8}$/.test(s) ? s.toUpperCase() : null;
  return s.padStart(4, '0');
}
/** LW20534 + 2598 + "One size" = LW20534-2598-ONE SIZE-CU, the way the SKUs are set up in DEAR. */
export function buildSku(style: unknown, colour: unknown, size: unknown): string | null {
  const st = text(style).toUpperCase(), c = colourCodeOf(colour), sz = text(size).toUpperCase() || 'ONE SIZE';
  if (!/^[A-Z]{1,4}\d{3,8}$/.test(st) || !c) return null;
  return `${st}-${c}-${sz}-CU`;
}
/** The season as Liewood writes it ("01 2027"), also when Excel has turned it into a date. */
const seasonOf = (v: unknown): string => {
  if (v instanceof Date) { const d = new Date(v.getTime() + 12 * 3600_000); return `${String(d.getUTCMonth() + 1).padStart(2, '0')} ${d.getUTCFullYear()}`; }   // half a day on, so a date stored as midnight in another time zone keeps its month
  return text(v);
};

export type SoLine = { lineNo: number; display: boolean; styleNo: string; styleName: string; colourCode: string; colour: string; size: string; barcode: string | null; sku: string; qty: number; currency: string | null; wsp: number | null; discount: number | null; price: number | null; amount: number | null; rrp: number | null; deliveryWindow: string | null };
export type SalesOrder = { orderNo: string; season: string | null; customerOrderNo: string | null; customer: string | null; currency: string | null; lines: SoLine[]; totalUnits: number; totalAmount: number; deliveryWindows: string[]; problems: string[] };
const H = (s: unknown) => text(s).toLowerCase().replace(/[^a-z0-9%]+/g, ' ').trim();
const COLS: Record<string, string[]> = {
  orderNo: ['order no'], season: ['season'], customer: ['customer name'], customerOrderNo: ['customer order no'], styleNo: ['style no'], styleName: ['style name'],
  colourCode: ['color code', 'colour code'], colour: ['color description', 'colour description', 'color name'], barcode: ['barcode', 'ean'], size: ['size'], qty: ['qty cu', 'qty', 'quantity'],
  currency: ['currency'], wsp: ['wholesale price'], discount: ['discount %', 'discount'], price: ['wsp after disc'], amount: ['total wsp amount', 'amount'], rrp: ['recommended retail price', 'rrp'], deliveryWindow: ['delivery window', 'delivery'],
};
/**
 * Liewood's sales order export: one row per colour and size, under a heading row with "Order No." and "Qty (CU)".
 * The heading row can be a few rows down (the copies in the Master file have a total above it), and columns can move.
 * Anything wrong with a row is named, and the row is left out; a file that is not a sales order is refused.
 */
export function parseSalesOrder(rows: unknown[][]): SalesOrder {
  const at = rows.slice(0, 15).findIndex(r => Array.isArray(r) && r.some(c => H(c) === 'order no') && r.some(c => /^qty/.test(H(c))));
  if (at < 0) throw new LiewoodError('This does not look like a Liewood sales order: there is no heading row with "Order No." and "Qty (CU)". Use the Excel export that comes with the order confirmation.');
  const head = rows[at]!.map(H);
  const idx: Record<string, number> = {};
  for (const [k, names] of Object.entries(COLS)) { const i = names.map(n => head.indexOf(n)).find(i => i >= 0); if (i !== undefined && i >= 0) idx[k] = i; }
  for (const need of ['orderNo', 'styleNo', 'colourCode', 'qty']) if (idx[need] === undefined) throw new LiewoodError(`The sales order has no "${COLS[need]![0]}" column, so it cannot be read.`);
  const get = (r: unknown[], k: string) => (idx[k] === undefined ? undefined : r[idx[k]!]);
  const problems: string[] = [], lines: SoLine[] = [], orderNos = new Set<string>();
  let season: string | null = null, customerOrderNo: string | null = null, customer: string | null = null, currency: string | null = null;
  rows.slice(at + 1).forEach((r, i) => {
    if (!Array.isArray(r) || r.every(c => text(c) === '')) return;
    const rowNo = at + i + 2, order = text(get(r, 'orderNo')).toUpperCase();
    if (!order && !text(get(r, 'styleNo'))) return;   // a total row
    const qty = num(get(r, 'qty')), sku = buildSku(get(r, 'styleNo'), get(r, 'colourCode'), get(r, 'size'));
    if (!/^SO\d{4,}$/.test(order)) { problems.push(`Row ${rowNo}: "${order || '(blank)'}" is not a Liewood order number.`); return; }
    if (qty === null || qty < 0 || !Number.isInteger(qty)) { problems.push(`Row ${rowNo}: the quantity "${text(get(r, 'qty'))}" is not a whole number.`); return; }
    // Shop displays and marketing pieces ("1.27 1001 Summer Shop display") have their own numbering: kept on the order (so the totals match the PDF), left out of the stock tally
    const style = text(get(r, 'styleNo')), display = !sku;
    if (display && !style) { problems.push(`Row ${rowNo}: there is no style number.`); return; }
    orderNos.add(order);
    season ??= seasonOf(get(r, 'season')) || null; customerOrderNo ??= text(get(r, 'customerOrderNo')) || null; customer ??= text(get(r, 'customer')) || null; currency ??= text(get(r, 'currency')).toUpperCase() || null;
    lines.push({ lineNo: lines.length + 1, display, styleNo: style.toUpperCase(), styleName: text(get(r, 'styleName')), colourCode: colourCodeOf(get(r, 'colourCode')) ?? text(get(r, 'colourCode')), colour: text(get(r, 'colour')), size: text(get(r, 'size')) || 'One size', barcode: barcodeOf(get(r, 'barcode')), sku: sku ?? `DISPLAY ${style.toUpperCase()}`,
      qty, currency: text(get(r, 'currency')).toUpperCase() || null, wsp: num(get(r, 'wsp')), discount: num(get(r, 'discount')), price: num(get(r, 'price')), amount: num(get(r, 'amount')), rrp: num(get(r, 'rrp')), deliveryWindow: text(get(r, 'deliveryWindow')) || null });
  });
  if (!lines.length) throw new LiewoodError(problems[0] ?? 'The sales order has no lines.');
  if (orderNos.size > 1) throw new LiewoodError(`This file has more than one order in it (${[...orderNos].join(', ')}). Upload one sales order at a time.`);
  const round = (n: number) => Math.round(n * 100) / 100;
  return { orderNo: [...orderNos][0]!, season, customerOrderNo, customer, currency, lines, totalUnits: lines.reduce((t, l) => t + l.qty, 0), totalAmount: round(lines.reduce((t, l) => t + (l.amount ?? 0), 0)),
    deliveryWindows: [...new Set(lines.map(l => l.deliveryWindow).filter((x): x is string => !!x))], problems: problems.slice(0, 20) };
}

// ---------- the PDF confirmation against the Excel ----------
export type PdfTotals = { orderNo: string | null; totalUnits: number | null; totalAmount: number | null; currency: string | null };
export type ConfirmationCheck = { status: 'match' | 'mismatch' | 'not_checked'; reasons: string[]; pdf: PdfTotals | null; checkedAt: string };
/** What Claude read from the PDF (asked for JSON only); anything it could not read is null. */
export function parsePdfReply(reply: string): PdfTotals {
  const m = reply.match(/\{[\s\S]*\}/);
  let o: any = {};
  try { o = m ? JSON.parse(m[0]) : {}; } catch { o = {}; }
  const order = typeof o.orderNo === 'string' ? o.orderNo.trim().toUpperCase() : null;
  return { orderNo: order && /^SO\d{4,}$/.test(order) ? order : null, totalUnits: num(o.totalUnits), totalAmount: num(o.totalAmount), currency: typeof o.currency === 'string' ? o.currency.trim().toUpperCase().slice(0, 3) || null : null };
}
export function compareConfirmation(so: Pick<SalesOrder, 'orderNo' | 'totalUnits' | 'totalAmount' | 'currency'>, pdf: PdfTotals, at = new Date()): ConfirmationCheck {
  const reasons: string[] = [];
  if (pdf.orderNo === null && pdf.totalUnits === null && pdf.totalAmount === null) return { status: 'not_checked', reasons: ['The order number and totals could not be read from the PDF.'], pdf, checkedAt: at.toISOString() };
  if (pdf.orderNo && pdf.orderNo !== so.orderNo) reasons.push(`The PDF is for ${pdf.orderNo}, not ${so.orderNo}.`);
  if (pdf.totalUnits !== null && pdf.totalUnits !== so.totalUnits) reasons.push(`The PDF says ${pdf.totalUnits} units; the sales order has ${so.totalUnits}.`);
  if (pdf.totalAmount !== null && Math.abs(pdf.totalAmount - so.totalAmount) > 0.01) reasons.push(`The PDF total is ${pdf.totalAmount.toFixed(2)} ${pdf.currency ?? ''}; the sales order adds up to ${so.totalAmount.toFixed(2)} ${so.currency ?? ''}.`.replace(/ +\./g, '.').replace(/ {2,}/g, ' '));
  return { status: reasons.length ? 'mismatch' : 'match', reasons, pdf, checkedAt: at.toISOString() };
}

// ---------- what DEAR has on a purchase order ----------
export type PoDocLine = { sku: string; qty: number };
export type PoDoc = { key: string; number: string | null; date: string | null; status: string | null; lines: PoDocLine[] };
export type DearPo = { orderNumber: string | null; status: string | null; ordered: PoDocLine[]; invoices: PoDoc[]; receipts: PoDoc[]; fields: string[] };
const NOT_COUNTED = /^(DRAFT|VOID|VOIDED|CANCEL)/i;
const day = (v: unknown): string | null => { const s = text(v); const m = /^(\d{4}-\d{2}-\d{2})/.exec(s); return m ? m[1]! : null; };
function linesOf(v: unknown): PoDocLine[] {
  const by = new Map<string, number>();
  for (const l of Array.isArray(v) ? v : []) {
    if (!l || typeof l !== 'object') continue;
    const sku = text((l as any).SKU).toUpperCase(), q = num((l as any).Quantity ?? (l as any).QuantityReceived ?? (l as any).Qty);
    if (!sku || q === null) continue;
    by.set(sku, (by.get(sku) ?? 0) + q);
  }
  return [...by].map(([sku, qty]) => ({ sku, qty }));
}
function docsOf(v: unknown, kind: 'invoice' | 'receipt'): PoDoc[] {
  const list = Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : [];
  return list.filter(d => d && typeof d === 'object').map((d: any, i: number) => ({
    key: text(d.TaskID) || `section-${i + 1}`, number: text(d.InvoiceNumber ?? d.Reference ?? d.Number) || null, date: day(d.InvoiceDate ?? d.ReceivedDate ?? d.Date ?? d.Lines?.[0]?.Date ?? d.Lines?.[0]?.ReceivedDate),
    status: text(d.Status) || null, lines: linesOf(d.Lines) }))
    .filter(d => d.lines.length || d.number);
}
/** A purchase order as DEAR sends it (an advanced purchase with several "Invoicing and receiving" sections, or a simple one). Drafts and voided sections do not count. */
export function readDearPurchase(p: any): DearPo {
  if (!p || typeof p !== 'object') return { orderNumber: null, status: null, ordered: [], invoices: [], receipts: [], fields: [] };
  const invoices = docsOf(p.Invoices ?? p.Invoice, 'invoice').filter(d => !NOT_COUNTED.test(d.status ?? ''));
  const receipts = docsOf(p.StockReceived ?? p.StockReceivings ?? p.Receivings, 'receipt').filter(d => !NOT_COUNTED.test(d.status ?? ''));
  return { orderNumber: text(p.OrderNumber ?? p.Order?.OrderNumber ?? p.PurchaseOrderNumber) || null, status: text(p.CombinedReceivingStatus ?? p.Status) || null, ordered: linesOf(p.Order?.Lines ?? p.Lines), invoices, receipts, fields: Object.keys(p).slice(0, 40) };
}
const sum = (docs: PoDoc[]) => { const m = new Map<string, number>(); for (const d of docs) for (const l of d.lines) m.set(l.sku, (m.get(l.sku) ?? 0) + l.qty); return m; };

// ---------- the tally ----------
export type LineStage = 'not_on_po' | 'short_on_po' | 'not_invoiced' | 'part_invoiced' | 'invoiced' | 'part_received' | 'received';
export type TallyLine = { orderId: string; lineNo: number; sku: string; qty: number; onPo: number; invoiced: number; received: number; stage: LineStage };
export type Shortage = { invoice: string; sku: string; invoiced: number; received: number };
export type PoTally = { lines: TallyLine[]; extraOnPo: PoDocLine[]; extraInvoiced: PoDocLine[]; shortages: Shortage[] };
export const STAGE_LABEL: Record<LineStage, string> = { not_on_po: 'Not on the PO', short_on_po: 'Less on the PO', not_invoiced: 'Not invoiced yet', part_invoiced: 'Partly invoiced', invoiced: 'Invoiced, coming', part_received: 'Partly received', received: 'Received' };
function stageOf(qty: number, onPo: number, inv: number, rec: number): LineStage {
  if (rec >= qty && qty > 0) return 'received';
  if (rec > 0) return 'part_received';
  if (inv >= qty && qty > 0) return 'invoiced';
  if (inv > 0) return 'part_invoiced';
  if (onPo <= 0) return 'not_on_po';
  if (onPo < qty) return 'short_on_po';
  return 'not_invoiced';
}
/**
 * Every order on one PO, oldest first. What is on the PO, invoiced and received for a SKU is shared out in that order, so two orders with
 * the same SKU are each filled before anything counts as extra. Invoice by invoice, what was received is compared with what that invoice billed.
 */
export function tallyPo(orders: { id: string; lines: { lineNo: number; sku: string; qty: number }[] }[], po: DearPo | null): PoTally {
  const left = (m: Map<string, number>) => new Map(m);
  const onPo = left(new Map((po?.ordered ?? []).map(l => [l.sku, l.qty]))), inv = left(sum(po?.invoices ?? [])), rec = left(sum(po?.receipts ?? []));
  const take = (m: Map<string, number>, sku: string, want: number) => { const have = m.get(sku) ?? 0, got = Math.max(0, Math.min(have, want)); m.set(sku, have - got); return got; };
  const lines: TallyLine[] = [];
  for (const o of orders) for (const l of o.lines) {
    const a = take(onPo, l.sku, l.qty), b = take(inv, l.sku, l.qty), c = take(rec, l.sku, l.qty);
    lines.push({ orderId: o.id, lineNo: l.lineNo, sku: l.sku, qty: l.qty, onPo: a, invoiced: b, received: c, stage: stageOf(l.qty, a, b, c) });
  }
  const extra = (m: Map<string, number>) => [...m].filter(([, q]) => q > 0).map(([sku, qty]) => ({ sku, qty }));
  const shortages: Shortage[] = [];
  for (const d of po?.invoices ?? []) {
    const r = (po?.receipts ?? []).filter(x => x.key === d.key);
    if (!r.length) continue;   // not received yet: nothing to compare
    const got = sum(r);
    for (const l of d.lines) { const g = got.get(l.sku) ?? 0; if (g < l.qty) shortages.push({ invoice: d.number ?? d.key, sku: l.sku, invoiced: l.qty, received: g }); }
    for (const [sku, g] of got) if (!d.lines.some(l => l.sku === sku) && g > 0) shortages.push({ invoice: d.number ?? d.key, sku, invoiced: 0, received: g });
  }
  return { lines, extraOnPo: po ? extra(onPo) : [], extraInvoiced: po ? extra(inv) : [], shortages };
}
export type OrderStage = 'confirmed' | 'on_po' | 'part_invoiced' | 'invoiced' | 'part_received' | 'received';
export const ORDER_STAGE_LABEL: Record<OrderStage, string> = { confirmed: 'Confirmed, no PO yet', on_po: 'On PO', part_invoiced: 'Partly invoiced', invoiced: 'Invoiced, coming', part_received: 'Partly received', received: 'Received in full' };
export function orderStage(hasPo: boolean, lines: TallyLine[]): OrderStage {
  if (!hasPo) return 'confirmed';
  const t = (k: 'qty' | 'invoiced' | 'received') => lines.reduce((s, l) => s + l[k], 0), q = t('qty');
  if (q > 0 && t('received') >= q) return 'received';
  if (t('received') > 0) return 'part_received';
  if (q > 0 && t('invoiced') >= q) return 'invoiced';
  if (t('invoiced') > 0) return 'part_invoiced';
  return 'on_po';
}

// ---------- the ETA ----------
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** The last day of the month an ETA names ("April 2027", "Apr-27", "Nov-26", "04/2027", "2027-04"), or null if it does not name one. */
export function etaEnd(eta: unknown): string | null {
  const s = text(eta).toLowerCase();
  let y: number | null = null, mo: number | null = null, m: RegExpMatchArray | null;
  if ((m = s.match(/^([a-z]{3,9})\.?[\s\-'/]*(\d{2}|\d{4})$/)) && MONTHS.indexOf(m[1]!.slice(0, 3)) >= 0) { mo = MONTHS.indexOf(m[1]!.slice(0, 3)) + 1; y = Number(m[2]); }
  else if ((m = s.match(/^(\d{1,2})[/\-](\d{4})$/))) { mo = Number(m[1]); y = Number(m[2]); }
  else if ((m = s.match(/^(\d{4})[/\-](\d{1,2})$/))) { y = Number(m[1]); mo = Number(m[2]); }
  if (y === null || mo === null || mo < 1 || mo > 12) return null;
  if (y < 100) y += 2000;
  return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
}
