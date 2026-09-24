/**
 * For every quote that has no line items yet (synced before this
 * feature existed), looks up its real sale in DEAR by order number
 * and pulls the SKU/brand/quantity/price detail. Rate-limited to
 * DEAR's real 60/min — this will take a while across your full
 * order history, safe to stop and restart anytime.
 *
 * Usage:
 *   npx tsx scripts/backfill-quote-lines.ts
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { dearGet, fetchAllProducts } from '../src/sync/dearClient';

const prisma = new PrismaClient();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log('Fetching product catalog for brand lookup...');
  const products = await fetchAllProducts();
  const brandBySku = new Map(products.map(p => [p.SKU, p.Brand || null]));
  console.log(`Fetched ${products.length} products.`);

  const quotes = await prisma.quote.findMany({
    where: { lines: { none: {} } },
    select: { id: true, number: true },
  });
  console.log(`Found ${quotes.length} quotes with no line items yet.`);

  let filled = 0;
  let noLines = 0;
  let notFound = 0;
  let checked = 0;

  for (const q of quotes) {
    checked++;
    try {
      const searchResult = await dearGet('/saleList', { Limit: 5, search: q.number });
      const match = (searchResult.SaleList ?? []).find((s: any) => String(s.OrderNumber) === q.number);

      if (!match) { notFound++; await sleep(1100); continue; }

      const detail = await dearGet('/sale', { ID: match.SaleID });
      const rawLines = detail.Order?.Lines ?? detail.Quote?.Lines ?? [];

      if (rawLines.length) {
        await prisma.quoteLine.createMany({
          data: rawLines.map((line: any) => ({
            quoteId: q.id,
            sku: line.SKU ?? 'UNKNOWN',
            productName: line.Name ?? 'Unknown product',
            brand: brandBySku.get(line.SKU) ?? null,
            quantity: line.Quantity ?? 0,
            unitPrice: line.Price ?? 0,
            lineTotal: (line.Quantity ?? 0) * (line.Price ?? 0),
          })),
        });
        filled++;
      } else {
        noLines++;
      }
    } catch (e) {
      console.warn(`Couldn't backfill lines for ${q.number}: ${(e as Error).message}`);
    }

    await sleep(1100);
    if (checked % 50 === 0) console.log(`...${checked}/${quotes.length} checked, ${filled} filled so far`);
  }

  console.log(`\nChecked: ${checked}`);
  console.log(`Filled with real line items: ${filled}`);
  console.log(`Found the order but it genuinely had no lines: ${noLines}`);
  console.log(`Couldn't find the order in DEAR anymore: ${notFound}`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());