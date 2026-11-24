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

// ---------- ETA: DEAR's own "ETA" field, exactly as the team types it ("Nov-26") ----------
// DEAR keeps its extra product fields in numbered slots (AdditionalAttribute1 to 10). Which slot is "ETA" is set in DEAR's attribute set settings,
// so it is looked up by its NAME there (per attribute set), never assumed. DEAR_ETA_FIELD on the API can name the slot instead.
export const etaOverride = () => process.env.DEAR_ETA_FIELD?.trim() || '';
const isEtaName = (v: unknown) => typeof v === 'string' && /^\s*eta\s*$/i.test(v);
/** From DEAR's attribute set settings: for each attribute set (by name, lower case), the product field that holds "ETA". "*" is the first one found. */
export function etaFieldsFrom(raw: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const sets: any[] = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? (Object.values(raw).find(v => Array.isArray(v)) as any[] | undefined) ?? [raw] : [];
  for (const set of sets) {
    if (!set || typeof set !== 'object') continue;
    let field: string | null = null;
    for (const [k, v] of Object.entries(set)) {
      const n = /(\d{1,2})/.exec(k)?.[1];
      if (isEtaName(v) && n && /attribute/i.test(k)) { field = `AdditionalAttribute${Number(n)}`; break; }
      if (Array.isArray(v)) for (const [i, a] of v.entries()) {   // a list of attributes, each with its name
        if (a && typeof a === 'object' && isEtaName((a as any).Name ?? (a as any).Label)) {
          const pos = Number((a as any).Number ?? (a as any).Position ?? (a as any).Index ?? (a as any).Order ?? i + 1);
          if (Number.isInteger(pos) && pos >= 1 && pos <= 10) { field = `AdditionalAttribute${pos}`; break; }
        }
      }
      if (field) break;
    }
    if (!field) continue;
    const name = String(set.Name ?? set.AttributeSetName ?? '').trim().toLowerCase();
    if (!out.has(name)) out.set(name, field);
    if (!out.has('*')) out.set('*', field);
  }
  return out;
}
/** The field that holds this product's ETA: the one named in the settings, else the one its attribute set uses, else the first one found. */
export function etaFieldFor(p: any, fields: Map<string, string>): string | null {
  const o = etaOverride(); if (o) return o;
  return fields.get(String(p?.AttributeSet ?? '').trim().toLowerCase()) ?? fields.get('*') ?? null;
}
/** The ETA as typed (spaces tidied, at most 40 characters); blank stays blank. Never turned into a date. */
export function etaOf(p: any, field: string | null): string | null {
  if (!field || !p || typeof p !== 'object') return null;
  const v = p[field];
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const t = String(v).replace(/\s+/g, ' ').trim().slice(0, 40);
  return t || null;
}
/** DEAR's attribute set settings, read once per run. Nothing is found if DEAR will not say (the job then leaves ETAs as they are). */
export async function fetchEtaFields(): Promise<Map<string, string>> {
  try { const { dearGet } = await import('../sync/dearClient'); return etaFieldsFrom(await dearGet('/ref/attributeset', { Page: 1, Limit: 100 })); }
  catch (e) { console.warn('Product cartons: could not read DEAR\'s attribute set settings, so ETAs were left as they are:', String((e as Error)?.message ?? e).slice(0, 120)); return new Map(); }
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
export type Diagnostics = { withSuppliersList: number; supplierFields: string[]; innerField: string | null; outerField: string | null; etaField: string | null };
export type CartonResult = { checked: number; updated: number; withInner: number; withOuter: number; withCost: number; withEta: number; etaUpdated: number; etaSkipped: string | null; skipped: string | null; diagnostics: Diagnostics; examples: { sku: string; inner: number | null; outer: number | null; cost: number | null; currency: string | null; supplier: string | null }[] };
const missingColumns = (e: unknown) => (e as any)?.code === '42703' || (/inner_carton_qty|outer_carton_qty|supplier_cost|supplier_name/.test(String((e as any)?.message ?? e)) && /does not exist|column/i.test(String((e as any)?.message ?? e)));
/** Every product from DEAR WITH its Suppliers list (DEAR leaves the suppliers out unless it is asked for them), 100 at a time, as Radar's other product reads do. */
export async function fetchProductsWithSuppliers(): Promise<any[]> {
  const { dearGet } = await import('../sync/dearClient');
  const all: any[] = [];
  for (let page = 1; page <= 500; page++) {
    const data = await dearGet('/product', { Page: page, Limit: 100, IncludeSuppliers: 'true' });
    const batch: any[] = data?.Products ?? [];
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}
export async function syncProductCartons(products?: any[], o: { dryRun?: boolean; etaFields?: Map<string, string> } = {}): Promise<CartonResult> {
  const list = products ?? await fetchProductsWithSuppliers();
  const etaFields = o.etaFields ?? (products ? new Map<string, string>() : await fetchEtaFields());
  const rows = list.filter(p => p && p.SKU != null && String(p.SKU).trim() !== '').map(p => { const ef = etaFieldFor(p, etaFields); return { sku: String(p.SKU).trim(), ...cartonsOf(p), cost: supplierCostOf(p), eta: etaOf(p, ef), etaKnown: !!ef && Object.prototype.hasOwnProperty.call(p, ef) }; });
  const withList = list.filter(p => p && Array.isArray(p.Suppliers)), firstSupplier = withList.flatMap(p => p.Suppliers).find((x: any) => x && typeof x === 'object');
  const sample = list.find(p => p && (cartonKey(p, 'inner') || cartonKey(p, 'outer')));
  const diagnostics: Diagnostics = { withSuppliersList: withList.length, supplierFields: firstSupplier ? Object.keys(firstSupplier).slice(0, 30) : [], innerField: sample ? cartonKey(sample, 'inner') : null, outerField: sample ? cartonKey(sample, 'outer') : null, etaField: etaOverride() || etaFields.get('*') || null };
  const out: CartonResult = { checked: rows.length, updated: 0, withInner: rows.filter(r => r.inner).length, withOuter: rows.filter(r => r.outer).length, withCost: rows.filter(r => r.cost).length, withEta: rows.filter(r => r.eta).length, etaUpdated: 0, etaSkipped: null, skipped: null, diagnostics,
    examples: rows.filter(r => r.inner || r.outer || r.cost).slice(0, 5).map(r => ({ sku: r.sku, inner: r.inner, outer: r.outer, cost: r.cost?.cost ?? null, currency: r.cost?.currency ?? null, supplier: r.cost?.supplier ?? null })) };
  // If DEAR's answer carries none of these fields at all, something is different about it: leave what we have, never wipe it.
  const cartonsPresent = list.some(p => p && (cartonKey(p, 'inner') || cartonKey(p, 'outer'))), suppliersPresent = list.some(p => p && Array.isArray(p.Suppliers));
  if (!cartonsPresent) console.warn('Product cartons: DEAR\'s product list has no inner or outer carton field, so cartons were left as they are (set DEAR_INNER_CARTON_FIELD and DEAR_OUTER_CARTON_FIELD if they are named differently).');
  if (!suppliersPresent) console.warn('Product cartons: DEAR\'s product list has no Suppliers list, so supplier costs were left as they are.');
  // ETA: only for products whose answer actually carries the ETA field (so a field DEAR did not send never wipes what Radar has)
  const etaRows = rows.filter(r => r.etaKnown), etaPresent = etaRows.length > 0;
  if (!etaPresent) { out.etaSkipped = diagnostics.etaField ? `DEAR's products do not carry ${diagnostics.etaField}` : 'no attribute called ETA was found in DEAR\'s attribute set settings (set DEAR_ETA_FIELD to name it)'; }
  console.log(`Product cartons: read ${list.length} products from DEAR; ${diagnostics.withSuppliersList} came with a Suppliers list (fields on a supplier line: ${diagnostics.supplierFields.join(', ') || 'none'}); inner carton field ${diagnostics.innerField ?? 'not found'}, outer ${diagnostics.outerField ?? 'not found'}; ${out.withInner} inner, ${out.withOuter} outer and ${out.withCost} supplier costs found; ETA field ${diagnostics.etaField ?? 'not found'}, ${out.withEta} ETAs found.`);
  if (!cartonsPresent && !suppliersPresent && !etaPresent) return { ...out, skipped: 'DEAR\'s product list carries neither carton fields nor suppliers' };
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
        from unnest(${b.map(x => x.sku)}::text[], ${b.map(x => x.inner)}::int[], ${b.map(x => x.outer)}::int[], ${b.map(x => x.cost?.cost == null ? null : String(x.cost.cost))}::text[]::numeric[], ${b.map(x => x.cost?.currency ?? null)}::text[], ${b.map(x => x.cost?.supplier ?? null)}::text[]) as v(sku, inq, ouq, cost, cur, sup)
        where p.sku = v.sku and (
          (${cartonsPresent}::boolean and (p.inner_carton_qty is distinct from v.inq or p.outer_carton_qty is distinct from v.ouq))
          or (${suppliersPresent}::boolean and (p.supplier_cost is distinct from v.cost or p.supplier_cost_currency is distinct from v.cur or p.supplier_name is distinct from v.sup)))
        returning 1 as n`;
      out.updated += r.length;
    }
  } catch (e) { if (missingColumns(e)) return { ...out, skipped: 'not set up in the database yet (run product-cartons.sql)' }; throw e; }
  // ETA on its own, so the cartons and costs are saved even before product-eta.sql has been run
  if (etaPresent) {
    try {
      for (let i = 0; i < etaRows.length; i += 1000) {
        const b = etaRows.slice(i, i + 1000);
        const r = await prisma.$queryRaw<{ n: number }[]>`
          update crm.products p set dear_eta = v.eta from unnest(${b.map(x => x.sku)}::text[], ${b.map(x => x.eta)}::text[]) as v(sku, eta)
          where p.sku = v.sku and p.dear_eta is distinct from v.eta returning 1 as n`;
        out.etaUpdated += r.length;
      }
    } catch (e) { if ((e as any)?.code === '42703' || /dear_eta/.test(String((e as any)?.message ?? e))) out.etaSkipped = 'not set up in the database yet (run product-eta.sql)'; else throw e; }
  }
  return out;
}
