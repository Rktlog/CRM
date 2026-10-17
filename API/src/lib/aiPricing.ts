// Pricing for the assistant: from a supplier cost to a wholesale and a retail price, and checking a supplier price list
// against what is in the CRM. All exact arithmetic, done here and not by the language model, with the assumptions made
// visible so they can be corrected. Prices are in AUD. GST is shown separately, never mixed in by accident.
export class PriceError extends Error {}

export type Rounding = 'none' | '.95' | '.99' | '.50' | '0.05' | '1';
export type Direction = 'up' | 'nearest' | 'down';
export type PriceParams = {
  currency: string; fxRate: number | null;            // supplier currency, and AUD per 1 unit of it
  freightPct: number; dutyPct: number; otherPct: number; freightPerUnit: number;   // added to the supplier cost
  costIncludesGst: boolean; gstPct: number;
  wholesaleMarginPct: number | null;                   // our margin on the wholesale price (45 = 45% of the price is margin)
  wholesaleMarkupPct: number | null;                   // or: markup on landed cost (80 = landed cost x 1.8)
  retailerMarginPct: number;                           // the shop's margin on the RRP ex GST (50 = keystone: RRP ex GST is double wholesale)
  rrpRounding: Rounding; rrpDirection: Direction; wholesaleRounding: Rounding; wholesaleDirection: Direction;
  minWholesaleMarginPct: number | null; tolerancePct: number;
  wholesaleTierIncludesGst: boolean; retailTierIncludesGst: boolean;   // how the prices already in DEAR are held
};

const num = (v: unknown, name: string, lo: number, hi: number, dflt: number | null): number | null => {
  if (v === undefined || v === null || v === '') return dflt;
  const n = typeof v === 'string' ? Number(v.replace(/[$,%\s]/g, '')) : Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) throw new PriceError(`${name} must be a number from ${lo} to ${hi}`);
  return n;
};
const oneOf = <T extends string>(v: unknown, name: string, allowed: readonly T[], dflt: T): T => {
  if (v === undefined || v === null || v === '') return dflt;
  const s = String(v).trim().toLowerCase();
  const hit = allowed.find(a => a.toLowerCase() === s); if (!hit) throw new PriceError(`${name} must be one of: ${allowed.join(', ')}`);
  return hit;
};
// People write the same rule many ways: .95, 0.95, "ends in 95", "$1", "whole".
const ROUNDING_ALIASES: Record<string, Rounding> = { none: 'none', '.95': '.95', '0.95': '.95', '95': '.95', '.99': '.99', '0.99': '.99', '99': '.99', '.5': '.50', '.50': '.50', '0.5': '.50', '0.50': '.50', half: '.50', '0.05': '0.05', '.05': '0.05', '5c': '0.05', '1': '1', '1.00': '1', '$1': '1', whole: '1', dollar: '1' };
const rounding = (v: unknown, name: string, dflt: Rounding): Rounding => {
  if (v === undefined || v === null || v === '') return dflt;
  const hit = ROUNDING_ALIASES[String(v).trim().toLowerCase()]; if (!hit) throw new PriceError(`${name} must be one of: none, .95, .99, .50, 0.05, 1`);
  return hit;
};
const bool = (v: unknown, dflt: boolean) => (typeof v === 'boolean' ? v : typeof v === 'string' ? /^(true|yes|y|1)$/i.test(v.trim()) : dflt);

