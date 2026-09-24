/**
 * "Personal" is a real, confirmed category value (814 accounts as of
 * this writing) — the same field already synced from DEAR's
 * AdditionalAttribute1. These are marketing/warranty/personal-use
 * accounts, not real wholesale customers, and shouldn't count toward
 * a rep's sales performance.
 *
 * Usage:
 *   npx tsx scripts/flag-personal-as-misc.ts          (preview)
 *   npx tsx scripts/flag-personal-as-misc.ts --apply
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const apply = process.argv.includes('--apply');

async function main() {
  const accounts = await prisma.account.findMany({
    where: { category: 'Personal', misc: false },
    select: { id: true, name: true, type: true, spend365: true },
  });

  console.log(`Found ${accounts.length} accounts with category "Personal" not yet flagged as Misc.`);
  const withSpend = accounts.filter(a => a.spend365 > 0);
  console.log(`Of those, ${withSpend.length} have real recorded spend in the last 365 days — this is the group directly affecting current performance figures.`);
  console.log(`Sample: ${accounts.slice(0, 15).map(a => a.name).join(', ')}`);

  if (!apply) {
    console.log('\nPreview only — rerun with --apply to flag these as Misc.');
    return;
  }

  const ids = accounts.map(a => a.id);
  const chunkSize = 500;
  for (let i = 0; i < ids.length; i += chunkSize) {
    await prisma.account.updateMany({ where: { id: { in: ids.slice(i, i + chunkSize) } }, data: { misc: true } });
  }

  console.log(`\nFlagged ${accounts.length} accounts as Misc — excluded from all performance reporting from now on.`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
