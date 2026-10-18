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
import { descriptionOf, saysEndOfLine } from '../src/sync/syncProductDetails';

async function main() {
  const products = (await dearGet('/product', { Page: 1, Limit: 100 })).Products ?? [];
  const withText = products.filter((p: any) => descriptionOf(p));
  console.log(`Products: ${products.length} read, ${withText.length} have a description, ${withText.filter((p: any) => saysEndOfLine(descriptionOf(p))).length} of them say end of line (they would be set to EOL).`);
  console.log('Fields on a product:', Object.keys(products[0] ?? {}).join(', '));
  for (const p of withText.slice(0, 3)) console.log(`\n${p.SKU} (${p.Name})\n  Description: ${JSON.stringify(p.Description)}\n  -> saved as: ${JSON.stringify(descriptionOf(p))}${saysEndOfLine(descriptionOf(p)) ? '\n  -> says end of line: would be set to EOL' : ''}`);

  const purchases = (await dearGet('/purchaseList', { Page: 1, Limit: 20 })).PurchaseList ?? [];
  console.log(`\nPurchase orders: ${purchases.length} read.`);
  console.log('Fields on a purchase order:', Object.keys(purchases[0] ?? {}).join(', '));
  for (const p of purchases.slice(0, 8)) console.log(`  ${p.OrderNumber}  status=${p.Status}  RequiredBy=${JSON.stringify(p.RequiredBy)}`);
}

main().catch(e => { console.error(e); process.exit(1); });