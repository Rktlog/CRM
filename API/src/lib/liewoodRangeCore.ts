// The Liewood range: the plain rules, with no database (tested in scripts/test-liewood-range.ts).
// - Reading the Product Range List tab of the Liewood Master File (one import, to start the range in Radar).
// - Reading each season's two files: Liewood's Product Data file, and the Customer Forecast Form.
// - The rules for filling a SKU in from those files when a sales order brings it in:
//     EUR price      WSP EUR (STOCK), or (PRE) only when there is no STOCK price
//     increment      from the Customer Forecast Form
//     drop delivery  Master column M comes from the Product Data file; column O (to Australia) is typed in by hand and never filled
//     category       from the Customer Forecast Form
import { LiewoodError, num } from './liewoodCore';

const text = (v: unknown): string => (v == null ? '' : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).replace(/\s+/g, ' ').trim());
/** A heading, tidied: lower case, single spaces ("Drop Delivery TO AUS \n(+3 months...)" becomes "drop delivery to aus (+3 months...)"). */
const H = (v: unknown) => text(v).toLowerCase();
/** A spreadsheet error (#N/A, #REF!) or a blank is nothing. */
const clean = (v: unknown): string | null => { const s = text(v); return !s || /^#(N\/A|REF!|VALUE!|DIV\/0!|NAME\?|NUM!|NULL!|ERROR!)$/i.test(s) ? null : s; };
/** A price: 29.95, "29.95", "$29.95", "1.234,50". Never negative. */
export function price(v: unknown): number | null {
  const s = clean(v);
  if (s === null) return null;
  const n = typeof v === 'number' ? v : num(s.replace(/[$\s]|A\$|AUD/gi, ''));
  return n === null || !Number.isFinite(n) || n < 0 ? null : Math.round(n * 100) / 100;
}
const whole = (v: unknown): number | null => { const n = price(v); return n !== null && Number.isInteger(n) && n >= 1 && n <= 1000 ? n : null; };
const skuOf = (v: unknown): string | null => { const s = clean(v)?.toUpperCase() ?? null; return s && /^[A-Z0-9][A-Z0-9 ./\-]{2,60}$/.test(s) ? s : null; };
const eanOf = (v: unknown): string | null => { const s = typeof v === 'number' && Number.isInteger(v) ? String(v) : (clean(v) ?? '').replace(/\.0+$/, ''); return /^\d{8,14}$/.test(s) ? s : null; };

type Rows = unknown[][];
/** Finds the heading row (in the first `look` rows) that has every one of `need`, and where each wanted column is (first match wins). */
function headings(rows: Rows, need: string[], cols: Record<string, ((h: string) => boolean)>, look = 30): { at: number; idx: Record<string, number> } | null {
  for (let at = 0; at < Math.min(rows.length, look); at++) {
    const r = rows[at];
    if (!Array.isArray(r)) continue;
    const head = r.map(H);
    if (!need.every(n => head.includes(n))) continue;
    const idx: Record<string, number> = {};
    for (const [k, test] of Object.entries(cols)) { const i = head.findIndex(test); if (i >= 0) idx[k] = i; }
    return { at, idx };
  }
  return null;
}
const is = (...names: string[]) => (h: string) => names.includes(h);
const starts = (...names: string[]) => (h: string) => names.some(n => h.startsWith(n));

// ---------- the Product Range List tab (Liewood Master File) ----------
export type RangeRow = {
  sku: string; ean: string | null; name: string | null; colour: string | null; season: string | null; essential: string | null; subbrand: string | null;
  category: string | null; subCategory: string | null; productType: string | null; orderIncrement: number | null; dropEur: string | null; dropAus: string | null;
  ranged: string | null; status: string | null; wspEur: number | null; proposedRrp: number | null;
};
export type RangeList = { rows: RangeRow[]; noSku: number; duplicates: string[]; problems: string[] };
const RANGE_COLS = {
  ean: is('ean'), sku: is('sku'), name: is('name'), season: is('season'), essential: starts('essential'), subbrand: is('subbrand', 'sub brand', 'sub-brand'),
  category: is('category'), subCategory: is('sub-category', 'sub category'), productType: is('product type'), colour: is('color name', 'colour name'),
  orderIncrement: is('order increment'),   // the first one: column L. (Column BI, the second "Order increment", is not used.)
  dropEur: starts('drop delivery to eur (from product data file)'),        // column M
  dropAus: starts('drop delivery to aus'),                                // column O
  ranged: is('confirmed to range'), status: is('status'), wspEur: is('w/sprice euro', 'w/s price euro', 'w/s price eur'), proposedRrp: is('proposed rrp'),
};
/**
 * The Product Range List tab: the heading row has "SKU" and "Confirmed to range" (row 14 today, with the notes and colour key above it).
 * Only the range's own columns are read. The sales order columns are not: Radar has those from the uploaded sales orders.
 * A row with no SKU (shop displays, marketing pieces) is left out and counted.
 */
export function parseRangeList(rows: Rows): RangeList {
  const h = headings(rows, ['sku', 'confirmed to range'], RANGE_COLS);
  if (!h) throw new LiewoodError('This does not look like the Product Range List: there is no heading row with "SKU" and "Confirmed to range". Download that tab of the Liewood Master File (File, Download, CSV) and add it here.');
  const get = (r: unknown[], k: keyof typeof RANGE_COLS) => (h.idx[k] === undefined ? undefined : r[h.idx[k]!]);
  const out = new Map<string, RangeRow>(), duplicates: string[] = [], problems: string[] = [];
  let noSku = 0;
  rows.slice(h.at + 1).forEach((r, i) => {
    if (!Array.isArray(r) || r.every(c => text(c) === '')) return;
    const sku = skuOf(get(r, 'sku'));
    if (!sku) { if (clean(get(r, 'name')) || clean(get(r, 'sku'))) noSku++; return; }
    const incRaw = clean(get(r, 'orderIncrement')), inc = whole(incRaw);
    if (incRaw !== null && inc === null) problems.push(`Row ${h.at + i + 2} (${sku}): the order increment "${incRaw}" is not a whole number, so it was left blank.`);
    if (out.has(sku)) duplicates.push(sku);
    out.set(sku, {
      sku, ean: eanOf(get(r, 'ean')), name: clean(get(r, 'name')), colour: clean(get(r, 'colour')), season: clean(get(r, 'season')), essential: clean(get(r, 'essential')),
      subbrand: clean(get(r, 'subbrand')), category: clean(get(r, 'category')), subCategory: clean(get(r, 'subCategory')), productType: clean(get(r, 'productType')),
      orderIncrement: inc, dropEur: clean(get(r, 'dropEur')), dropAus: clean(get(r, 'dropAus')), ranged: clean(get(r, 'ranged')), status: clean(get(r, 'status')),
      wspEur: price(get(r, 'wspEur')), proposedRrp: price(get(r, 'proposedRrp')),
    });
  });
  if (!out.size) throw new LiewoodError('The Product Range List has no rows with a SKU under its heading row.');
  return { rows: [...out.values()], noSku, duplicates: [...new Set(duplicates)], problems: problems.slice(0, 20) };
}

// ---------- a season's files ----------
export type ProductDataRow = {
  sku: string; ean: string | null; styleNo: string | null; styleName: string | null; colourCode: string | null; colour: string | null; size: string | null; seasonCode: string | null;
  essentials: string | null; development: string | null; dropDelivery: string | null; salesMultiple: number | null; wspEurStock: number | null; wspEurPre: number | null; rrpEur: number | null;
  brand: string | null; category: string | null; subCategory: string | null; productType: string | null;
};
export type ForecastRow = { sku: string; ean: string | null; styleName: string | null; colour: string | null; size: string | null; category: string | null; subCategory: string | null; productType: string | null; eta: string | null; increment: number | null; rrpAud: number | null; wsAud: number | null };
export type SeasonFile = { kind: 'product_data'; rows: ProductDataRow[]; tabs: string[]; problems: string[] } | { kind: 'forecast'; rows: ForecastRow[]; tabs: string[]; problems: string[] };

const PD_COLS = {
  sku: is('product'), ean: is('ean'), styleNo: is('style no.', 'style no'), styleName: is('style name (en)', 'style name'), colourCode: is('colours', 'color code', 'colour code'),
  colour: is('color name', 'colour name'), size: is('size'), seasonCode: is('season code'), essentials: is('essentials'), development: starts('style/color development'),
  dropDelivery: is('drop delivery latest'), salesMultiple: is('sales order multiple'),
  wspStock: is('wsp eur (stock)', 'wsp eur'), wspPre: is('wsp eur (pre)'), rrpEur: is('rrp eur (stock)', 'rrp eur'),
  brand: is('brand'), category: is('category'), subCategory: is('sub category', 'sub-category'), productType: is('product type'),
};
const FC_COLS = {
  ean: is('ean'), sku: is('sku'), category: is('category'), subCategory: is('sub category', 'sub-category'), productType: is('product type'), styleName: is('style name'),
  colour: is('colour', 'color'), size: is('size'), eta: is('eta'), rrp: is('rrp inc gst'), ws: is('ws ex gst'), increment: is('order increment'),
};
/**
 * One of a season's two files, told apart by their headings, every tab read:
 *   Liewood's Product Data file: a tab with "Product", "EAN" and "Sales Order Multiple" (the "Product Data" tab is used over "Colour Overview", which repeats it).
 *   The Customer Forecast Form: every tab with "SKU", "RRP inc GST" and "WS ex GST" (one per category); the Summary tab has none and is skipped.
 */
export function parseSeasonFile(sheets: { name: string; rows: Rows }[]): SeasonFile {
  const fc = sheets.map(s => ({ s, h: headings(s.rows, ['sku', 'rrp inc gst', 'ws ex gst'], FC_COLS, 15) })).filter(x => x.h);
  if (fc.length) {
    const out = new Map<string, ForecastRow>(), problems: string[] = [];
    for (const { s, h } of fc) {
      const get = (r: unknown[], k: keyof typeof FC_COLS) => (h!.idx[k] === undefined ? undefined : r[h!.idx[k]!]);
      s.rows.slice(h!.at + 1).forEach((r, i) => {
        if (!Array.isArray(r)) return;
        const sku = skuOf(get(r, 'sku'));
        if (!sku) return;
        const incRaw = clean(get(r, 'increment')), inc = whole(incRaw);
        if (incRaw !== null && inc === null) problems.push(`${s.name} row ${h!.at + i + 2} (${sku}): the order increment "${incRaw}" is not a whole number.`);
        out.set(sku, { sku, ean: eanOf(get(r, 'ean')), styleName: clean(get(r, 'styleName')), colour: clean(get(r, 'colour')), size: clean(get(r, 'size')), category: clean(get(r, 'category')),
          subCategory: clean(get(r, 'subCategory')), productType: clean(get(r, 'productType')), eta: clean(get(r, 'eta')), increment: inc, rrpAud: price(get(r, 'rrp')), wsAud: price(get(r, 'ws')) });
      });
    }
    if (!out.size) throw new LiewoodError('The Customer Forecast Form has no SKUs under its headings.');
    return { kind: 'forecast', rows: [...out.values()], tabs: fc.map(x => x.s.name), problems: problems.slice(0, 20) };
  }
  const pd = sheets.map(s => ({ s, h: headings(s.rows, ['product', 'ean', 'sales order multiple'], PD_COLS, 10) })).filter(x => x.h)
    .sort((a, b) => Number(/product data/i.test(b.s.name)) - Number(/product data/i.test(a.s.name)) || b.s.rows.length - a.s.rows.length);
  const pick = pd[0];
  if (!pick) throw new LiewoodError('This is not one of the season files Radar knows: Liewood\'s Product Data file (a tab with "Product", "EAN" and "Sales Order Multiple"), or the Customer Forecast Form (tabs with "SKU", "RRP inc GST" and "WS ex GST").');
  const { s, h } = pick, get = (r: unknown[], k: keyof typeof PD_COLS) => (h!.idx[k] === undefined ? undefined : r[h!.idx[k]!]);
  const out = new Map<string, ProductDataRow>();
  for (const r of s.rows.slice(h!.at + 1)) {
    if (!Array.isArray(r)) continue;
    const sku = skuOf(get(r, 'sku'));
    if (!sku) continue;
    out.set(sku, { sku, ean: eanOf(get(r, 'ean')), styleNo: clean(get(r, 'styleNo'))?.toUpperCase() ?? null, styleName: clean(get(r, 'styleName')), colourCode: clean(get(r, 'colourCode')), colour: clean(get(r, 'colour')),
      size: clean(get(r, 'size')), seasonCode: clean(get(r, 'seasonCode')), essentials: clean(get(r, 'essentials')), development: clean(get(r, 'development')), dropDelivery: clean(get(r, 'dropDelivery')),
      salesMultiple: whole(get(r, 'salesMultiple')), wspEurStock: price(get(r, 'wspStock')), wspEurPre: price(get(r, 'wspPre')), rrpEur: price(get(r, 'rrpEur')),
      brand: clean(get(r, 'brand')), category: clean(get(r, 'category')), subCategory: clean(get(r, 'subCategory')), productType: clean(get(r, 'productType')) });
  }
  if (!out.size) throw new LiewoodError(`The "${s.name}" tab has no products under its headings.`);
  return { kind: 'product_data', rows: [...out.values()], tabs: [s.name], problems: [] };
}

// ---------- the rules for filling a SKU in ----------
/** Liewood's EUR wholesale price: the STOCK price, or the PRE price only when there is no STOCK price (blank or 0). */
export const wspEurOf = (stock: number | null, pre: number | null): number | null => (stock !== null && stock > 0 ? stock : pre !== null && pre > 0 ? pre : null);
/** "TRUE"/"False"/"ESSENTIALS" in Liewood's file, written the way the range writes it. */
export const essentialOf = (v: string | null): string | null => (v === null ? null : /^(true|yes|essentials?)$/i.test(v) ? 'YES' : /^(false|no)$/i.test(v) ? 'NO' : v);

/** Proposed RRP against DEAR's RRP: what the old PRICE CHECK column showed, with the reason when it is not a match. */
export type PriceCheck = 'match' | 'differs' | 'not_in_dear' | 'no_proposed';
export function priceCheck(proposed: number | null, dear: number | null, inDear: boolean): PriceCheck {
  if (!inDear || dear === null) return 'not_in_dear';
  if (proposed === null) return 'no_proposed';
  return Math.abs(proposed - dear) < 0.005 ? 'match' : 'differs';
}
