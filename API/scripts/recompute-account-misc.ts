/**
 * The original flag-personal-as-misc.ts set misc=true on every
 * category="Personal" account, blanket, based only on category. That
 * was proven wrong by "Sally Munro (State of Play)" — a real business
 * with genuine orders that happened to be recorded as category=
 * "Personal" in DEAR. This recomputes the flag properly: an account
 * is misc=true only if it has real orders AND every single one of
 * them is marketing/warranty-tagged. An account with at least one
 * real order (even mixed with mostly-personal history) is not hidden.
 *
 * Usage:
 *   npx tsx scripts/recompute-account-misc.ts        (preview)
 *   npx tsx scripts/recompute-account-misc.ts --apply
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const apply = process.argv.includes('--apply');

async function main() {
  const accounts = await prisma.account.findMany({
    where: { category: 'Personal' },
    select: { id: true, name: true, misc: true, quotes: { select: { miscType: true } } },
  });

  let shouldBeMisc = 0;
  let shouldBeVisible = 0;
  const toUnflag: string[] = [];
  const toFlag: string[] = [];

  for (const a of accounts) {
    const hasRealOrder = a.quotes.some(q => q.miscType === null);
    const hasAnyOrder = a.quotes.length > 0;
    const correctMisc = hasAnyOrder && !hasRealOrder; // misc only if it has orders AND all are tagged

    if (correctMisc) shouldBeMisc++; else shouldBeVisible++;

    if (correctMisc && !a.misc) toFlag.push(a.id);
    if (!correctMisc && a.misc) toUnflag.push(a.id);
  }

  console.log(`Checked ${accounts.length} "Personal" accounts.`);
  console.log(`Should correctly be hidden (misc): ${shouldBeMisc}`);
  console.log(`Should correctly be visible (has a real order, or none yet): ${shouldBeVisible}`);
  console.log(`\nCurrently wrong: ${toUnflag.length} wrongly hidden, ${toFlag.length} wrongly visible.`);

  if (!apply) {
    console.log('\nPreview only — rerun with --apply to fix these.');
    return;
  }

  if (toUnflag.length) await prisma.account.updateMany({ where: { id: { in: toUnflag } }, data: { misc: false } });
  if (toFlag.length) await prisma.account.updateMany({ where: { id: { in: toFlag } }, data: { misc: true } });

  console.log(`\nUn-hid ${toUnflag.length} accounts with real orders, flagged ${toFlag.length} more that should have been hidden.`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
