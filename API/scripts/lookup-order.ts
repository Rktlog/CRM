/**
 * Looks up one specific order by its number directly in DEAR — same
 * search-by-order-number technique used elsewhere (cleanup-warranty-
 * marketing-quotes.ts, backfill-contact-from-orders.ts).
 *
 * Usage:
 *   npx tsx scripts/lookup-order.ts SQ36022
 */
import 'dotenv/config';
import { dearGet, fetchAllCustomers } from '../src/sync/dearClient';

const [, , orderNumber] = process.argv;

async function main() {
  if (!orderNumber) {
    console.error('Usage: npx tsx scripts/lookup-order.ts <order-number>');
    process.exit(1);
  }

  const searchResult = await dearGet('/saleList', { Limit: 5, search: orderNumber });
  const match = (searchResult.SaleList ?? []).find((s: any) => String(s.OrderNumber) === orderNumber);

  if (!match) {
    console.log(`Couldn't find an order matching "${orderNumber}" in DEAR.`);
    console.log('Raw search results, in case the number format is slightly different:');
    console.log(JSON.stringify(searchResult.SaleList ?? [], null, 2));
    return;
  }

  const detail = await dearGet('/sale', { ID: match.SaleID });

  console.log('Customer:', detail.Customer);
  console.log('CustomerID:', detail.CustomerID);
  console.log('CustomerReference:', detail.CustomerReference);
  console.log('SalesRepresentative:', detail.SalesRepresentative);
  console.log('Status:', detail.Status);
  console.log('Order total:', detail.Order?.Total ?? detail.Quote?.Total);
  console.log('Order date:', detail.SaleOrderDate);

  // Also pull the real Customer record to see its actual category —
  // the field that's driving the misc classification. Using the same
  // bulk fetch + find-by-ID that the real sync relies on, since the
  // direct /customer?ID= lookup just proved unreliable.
  if (detail.CustomerID) {
    const customers = await fetchAllCustomers();
    const customer = customers.find(c => c.ID === detail.CustomerID);
    console.log('\nCustomer record — Name:', customer?.Name);
    console.log('Customer record — AdditionalAttribute1 (category):', customer?.AdditionalAttribute1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
