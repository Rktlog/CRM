/**
 * For quotes synced BEFORE the reference field existed, this looks
 * each one up in DEAR by order number (using DEAR's own search) to
 * recover its real CustomerReference, then deletes it if it turns
 * out to be a warranty/marketing one-off order.
 *
 * This is best-effort: it depends on DEAR's search matching your
 * order number reliably. Review what it deletes (it lists every one
 * before removing it) rather than trusting it blindly.
 *
 * Usage:
 *   npx tsx scripts/cleanup-warranty-marketing-quotes.ts
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { dearGet } from '../src/sync/dearClient';

const prisma = new PrismaClient();

async function main() {
  // Only quotes that predate the reference field — anything synced
  // after already has it and was already filtered at sync time.
  const quotes = await prisma.quote.findMany({
    where: { reference: null, source: 'cin7' },
    select: { id: true, number: true, accountId: true },
  });
  console.log(`Checking ${quotes.length} quotes with no stored reference...`);

  let checked = 0;
  let deleted = 0;
  let notFound = 0;
  const touchedAccountIds = new Set<string>();

  for (const quote of quotes) {
    checked++;
    try {
      const data = await dearGet('/saleList', { Limit: 5, search: quote.number });
      const match = (data.SaleList ?? []).find((s: any) => String(s.OrderNumber) === quote.number);

      if (!match) {
        notFound++;
        continue;
      }

      const ref = String(match.CustomerReference ?? '').toLowerCase();
      const isVoided = (match.Status ?? '').toUpperCase() === 'VOIDED';
      const isWarrantyOrMarketing = ref.includes('warranty') || ref.includes('marketing');

      if (isVoided || isWarrantyOrMarketing) {
        console.log(`Deleting ${quote.number} — ${isVoided ? 'voided' : `reference: "${match.CustomerReference}"`}`);
        await prisma.quote.delete({ where: { id: quote.id } });
        touchedAccountIds.add(quote.accountId);
        deleted++;
      } else {
        // Real order — backfill its reference now so it's not
        // re-checked next time this script runs.
        await prisma.quote.update({ where: { id: quote.id }, data: { reference: match.CustomerReference ?? '' } });
      }
    } catch (e) {
      console.warn(`Couldn't look up ${quote.number}, skipping:`, (e as Error).message);
    }

    if (checked % 50 === 0) console.log(`...${checked}/${quotes.length} checked so far`);
  }

  // Recompute spend for any account that lost a quote.
  for (const accountId of touchedAccountIds) {
    const remaining = await prisma.quote.findMany({ where: { accountId, paid: true } });
    const now = Date.now();
    const sum = (days: number) => remaining.filter(q => now - q.sentAt.getTime() <= days * 86400000).reduce((s, q) => s + q.amount, 0);
    await prisma.account.update({ where: { id: accountId }, data: { spend30: sum(30), spend90: sum(90), spend365: sum(365) } });
  }

  console.log(`\nChecked: ${checked}, deleted: ${deleted}, couldn't find in DEAR: ${notFound}`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
