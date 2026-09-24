/**
 * Backfills the `address` field onto accounts that already exist
 * (from the first import pass), pulling Address/Suburb/Post Code
 * from "NSW Contacts List". Matches by name, updates in place —
 * doesn't touch activity, quotes, or create any new accounts.
 *
 * Usage:
 *   npx tsx scripts/backfill-address.ts "/path/to/NSW_ACT_SALES_MASTER.xlsx"
 */
import 'dotenv/config';
import * as XLSX from 'xlsx';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const [, , filePath] = process.argv;
if (!filePath) {
  console.error('Usage: npx tsx scripts/backfill-address.ts <path-to-xlsx>');
  process.exit(1);
}

function normalize(name: string): string {
  return name.trim().toLowerCase().replace(/^zz\(closed\)\s*/i, '').replace(/^\(closed\)\s*/i, '').replace(/\s+/g, ' ');
}

async function main() {
  const wb = XLSX.readFile(filePath, { cellDates: true });
  const contactsSheet = wb.Sheets['NSW Contacts List'];
  const contactRows: any[] = XLSX.utils.sheet_to_json(contactsSheet, { defval: null });

  const existing = await prisma.account.findMany({ select: { id: true, name: true } });
  const idByName = new Map<string, string>();
  for (const a of existing) idByName.set(normalize(a.name), a.id);

  let updated = 0;
  let skippedNoMatch = 0;

  for (const row of contactRows) {
    const rawName = row['Business Name'];
    if (!rawName || typeof rawName !== 'string' || !rawName.trim()) continue;

    const accountId = idByName.get(normalize(rawName));
    if (!accountId) {
      skippedNoMatch++;
      continue;
    }

    const parts = [row['Address'], row['Suburb'], row['Post Code']].filter(Boolean).map(String);
    if (!parts.length) continue;

    await prisma.account.update({
      where: { id: accountId },
      data: { address: parts.join(', ') },
    });
    updated++;
  }

  console.log(`Addresses updated: ${updated}`);
  console.log(`Contact rows with no matching account: ${skippedNoMatch}`);
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
