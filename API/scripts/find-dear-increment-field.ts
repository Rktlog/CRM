/**
 * Finds where DEAR keeps the order increment. Reads every product, takes the ones whose description says
 * "ORDER INCREMENT: n" as the known answers, and ranks every whole-number field by how often it equals them and how many
 * products have a value in it. Also looks in DEAR's attribute sets for anything named like "increment".
 *
 * Usage (from the API folder):
 *   npx tsx scripts/find-dear-increment-field.ts
 */
import 'dotenv/config';
import { dearGet, fetchAllProducts } from '../src/sync/dearClient';
import { descriptionOf, orderIncrementOf } from '../src/sync/syncProductDetails';
import { rankFields, candidateValues } from '../src/sync/incrementFields';

async function main() {
  const products = await fetchAllProducts();
  const wanted = new Map<string, number>();
  for (const p of products) { const n = orderIncrementOf(descriptionOf(p)); if (n) wanted.set(String(p.SKU), n); }
  console.log(`Products read: ${products.length}. With "ORDER INCREMENT" in the description: ${wanted.size}.\n`);

  const ranked = rankFields(products, wanted).slice(0, 15);
  console.log('Fields that hold a whole number, best match first:');
  console.log('  field'.padEnd(46) + 'has a value'.padEnd(14) + 'equals the description'.padEnd(26) + 'most common values');
  for (const c of ranked) console.log(`  ${c.field}`.padEnd(46) + `${c.filled}`.padEnd(14) + `${c.matches} of ${c.compared}`.padEnd(26) + c.common.map(v => `${v.value} (${v.products})`).join(', '));

  console.log('\nThe first few products with an increment in the description, and every whole-number field they have:');
  for (const [sku, n] of [...wanted].slice(0, 4)) {
    const p = products.find(x => String(x.SKU) === sku);
    console.log(`  ${sku}  description says ${n}  ->  ${JSON.stringify(candidateValues(p))}`);
  }

  try {
    const sets = JSON.stringify(await dearGet('/ref/attributeset', { Page: 1, Limit: 100 }));
    const hits = [...sets.matchAll(/[^"]{0,40}increment[^"]{0,40}/gi)].map(m => m[0]);
    console.log(hits.length ? `\nAttribute sets mention: ${[...new Set(hits)].join(' | ')}` : '\nNo attribute set mentions "increment".');
  } catch (e) { console.log(`\n(Could not read the attribute sets: ${(e as Error).message})`); }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });