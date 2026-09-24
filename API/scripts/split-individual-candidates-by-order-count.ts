/**
 * archive-non-leads.ts correctly refuses to auto-archive anything
 * based on name shape alone — "Blue Jaam" and "Humble Haven" look
 * exactly like a person's name but are real boutique brands. But
 * name shape isn't the only signal available: a genuine one-off
 * individual buyer almost always has exactly one order, ever, while
 * a real business — even one with a person-name-shaped title —
 * gets repeat orders over time.
 *
 * This reads individual-name-candidates.csv (from the last
 * archive-non-leads.ts run) and splits it in two: accounts with 2+
 * separate orders (very likely real, left alone) vs. accounts with
 * exactly one order (the group actually worth reviewing).
 *
 * Usage:
 *   npx tsx scripts/split-individual-candidates-by-order-count.ts
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';

const prisma = new PrismaClient();

// Minimal CSV line parser — handles simple "id,name" rows with
// optionally-quoted names, no external dependency needed for this
// one-off script.
function parseCsv(text: string): { id: string; name: string }[] {
  const lines = text.trim().split('\n').slice(1); // skip header
  return lines.map(line => {
    const match = line.match(/^([^,]+),"?(.*?)"?$/);
    return { id: match?.[1] ?? '', name: (match?.[2] ?? '').replace(/""/g, '"') };
  }).filter(r => r.id);
}

async function main() {
  const csvPath = 'individual-name-candidates.csv';
  if (!fs.existsSync(csvPath)) {
    console.error(`Can't find ${csvPath} — run archive-non-leads.ts first (preview mode is fine).`);
    process.exit(1);
  }

  const rows = parseCsv(fs.readFileSync(csvPath, 'utf-8'));
  console.log(`Read ${rows.length} candidates from the CSV.`);

  const ids = rows.map(r => r.id);
  const orderCounts = await prisma.quote.groupBy({
    by: ['accountId'],
    where: { accountId: { in: ids } },
    _count: { id: true },
  });
  const countByAccount = new Map(orderCounts.map(o => [o.accountId, o._count.id]));

  const likelyReal: typeof rows = [];
  const genuinelyOneOff: typeof rows = [];

  for (const r of rows) {
    const count = countByAccount.get(r.id) ?? 0;
    if (count >= 2) likelyReal.push(r);
    else genuinelyOneOff.push(r);
  }

  console.log(`\n${likelyReal.length} have 2+ real orders — very likely genuine businesses despite the name shape. Left alone.`);
  console.log(`${genuinelyOneOff.length} have 0-1 orders — this is the group actually worth a manual look.`);

  fs.writeFileSync('likely-real-businesses.csv', 'id,name\n' + likelyReal.map(r => `${r.id},"${r.name.replace(/"/g, '""')}"`).join('\n'));
  fs.writeFileSync('genuine-one-off-candidates.csv', 'id,name\n' + genuinelyOneOff.map(r => `${r.id},"${r.name.replace(/"/g, '""')}"`).join('\n'));

  console.log(`\nWritten: likely-real-businesses.csv (${likelyReal.length} rows, for your records — not archived)`);
  console.log(`Written: genuine-one-off-candidates.csv (${genuinelyOneOff.length} rows — this is the one worth reviewing)`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());