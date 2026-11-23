// Trade shows: the plain rules, with no database (tested in scripts/test-tradeshow.ts).
// - The order total: lines at wholesale ex GST, a discount (% or $, managers only) spread as the same % on every line so the DEAR file
//   works it out the same way, freight, the card surcharge, then GST (none for NZ and overseas).
// - Stock that is free to sell: DEAR's available stock (allocated already taken off) less what trade show orders have taken that DEAR
//   has not allocated yet. If it is short: what is coming, when.
// - The reference for DEAR, the file DEAR imports (Bulk Update Sale Quote), the email to sales, and the follow-up rules.

import { combinePct } from './tsOffers';
export class TsError extends Error { status: number; constructor(message: string, status = 400) { super(message); this.status = status; } }
export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const money = (n: number) => n.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** GST for the customer's state: none for New Zealand and overseas. */
export const gstRateFor = (region: string | null | undefined) => (/^(NZ|INTL)$/i.test(String(region ?? '').trim()) ? 0 : 0.1);

// ---------- totals ----------
export type Discount = { kind: 'pct' | 'amount'; value: number } | null;
export type TotalsIn = { lines: { qty: number; price: number; pct?: number }[]; discount: Discount; freight: number; cardPayment: boolean; surchargePct: number | null; gstRate: number };
export type Totals = {
  goods: number;            // lines at their price, before any discount (free bonus products at their price)
  linePct: number;          // the manager's discount % put on every paying line
  offerDiscount: number;    // what the offers take off (percent offers, bundles, free bonus products), in dollars
  discount: number;         // everything the offers and the discount take off, in dollars, as DEAR will work it out
  goodsAfter: number;       // goods after both
  freight: number; surcharge: number; surchargePct: number;
  exGst: number; gst: number; total: number;
  lineTotals: number[];
  linePcts: number[];       // each line's % off in the DEAR file (its offer and the discount together)
};
export function discountPct(goods: number, d: Discount): number {
  if (!d || !(d.value > 0) || !(goods > 0)) return 0;
  const pct = d.kind === 'pct' ? d.value : (d.value / goods) * 100;
  return Math.min(100, Math.round(pct * 100) / 100);   // DEAR takes a % per line, to 2 decimals
}
export function totals(t: TotalsIn): Totals {
  const goods = round2(t.lines.reduce((s, l) => s + l.qty * l.price, 0));
  const offerBase = round2(t.lines.reduce((s, l) => s + round2(l.qty * l.price * (1 - (l.pct || 0) / 100)), 0));
  const linePct = discountPct(offerBase, t.discount);   // the manager's discount works on what is left after the offers
  const linePcts = t.lines.map(l => ((l.pct || 0) >= 100 ? 100 : combinePct(l.pct || 0, linePct)));
  const lineTotals = t.lines.map((l, i) => round2(l.qty * l.price * (1 - linePcts[i]! / 100)));
  const goodsAfter = round2(lineTotals.reduce((s, x) => s + x, 0));
  const freight = round2(Math.max(0, t.freight || 0));
  const surchargePct = t.cardPayment && t.surchargePct && t.surchargePct > 0 ? t.surchargePct : 0;
  const surcharge = round2(((goodsAfter + freight) * surchargePct) / 100);
  const exGst = round2(goodsAfter + freight + surcharge);
  const gst = round2(exGst * t.gstRate);
  return { goods, linePct, offerDiscount: round2(goods - offerBase), discount: round2(goods - goodsAfter), goodsAfter, freight, surcharge, surchargePct, exGst, gst, total: round2(exGst + gst), lineTotals, linePcts };
}
/** A discount as typed: { kind: 'pct' | 'amount', value }. Blank or 0 = none. */
export function parseDiscount(kind: unknown, value: unknown, goods: number): Discount {
  if (value === null || value === undefined || value === '' || Number(value) === 0) return null;
  const v = Number(value);
  if (!Number.isFinite(v) || v < 0) throw new TsError('The discount must be a number.');
  if (kind === 'pct') { if (v > 100) throw new TsError('A discount cannot be more than 100%.'); return { kind, value: v }; }
  if (kind === 'amount') { if (v > goods + 0.005) throw new TsError(`The discount cannot be more than the goods ($${money(goods)}).`); return { kind, value: v }; }
  throw new TsError('Choose % or $ for the discount.');
}