export function parseParams(raw: unknown): PriceParams {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const currency = String(r.currency ?? 'AUD').trim().toUpperCase() || 'AUD';
  const p: PriceParams = {
    currency, fxRate: num(r.fxRate, 'fxRate', 0.0001, 100000, null),
    freightPct: num(r.freightPct, 'freightPct', 0, 500, 0)!, dutyPct: num(r.dutyPct, 'dutyPct', 0, 500, 0)!, otherPct: num(r.otherPct, 'otherPct', 0, 500, 0)!, freightPerUnit: num(r.freightPerUnit, 'freightPerUnit', 0, 100000, 0)!,
    costIncludesGst: bool(r.costIncludesGst, false), gstPct: num(r.gstPct, 'gstPct', 0, 100, 10)!,
    wholesaleMarginPct: num(r.wholesaleMarginPct, 'wholesaleMarginPct', 0, 95, null), wholesaleMarkupPct: num(r.wholesaleMarkupPct, 'wholesaleMarkupPct', 0, 5000, null),
    retailerMarginPct: num(r.retailerMarginPct, 'retailerMarginPct', 0, 95, 50)!,
    rrpRounding: rounding(r.rrpRounding, 'rrpRounding', '.95'), rrpDirection: oneOf(r.rrpDirection, 'rrpDirection', ['up', 'nearest', 'down'] as const, 'up'),
    wholesaleRounding: rounding(r.wholesaleRounding, 'wholesaleRounding', '0.05'), wholesaleDirection: oneOf(r.wholesaleDirection, 'wholesaleDirection', ['up', 'nearest', 'down'] as const, 'nearest'),
    minWholesaleMarginPct: num(r.minWholesaleMarginPct, 'minWholesaleMarginPct', 0, 95, null), tolerancePct: num(r.tolerancePct, 'tolerancePct', 0, 100, 3)!,
    wholesaleTierIncludesGst: bool(r.wholesaleTierIncludesGst, false), retailTierIncludesGst: bool(r.retailTierIncludesGst, true),
  };
  if (p.wholesaleMarginPct !== null && p.wholesaleMarkupPct !== null) throw new PriceError('Give either wholesaleMarginPct or wholesaleMarkupPct, not both');
  if (p.currency !== 'AUD' && p.fxRate === null) throw new PriceError(`The costs are in ${p.currency}, so I need the exchange rate: how many AUD is 1 ${p.currency}? (fxRate)`);
  return p;
}

// Round a price to a rule, in whole cents so floating point never sneaks in. 'up' never goes below the price, 'down' never above.
export function roundPrice(x: number, rule: Rounding, dir: Direction): number {
  if (!Number.isFinite(x)) return x;
  const c = Math.round(x * 100 + 1e-7);
  const pick = (down: number, up: number) => (dir === 'up' ? up : dir === 'down' ? down : (c - down < up - c ? down : up));
  if (rule === 'none') return c / 100;
  if (rule === '.95' || rule === '.99') {
    const end = rule === '.95' ? 95 : 99, base = Math.floor(c / 100) * 100 + end;
    const down = base <= c ? base : base - 100, up = base >= c ? base : base + 100;
    return Math.max(pick(down, up), end) / 100;
  }
  const step = rule === '0.05' ? 5 : rule === '.50' ? 50 : 100, down = Math.floor(c / step) * step, up = Math.ceil(c / step) * step;
  return pick(down, up) / 100;
}

const r2 = (n: number) => Math.round(n * 100) / 100, r1 = (n: number) => Math.round(n * 10) / 10;
export type PriceResult = {
  costAud: number; landed: number; wholesale: number; rrpEx: number; rrpInc: number;
  wholesaleMarginPct: number; retailerMarginPct: number; directMarginPct: number; belowMin: boolean;
};

// currency: this item's currency if it differs from the list's. rrp: a retail price (inc GST) to work back from instead.
export function priceItem(p: PriceParams, item: { cost: number; currency?: string; rrp?: number | null }): PriceResult {
  if (!Number.isFinite(item.cost) || item.cost < 0) throw new PriceError('A cost is missing or not a number');
  const cur = (item.currency ?? p.currency).toUpperCase();
  if (cur !== 'AUD' && !p.fxRate) throw new PriceError(`The costs are in ${cur}, so I need the exchange rate (fxRate)`);
  const gst = 1 + p.gstPct / 100;
  const costAud = (cur === 'AUD' ? item.cost : item.cost * p.fxRate!) / (p.costIncludesGst ? gst : 1);
  const landed = costAud * (1 + (p.freightPct + p.dutyPct + p.otherPct) / 100) + p.freightPerUnit;
  const shopShare = 1 - p.retailerMarginPct / 100;

  let wholesaleRaw: number;
  if (item.rrp && item.rrp > 0) wholesaleRaw = (item.rrp / gst) * shopShare;                       // working back from a retail price
  else if (p.wholesaleMarginPct !== null) wholesaleRaw = landed / (1 - p.wholesaleMarginPct / 100);
  else if (p.wholesaleMarkupPct !== null) wholesaleRaw = landed * (1 + p.wholesaleMarkupPct / 100);
  else throw new PriceError('Tell me how to price it: wholesaleMarginPct (our margin on the wholesale price) or wholesaleMarkupPct (markup on landed cost), or give a retail price for each item');
  const wholesale = roundPrice(wholesaleRaw, p.wholesaleRounding, p.wholesaleDirection);

  let rrpInc: number;
  if (item.rrp && item.rrp > 0) rrpInc = item.rrp;
  else { const rrpEx = shopShare > 0 ? wholesale / shopShare : wholesale; rrpInc = roundPrice(rrpEx * gst, p.rrpRounding, p.rrpDirection); }
  const rrpEx = rrpInc / gst;
  const wholesaleMarginPct = wholesale > 0 ? ((wholesale - landed) / wholesale) * 100 : 0;
  return {
    costAud: r2(costAud), landed: r2(landed), wholesale: r2(wholesale), rrpEx: r2(rrpEx), rrpInc: r2(rrpInc),
    wholesaleMarginPct: r1(wholesaleMarginPct), retailerMarginPct: r1(rrpEx > 0 ? ((rrpEx - wholesale) / rrpEx) * 100 : 0), directMarginPct: r1(rrpEx > 0 ? ((rrpEx - landed) / rrpEx) * 100 : 0),
    belowMin: p.minWholesaleMarginPct !== null && wholesaleMarginPct + 1e-9 < p.minWholesaleMarginPct,
  };
}

