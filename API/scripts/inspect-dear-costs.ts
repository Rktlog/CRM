/**
 * Read-only: shows which COST fields DEAR sends, so we know what could be stored for the Ordering reports before anything is built.
 * Nothing is written anywhere. By default it prints field NAMES and how many are set, never amounts, so its output is safe to share.
 * Add --values to also print a few real amounts on your own screen.
 *
 *   npx tsx scripts/inspect-dear-costs.ts
 *   npx tsx scripts/inspect-dear-costs.ts --values
 *
 * It looks at three things:
 *   1. products: is there an AverageCost (what stock at cost would use), or any other field with "cost" in its name?
 *   2. stock rows (ref/productavailability): is a cost or stock value there already?
 *   3. purchase orders, one simple and one advanced, read in full: the line price, line total, currency and exchange rate
 *      (what Purchase Order Details would need: cost, currency rate, line total).
 */
import 'dotenv/config';
import { dearGet } from '../src/sync/dearClient';

const showValues = process.argv.includes('--values');
const COSTY = /cost|price|total|value|currency|rate|tax|discount/i;
const asArray = (v: any): any[] => (Array.isArray(v) ? v : v ? [v] : []);
const shown = (v: any) => (showValues ? JSON.stringify(v) : v === null || v === undefined ? 'empty' : typeof v === 'number' ? (v !== 0 ? 'set' : 'zero') : 'set');
const costyFields = (o: any) => Object.entries(o ?? {}).filter(([k]) => COSTY.test(k)).map(([k, v]) => `${k}=${shown(v)}`).join('  ') || '(none)';

async function main() {
  console.log(showValues ? 'Showing amounts (this stays on your screen: do not paste it).\n' : 'Names and counts only (safe to share). Add --values to see amounts.\n');

  // 1. products
  const products: any[] = (await dearGet('/product', { Page: 1, Limit: 100 })).Products ?? [];
  const nonZero = (f: string) => products.filter(p => Number(p?.[f]) > 0).length;
  console.log(`PRODUCTS (${products.length} read)`);
  const costNamed = Object.keys(products[0] ?? {}).filter(k => /cost/i.test(k));
  console.log(`  Fields with "cost" in the name: ${costNamed.join(', ') || '(none)'}`);
  console.log(`  AverageCost: ${'AverageCost' in (products[0] ?? {}) ? 'is there' : 'is MISSING'}, ${nonZero('AverageCost')} of ${products.length} are above zero`);
  for (const f of costNamed.filter(f => f !== 'AverageCost')) console.log(`  ${f}: ${nonZero(f)} of ${products.length} above zero`);
  if (showValues) for (const p of products.filter(p => Number(p.AverageCost) > 0).slice(0, 3)) console.log(`    ${p.SKU}: AverageCost ${p.AverageCost}`);

  // 2. stock rows
  const stock: any[] = (await dearGet('/ref/productavailability', { Page: 1, Limit: 5 })).ProductAvailabilityList ?? [];
  console.log(`\nSTOCK ROWS (/ref/productavailability, ${stock.length} read)`);
  console.log(`  Fields: ${Object.keys(stock[0] ?? {}).join(', ') || '(none)'}`);
  console.log(`  Cost-like fields: ${costyFields(stock[0])}`);

  // 3. purchase orders
  const list: any[] = (await dearGet('/purchaseList', { Page: 1, Limit: 30 })).PurchaseList ?? [];
  const isAdv = (p: any) => String(p.Type ?? '').toLowerCase().includes('advanced');
  const picks = [list.find(p => !isAdv(p)), list.find(isAdv)].filter(Boolean);
  console.log(`\nPURCHASE ORDERS (${list.length} read; reading one simple and one advanced in full)`);
  if (!picks.length) console.log('  none found');
  for (const p of picks) {
    const d = await dearGet(isAdv(p) ? '/advanced-purchase' : '/purchase', { ID: p.ID });
    console.log(`\n  ${p.OrderNumber} (${isAdv(p) ? 'advanced' : 'simple'}), status ${p.Status}`);
    console.log(`    Top-level fields: ${Object.keys(d).join(', ')}`);
    console.log(`    Cost-like fields at the top: ${costyFields(d)}`);
    const orders = asArray(d.Order);
    for (const [i, o] of orders.entries()) {
      console.log(`    Order block${orders.length > 1 ? ' ' + (i + 1) : ''}: ${Object.keys(o).filter(k => k !== 'Lines').join(', ')}`);
      console.log(`      cost-like: ${costyFields(o)}`);
      const lines = asArray(o.Lines);
      console.log(`      Lines: ${lines.length}; fields on a line: ${Object.keys(lines[0] ?? {}).join(', ') || '(none)'}`);
      console.log(`      first line cost-like: ${costyFields(lines[0])}`);
      console.log(`      lines with a price above zero: ${lines.filter((l: any) => Number(l?.Price) > 0).length} of ${lines.length}`);
    }
  }
  console.log('\nWhat this tells us: a Price on purchase lines + a currency and rate = Purchase Order Details can carry cost, currency rate and line total; an AverageCost on products = Availability can carry stock at cost.');
}

main().catch(e => { console.error(e); process.exit(1); });