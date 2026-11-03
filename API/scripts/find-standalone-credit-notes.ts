/**
 * Finds the standalone credit notes in DEAR (a credit note with its own SQ number) and shows which ones Radar does not have, so the sync can be
 * taught to carry them. It needs no example numbers: it reads DEAR's sale list for the period itself.
 *
 * Usage (from the API folder):
 *   npx tsx scripts/find-standalone-credit-notes.ts                    reads 2026 so far
 *   npx tsx scripts/find-standalone-credit-notes.ts --since=2025-10-01
 *
 * Read-only: it only reads DEAR's sale list and Radar's order and shop names. Nothing is written anywhere. It prints no keys or passwords.
 * It does print customer names and amounts: send the output only to the people working on this.
 */
import 'dotenv/config';
import { dearGet } from '../src/sync/dearClient';
import { prisma } from '../src/lib/prisma';
import { normalize } from '../src/lib/normalize';
import { candidates, locate, missingByMonth, statusCounts, type DearSale } from '../src/lib/standaloneCreditNotes';

const since = (process.argv.find(a => a.startsWith('--since=')) ?? '--since=2026-01-01').slice(8);
const money = (n: number | null) => (n === null ? '?' : n.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

async function readSales(): Promise<DearSale[]> {
  const all = new Map<string, DearSale>();
  for (let page = 1; page <= 400; page++) {
    const data = await dearGet('/saleList', { Page: page, Limit: 100, UpdatedSince: new Date(`${since}T00:00:00Z`).toISOString() });
    const batch: DearSale[] = data?.SaleList ?? [];
    for (const s of batch) all.set(String(s.SaleID ?? s.OrderNumber), s);
    if (page % 10 === 0) console.log(`  ... ${all.size} sales read`);
    if (batch.length < 100) break;
  }
  return [...all.values()];
}

async function main() {
  console.log(`Reading DEAR's sale list, sales updated since ${since} ...`);
  const sales = await readSales();
  console.log(`Read ${sales.length} sales.\n`);

  console.log('--- What DEAR calls things (every field with "status" in its name, most common first)');
  for (const [key, counts] of Object.entries(statusCounts(sales))) {
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([v, n]) => `${v} (${n})`).join(', ');
    console.log(`  ${key}: ${top}`);
  }

  const cands = candidates(sales);
  const numbers = cands.map(c => c.number);
  const haveRows = await prisma.$queryRaw<{ number: string }[]>`select number from crm.quotes where number = any(${numbers}::text[])`;
  const have = new Set<string>(haveRows.map(r => r.number));
  const accounts = await prisma.$queryRaw<{ dear_customer_id: string | null; name: string }[]>`select dear_customer_id, name from crm.accounts`;
  const byId = new Set(accounts.map(a => a.dear_customer_id).filter(Boolean) as string[]);
  const byName = new Set(accounts.map(a => normalize(a.name)));
  const located = locate(cands, have, c => (!!c.customerId && byId.has(c.customerId)) || byName.has(normalize(c.customer)));

  const missing = located.filter(r => !r.inRadar);
  console.log(`\n--- Sales that look like credit notes: ${located.length}.  Radar has ${located.length - missing.length}.  Radar is missing ${missing.length}.`);
  console.log(`    Missing and the shop IS in Radar: ${missing.filter(r => r.customerInRadar).length}.   Missing and the shop is NOT in Radar: ${missing.filter(r => !r.customerInRadar).length}.`);
  const reasons = new Map<string, number>(); for (const r of located) reasons.set(r.reason, (reasons.get(r.reason) ?? 0) + 1);
  console.log('    Why they look like credit notes: ' + [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${k} (${n})`).join('; '));

  console.log('\n--- Missing from Radar, by month (set this beside the sales team table: 32 credit notes, -9,895.89 for 2026)');
  let tc = 0, tt = 0;
  for (const m of missingByMonth(located)) { console.log(`  ${m.month}   ${String(m.count).padStart(3)} credit notes   ${money(m.total).padStart(12)}`); tc += m.count; tt += m.total; }
  console.log(`  total   ${String(tc).padStart(3)} credit notes   ${money(Math.round(tt * 100) / 100).padStart(12)}`);

  console.log('\n--- The missing ones (up to 40): number, date, customer, amount, shop in Radar?, why it looks like a credit note');
  for (const r of missing.slice(0, 40)) console.log(`  ${r.number.padEnd(10)} ${(r.day ?? '').padEnd(10)} ${r.customer.slice(0, 32).padEnd(32)} ${money(r.amount).padStart(10)}   shop ${r.customerInRadar ? 'yes' : 'NO '}   ${r.reason}`);

  if (missing[0]) {
    console.log('\n--- One of them exactly as DEAR sends it (so the sync can be written to match)');
    for (const [k, v] of Object.entries(missing[0].sale)) console.log(`  ${k}: ${typeof v === 'object' ? JSON.stringify(v).slice(0, 120) : String(v).slice(0, 120)}`);
  } else console.log('\nNothing is missing: every credit-note-like sale is already in Radar.');
  await prisma.$disconnect();
}
main().catch(e => { console.error('Failed:', e.message ?? e); process.exit(1); });
