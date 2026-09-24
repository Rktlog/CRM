/**
 * DEAR confirmed only ONE customer record exists for "Toys and
 * Tales" (Customer ID ee4f312e-f862-40f5-b49f-3f2962e12bc3) — head
 * office places every order under this single account, and
 * "Macquarie"/"Marrickville" were just text on individual orders,
 * not separate DEAR customers. Merging into one account, tagging
 * every reassigned quote with its original store name via
 * shippingCompany first so that information isn't lost.
 *
 * Usage:
 *   npx tsx scripts/merge-toys-and-tales.ts
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const CONFIRMED_DEAR_ID = 'ee4f312e-f862-40f5-b49f-3f2962e12bc3';

async function main() {
  const accounts = await prisma.account.findMany({
    where: { name: { startsWith: 'Toys and Tales' } },
    select: { id: true, name: true, contactName: true, phone: true, email: true },
  });

  console.log(`Found ${accounts.length} accounts: ${accounts.map(a => a.name).join(', ')}`);
  if (accounts.length < 2) {
    console.log('Nothing to merge.');
    return;
  }

  // Prefer whichever has real contact info as the keeper.
  const sorted = [...accounts].sort((a, b) => {
    const scoreA = [a.contactName, a.phone, a.email].filter(Boolean).length;
    const scoreB = [b.contactName, b.phone, b.email].filter(Boolean).length;
    return scoreB - scoreA;
  });
  const keeper = sorted[0];
  const dupes = sorted.slice(1);

  console.log(`Keeping "${keeper.name}" (${keeper.id}), merging in: ${dupes.map(d => d.name).join(', ')}`);

  for (const dupe of dupes) {
    // Tag every quote with the store name it actually came from,
    // before that information disappears into the merged account.
    await prisma.quote.updateMany({
      where: { accountId: dupe.id, shippingCompany: null },
      data: { shippingCompany: dupe.name },
    });

    await prisma.activity.updateMany({ where: { accountId: dupe.id }, data: { accountId: keeper.id } });

    const dupeQuotes = await prisma.quote.findMany({ where: { accountId: dupe.id } });
    for (const q of dupeQuotes) {
      const collision = await prisma.quote.findFirst({ where: { accountId: keeper.id, number: q.number } });
      if (collision) {
        await prisma.quote.delete({ where: { id: q.id } });
      } else {
        await prisma.quote.update({ where: { id: q.id }, data: { accountId: keeper.id } });
      }
    }

    await prisma.account.delete({ where: { id: dupe.id } });
    console.log(`Merged and removed "${dupe.name}".`);
  }

  // Lock in the confirmed real DEAR link on the survivor.
  await prisma.account.update({ where: { id: keeper.id }, data: { dearCustomerId: CONFIRMED_DEAR_ID } });

  const quotes = await prisma.quote.findMany({ where: { accountId: keeper.id, paid: true } });
  const now = Date.now();
  const sum = (days: number) => quotes.filter(q => now - q.sentAt.getTime() <= days * 86400000).reduce((s, q) => s + q.amount, 0);
  await prisma.account.update({ where: { id: keeper.id }, data: { spend30: sum(30), spend90: sum(90), spend365: sum(365) } });

  console.log(`\nDone. "${keeper.name}" now holds all activity and orders, each order tagged with its real store via shippingCompany.`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
