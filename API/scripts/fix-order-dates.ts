/**
 * One-off repair for orders whose date in the CRM is wrong because the sync fell back to a "modified" or "now"
 * timestamp instead of DEAR's order date (SQ34887 showed 24 Aug 2026 against DEAR's 21 Sep 2025).
 *
 * Orders with a real order date are stored at 00:00 UTC (or at 13:00 / 14:00 UTC for history loaded from a Melbourne machine: see the one-off SQL that
 * moves those to 00:00). Anything else (15:09, 15:06 ...) is a real timestamp from when the sync ran, so those are the ones checked against DEAR.
 *
 *   npx tsx scripts/fix-order-dates.ts           shows what it WOULD change, writes nothing
 *   npx tsx scripts/fix-order-dates.ts --apply   makes the changes
 *
 * About 2 DEAR calls per order at DEAR's 60 per minute limit: roughly 4 minutes for 120 orders. Safe to stop and re-run.
 * It changes sent_at to DEAR's order day at 00:00 UTC, the way the rest of the CRM stores dates.
 *
 * It also recalculates, for each account it touched, exactly what the sync-sales edge function recalculates after every order: spend_30/90/365,
 * the usual reorder gap (reorder_gap_auto, and avg_order_gap_days = the manual override if there is one) and last_order_at. Same rule as the
 * function: real orders only (paid or not; no drafts, quotes, Ordering, voided, credited, marketing or warranty orders). A wrong order date
 * can make a customer look active in August when the order was months earlier, which feeds Inactive stockists, the Planner and the
 * marketing "inactive" audience.
 *
 * Do NOT run scripts/recompute-all-spend.ts after this. It is the old rule (paid orders only, no reorder gap override) and would overwrite
 * the figures the edge function keeps.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { dearGet } from '../src/sync/dearClient';

const prisma = new PrismaClient();
const apply = process.argv.includes('--apply');

/** The CRM stores an order date as that calendar day at 00:00 UTC (everything that reads it takes the UTC day). */
const dayAtUtcMidnight = (day: string): Date | null => { const t = new Date(`${day}T00:00:00Z`); return Number.isNaN(t.getTime()) ? null : t; };

const NOT_REAL_ORDERS = ['DRAFT', 'ESTIMATING', 'ESTIMATED', 'ORDERING', 'VOIDED', 'CREDITED'];   // the sync-sales function's list

/** Same working as the end of the sync-sales edge function: spend windows, the typical gap between ordering rounds, the latest order. */
export function figures(sent: number[], amounts: number[], now: number) {
  const sum = (days: number) => amounts.reduce((t, a, i) => (now - sent[i] <= days * 86400000 ? t + a : t), 0);
  const sorted = [...sent].sort((a, b) => a - b);
  const roundStarts: number[] = [];   // orders within 7 days of a round's first order are one round (several branches on one account)
  for (const t of sorted) if (!roundStarts.length || t - roundStarts[roundStarts.length - 1] > 7 * 86400000) roundStarts.push(t);
  let autoGap: number | null = null;
  if (roundStarts.length >= 2) {
    const gaps = roundStarts.slice(1).map((t, i) => (t - roundStarts[i]) / 86400000).sort((a, b) => a - b);
    const mid = Math.floor(gaps.length / 2);
    autoGap = Math.round(gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2);
  }
  return { spend30: sum(30), spend90: sum(90), spend365: sum(365), autoGap, last: sorted.length ? new Date(sorted[sorted.length - 1]) : null };
}
const saveFigures = (accountId: string, f: ReturnType<typeof figures>, gap: number | null) => prisma.$executeRaw`
  update crm.accounts set spend_30 = ${f.spend30}, spend_90 = ${f.spend90}, spend_365 = ${f.spend365}, reorder_gap_auto = ${f.autoGap}::int,
    avg_order_gap_days = ${gap}::int, last_order_at = ${f.last}::timestamp where id = ${accountId}::uuid`;

