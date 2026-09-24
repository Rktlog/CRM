/**
 * A much more reliable warranty signal than the $36 amount guess —
 * if any line item on an order literally has "replacement" in its
 * product name, it's a warranty replacement, full stop. Scoped to
 * orders not already tagged, so this only fills in gaps rather than
 * overriding anything already correctly classified.
 *
 * Usage:
 *   npx tsx scripts/tag-replacement-orders-as-warranty.ts        (preview)
 *   npx tsx scripts/tag-replacement-orders-as-warranty.ts --apply
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const apply = process.argv.includes('--apply');

async function main() {
  const lines = await prisma.quoteLine.findMany({
    where: { productName: { contains: 'replacement', mode: 'insensitive' } },
    select: { quoteId: true, productName: true },
  });

  const quoteIds = [...new Set(lines.map(l => l.quoteId))];
  console.log(`Found ${lines.length} line items mentioning "replacement", across ${quoteIds.length} distinct orders.`);

  const quotes = await prisma.quote.findMany({
    where: { id: { in: quoteIds }, miscType: null },
    include: { account: { select: { name: true } } },
  });

  console.log(`${quotes.length} of those aren't tagged yet (the rest were already classified some other way).`);
  console.log(`\nSample:`);
  quotes.slice(0, 15).forEach(q => console.log(`  "${q.account.name}" — ${q.number} — $${q.amount} — ${q.source}`));

  if (!apply) {
    console.log('\nPreview only — rerun with --apply to tag these as warranty.');
    return;
  }

  await prisma.quote.updateMany({ where: { id: { in: quotes.map(q => q.id) } }, data: { miscType: 'warranty' } });
  console.log(`\nTagged ${quotes.length} orders as warranty.`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
