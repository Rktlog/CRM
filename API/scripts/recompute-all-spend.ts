/**
 * Recomputes spend_30/90/365 and avg_order_gap_days for every
 * account with at least one paid quote. Safe to run any time — pure
 * recalculation from existing data, doesn't touch accounts or
 * quotes themselves.
 *
 * Usage:
 *   npx tsx scripts/recompute-all-spend.ts
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { computeAvgOrderGapDays } from '../src/lib/orderCadence';

const prisma = new PrismaClient();

async function main() {
  const accounts = await prisma.account.findMany({
    where: { quotes: { some: { paid: true } } },
    select: { id: true },
  });

  console.log(`Recomputing spend for ${accounts.length} accounts...`);
  const now = Date.now();
  let done = 0;
  for (const { id } of accounts) {
    const quotes = await prisma.quote.findMany({ where: { accountId: id, paid: true } });
    const sum = (days: number) => quotes.filter(q => now - q.sentAt.getTime() <= days * 86400000).reduce((s, q) => s + q.amount, 0);
    await prisma.account.update({
      where: { id },
      data: {
        spend30: sum(30),
        spend90: sum(90),
        spend365: sum(365),
        avgOrderGapDays: computeAvgOrderGapDays(quotes.map(q => q.sentAt)),
      },
    });
    done++;
    if (done % 200 === 0) console.log(`...${done}/${accounts.length} accounts recomputed so far`);
  }

  console.log(`Recomputed spend and order cadence for ${accounts.length} accounts.`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());