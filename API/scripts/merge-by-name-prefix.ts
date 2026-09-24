/**
 * Generic version of the Toys and Tales fix — merges every account
 * whose name starts with the given prefix into one, keeping whichever
 * has the most contact info, tagging each merged-in quote with its
 * original account name via shippingCompany first so that detail
 * isn't lost, then locking in the confirmed real DEAR customer ID.
 *
 * Usage:
 *   npx tsx scripts/merge-by-name-prefix.ts "Norfolk and Co" 587bf550-5f80-4e66-8c15-d68f39720d5b
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const [, , prefix, confirmedDearId] = process.argv;
if (!prefix || !confirmedDearId) {
  console.error('Usage: npx tsx scripts/merge-by-name-prefix.ts "<name prefix>" <confirmed-dear-customer-id>');
  process.exit(1);
}

async function main() {
  const accounts = await prisma.account.findMany({
    where: { name: { startsWith: prefix } },
    select: { id: true, name: true, contactName: true, phone: true, email: true },
  });

  console.log(`Found ${accounts.length} accounts: ${accounts.map(a => a.name).join(', ')}`);
  if (accounts.length < 2) {
    console.log('Nothing to merge.');
    return;
  }

  const sorted = [...accounts].sort((a, b) => {
    const scoreA = [a.contactName, a.phone, a.email].filter(Boolean).length;
    const scoreB = [b.contactName, b.phone, b.email].filter(Boolean).length;
    return scoreB - scoreA;
  });
  const keeper = sorted[0];
  const dupes = sorted.slice(1);

  console.log(`Keeping "${keeper.name}" (${keeper.id}), merging in: ${dupes.map(d => d.name).join(', ')}`);

  for (const dupe of dupes) {
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

  await prisma.account.update({ where: { id: keeper.id }, data: { dearCustomerId: confirmedDearId } });

  const quotes = await prisma.quote.findMany({ where: { accountId: keeper.id, paid: true } });
  const now = Date.now();
  const sum = (days: number) => quotes.filter(q => now - q.sentAt.getTime() <= days * 86400000).reduce((s, q) => s + q.amount, 0);
  await prisma.account.update({ where: { id: keeper.id }, data: { spend30: sum(30), spend90: sum(90), spend365: sum(365) } });

  console.log(`\nDone. "${keeper.name}" now holds everything, linked to confirmed DEAR ID ${confirmedDearId}.`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());