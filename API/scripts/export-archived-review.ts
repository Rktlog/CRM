/**
 * Exports every account from genuine-one-off-candidates.csv (the
 * batch just archived) along with their real order history, so you
 * can review the actual order numbers rather than just names.
 *
 * Usage:
 *   npx tsx scripts/export-archived-review.ts
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import * as XLSX from 'xlsx';
import * as fs from 'fs';

const prisma = new PrismaClient();

function parseCsv(text: string): { id: string; name: string }[] {
  const lines = text.trim().split('\n').slice(1);
  return lines.map(line => {
    const match = line.match(/^([^,]+),"?(.*?)"?$/);
    return { id: match?.[1] ?? '', name: (match?.[2] ?? '').replace(/""/g, '"') };
  }).filter(r => r.id);
}

async function main() {
  const csvPath = 'genuine-one-off-candidates.csv';
  if (!fs.existsSync(csvPath)) {
    console.error(`Can't find ${csvPath} in this folder.`);
    process.exit(1);
  }
  const candidates = parseCsv(fs.readFileSync(csvPath, 'utf-8'));
  console.log(`Read ${candidates.length} archived accounts. Pulling their real order history...`);

  const ids = candidates.map(c => c.id);
  const accounts = await prisma.account.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, region: true, contactName: true, phone: true, email: true, archived: true },
  });
  const quotes = await prisma.quote.findMany({
    where: { accountId: { in: ids } },
    select: { accountId: true, number: true, sentAt: true, amount: true, paid: true, reference: true },
    orderBy: { sentAt: 'desc' },
  });

  const quotesByAccount = new Map<string, typeof quotes>();
  for (const q of quotes) {
    if (!quotesByAccount.has(q.accountId)) quotesByAccount.set(q.accountId, []);
    quotesByAccount.get(q.accountId)!.push(q);
  }
  const accountById = new Map(accounts.map(a => [a.id, a]));

  // One row per order, so the real order number is right there next
  // to the account — accounts with zero orders still get one row.
  const rows: any[] = [];
  for (const c of candidates) {
    const account = accountById.get(c.id);
    const accountQuotes = quotesByAccount.get(c.id) ?? [];
    if (accountQuotes.length === 0) {
      rows.push({
        Account: c.name, Region: account?.region ?? '', Contact: account?.contactName ?? '',
        Phone: account?.phone ?? '', Email: account?.email ?? '',
        'Order #': '(no orders)', 'Order Date': '', Amount: '', Reference: '',
        'Currently Archived': account?.archived ? 'Yes' : 'No',
      });
    } else {
      for (const q of accountQuotes) {
        rows.push({
          Account: c.name, Region: account?.region ?? '', Contact: account?.contactName ?? '',
          Phone: account?.phone ?? '', Email: account?.email ?? '',
          'Order #': q.number, 'Order Date': q.sentAt.toISOString().slice(0, 10), Amount: q.amount, Reference: q.reference ?? '',
          'Currently Archived': account?.archived ? 'Yes' : 'No',
        });
      }
    }
  }

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, 'Archived for Review');
  XLSX.writeFile(wb, 'archived-accounts-review.xlsx');

  console.log(`\nWritten archived-accounts-review.xlsx — ${rows.length} rows covering ${candidates.length} accounts.`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
