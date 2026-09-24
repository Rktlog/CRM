/**
 * The 814 "Personal" category orders imported from the Rhino
 * spreadsheet have no descriptive reference text to classify by
 * (just a bare invoice number), unlike live DEAR orders which will
 * be tagged automatically from CustomerReference going forward.
 * Uses the confirmed pattern instead: a flat $36 charge = warranty
 * replacement shipping fee, $0 = marketing/sample giveaway.
 *
 * Usage:
 *   npx tsx scripts/classify-personal-orders.ts        (preview)
 *   npx tsx scripts/classify-personal-orders.ts --apply
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const apply = process.argv.includes('--apply');

async function main() {
  const personalAccounts = await prisma.account.findMany({ where: { category: 'Personal' }, select: { id: true } });
  const accountIds = personalAccounts.map(a => a.id);

  const quotes = await prisma.quote.findMany({
    where: { accountId: { in: accountIds }, miscType: null },
    select: { id: true, amount: true },
  });

  const warranty = quotes.filter(q => Math.abs(q.amount - 36) <= 3); // catches $35/$37/$36 variants
  const ambiguous = quotes.filter(q => Math.abs(q.amount - 36) > 3 && q.amount !== 0);
  const marketing = quotes.filter(q => q.amount === 0 || ambiguous.includes(q)); // ambiguous ones go here for now — re-split once visible on the Misc page

  console.log(`Found ${quotes.length} unclassified orders on Personal accounts.`);
  console.log(`~$36 (warranty, within $3): ${warranty.length}`);
  console.log(`Marketing (incl. ${ambiguous.length} ambiguous, defaulted here for now): ${marketing.length}`);

  if (!apply) {
    console.log('\nPreview only — rerun with --apply to tag these.');
    return;
  }

  await prisma.quote.updateMany({ where: { id: { in: warranty.map(q => q.id) } }, data: { miscType: 'warranty' } });
  await prisma.quote.updateMany({ where: { id: { in: marketing.map(q => q.id) } }, data: { miscType: 'marketing' } });

  console.log(`\nTagged ${warranty.length} as warranty, ${marketing.length} as marketing.`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());