async function main() {
  const rows = await prisma.$queryRaw<{ id: string; account_id: string; number: string; sent_at: Date }[]>`
    select id, account_id, number, sent_at from crm.quotes
    where source = 'cin7' and number like 'SQ%' and to_char(sent_at, 'HH24:MI') not in ('00:00', '13:00', '14:00')
    order by sent_at`;
  console.log(`${rows.length} orders have a sync-time stamp instead of an order date. ${apply ? 'APPLYING changes.' : 'Dry run: nothing is written (add --apply).'}\n`);

  let fixed = 0, same = 0, noDate = 0, notFound = 0, failed = 0;
  const changes: { id: string; accountId: string; number: string; wrong: Date; target: Date }[] = [];
  for (const q of rows) {
    try {
      const found = await dearGet('/saleList', { Limit: 5, search: q.number });
      const match = (found.SaleList ?? []).find((s: any) => String(s.OrderNumber) === q.number);
      if (!match) { notFound++; console.log(`${q.number}  not found in DEAR`); continue; }
      const detail = await dearGet('/sale', { ID: match.SaleID });
      const raw = detail.SaleOrderDate;
      // DEAR gives a local calendar date: read the day as written, never through new Date() (that is what caused the shift in the first place)
      const day = typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : null;
      if (!day) { noDate++; console.log(`${q.number}  DEAR has no order date yet (status ${detail.Status}) - left alone`); continue; }
      const target = dayAtUtcMidnight(day);
      if (!target) { failed++; console.log(`${q.number}  could not work out ${day}`); continue; }
      if (target.getTime() === q.sent_at.getTime()) { same++; continue; }
      console.log(`${q.number}  ${q.sent_at.toISOString()}  ->  ${target.toISOString()}  (DEAR order date ${day})`);
      if (apply) await prisma.quote.update({ where: { id: q.id }, data: { sentAt: target } });
      changes.push({ id: q.id, accountId: q.account_id, number: q.number, wrong: q.sent_at, target });
      fixed++;
    } catch (e) { failed++; console.warn(`${q.number}  failed: ${(e as Error).message}`); }
  }
  // ---- spend, reorder gap and last order for the accounts touched (same rule as the sync-sales edge function) ----
  const byAccount = new Map<string, typeof changes>();
  for (const c of changes) byAccount.set(c.accountId, [...(byAccount.get(c.accountId) ?? []), c]);
  let accountsChanged = 0;
  if (byAccount.size) console.log('\nAccounts whose figures change:');
  for (const [accountId, list] of byAccount) {
    const override = new Map(list.map(c => [c.id, c.target]));
    const [acct] = await prisma.$queryRaw<any[]>`select name, last_order_at, avg_order_gap_days, reorder_gap_auto, reorder_gap_override from crm.accounts where id = ${accountId}::uuid`;
    const quotes = await prisma.$queryRaw<{ id: string; sent_at: Date; amount: number }[]>`
      select id::text as id, sent_at, amount::float8 as amount from crm.quotes
      where account_id = ${accountId}::uuid and misc_type is null and upper(coalesce(fulfillment_status, '')) <> all(${NOT_REAL_ORDERS}::text[])`;
    const f = figures(quotes.map(q => (override.get(q.id) ?? q.sent_at).getTime()), quotes.map(q => q.amount), Date.now());
    const gap = acct.reorder_gap_override ?? f.autoGap;
    const lastBefore = acct.last_order_at ? new Date(acct.last_order_at).toISOString().slice(0, 10) : 'none';
    const lastAfter = f.last ? f.last.toISOString().slice(0, 10) : 'none';
    if (lastBefore === lastAfter && gap === acct.avg_order_gap_days) { if (apply) await saveFigures(accountId, f, gap); continue; }
    console.log(`${acct.name}: last order ${lastBefore} -> ${lastAfter}, usual gap ${acct.avg_order_gap_days ?? 'none'} -> ${gap ?? 'none'} days`);
    if (apply) await saveFigures(accountId, f, gap);
    accountsChanged++;
  }

  console.log(`\n${apply ? 'Changed' : 'Would change'}: ${fixed}   already right: ${same}   DEAR has no order date: ${noDate}   not found: ${notFound}   failed: ${failed}   accounts with changed figures: ${accountsChanged}`);
  if (!apply && fixed) console.log('Run again with --apply to make these changes, the account figures are updated in the same run.');
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());