// ---- checking a supplier list against what the CRM holds ----
export type Supplier = { row: number; sku: string | null; barcode: string | null; name: string | null; cost: number; currency?: string; rrp?: number | null };
export type Ours = { sku: string; name: string | null; brand: string | null; barcode: string | null; wholesale: number | null; retail: number | null };
export type Compared = {
  row: number; supplierSku: string | null; supplierName: string | null; supplierCost: number; currency: string; landed: number;
  ourSku: string | null; ourName: string | null; matchedBy: string; ourWholesale: number | null; suggestedWholesale: number; wholesaleGapPct: number | null; ourWholesaleMarginPct: number | null;
  ourRetailInc: number | null; suggestedRrpInc: number; retailGapPct: number | null; retailerMarginAtOurRrpPct: number | null; flag: string; note: string;
};

const clean = (s: string) => s.trim().toUpperCase();
const squash = (s: string) => clean(s).replace(/[\s\-_./]+/g, '');
export function matchProducts(rows: Supplier[], products: Ours[]): Map<number, { product: Ours; by: string }> {
  const exact = new Map<string, Ours>(), loose = new Map<string, Ours[]>(), codes = new Map<string, Ours>();
  for (const p of products) {
    exact.set(clean(p.sku), p);
    const k = squash(p.sku); loose.set(k, [...(loose.get(k) ?? []), p]);
    if (p.barcode) codes.set(p.barcode.trim(), p);
  }
  const out = new Map<number, { product: Ours; by: string }>();
  for (const r of rows) {
    const e = r.sku ? exact.get(clean(r.sku)) : undefined; if (e) { out.set(r.row, { product: e, by: 'SKU' }); continue; }
    const l = r.sku ? loose.get(squash(r.sku)) : undefined; if (l && l.length === 1) { out.set(r.row, { product: l[0], by: 'SKU (ignoring spaces and dashes)' }); continue; }
    const b = r.barcode ? codes.get(r.barcode.trim()) : undefined; if (b) { out.set(r.row, { product: b, by: 'Barcode' }); continue; }
    if (r.sku && codes.get(r.sku.trim())) out.set(r.row, { product: codes.get(r.sku.trim())!, by: 'Barcode (in the SKU column)' });
  }
  return out;
}

