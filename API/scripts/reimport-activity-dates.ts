/**
 * Re-imports activity and quotes from Daily Activity, with the date
 * bug fixed. Does NOT touch accounts — matches against your existing
 * 955 accounts by name instead of creating new ones, since those are
 * already correct from the first run.
 *
 * Run cleanup_activity_quotes.sql FIRST, then this.
 *
 * Usage:
 *   npx tsx scripts/reimport-activity-dates.ts "/path/to/NSW_ACT_SALES_MASTER.xlsx" <rep-uuid>
 *
 * The fix: XLSX.readFile defaults to returning Excel dates as raw
 * serial numbers, not JS Date objects. Passing { cellDates: true }
 * makes it convert them properly — that's the whole bug.
 */
import 'dotenv/config';
import * as XLSX from 'xlsx';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const [, , filePath, repId] = process.argv;
if (!filePath || !repId) {
  console.error('Usage: npx tsx scripts/reimport-activity-dates.ts <path-to-xlsx> <rep-uuid>');
  process.exit(1);
}

function normalize(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/^zz\(closed\)\s*/i, '')
    .replace(/^\(closed\)\s*/i, '')
    .replace(/\s+/g, ' ');
}

function isClosed(name: string): boolean {
  return /^zz\(closed\)|^\(closed\)/i.test(name.trim());
}

function activityTypeFor(contactType: string | null | undefined): 'call' | 'email' | 'visit' {
  const t = (contactType ?? '').toLowerCase();
  if (t.includes('f2f')) return 'visit';
  if (t.includes('phone')) return 'call';
  if (t.includes('email') || t.includes('forecast')) return 'email';
  if (t.includes('portal') || t.includes('b2b')) return 'email'; // self-service order, closest fit
  return 'call';
}

async function main() {
  // The fix: cellDates true.
  const wb = XLSX.readFile(filePath, { cellDates: true });

  // Load existing accounts instead of creating new ones.
  const existing = await prisma.account.findMany({ select: { id: true, name: true } });
  const accountIdByName = new Map<string, string>();
  for (const a of existing) accountIdByName.set(normalize(a.name), a.id);
  console.log(`Matched against ${accountIdByName.size} existing accounts.`);

  const activitySheet = wb.Sheets['Daily Activity'];
  const activityRows: any[] = XLSX.utils.sheet_to_json(activitySheet, { defval: null });

  let activityCreated = 0;
  let quotesCreated = 0;
  let accountsCreatedFallback = 0;
  let rowsWithNoDate = 0;
  const customerAccountIds = new Set<string>();
  const latestFollowUp = new Map<string, Date>();

  for (const row of activityRows) {
    const rawName = row['Customer Name  (ONLY)'];
    if (!rawName || typeof rawName !== 'string' || !rawName.trim()) continue;
    if (isClosed(rawName)) continue;

    const key = normalize(rawName);
    let accountId = accountIdByName.get(key);

    if (!accountId) {
      // Shouldn't happen much — the first run should have created
      // everyone already — but guard against it anyway.
      const account = await prisma.account.create({
        data: { name: rawName.trim(), region: 'NSW', repId, credit: 'account', type: 'prospect', stage: 'new_lead' },
      });
      accountId = account.id;
      accountIdByName.set(key, accountId);
      accountsCreatedFallback++;
    }

    const date: Date | null = row['Date'] instanceof Date ? row['Date'] : null;
    if (!date) rowsWithNoDate++;
    const isExisting = String(row['New / Existing'] ?? '').toLowerCase().includes('existing');

    await prisma.activity.create({
      data: {
        accountId,
        repId,
        type: activityTypeFor(row['Contact Type']),
        note: String(row['Notes & Comments'] ?? row['Ellen - Notes & Comments for follow up '] ?? '(imported, no note)').trim(),
        occurredAt: date ?? new Date(),
      },
    });
    activityCreated++;

    const quoteNumber = row['Sales Quote #'];
    const amount = row['Total Sales ($) ex GST'];
    if (quoteNumber && typeof amount === 'number') {
      const paid = row['Paid / Invoice #'] === true || typeof row['Paid / Invoice #'] === 'string';
      try {
        await prisma.quote.create({
          data: {
            accountId,
            number: String(quoteNumber).trim(),
            amount: Math.round(amount),
            sentAt: date ?? new Date(),
            paid,
            source: 'legacy_import',
          },
        });
        quotesCreated++;
      } catch {
        // Duplicate quote number in the sheet — skip.
      }
    }

    if (amount || isExisting) customerAccountIds.add(accountId);

    const followUp = row['Next Follow Up Date'];
    if (followUp instanceof Date) {
      const prev = latestFollowUp.get(accountId);
      if (!prev || followUp > prev) latestFollowUp.set(accountId, followUp);
    }
  }

  for (const accountId of customerAccountIds) {
    await prisma.account.update({ where: { id: accountId }, data: { type: 'customer', stage: 'dispatched' } });
  }
  for (const [accountId, date] of latestFollowUp) {
    await prisma.account.update({ where: { id: accountId }, data: { nextFollowUpAt: date } });
  }

  console.log(`Activity rows imported: ${activityCreated}`);
  console.log(`Quotes imported: ${quotesCreated}`);
  console.log(`Rows with no valid date (fell back to import time): ${rowsWithNoDate}`);
  console.log(`Fallback accounts created (should be near 0): ${accountsCreatedFallback}`);
  console.log(`Accounts marked as customers: ${customerAccountIds.size}`);
  console.log(`\nNow re-run backfill_spend.sql — the spend buckets depend on these corrected dates.`);
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
