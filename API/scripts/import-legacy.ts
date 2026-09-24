/**
 * One-time migration from the legacy NSW/ACT sales spreadsheet into
 * the CRM database. Run once, review the output counts, then never
 * again — this is not a sync job.
 *
 * Usage:
 *   npx tsx scripts/import-legacy.ts "/path/to/NSW_ACT_SALES_MASTER.xlsx" <rep-uuid>
 *
 * What it does:
 *   1. Reads "NSW Contacts List" -> creates/updates crm.accounts with
 *      name, region, contact name, phone, email.
 *   2. Reads "Daily Activity" -> for each row, matches (or creates) the
 *      account by name, then writes a crm.activity row, and a
 *      crm.quotes row if a Sales Quote # is present.
 *   3. Everything is assigned to the single rep UUID you pass in —
 *      re-run a plain SQL UPDATE later if activity should be split
 *      across multiple reps' history.
 *
 * Heuristics used (adjust in the code below if they're wrong):
 *   - Business names starting "ZZ(CLOSED)" or "(CLOSED)" are skipped
 *     entirely — treated as dead accounts not worth importing.
 *   - credit defaults to 'account' for everyone (no equivalent
 *     column in the spreadsheet) — fix individual accounts by hand
 *     after import if some are actually pay-first.
 *   - type is 'customer' if the account has any paid quote or any
 *     activity marked "Existing", otherwise 'prospect'.
 *   - stage is 'dispatched' for anyone already a customer (this is
 *     historical backfill, not an active deal in progress), or
 *     'approached' for a prospect with any logged activity, or
 *     'new_lead' for a prospect with none.
 */
import 'dotenv/config';
import * as XLSX from 'xlsx';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const [, , filePath, repId] = process.argv;
if (!filePath || !repId) {
  console.error('Usage: npx tsx scripts/import-legacy.ts <path-to-xlsx> <rep-uuid>');
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
  if (t.includes('email') || t.includes('forecast')) return 'email';
  return 'call';
}

async function main() {
  const wb = XLSX.readFile(filePath);

  // ---- Pass 1: NSW Contacts List -> accounts ----
  const contactsSheet = wb.Sheets['NSW Contacts List'];
  const contactRows: any[] = XLSX.utils.sheet_to_json(contactsSheet, { defval: null });

  const accountIdByName = new Map<string, string>();
  let accountsCreated = 0;
  let accountsSkippedClosed = 0;

  for (const row of contactRows) {
    const rawName = row['Business Name'];
    if (!rawName || typeof rawName !== 'string' || !rawName.trim()) continue;
    if (isClosed(rawName)) {
      accountsSkippedClosed++;
      continue;
    }

    const key = normalize(rawName);
    if (accountIdByName.has(key)) continue; // duplicate row, first one wins

    const account = await prisma.account.create({
      data: {
        name: rawName.trim(),
        region: (row['State'] ?? 'NSW').toString().trim(),
        repId,
        credit: 'account',
        type: 'prospect', // corrected in pass 2 once we see their activity/quotes
        stage: 'new_lead',
        contactName: row[' Contact Name'] ? String(row[' Contact Name']).trim() : null,
        phone: row['Phone'] ? String(row['Phone']).trim() : null,
        email: row['Email'] ? String(row['Email']).trim() : null,
      },
    });
    accountIdByName.set(key, account.id);
    accountsCreated++;
  }

  console.log(`Accounts created from contacts list: ${accountsCreated}`);
  console.log(`Closed accounts skipped: ${accountsSkippedClosed}`);

  // ---- Pass 2: Daily Activity -> activity + quotes, and fill in
  // any account the contacts list didn't have ----
  const activitySheet = wb.Sheets['Daily Activity'];
  const activityRows: any[] = XLSX.utils.sheet_to_json(activitySheet, { defval: null });

  let activityCreated = 0;
  let quotesCreated = 0;
  let accountsCreatedFromActivity = 0;
  const customerAccountIds = new Set<string>();
  const latestFollowUp = new Map<string, Date>();

  for (const row of activityRows) {
    const rawName = row['Customer Name  (ONLY)'];
    if (!rawName || typeof rawName !== 'string' || !rawName.trim()) continue;
    if (isClosed(rawName)) continue;

    const key = normalize(rawName);
    let accountId = accountIdByName.get(key);

    if (!accountId) {
      // Someone in Daily Activity who never made it into the contacts
      // list — create a bare-bones account so their history isn't lost.
      const account = await prisma.account.create({
        data: {
          name: rawName.trim(),
          region: 'NSW',
          repId,
          credit: 'account',
          type: 'prospect',
          stage: 'new_lead',
        },
      });
      accountId = account.id;
      accountIdByName.set(key, accountId);
      accountsCreatedFromActivity++;
    }

    const date: Date | null = row['Date'] instanceof Date ? row['Date'] : null;
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
        // Duplicate quote number — spreadsheet has a repeat, skip it.
      }
    }

    if (amount || isExisting) customerAccountIds.add(accountId);

    const followUp = row['Next Follow Up Date'];
    if (followUp instanceof Date) {
      const existing = latestFollowUp.get(accountId);
      if (!existing || followUp > existing) latestFollowUp.set(accountId, followUp);
    }
  }

  // ---- Pass 3: fix up type/stage now that we know who's a real customer ----
  for (const accountId of customerAccountIds) {
    await prisma.account.update({
      where: { id: accountId },
      data: { type: 'customer', stage: 'dispatched' },
    });
  }

  for (const [accountId, date] of latestFollowUp) {
    await prisma.account.update({
      where: { id: accountId },
      data: { nextFollowUpAt: date },
    });
  }

  // Prospects with at least one logged activity move past new_lead.
  const stillNewLeads = await prisma.account.findMany({
    where: { type: 'prospect', stage: 'new_lead' },
    select: { id: true },
  });
  for (const { id } of stillNewLeads) {
    const hasActivity = await prisma.activity.findFirst({ where: { accountId: id } });
    if (hasActivity) {
      await prisma.account.update({ where: { id }, data: { stage: 'approached' } });
    }
  }

  console.log(`Accounts created from activity log (not in contacts list): ${accountsCreatedFromActivity}`);
  console.log(`Activity rows imported: ${activityCreated}`);
  console.log(`Quotes imported: ${quotesCreated}`);
  console.log(`Accounts marked as customers: ${customerAccountIds.size}`);
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());