export function comparePrices(p: PriceParams, rows: Supplier[], products: Ours[]): Compared[] {
  const matches = matchProducts(rows, products), gst = 1 + p.gstPct / 100, tol = p.tolerancePct / 100;
  return rows.map(r => {
    const cur = (r.currency ?? p.currency).toUpperCase();
    const calc = priceItem(p, { cost: r.cost, currency: r.currency, rrp: null });
    const m = matches.get(r.row), o = m?.product ?? null;
    const base = { row: r.row, supplierSku: r.sku, supplierName: r.name, supplierCost: r.cost, currency: cur, landed: calc.landed, suggestedWholesale: calc.wholesale, suggestedRrpInc: calc.rrpInc };
    if (!o) return { ...base, ourSku: null, ourName: null, matchedBy: '', ourWholesale: null, wholesaleGapPct: null, ourWholesaleMarginPct: null, ourRetailInc: null, retailGapPct: null, retailerMarginAtOurRrpPct: null, flag: 'Not in the CRM', note: 'No product with that SKU or barcode. It may be new, or listed under a different code.' };
    const wEx = o.wholesale === null ? null : p.wholesaleTierIncludesGst ? o.wholesale / gst : o.wholesale;
    const rInc = o.retail === null ? null : p.retailTierIncludesGst ? o.retail : o.retail * gst;
    const wGap = wEx === null ? null : r1(((wEx - calc.wholesale) / calc.wholesale) * 100), rGap = rInc === null ? null : r1(((rInc - calc.rrpInc) / calc.rrpInc) * 100);
    const wMargin = wEx === null || wEx <= 0 ? null : r1(((wEx - calc.landed) / wEx) * 100);
    const retailerMargin = wEx === null || rInc === null ? null : r1((((rInc / gst) - wEx) / (rInc / gst)) * 100);
    let flag = 'OK', note = '';
    if (wEx === null && rInc === null) { flag = 'No price in the CRM'; note = 'The product has no wholesale or retail price set.'; }
    else if (wMargin !== null && p.minWholesaleMarginPct !== null && wMargin + 1e-9 < p.minWholesaleMarginPct) { flag = 'Below minimum margin'; note = `Wholesale margin is ${wMargin}% against a minimum of ${p.minWholesaleMarginPct}%.`; }
    else if (wEx !== null && wEx < calc.wholesale * (1 - tol)) { flag = 'Wholesale too low'; note = `Wholesale is ${Math.abs(wGap!)}% under what the target margin needs.`; }
    else if (rInc !== null && rInc < calc.rrpInc * (1 - tol)) { flag = 'Retail too low'; note = `The retail price is ${Math.abs(rGap!)}% under what the target gives.`; }
    else if (wEx !== null && wEx > calc.wholesale * (1 + tol)) { flag = 'Wholesale above target'; note = `Wholesale is ${wGap}% over the target, so there is room, or it is priced for the market.`; }
    else if (rInc !== null && rInc > calc.rrpInc * (1 + tol)) { flag = 'Retail above target'; note = `The retail price is ${rGap}% over the target.`; }
    else if (wEx === null) { flag = 'No wholesale price'; note = 'Retail is fine but there is no wholesale price set.'; }
    else if (rInc === null) { flag = 'No retail price'; note = 'Wholesale is fine but there is no retail price set.'; }
    return { ...base, ourSku: o.sku, ourName: o.name, matchedBy: m!.by, ourWholesale: wEx === null ? null : r2(wEx), wholesaleGapPct: wGap, ourWholesaleMarginPct: wMargin, ourRetailInc: rInc === null ? null : r2(rInc), retailGapPct: rGap, retailerMarginAtOurRrpPct: retailerMargin, flag, note };
  });
}

// What was assumed, in words, so a wrong assumption is easy to spot.
export function assumptions(p: PriceParams): string[] {
  const a = [`Costs are in ${p.currency}${p.currency === 'AUD' ? '' : ` at ${p.fxRate} AUD each`}, ${p.costIncludesGst ? 'including' : 'excluding'} GST.`];
  const add = [p.freightPct && `freight ${p.freightPct}%`, p.dutyPct && `duty ${p.dutyPct}%`, p.otherPct && `other ${p.otherPct}%`, p.freightPerUnit && `$${p.freightPerUnit} per unit`].filter(Boolean);
  a.push(add.length ? `Landed cost = cost plus ${add.join(', ')}.` : 'Landed cost = cost (no freight or duty added).');
  a.push(p.wholesaleMarginPct !== null ? `Wholesale = landed cost / (1 - ${p.wholesaleMarginPct}%), so ${p.wholesaleMarginPct}% of the wholesale price is our margin.` : p.wholesaleMarkupPct !== null ? `Wholesale = landed cost x ${1 + p.wholesaleMarkupPct / 100} (a ${p.wholesaleMarkupPct}% markup).` : 'Wholesale is worked back from the retail price.');
  a.push(`RRP ex GST = wholesale / (1 - ${p.retailerMarginPct}%) (the shop's margin), then plus ${p.gstPct}% GST. RRP rounds ${p.rrpDirection === 'nearest' ? 'to the nearest' : p.rrpDirection} ${p.rrpRounding === 'none' ? 'cent' : p.rrpRounding}; wholesale rounds ${p.wholesaleDirection === 'nearest' ? 'to the nearest' : p.wholesaleDirection} ${p.wholesaleRounding === 'none' ? 'cent' : p.wholesaleRounding}.`);
  a.push(`The CRM's wholesale prices are treated as ${p.wholesaleTierIncludesGst ? 'including' : 'excluding'} GST and its retail prices as ${p.retailTierIncludesGst ? 'including' : 'excluding'} GST. Say if that is wrong.`);
  return a;
}