// ---------- stock ----------
export type Incoming = { qty: number; date: string | null; po: string | null };
export type StockView = { available: number; pending: number; free: number; canShip: number; backorder: number; incoming: Incoming | null; eta: string | null; note: string };
/**
 * available: DEAR's available (on hand less allocated). pending: units on other trade show orders that DEAR has not allocated yet.
 * Shows how much of qty can go now, how much would be a backorder, and when more is coming.
 */
export function stockView(qty: number, available: number, pending: number, incoming: Incoming | null, eta: string | null): StockView {
  const free = Math.floor(available - pending);
  const canShip = Math.max(0, Math.min(qty, free));
  const backorder = Math.max(0, qty - canShip);
  const when = incoming ? `${incoming.qty} more coming${incoming.po ? ` on ${incoming.po}` : ''}${incoming.date ? `, due ${incoming.date}` : ''}` : '';
  const etaTxt = eta ? `ETA ${eta}` : '';
  const note = backorder === 0 ? 'In stock' : [canShip ? `${canShip} now, ${backorder} on backorder` : `None free now, ${backorder} on backorder`, when || etaTxt || 'Nothing on order yet'].filter(Boolean).join('. ');
  return { available, pending, free, canShip, backorder, incoming, eta, note };
}
/** Pack size: the quantity should be a multiple of the order increment. */
export const incrementProblem = (qty: number, inc: number | null | undefined) => (inc && inc > 1 && qty % inc !== 0 ? `Sold in packs of ${inc}` : null);

