/**
 * For each prospect linked to a real DEAR customer, pulls their
 * actual order list directly from DEAR and checks the real outcome:
 * if they have at least one order AND every single one is VOIDED,
 * archive them — this is exactly the leftover Project Clothing /
 * one-off pattern (an order was placed, then voided/refunded,
 * nothing genuine ever went through).
 *
 * Deliberately does NOT touch a prospect with zero orders at all —
 * "never ordered yet" is a normal, real prospect state, completely
 * different from "ordered once, and it fell through."
 *
 * This only ever checks type='prospect' accounts — never a real
 * customer, regardless of what DEAR shows.
 *
 * Usage:
 *   npx tsx scripts/archive-all-voided-accounts.ts        (preview)
 *   npx tsx scripts/archive-all-voided-accounts.ts --apply
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { dearGet } from '../src/sync/dearClient';

const prisma = new PrismaClient();
const apply = process.argv.includes('--apply');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  const prospects = await prisma.account.findMany({
    where: { type: 'prospect', archived: false, dearCustomerId: { not: null } },
    select: { id: true, name: true, dearCustomerId: true },
  });

  console.log(`Checking ${prospects.length} DEAR-linked prospects against their real order history...`);

  const toArchive: { id: string; name: string }[] = [];
  let checked = 0;
  let hadNoOrders = 0;
  let hadRealOrders = 0;

  for (const p of prospects) {
    checked++;
    try {
      const data = await dearGet('/saleList', { CustomerID: p.dearCustomerId!, Limit: 100 });
      const sales: any[] = data.SaleList ?? data.Sales ?? [];

      if (sales.length === 0) {
        hadNoOrders++;
      } else if (sales.every(s => String(s.Status ?? '').toUpperCase() === 'VOIDED')) {
        toArchive.push({ id: p.id, name: p.name });
      } else {
        hadRealOrders++;
      }
    } catch (e) {
      console.warn(`Couldn't check ${p.name}: ${(e as Error).message}`);
    }

    // DEAR's rate limit is 60/min — same pacing as the other sync scripts.
    await sleep(1100);
    if (checked % 50 === 0) console.log(`...${checked}/${prospects.length} checked, ${toArchive.length} all-voided so far`);
  }

  console.log(`\nChecked ${checked} accounts.`);
  console.log(`Had no orders at all (left alone — genuinely just hasn't ordered yet): ${hadNoOrders}`);
  console.log(`Had at least one real, non-voided order (left alone): ${hadRealOrders}`);
  console.log(`Every order voided — archiving: ${toArchive.length}`);
  console.log(`Sample: ${toArchive.slice(0, 15).map(a => a.name).join(', ')}`);

  if (!apply) {
    console.log('\nPreview only — rerun with --apply to archive these.');
    return;
  }

  const ids = toArchive.map(a => a.id);
  const chunkSize = 500;
  for (let i = 0; i < ids.length; i += chunkSize) {
    await prisma.account.updateMany({
      where: { id: { in: ids.slice(i, i + chunkSize) } },
      data: { archived: true },
    });
  }

  console.log(`\nArchived ${toArchive.length} accounts.`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
