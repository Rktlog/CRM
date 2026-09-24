/**
 * Two things we don't know yet and shouldn't guess at:
 * 1. What a Sale's line items actually look like (field names for
 *    SKU, product name, quantity) — we've only ever looked at the
 *    Sale's top-level fields before, never its Lines.
 * 2. Whether/where "brand" lives — likely NOT on the sale line
 *    itself, but on the Product record for that SKU (DEAR's
 *    AdditionalAttribute fields, same pattern as Customer category).
 *
 * Usage:
 *   npx tsx scripts/inspect-dear-product-fields.ts
 */
import 'dotenv/config';
import { dearGet, fetchSalesUpdatedSince } from '../src/sync/dearClient';

async function main() {
  console.log('=== Fetching one recent sale to inspect its line items ===');
  const since = new Date(Date.now() - 30 * 86400000);
  const sales = await fetchSalesUpdatedSince(since);
  const withLines = sales.find(s => s.SaleID);

  if (!withLines) {
    console.log('No recent sales found to inspect.');
    return;
  }

  const detail = await dearGet('/sale', { ID: withLines.SaleID });
  console.log('Full sale detail keys:', Object.keys(detail));
  console.log('\nLine items (detail.Lines or similar):');
  console.log(JSON.stringify(detail.Lines ?? detail.LineItems ?? 'NO Lines/LineItems FIELD FOUND', null, 2));

  const firstLine = (detail.Lines ?? detail.LineItems ?? [])[0];
  if (!firstLine) {
    console.log('\nNo line items on this sale — trying another endpoint shape.');
    console.log(JSON.stringify(detail, null, 2).slice(0, 3000));
    return;
  }

  const sku = firstLine.SKU ?? firstLine.Code ?? firstLine.ProductCode;
  console.log('\n=== Fetching the Product record for SKU:', sku, '===');
  if (sku) {
    try {
      const product = await dearGet('/product', { SKU: sku });
      console.log(JSON.stringify(product, null, 2));
    } catch (e) {
      console.log('Could not fetch /product with that SKU:', (e as Error).message);
      console.log('Trying /product list search instead...');
      const productList = await dearGet('/productlist', { Limit: 1, SKU: sku });
      console.log(JSON.stringify(productList, null, 2));
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
