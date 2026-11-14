// The product feed's Status column, and the inner carton, outer carton and supplier cost columns (read from DEAR).
// Pure rules first (tested without a database, see scripts/test-product-feed.ts), then the job that reads them from DEAR and saves them.
// Radar only READS DEAR here. If DEAR's answer does not carry a field at all, what Radar has is left as it is, never wiped.
import { prisma } from './prisma';

// ---------- Status (the feed's first column) ----------
/** Discontinued: DEAR has the product as Deprecated, or its stage here is Discontinued. Otherwise the product's stage, in the words the team uses (EOL, Preorder Only, New, Phasing Out...). Otherwise Active. */
export function statusOf(dearStatus: string | null | undefined, lifecycle: string | null | undefined, labels?: Map<string, string>): string {
  if (dearStatus === 'Deprecated' || lifecycle === 'discontinued') return 'Discontinued';
  if (!lifecycle) return 'Active';
  const label = labels?.get(lifecycle);
  if (label && label.trim()) return label.trim();
  return lifecycle === 'eol' ? 'EOL' : lifecycle.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// ---------- inner and outer carton ----------
const whole = (v: unknown): number | null => { const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.trim()) : NaN; return Number.isFinite(n) && n >= 1 && n <= 1_000_000 ? Math.round(n) : null; };   // 0 is "not set" in DEAR
const INNER = ['InnerCartonQuantity', 'CartonInnerQuantity', 'InnerCartonQty', 'CartonInnerQty', 'InnerQuantity', 'InnerQty'];
const OUTER = ['OuterCartonQuantity', 'CartonOuterQuantity', 'OuterCartonQty', 'CartonOuterQty', 'OuterQuantity', 'OuterQty', 'CartonQuantity'];
export const innerOverride = () => process.env.DEAR_INNER_CARTON_FIELD?.trim() || '';
export const outerOverride = () => process.env.DEAR_OUTER_CARTON_FIELD?.trim() || '';
/** The name of the DEAR field holding it: the one set in the environment, a well-known name, or any field with the word inner (or outer) and carton or quantity in it. */
export function cartonKey(p: any, which: 'inner' | 'outer'): string | null {
  if (!p || typeof p !== 'object') return null;
  const keys = Object.keys(p), override = which === 'inner' ? innerOverride() : outerOverride();
  if (override) return keys.includes(override) ? override : null;
  const known = (which === 'inner' ? INNER : OUTER).find(k => keys.includes(k));
  if (known) return known;
  const word = which === 'inner' ? /inner/i : /outer/i;
  return keys.find(k => word.test(k) && /carton|qty|quantity/i.test(k)) ?? null;
}
export function cartonsOf(p: any): { inner: number | null; outer: number | null } {
  const i = cartonKey(p, 'inner'), o = cartonKey(p, 'outer');
  return { inner: i ? whole(p[i]) : null, outer: o ? whole(p[o]) : null };
}

// ---------- supplier cost ----------
export type SupplierCost = { cost: number; currency: string | null; supplier: string | null };
const money = (v: unknown): number => { const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(/[$,\s]/g, '')) : NaN; return Number.isFinite(n) && n > 0 ? Math.round(n * 10000) / 10000 : 0; };
const pick = (s: any, names: string[]): unknown => { for (const n of names) if (s[n] !== undefined && s[n] !== null && s[n] !== '') return s[n]; return undefined; };
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : typeof v === 'string' ? (/^(true|yes|1)$/i.test(v.trim()) ? true : /^(false|no|0)$/i.test(v.trim()) ? false : null) : typeof v === 'number' ? v !== 0 : null);
/** A date from DEAR (2026-10-09T00:00:00, or 09/10/2026 written day first) as a sortable number; 0 when there is none. */
export function whenOf(v: unknown): number {
  if (typeof v !== 'string' || !v.trim()) return 0;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(v.trim()); if (iso) return Date.UTC(+iso[1]!, +iso[2]! - 1, +iso[3]!);
  const au = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(v.trim()); if (au) return Date.UTC(+au[3]!, +au[2]! - 1, +au[1]!);
  return 0;
}
/**
 * The supplier cost of a product, from DEAR's Suppliers tab: of the suppliers that have a price, those ticked "Include in pricing" (all of them if none is ticked);
 * the one supplied most recently wins (if none has a date, the first); its price is the Fixed price when it has one, otherwise the Latest price; with its currency.
 * null when no supplier has a price.
 */
export function supplierCostOf(p: any): SupplierCost | null {
  const list: any[] = Array.isArray(p?.Suppliers) ? p.Suppliers.filter((s: any) => s && typeof s === 'object') : [];
  const rows = list.map((s, order) => {
    const fixed = money(pick(s, ['FixedCost', 'FixedPrice', 'CostFixed'])), latest = money(pick(s, ['Cost', 'LatestCost', 'LatestPrice', 'Price', 'UnitPrice']));
    const currency = pick(s, ['Currency', 'CurrencyName', 'CurrencyCode']), name = pick(s, ['SupplierName', 'Name', 'Supplier']);
    return { order, cost: fixed > 0 ? fixed : latest, include: bool(pick(s, ['IncludeInPricing', 'IncludedInPricing', 'IncludeInPriceCalculation'])), when: whenOf(pick(s, ['LastSupplied', 'LastSuppliedDate', 'LastSuppliedOn', 'LastPurchaseDate', 'LastDeliveredDate'])),
      currency: typeof currency === 'string' && currency.trim() ? currency.trim().toUpperCase().slice(0, 8) : null, supplier: typeof name === 'string' && name.trim() ? name.trim().slice(0, 120) : null };
  }).filter(r => r.cost > 0);
  if (!rows.length) return null;
  const included = rows.filter(r => r.include !== false), pool = included.length ? included : rows;
  const best = [...pool].sort((a, b) => b.when - a.when || a.order - b.order)[0]!;
  return { cost: best.cost, currency: best.currency, supplier: best.supplier };
}

