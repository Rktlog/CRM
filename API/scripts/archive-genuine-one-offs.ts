/**
 * Archives every account in genuine-one-off-candidates.csv (produced
 * by split-individual-candidates-by-order-count.ts) — confirmed as
 * having 0-1 real orders, matching the confirmed ~99% real-individual
 * base rate for this shape of name. Reversible: archiving doesn't
 * delete anything, and a genuine future order auto-un-archives the
 * account (see the fix in syncSales.ts / backfill-full-history.ts).
 *
 * Usage:
 *   npx tsx scripts/archive-genuine-one-offs.ts        (preview)
 *   npx tsx scripts/archive-genuine-one-offs.ts --apply
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';

const prisma = new PrismaClient();
const apply = process.argv.includes('--apply');

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
    console.error(`Can't find ${csvPath} — run split-individual-candidates-by-order-count.ts first.`);
    process.exit(1);
  }
  const rows = parseCsv(fs.readFileSync(csvPath, 'utf-8'));
  console.log(`Read ${rows.length} candidates.`);

  const ids = rows.map(r => r.id);
  const alreadyArchived = await prisma.account.count({ where: { id: { in: ids }, archived: true } });
  const toArchive = rows.length - alreadyArchived;
  console.log(`${alreadyArchived} already archived, ${toArchive} to newly archive.`);

  if (!apply) {
    console.log('\nPreview only — rerun with --apply to archive these.');
    return;
  }

  const result = await prisma.account.updateMany({ where: { id: { in: ids } }, data: { archived: true } });
  console.log(`\nArchived ${result.count} accounts.`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
