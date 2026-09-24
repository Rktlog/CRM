/**
 * For accounts already linked to DEAR but missing contact details
 * (the gap: the Customer master record often lacks a contact person,
 * which actually lives on individual Sale records instead), this
 * looks up one of the account's own orders in DEAR and pulls
 * Contact/Phone/Email from it. Much cheaper than re-running the full
 * backfill — one lookup per account needing it, not per order.
 *
 * Usage:
 *   npx tsx scripts/backfill-contact-from-orders.ts
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { dearGet } from '../src/sync/dearClient';

const prisma = new PrismaClient();

async function main() {
  const accounts = await prisma.account.findMany({
    where: {
      dearCustomerId: { not: null },
      contactName: null,
      quotes: { some: {} },
    },
    include: { quotes: { orderBy: { sentAt: 'desc' }, take: 1 } },
  });

  console.log(`Checking ${accounts.length} linked accounts with no contact info...`);

  let updated = 0;
  let noContactFound = 0;
  let notFound = 0;

  for (const account of accounts) {
    const quoteNumber = account.quotes[0]?.number;
    if (!quoteNumber) continue;

    try {
      const data = await dearGet('/saleList', { Limit: 5, search: quoteNumber });
      const match = (data.SaleList ?? []).find((s: any) => String(s.OrderNumber) === quoteNumber);

      if (!match) {
        notFound++;
        continue;
      }

      // saleList items are lighter than full sale detail — fetch the
      // real detail to get Contact/Phone/Email reliably.
      const detail = await dearGet('/sale', { ID: match.SaleID });

      if (!detail.Contact) {
        noContactFound++;
        continue;
      }

      await prisma.account.update({
        where: { id: account.id },
        data: {
          contactName: detail.Contact,
          phone: detail.Phone ?? undefined,
          email: detail.Email ?? undefined,
        },
      });
      updated++;
    } catch (e) {
      console.warn(`Couldn't check ${account.name} (${quoteNumber}):`, (e as Error).message);
    }
  }

  console.log(`\nUpdated with real contact info: ${updated}`);
  console.log(`Order found, but it also had no contact info: ${noContactFound}`);
  console.log(`Couldn't find the order in DEAR: ${notFound}`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