/** The whole story for one DEAR product, in plain words: used by the read-only check script, and by the example sheet for the sales team. */
export function explainProduct(p: any): string[] {
  const out: string[] = [], i = cartonKey(p, 'inner'), o = cartonKey(p, 'outer'), c = cartonsOf(p), s = supplierCostOf(p);
  out.push(`SKU ${p?.SKU ?? '?'}: ${p?.Name ?? ''}`);
  out.push(`Inner carton: ${i ? `field "${i}" = ${JSON.stringify(p[i])}` : 'no field found'} -> ${c.inner ?? 'blank'}`);
  out.push(`Outer carton: ${o ? `field "${o}" = ${JSON.stringify(p[o])}` : 'no field found'} -> ${c.outer ?? 'blank'}`);
  const list: any[] = Array.isArray(p?.Suppliers) ? p.Suppliers : [];
  out.push(`Suppliers in DEAR: ${list.length}`);
  list.forEach((x, n) => out.push(`  ${n + 1}. ${JSON.stringify(x)}`));
  out.push(s ? `Supplier cost chosen: ${s.cost} ${s.currency ?? '(no currency)'} from ${s.supplier ?? 'a supplier with no name'}` : 'Supplier cost: blank (no supplier has a price)');
  return out;
}

// ---------- the job: read DEAR, save onto crm.products ----------
export type CartonResult = { checked: number; updated: number; withInner: number; withOuter: number; withCost: number; skipped: string | null; examples: { sku: string; inner: number | null; outer: number | null; cost: number | null; currency: string | null; supplier: string | null }[] };
const missingColumns = (e: unknown) => (e as any)?.code === '42703' || (/inner_carton_qty|outer_carton_qty|supplier_cost|supplier_name/.test(String((e as any)?.message ?? e)) && /does not exist|column/i.test(String((e as any)?.message ?? e)));
export async function syncProductCartons(products?: any[], o: { dryRun?: boolean } = {}): Promise<CartonResult> {
  const list = products ?? await (await import('../sync/dearClient')).fetchAllProducts();
  const rows = list.filter(p => p && p.SKU != null && String(p.SKU).trim() !== '').map(p => ({ sku: String(p.SKU).trim(), ...cartonsOf(p), cost: supplierCostOf(p) }));
  const out: CartonResult = { checked: rows.length, updated: 0, withInner: rows.filter(r => r.inner).length, withOuter: rows.filter(r => r.outer).length, withCost: rows.filter(r => r.cost).length, skipped: null,
    examples: rows.filter(r => r.inner || r.outer || r.cost).slice(0, 5).map(r => ({ sku: r.sku, inner: r.inner, outer: r.outer, cost: r.cost?.cost ?? null, currency: r.cost?.currency ?? null, supplier: r.cost?.supplier ?? null })) };
  // If DEAR's answer carries none of these fields at all, something is different about it: leave what we have, never wipe it.
  const cartonsPresent = list.some(p => p && (cartonKey(p, 'inner') || cartonKey(p, 'outer'))), suppliersPresent = list.some(p => p && Array.isArray(p.Suppliers));
  if (!cartonsPresent) console.warn('Product cartons: DEAR\'s product list has no inner or outer carton field, so cartons were left as they are (set DEAR_INNER_CARTON_FIELD and DEAR_OUTER_CARTON_FIELD if they are named differently).');
  if (!suppliersPresent) console.warn('Product cartons: DEAR\'s product list has no Suppliers list, so supplier costs were left as they are.');
  if (!cartonsPresent && !suppliersPresent) return { ...out, skipped: 'DEAR\'s product list carries neither carton fields nor suppliers' };
  if (o.dryRun) return out;
  try {
    for (let i = 0; i < rows.length; i += 1000) {
      const b = rows.slice(i, i + 1000);
      const r = await prisma.$queryRaw<{ n: number }[]>`
        update crm.products p set
          inner_carton_qty = case when ${cartonsPresent}::boolean then v.inq else p.inner_carton_qty end,
          outer_carton_qty = case when ${cartonsPresent}::boolean then v.ouq else p.outer_carton_qty end,
          supplier_cost = case when ${suppliersPresent}::boolean then v.cost else p.supplier_cost end,
          supplier_cost_currency = case when ${suppliersPresent}::boolean then v.cur else p.supplier_cost_currency end,
          supplier_name = case when ${suppliersPresent}::boolean then v.sup else p.supplier_name end
        from unnest(${b.map(x => x.sku)}::text[], ${b.map(x => x.inner)}::int[], ${b.map(x => x.outer)}::int[], ${b.map(x => x.cost?.cost ?? null)}::numeric[], ${b.map(x => x.cost?.currency ?? null)}::text[], ${b.map(x => x.cost?.supplier ?? null)}::text[]) as v(sku, inq, ouq, cost, cur, sup)
        where p.sku = v.sku and (
          (${cartonsPresent}::boolean and (p.inner_carton_qty is distinct from v.inq or p.outer_carton_qty is distinct from v.ouq))
          or (${suppliersPresent}::boolean and (p.supplier_cost is distinct from v.cost or p.supplier_cost_currency is distinct from v.cur or p.supplier_name is distinct from v.sup)))
        returning 1 as n`;
      out.updated += r.length;
    }
  } catch (e) { if (missingColumns(e)) return { ...out, skipped: 'not set up in the database yet (run product-cartons.sql)' }; throw e; }
  return out;
}
