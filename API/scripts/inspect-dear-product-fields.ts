/**
 * Shows what DEAR sends for product descriptions and purchase order dates, so you can see the fields the CRM reads
 * are really there. Prints a few real products (does each have a Description?) and the fields of one purchase order
 * (is RequiredBy there, and what does it hold?).
 *
 * Usage:
 *   npx tsx scripts/inspect-dear-product-fields.ts
 */
import 'dotenv/config';
import { dearGet } from '../src/sync/dearClient';
import { descriptionOf, saysEndOfLine, specsOf, SPEC_FIELDS } from '../src/sync/syncProductDetails';

async function main() {
  const products = (await dearGet('/product', { Page: 1, Limit: 100 })).Products ?? [];
  const withText = products.filter((p: any) => descriptionOf(p));
  console.log(`Products: ${products.length} read, ${withText.length} have a description, ${withText.filter((p: any) => saysEndOfLine(descriptionOf(p))).length} of them say end of line (they would be set to EOL).`);
  console.log('Fields on a product:', Object.keys(products[0] ?? {}).join(', '));
  // Weight and size: are the fields there, which units does DEAR hold them in, and what do they come out as (kg and cm)?
  const has = (f: string) => products.filter((p: any) => Number(p?.[f]) > 0).length;
  console.log(`\nWeight and size: ${SPEC_FIELDS.map(f => `${f} ${f in (products[0] ?? {}) ? 'is there' : 'is MISSING'} (${has(f)} set)`).join(', ')}`);
  const units = (names: string[]) => { const c: Record<string, number> = {}; for (const p of products) { const u = names.map(n => p?.[n]).find(v => typeof v === 'string' && v.trim()) ?? '(none)'; c[u] = (c[u] ?? 0) + 1; } return JSON.stringify(c); };
  console.log(`  weight units seen: ${units(['WeightUnits', 'WeightUnit'])}   size units seen: ${units(['DimensionsUnits', 'DimensionUnits', 'DimensionsUnit', 'DimensionUnit', 'LengthUnits'])}`);
  for (const p of products.filter((x: any) => Number(x?.Weight) > 0 || Number(x?.Length) > 0).slice(0, 3)) console.log(`  ${p.SKU}: Weight ${p.Weight} ${p.WeightUnits ?? ''}, ${p.Length} x ${p.Width} x ${p.Height} ${p.DimensionsUnits ?? ''}  ->  saved as ${JSON.stringify(specsOf(p))}`);
  for (const p of withText.slice(0, 3)) console.log(`\n${p.SKU} (${p.Name})\n  Description: ${JSON.stringify(p.Description)}\n  -> saved as: ${JSON.stringify(descriptionOf(p))}${saysEndOfLine(descriptionOf(p)) ? '\n  -> says end of line: would be set to EOL' : ''}`);

  const purchases = (await dearGet('/purchaseList', { Page: 1, Limit: 20 })).PurchaseList ?? [];
  console.log(`\nPurchase orders: ${purchases.length} read.`);
  console.log('Fields on a purchase order:', Object.keys(purchases[0] ?? {}).join(', '));
  for (const p of purchases.slice(0, 8)) console.log(`  ${p.OrderNumber}  status=${p.Status}  RequiredBy=${JSON.stringify(p.RequiredBy)}`);
}

main().catch(e => { console.error(e); process.exit(1); });