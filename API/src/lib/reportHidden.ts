// Products a manager has taken out of the customer reports (the price list and the monthly stocklist sales send to stores).
// The mark is one column on each product (SQL/product-report-flag.sql). Until that has been run in the database, nothing is left out and the reports work as
// they always did; a real database failure is NOT swallowed, because quietly listing a product that was meant to be left out would be worse than an error.
import { prisma } from './prisma';

const columnMissing = (e: any) => e?.code === '42703' || e?.meta?.code === '42703' || /hide_from_customer_reports|\b42703\b|column .* does not exist/i.test(String(e?.message ?? e));
let warned = false;
const notSetUp = () => { if (!warned) { warned = true; console.warn('Customer reports: the "left out of reports" column is not in the database yet (run product-report-flag.sql); nothing is being left out.'); } };

/** The SKUs left out of customer reports. Empty when the feature has not been set up in the database yet. */
export async function hiddenFromReports(): Promise<Set<string>> {
  try {
    const rows = await prisma.$queryRaw<{ sku: string }[]>`select sku from crm.products where hide_from_customer_reports`;
    return new Set(rows.map(r => r.sku));
  } catch (e) { if (columnMissing(e)) { notSetUp(); return new Set(); } throw e; }
}

/** How many left-out products each brand has, so the price list's brand counts match what the report will hold. */
export async function hiddenCountsByBrand(): Promise<Map<string, number>> {
  try {
    const rows = await prisma.$queryRaw<{ brand: string; n: number }[]>`select brand, count(*)::int as n from crm.products where hide_from_customer_reports and brand is not null group by brand`;
    return new Map(rows.map(r => [r.brand, Number(r.n)] as [string, number]));
  } catch (e) { if (columnMissing(e)) { notSetUp(); return new Map(); } throw e; }
}

export type HiddenItem = { sku: string; name: string; brand: string | null; markedAt: string | null; markedBy: string | null };
/** Everything currently left out, for the Products page. ready is false when the database does not have the column yet. */
export async function listHidden(): Promise<{ ready: boolean; items: HiddenItem[] }> {
  try {
    const rows = await prisma.$queryRaw<{ sku: string; name: string; brand: string | null; at: Date | null; by: string | null }[]>`
      select p.sku, p.name, p.brand, p.hide_from_customer_reports_at as at, r.name as by
      from crm.products p left join crm.reps r on r.id = p.hide_from_customer_reports_by
      where p.hide_from_customer_reports order by p.brand nulls last, p.sku`;
    return { ready: true, items: rows.map(r => ({ sku: r.sku, name: r.name, brand: r.brand, markedAt: r.at ? new Date(r.at).toISOString() : null, markedBy: r.by })) };
  } catch (e) { if (columnMissing(e)) return { ready: false, items: [] }; throw e; }
}

export class ReportHiddenError extends Error { status: number; constructor(message: string, status = 400) { super(message); this.status = status; } }
const MAX_SKUS = 500, MAX_SKU_LENGTH = 80;

/** The SKUs in a request, trimmed and without repeats (capital letters ignored), or an error in words. */
export function parseSkus(input: unknown): { skus: string[] } | { error: string } {
  if (!Array.isArray(input) || !input.length) return { error: 'Give at least one SKU.' };
  if (input.length > MAX_SKUS) return { error: `Give at most ${MAX_SKUS} SKUs at a time.` };
  const seen = new Set<string>(), skus: string[] = [];
  for (const v of input) {
    if (typeof v !== 'string') return { error: 'Every SKU must be text.' };
    const s = v.trim();
    if (!s) continue;
    if (s.length > MAX_SKU_LENGTH || /[\u0000-\u001f]/.test(s)) return { error: `"${s.slice(0, 30)}" does not look like a SKU.` };
    const key = s.toUpperCase();
    if (!seen.has(key)) { seen.add(key); skus.push(s); }
  }
  return skus.length ? { skus } : { error: 'Give at least one SKU.' };
}

export type SetResult = { changed: string[]; alreadyThatWay: string[]; notFound: string[] };
/** Leave products out of the customer reports (hidden = true) or put them back. SKUs are matched ignoring capital letters. Managers only: the caller checks. */
export async function setHidden(skus: string[], hidden: boolean, byRepId: string): Promise<SetResult> {
  const wanted = skus.map(s => s.trim().toUpperCase());
  try {
    const found = (await prisma.$queryRaw<{ sku: string }[]>`select sku from crm.products where upper(btrim(sku)) = any(${wanted}::text[])`).map(r => r.sku);
    const changed = (await prisma.$queryRaw<{ sku: string }[]>`
      update crm.products set hide_from_customer_reports = ${hidden}::boolean,
        hide_from_customer_reports_at = case when ${hidden}::boolean then now() else null end,
        hide_from_customer_reports_by = case when ${hidden}::boolean then ${byRepId}::uuid else null end
      where upper(btrim(sku)) = any(${wanted}::text[]) and hide_from_customer_reports is distinct from ${hidden}::boolean
      returning sku`).map(r => r.sku);
    const changedSet = new Set(changed), foundUpper = new Set(found.map(s => s.trim().toUpperCase()));
    return { changed, alreadyThatWay: found.filter(s => !changedSet.has(s)), notFound: skus.filter(s => !foundUpper.has(s.trim().toUpperCase())) };
  } catch (e) {
    if (columnMissing(e)) throw new ReportHiddenError('This is not set up in the database yet. Run product-report-flag.sql in the Supabase SQL Editor first.', 503);
    throw e;
  }
}
