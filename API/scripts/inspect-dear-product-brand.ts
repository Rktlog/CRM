/**
 * Line items live under detail.Order.Lines[] (confirmed from a real
 * sale) — SKU, Name, Quantity, Price are right there. What we still
 * don't know is where "brand" lives. Fetching one real Product
 * record directly to find out, rather than guessing.
 *
 * Usage:
 *   npx tsx scripts/inspect-dear-product-brand.ts MTD182631
 */
import 'dotenv/config';
import { dearGet } from '../src/sync/dearClient';

const [, , sku] = process.argv;

async function main() {
  if (!sku) {
    console.error('Usage: npx tsx scripts/inspect-dear-product-brand.ts <SKU>');
    process.exit(1);
  }

  console.log(`Trying /product?SKU=${sku} ...`);
  try {
    const product = await dearGet('/product', { SKU: sku });
    console.log(JSON.stringify(product, null, 2));
    return;
  } catch (e) {
    console.log('  failed:', (e as Error).message);
  }

  console.log(`\nTrying /productavailability?SKU=${sku} ...`);
  try {
    const avail = await dearGet('/productavailability', { SKU: sku });
    console.log(JSON.stringify(avail, null, 2));
  } catch (e) {
    console.log('  failed:', (e as Error).message);
  }

  console.log(`\nTrying /product/list?SKU=${sku} ...`);
  try {
    const list = await dearGet('/product/list', { SKU: sku, Limit: 1 });
    console.log(JSON.stringify(list, null, 2));
  } catch (e) {
    console.log('  failed:', (e as Error).message);
  }
}

main().catch(e => { console.error(e); process.exit(1); });