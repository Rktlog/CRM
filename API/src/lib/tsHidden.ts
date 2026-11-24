// Trade shows: products and brands left out of the trade show product list.
// A manager chooses brands and single SKUs to hide (the table is made by sql/tradeshow-hidden-products.sql). A hidden product does not show in the order
// search, the Show range, the other-colours list or the assistant's order tool. Orders that already have it are not changed. Discontinued products (DEAR
// status Deprecated, or stage Discontinued) are always left out and need no setting. Until the table exists, nothing extra is hidden.
import { prisma } from './prisma';
import { cleanText, TsError } from './tradeshowCore';

export type Hidden = { ready: boolean; brands: string[]; brandsLower: string[]; skusUpper: string[]; v: number };
let cache: { at: number; h: Hidden } | null = null;
let version = 0;
export const forgetHidden = () => { cache = null; version++; };

/** What is hidden right now. Kept for 30 seconds, so a search does not pay a database trip for it. */
export async function getHidden(): Promise<Hidden> {
  if (cache && Date.now() - cache.at < 30_000) return cache.h;
  let h: Hidden = { ready: false, brands: [], brandsLower: [], skusUpper: [], v: version };
  try {
    const [t] = await prisma.$queryRaw<{ ok: boolean }[]>`select to_regclass('crm.ts_hidden_products') is not null as ok`;
    if (t?.ok) {
      const rows = await prisma.$queryRaw<{ kind: string; value: string }[]>`select kind, value from crm.ts_hidden_products`;
      const brands = rows.filter(r => r.kind === 'brand').map(r => r.value);
      h = { ready: true, brands, brandsLower: brands.map(b => b.toLowerCase()), skusUpper: rows.filter(r => r.kind === 'sku').map(r => r.value.toUpperCase()), v: version };
    }
  } catch { /* the setting is optional: if it cannot be read, nothing extra is hidden */ }
  cache = { at: Date.now(), h };
  return h;
}

type Rep = { id: string; role: string };
/** For the setting screen: what is hidden (SKUs with their names), and every brand to choose from. */
export async function hiddenSettings() {
  forgetHidden();
  const h = await getHidden();
  if (!h.ready) return { ready: false, brands: [] as string[], skus: [] as { sku: string; name: string | null; brand: string | null }[], allBrands: [] as string[] };
  const [skus, allBrands] = await Promise.all([
    h.skusUpper.length ? prisma.$queryRaw<{ sku: string; name: string | null; brand: string | null }[]>`select sku, name, brand from crm.products where upper(sku) = any(${h.skusUpper}::text[]) order by sku` : Promise.resolve([]),
    prisma.$queryRaw<{ brand: string }[]>`select distinct brand from crm.products where brand is not null and btrim(brand) <> '' order by brand`,
  ]);
  const known = new Set(skus.map(s => s.sku.toUpperCase()));
  return { ready: true, brands: [...h.brands].sort((a, b) => a.localeCompare(b)), skus: [...skus, ...h.skusUpper.filter(s => !known.has(s)).map(s => ({ sku: s, name: null, brand: null }))], allBrands: allBrands.map(b => b.brand) };
}

/** Replaces the whole list with the brands and SKUs ticked now (managers only). Every SKU must be a real product. */
export async function saveHidden(rep: Rep, b: any): Promise<void> {
  if (rep.role !== 'manager') throw new TsError('Only managers can choose what is hidden from trade shows.', 403);
  const h = await getHidden();
  if (!h.ready) throw new TsError('This is not set up in the database yet. Ask whoever looks after Radar to run tradeshow-hidden-products.sql.', 503);
  const uniq = (a: unknown, n: number) => [...new Set((Array.isArray(a) ? a : []).map(x => cleanText(x, 120)).filter((x): x is string => !!x))].slice(0, n);
  const brands = uniq(b?.brands, 300), skus = uniq(b?.skus, 500).map(s => s.toUpperCase());
  if (skus.length) {
    const found = await prisma.$queryRaw<{ sku: string }[]>`select upper(sku) as sku from crm.products where upper(sku) = any(${skus}::text[])`;
    const have = new Set(found.map(f => f.sku)), missing = skus.filter(s => !have.has(s));
    if (missing.length) throw new TsError(`No product has the SKU ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` (and ${missing.length - 5} more)` : ''}. Check the spelling.`);
  }
  await prisma.$transaction([
    prisma.$executeRaw`delete from crm.ts_hidden_products`,
    ...(brands.length ? [prisma.$executeRaw`insert into crm.ts_hidden_products (kind, value, created_by) select 'brand', x, ${rep.id}::uuid from unnest(${brands}::text[]) as x on conflict do nothing`] : []),
    ...(skus.length ? [prisma.$executeRaw`insert into crm.ts_hidden_products (kind, value, created_by) select 'sku', x, ${rep.id}::uuid from unnest(${skus}::text[]) as x on conflict do nothing`] : []),
  ]);
  forgetHidden();
}