// ---------- reference, DEAR file ----------
const ddmmyyyy = (day: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day); return m ? `${m[3]}/${m[2]}/${m[1]}` : day; };
/** "REED MEL FEB26 17/11/2026 TS-0007". The order number keeps each one unique, so Radar can find it in DEAR. */
export const defaultReference = (refName: string, orderDay: string, number: string) => `${refName.trim()} ${ddmmyyyy(orderDay)} ${number}`.replace(/\s+/g, ' ').trim();
export const TS_NO = /\bTS-\d{4,}\b/i;
export function cleanReference(v: unknown): string {
  const s = String(v ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) throw new TsError('The reference cannot be empty.');
  if (s.length > 100) throw new TsError('Keep the reference to 100 characters (DEAR\'s limit).');
  return s;
}
const csvCell = (v: string | number) => { const s = String(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
/** The file DEAR imports into a sale quote (Bulk Update Sale Quote): SKU, Name, Comment, Quantity, Price, Discount (%). */
export function dearCsv(lines: { sku: string; name: string; comment?: string | null; qty: number; price: number; pct?: number }[], linePct: number, charges: { sku: string; name: string; amount: number }[] = []): string {
  const rows = [['SKU', 'Name', 'Comment', 'Quantity', 'Price', 'Discount']];
  for (const l of lines) rows.push([l.sku, l.name, l.comment ?? '', String(l.qty), String(round2(l.price)), String(l.pct ?? linePct)]);
  for (const c of charges) if (c.amount > 0) rows.push([c.sku, c.name, '', '1', String(round2(c.amount)), '0']);
  return rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

// ---------- the email to sales ----------
export type EmailOrder = {
  number: string; kind: 'order' | 'quote'; reference: string; customerPo: string | null; orderDate: string; showName: string; repName: string | null;
  customer: { name: string; isNew: boolean; region: string | null; contact: string | null; email: string | null; phone: string | null; address: string | null; terms: string | null };
  lines: { sku: string; name: string; qty: number; price: number; lineTotal: number; stock: string; pct?: number; note?: string | null }[];
  totals: Totals; notes: string | null; version: number; chargesInFile: boolean;
  dearReference?: string; payBy?: string | null; offersNote?: string[]; freightNote?: string | null;
  payment?: { mode: 'later' | 'paid'; method: 'bank' | 'card' | null; amount: number | null; proofName: string | null } | null;
};
const METHOD_WORDS = { bank: 'bank transfer', card: 'card' } as const;
/** The payment part of the email to sales: it says what to do next, so nobody has to ask on WhatsApp. */
export function paymentLines(o: Pick<EmailOrder, 'kind' | 'payment'>): string[] {
  const p = o.payment;
  if (!p) return [];
  if (p.mode === 'paid') return [
    `PAYMENT: PAID AT THE SHOW by ${METHOD_WORDS[p.method ?? 'bank']}${p.amount != null ? `, $${money(p.amount)} inc GST` : ''}.`,
    `  The customer's payment screenshot is attached${p.proofName ? ` (${p.proofName})` : ''}. Please match it to the order in DEAR, then press Done in Radar (Trade Shows, the show, To action).`, '',
  ];
  return [`PAYMENT: not paid yet. Please send the customer ${o.kind === 'quote' ? 'the quote' : 'the invoice and payment details'}, then press Done in Radar (Trade Shows, the show, To action).`, ''];
}
export function salesEmail(o: EmailOrder): { subject: string; body: string } {
  const c = o.customer, t = o.totals, what = o.kind === 'quote' ? 'Quote' : 'Order';
  const body = [
    `${o.version > 1 ? 'UPDATED: ' : ''}A trade show ${o.kind} was written in Radar at ${o.showName}. Please enter it in DEAR${o.kind === 'quote' ? ' as a quote' : ''}.`, '',
    `REFERENCE TO USE: ${o.dearReference ?? o.reference}`, ...(o.dearReference ? [`Radar reference: ${o.reference}`] : []), ...(o.customerPo ? [`Customer's PO: ${o.customerPo}`] : []), `Radar ${what.toLowerCase()}: ${o.number}, ${ddmmyyyy(o.orderDate)}, by ${o.repName ?? 'unknown'}`, '',
    'CUSTOMER' + (c.isNew ? ' (NEW: not in DEAR yet, please set them up with this exact name)' : ''),
    `  ${c.name}${c.region ? ` (${c.region})` : ''}`, ...(c.contact ? [`  Contact: ${c.contact}`] : []), ...(c.email ? [`  Email: ${c.email}`] : []), ...(c.phone ? [`  Phone: ${c.phone}`] : []),
    ...(c.address ? [`  Deliver to: ${c.address}`] : []), ...(c.terms ? [`  Terms: ${c.terms}`] : []), '',
    'PRODUCTS (wholesale ex GST)',
    ...o.lines.map(l => `  ${l.sku}  ${l.name}  x${l.qty} @ $${money(l.price)}${(l.pct ?? t.linePct) ? ` less ${l.pct ?? t.linePct}%` : ''} = $${money(l.lineTotal)}${l.note ? `  (${l.note})` : ''}   [${l.stock}]`), '',
    `Goods: $${money(t.goods)}`, ...(t.offerDiscount ? [`Offers: -$${money(t.offerDiscount)}`] : []), ...(t.linePct ? [`Discount: ${t.linePct}% on every line, -$${money(round2(t.discount - (t.offerDiscount || 0)))}`] : []), `Freight: $${money(t.freight)}${o.freightNote ? ` (${o.freightNote})` : ''}`,
    ...(t.surcharge ? [`Card surcharge (${t.surchargePct}%): $${money(t.surcharge)}`] : []), `Total ex GST: $${money(t.exGst)}`, `GST: $${money(t.gst)}`, `TOTAL inc GST: $${money(t.total)}`, '',
    ...paymentLines(o),
    ...(o.offersNote?.length ? ['OFFERS ON THIS ORDER', ...o.offersNote.map(x => `  ${x}`), ...(o.payBy ? [`  These only hold if the order is paid by ${ddmmyyyy(o.payBy)}.`] : []), ''] : []),
    ...(o.notes ? ['NOTES', o.notes, ''] : []),
    `Attached: ${o.reference.replace(/[^\w\- ]+/g, '_')}.csv, ready to import into the ${o.kind === 'quote' ? 'quote' : 'sale'} in DEAR (Bulk Update Sale Quote).${o.chargesInFile ? '' : ' Add the freight and surcharge in DEAR.'}`,
    'Use the reference above exactly, so Radar can match the DEAR order to this one.',
  ].join('\n');
  return { subject: `[Radar] ${o.version > 1 ? 'UPDATED ' : ''}Trade show ${what.toLowerCase()} ${o.number}: ${c.name}, $${money(t.total)} inc GST${o.payment?.mode === 'paid' ? `, PAID by ${METHOD_WORDS[o.payment.method ?? 'bank']}` : ''} (${o.reference})`.slice(0, 200), body };
}

// ---------- where it is, and follow-ups ----------
export const QUOTE_STAGE = ['DRAFT', 'ESTIMATING', 'ESTIMATED', 'ORDERING'];
export type DearLink = { number: string; status: string | null; invoiced: number | null; due: number | null } | null;
export type OrderStage = 'draft' | 'sent' | 'in_dear_quote' | 'in_dear' | 'invoiced' | 'paid' | 'cancelled' | 'voided_in_dear';
export function orderStage(status: string, dear: DearLink): OrderStage {
  if (status === 'cancelled') return 'cancelled';
  if (status === 'draft') return 'draft';
  if (!dear) return 'sent';
  const s = String(dear.status ?? '').toUpperCase();
  if (s === 'VOIDED' || s === 'CREDITED') return 'voided_in_dear';
  if (QUOTE_STAGE.includes(s)) return 'in_dear_quote';
  if ((dear.invoiced ?? 0) > 0.005 && (dear.due ?? 0) <= 0.01) return 'paid';
  if ((dear.invoiced ?? 0) > 0.005) return 'invoiced';
  return 'in_dear';
}
export const STAGE_LABEL: Record<OrderStage, string> = {
  draft: 'Not confirmed yet', sent: 'Sent to sales', in_dear_quote: 'In DEAR as a quote', in_dear: 'In DEAR, confirmed', invoiced: 'Invoiced', paid: 'Paid', cancelled: 'Cancelled', voided_in_dear: 'Voided in DEAR',
};
/** Stock is still taken by a trade show order until DEAR has allocated it (a confirmed DEAR order), or it is cancelled. Quotes take none. */
export const holdsStock = (kind: 'order' | 'quote', stage: OrderStage) => kind === 'order' && (stage === 'sent' || stage === 'in_dear_quote');
/** Follow-ups stop by themselves: a quote once it is a confirmed order in DEAR, an order once it is paid, either if cancelled. */
export function followUpsClosed(kind: 'order' | 'quote', stage: OrderStage): boolean {
  if (stage === 'cancelled' || stage === 'voided_in_dear' || stage === 'draft') return true;
  return kind === 'quote' ? ['in_dear', 'invoiced', 'paid'].includes(stage) : stage === 'paid';
}
export const plusDays = (day: string, n: number) => new Date(Date.parse(`${day.slice(0, 10)}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** The 1st follow-up: a week after the order or lead, for the sales team. */
export const firstFollowUp = (day: string) => plusDays(day, 7);
export function parseDay(v: unknown, what: string): string {
  const s = String(v ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw new TsError(`Give the ${what} as a date.`);
  return s;
}

// ---------- typed-in details ----------
const t = (v: unknown, max: number) => { const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : ''; return s ? s.slice(0, max) : null; };
export const STATES = ['NSW', 'ACT', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'NT', 'NZ', 'NSW/HO', 'VIC/HO', 'INTL'];
export type NewCustomer = { name: string; contact: string | null; email: string | null; phone: string | null; address: string | null; region: string; category: string | null };
export function parseNewCustomer(b: any): NewCustomer {
  const name = t(b?.name, 120);
  if (!name || name.length < 2) throw new TsError('Give the business name.');
  const region = String(b?.region ?? '').toUpperCase().trim();
  if (!STATES.includes(region)) throw new TsError('Choose the state.');
  const email = t(b?.email, 160);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new TsError('That email does not look right.');
  return { name, contact: t(b?.contact, 120), email: email?.toLowerCase() ?? null, phone: t(b?.phone, 40), address: t(b?.address, 300), region, category: t(b?.category, 80) };
}
/** For spotting an account that already exists: digits of a phone number, last 8 (so +61 4.. and 04.. match). */
export const phoneKey = (p: string | null | undefined) => { const d = String(p ?? '').replace(/\D/g, ''); return d.length >= 8 ? d.slice(-8) : null; };
export const nameKey = (n: string | null | undefined) => String(n ?? '').toLowerCase().replace(/\b(pty|ltd|limited|the|t\/a|trading as)\b/g, '').replace(/[^a-z0-9]/g, '');
export { t as cleanText };

// ---------- scanning ----------
/** A 12-digit UPC and the same code with a leading 0 (13 digits) are the same barcode; try each. Anything that is not plausibly a barcode gives nothing. */
export function barcodeCandidates(code: string): string[] {
  const c = code.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9\-.$/+% ]{3,64}$/.test(c)) return [];
  const out = new Set([c]);
  if (/^\d+$/.test(c)) { const bare = c.replace(/^0+/, ''); for (const n of [12, 13, 14]) if (bare.length <= n) out.add(bare.padStart(n, '0')); out.add(bare); }
  return [...out];
}

// ---------- the same item in other colours ----------
// Radar has no colour field, so the colour is read from the product name: a colour word at the start ("Pink Birthday Candle Set"), at the end ("Bunny
// Small Pink") or after a dash or comma ("Bunny Small - Pink"). It is a best guess, so the page says "other colours (from the names)".
export const COLOUR_WORDS = ['black', 'white', 'grey', 'gray', 'silver', 'gold', 'rose gold', 'bronze', 'copper', 'red', 'burgundy', 'maroon', 'rust', 'orange', 'peach', 'coral', 'apricot', 'yellow', 'mustard', 'lemon', 'cream', 'beige', 'sand', 'tan', 'brown', 'chocolate', 'camel', 'green', 'sage', 'olive', 'khaki', 'forest', 'mint', 'teal', 'aqua', 'blue', 'navy', 'sky blue', 'baby blue', 'powder blue', 'cobalt', 'purple', 'lilac', 'lavender', 'mauve', 'plum', 'pink', 'blush', 'dusty pink', 'rose', 'fuchsia', 'magenta', 'multi', 'rainbow', 'natural', 'clear', 'ivory'];
const COLOUR_RE = [...COLOUR_WORDS].sort((a, b) => b.length - a.length).map(w => w.replace(/ /g, '\\s+')).join('|');
const lower = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
/** "Pink Birthday Candle Set" gives base "birthday candle set" and colour "pink". A name with no colour word gives colour null. */
export function splitColour(name: string): { base: string; colour: string | null } {
  const n = name.replace(/\s+/g, ' ').trim();
  const end = new RegExp(`^(.*?)\\s*(?:[-,/(]\\s*)?\\(?\\b(${COLOUR_RE})\\b\\)?\\s*$`, 'i').exec(n);
  if (end && end[1]!.trim().length >= 3) return { base: lower(end[1]!.replace(/[-,/(\s]+$/, '')), colour: lower(end[2]!) };
  const start = new RegExp(`^\\b(${COLOUR_RE})\\b\\s*[-,]?\\s+(.{3,})$`, 'i').exec(n);
  if (start) return { base: lower(start[2]!), colour: lower(start[1]!) };
  return { base: lower(n), colour: null };
}
