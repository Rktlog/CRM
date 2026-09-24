/**
 * Prints real numbers on sync coverage, so "I think it needs more
 * sync" becomes a concrete answer instead of a guess.
 *
 * Usage:
 *   npx tsx scripts/sync-status-report.ts
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { fetchAllCustomers, fetchSalesUpdatedSince } from '../src/sync/dearClient';

const prisma = new PrismaClient();

async function main() {
  console.log('=== Accounts ===');
  const totalAccounts = await prisma.account.count();
  const linkedAccounts = await prisma.account.count({ where: { dearCustomerId: { not: null } } });
  const customerAccounts = await prisma.account.count({ where: { type: 'customer' } });
  const prospectAccounts = await prisma.account.count({ where: { type: 'prospect' } });
  console.log(`Total accounts in CRM: ${totalAccounts}`);
  console.log(`  - Linked to a real DEAR customer ID: ${linkedAccounts}`);
  console.log(`  - Not linked to DEAR: ${totalAccounts - linkedAccounts}`);
  console.log(`  - type=customer: ${customerAccounts}, type=prospect: ${prospectAccounts}`);

  console.log('\n=== DEAR customers ===');
  const dearCustomers = await fetchAllCustomers();
  console.log(`Total customer records in DEAR: ${dearCustomers.length}`);
  console.log(`Matched to a CRM account: ${linkedAccounts}`);
  console.log(`Unmatched (one-off retail, closed, or genuinely not in scope): ${dearCustomers.length - linkedAccounts}`);

  console.log('\n=== Sync cursors ===');
  const salesState = await prisma.syncState.findUnique({ where: { key: 'sales' } });
  const backfillState = await prisma.syncState.findUnique({ where: { key: 'sales_backfill' } });
  const now = Date.now();
  if (salesState) {
    const daysAgo = Math.round((now - salesState.lastSyncedAt.getTime()) / 86400000);
    console.log(`Ongoing sync ("sales") last caught up to: ${salesState.lastSyncedAt.toISOString()} (${daysAgo} days ago)`);
  } else {
    console.log('Ongoing sync ("sales") has never run.');
  }
  if (backfillState) {
    const daysAgo = Math.round((now - backfillState.lastSyncedAt.getTime()) / 86400000);
    console.log(`Full backfill ("sales_backfill") reached: ${backfillState.lastSyncedAt.toISOString()} (${daysAgo} days into its scan)`);
  } else {
    console.log('Full backfill ("sales_backfill") has never run.');
  }

  console.log('\n=== Quotes/orders ===');
  const totalQuotes = await prisma.quote.count();
  console.log(`Quotes stored in CRM: ${totalQuotes}`);

  console.log('\nFetching DEAR\'s real sale count over the last 3 years for comparison (this takes a minute)...');
  const threeYearsAgo = new Date(now - 3 * 365 * 86400000);
  const realSales = await fetchSalesUpdatedSince(threeYearsAgo);
  console.log(`Real sales in DEAR, last 3 years: ${realSales.length}`);
  console.log(`Of those, roughly how many could ever match a CRM account depends on your ~13% historical match rate — expect stored quotes to be a small fraction of this number, not close to it. A low count here is not itself a problem.`);

  console.log('\n=== Bottom line ===');
  if (backfillState && (now - backfillState.lastSyncedAt.getTime()) > 60 * 86400000 * 2) {
    console.log('The backfill cursor is a while into its scan but may not have finished — if you never saw "Fully caught up" printed, re-run scripts/backfill-full-history.ts to continue.');
  }
  console.log('If unmatched DEAR customers still include real businesses you recognize, run scripts/add-accounts-from-dear.ts again — it only adds ones not already in the CRM, safe to re-run.');
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());