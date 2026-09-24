/**
 * Merges duplicate accounts, but ONLY when both names become
 * IDENTICAL after stripping all punctuation, spacing, and case
 * differences (e.g. "Child. Ish" / "Child(ish)" / "Child Ish" all
 * become "childish"). This deliberately does NOT touch pairs where
 * one name has an extra word the other doesn't — that extra word is
 * very often a real suburb/location name (confirmed real cases in
 * this account: "Toys and Tales" vs "Toys and Tales Macquarie" are
 * genuinely different stores, not a duplicate).
 *
 * Typos (Accourtrement/Accoutremen, Bundnon/Bundanon) are NOT caught
 * by this — they're intentionally left for manual review, since a
 * script can't reliably tell a typo from a genuinely different name
 * without human judgment.
 *
 * Usage:
 *   npx tsx scripts/merge-exact-normalized-duplicates.ts
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function stripToAlphanumeric(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, ' and ')   // treat & the same as the word "and"
    .replace(/\+/g, ' and ')  // same for +
    .replace(/[^a-z0-9]/g, '');
}

async function main() {
  const accounts = await prisma.account.findMany({
    select: { id: true, name: true, createdAt: true, contactName: true, phone: true, email: true },
  });

  const groups = new Map<string, typeof accounts>();
  for (const a of accounts) {
    const key = stripToAlphanumeric(a.name);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(a);
  }

  let merged = 0;
  let accountsRemoved = 0;
  const keeperIds: string[] = [];

  for (const [, group] of groups) {
    if (group.length < 2) continue;

    // Keep whichever has the most contact info filled in, tie-break
    // by earliest created.
    const sorted = [...group].sort((a, b) => {
      const scoreA = [a.contactName, a.phone, a.email].filter(Boolean).length;
      const scoreB = [b.contactName, b.phone, b.email].filter(Boolean).length;
      if (scoreA !== scoreB) return scoreB - scoreA;
      return a.createdAt.getTime() - b.createdAt.getTime();
    });
    const keeper = sorted[0];
    const dupes = sorted.slice(1);

    console.log(`Merging into "${keeper.name}" (${keeper.id}): ${dupes.map(d => `"${d.name}"`).join(', ')}`);

    for (const dupe of dupes) {
      await prisma.activity.updateMany({ where: { accountId: dupe.id }, data: { accountId: keeper.id } });

      // Quotes have a unique constraint on `number` — reassign only
      // ones that won't collide, drop any that would.
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
      accountsRemoved++;
    }
    keeperIds.push(keeper.id);
    merged++;
  }

  // Recompute spend for every merged keeper — using the ACTUAL keeper
  // id captured during merging, not re-derived from the group (which
  // was the bug: re-deriving picked whichever account happened to be
  // first in the original unsorted list, sometimes a deleted dupe).
  for (const id of keeperIds) {
    const quotes = await prisma.quote.findMany({ where: { accountId: id, paid: true } });
    const now = Date.now();
    const sum = (days: number) => quotes.filter(q => now - q.sentAt.getTime() <= days * 86400000).reduce((s, q) => s + q.amount, 0);
    await prisma.account.update({ where: { id }, data: { spend30: sum(30), spend90: sum(90), spend365: sum(365) } });
  }

  console.log(`\nMerged ${merged} groups, removed ${accountsRemoved} duplicate accounts.`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
