/**
 * When an account's business name and contact name are identical,
 * AND it has zero real orders (no quotes at all), it's very likely
 * a leftover individual buyer from the old Project Clothing Shopify
 * channel that got imported as a "lead" rather than a real business
 * — someone just typed their own name as both fields.
 *
 * Real exception found in a manual check of actual data: "The
 * General Store" has Contact = Account too, but is a genuine
 * business, not a person. This script can't perfectly tell those
 * apart from name-matching alone — it's a real, accepted trade-off,
 * not an oversight. Archiving is reversible (not deletion), and a
 * genuine future real order automatically un-archives the account
 * (see the fix already in syncSales.ts / backfill-full-history.ts),
 * so a wrongly-archived real business isn't permanently lost.
 *
 * Usage:
 *   npx tsx scripts/archive-same-name-no-orders.ts        (preview)
 *   npx tsx scripts/archive-same-name-no-orders.ts --apply
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const apply = process.argv.includes('--apply');

function normalize(s: string | null): string {
  if (!s) return '';
  return s.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Confirmed real businesses found by manually reading the actual
// matched list, not guessed — word count and keyword checks alone
// wrongly flagged tons of genuine individuals with compound or
// international names instead (word count is NOT a reliable
// business signal). These are the real exceptions:
const KNOWN_BUSINESS_KEYWORDS = [
  'pty', 'ltd', 'association', 'umpires', 'foundation', 'boutique', ' & co', 'group',
  'house of', 'supplies', 'hospital', 'nextra', 'general store',
];
function looksLikeRealBusiness(name: string): boolean {
  const lower = name.toLowerCase();
  if (/\(/.test(name)) return true; // "Just Jeans (Just Group - AU)" style multi-brand entries
  return KNOWN_BUSINESS_KEYWORDS.some(kw => lower.includes(kw));
}

async function main() {
  const accounts = await prisma.account.findMany({
    where: { archived: false, stage: 'new_lead' },
    select: { id: true, name: true, contactName: true, region: true, _count: { select: { quotes: true } } },
  });

  const matches = accounts.filter(a => {
    const nameNorm = normalize(a.name);
    if (!nameNorm || nameNorm !== normalize(a.contactName)) return false;
    if (a._count.quotes !== 0) return false;
    if (looksLikeRealBusiness(a.name)) return false;
    return true;
  });

  console.log(`Checked ${accounts.length} new-lead accounts.`);
  const sameNameNoOrders = accounts.filter(a => {
    const nameNorm = normalize(a.name);
    return nameNorm && nameNorm === normalize(a.contactName) && a._count.quotes === 0;
  });
  const excludedAsBusiness = sameNameNoOrders.length - matches.length;

  console.log(`Contact name = business name AND zero orders: ${sameNameNoOrders.length}`);
  console.log(`Excluded as a likely real business (Just Group entries, umpiring associations, Pty Ltd, etc.): ${excludedAsBusiness}`);
  console.log(`Remaining, to be archived: ${matches.length}`);
  console.log(`\nSample (first 20):`);
  matches.slice(0, 20).forEach(a => console.log(`  "${a.name}" — ${a.region}`));

  if (!apply) {
    console.log('\nPreview only — check the sample above for real business names (like "The General Store") before running --apply.');
    return;
  }

  const ids = matches.map(a => a.id);
  const result = await prisma.account.updateMany({ where: { id: { in: ids } }, data: { archived: true } });
  console.log(`\nArchived ${result.count} accounts.`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
