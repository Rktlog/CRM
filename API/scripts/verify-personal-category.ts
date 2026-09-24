/**
 * Before trusting that category="Personal" means marketing/warranty
 * (and not, say, leftover Project Clothing one-off retail buyers),
 * this pulls a real sample of these accounts and their actual order
 * references — the same field ("RR. warranty", "RR. Marketing")
 * that first revealed the warranty/marketing pattern early on.
 *
 * Usage:
 *   npx tsx scripts/verify-personal-category.ts
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const accounts = await prisma.account.findMany({
    where: { category: 'Personal' },
    select: { id: true, name: true, spend365: true, type: true, archived: true },
    take: 2000,
  });

  console.log(`Total "Personal" accounts: ${accounts.length}`);

  const withSpend = accounts.filter(a => a.spend365 > 0);
  const alreadyArchived = accounts.filter(a => a.archived);
  console.log(`With real spend in the last 365 days: ${withSpend.length}`);
  console.log(`Already archived from earlier cleanup: ${alreadyArchived.length}`);

  // Real order references for a sample of these accounts — the field
  // that originally revealed the "RR. warranty" / "RR. Marketing"
  // pattern. Project Clothing orders, if any slipped in here, would
  // show a distinctly different reference pattern instead.
  const sampleIds = accounts.slice(0, 40).map(a => a.id);
  const quotes = await prisma.quote.findMany({
    where: { accountId: { in: sampleIds } },
    select: { accountId: true, reference: true, amount: true, source: true },
    take: 200,
  });

  const accountById = new Map(accounts.map(a => [a.id, a]));
  console.log(`\nSample of real order references from "Personal" accounts:`);
  for (const q of quotes.slice(0, 60)) {
    const a = accountById.get(q.accountId);
    console.log(`  "${a?.name}" — ref: "${q.reference ?? '(none)'}" — $${q.amount} — source: ${q.source}`);
  }

  const referenceMentionsWarrantyOrMarketing = quotes.filter(q =>
    /warranty|marketing/i.test(q.reference ?? '')
  ).length;
  const referenceMentionsProjectClothing = quotes.filter(q =>
    /project ?clothing|shopify/i.test(q.reference ?? '')
  ).length;

  console.log(`\nOf ${quotes.length} sampled orders:`);
  console.log(`  Reference mentions warranty/marketing: ${referenceMentionsWarrantyOrMarketing}`);
  console.log(`  Reference mentions Project Clothing/Shopify: ${referenceMentionsProjectClothing}`);
  console.log(`  Neither (worth reading the raw sample above to judge): ${quotes.length - referenceMentionsWarrantyOrMarketing - referenceMentionsProjectClothing}`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());