/**
 * Runs the follow-up parser over every already-imported activity
 * row, updating each account's nextFollowUpAt if its most recent
 * matching activity implies one. Safe to re-run any time.
 *
 * Usage:
 *   npx tsx scripts/backfill-followups.ts
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { parseFollowUp } from '../src/lib/followup';

const prisma = new PrismaClient();

async function main() {
  const accounts = await prisma.account.findMany({
    select: { id: true, activity: { orderBy: { occurredAt: 'desc' } } },
  });

  let updated = 0;
  for (const account of accounts) {
    for (const a of account.activity) {
      const date = parseFollowUp(a.note, a.occurredAt);
      if (date) {
        await prisma.account.update({ where: { id: account.id }, data: { nextFollowUpAt: date } });
        updated++;
        break; // most recent match wins, stop scanning this account
      }
    }
  }

  console.log(`Accounts with a follow-up date set from notes: ${updated}`);
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
