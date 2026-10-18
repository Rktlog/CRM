import { prisma } from '../lib/prisma';
import { dearGet } from './dearClient';

// Keeps each purchase order's "required by" date in step with DEAR. That date is what the Products page and the catalogue
// show as the ETA for stock on order (lib/eta.ts). It only changes purchase orders the CRM already has (the purchase sync
// creates them), only where the date differs, and never clears a date because DEAR's answer was missing one.

// DEAR's purchase list, one word and no slash like saleList. Root key PurchaseList.
export async function fetchPurchasesUpdatedSince(since: Date): Promise<any[]> {
  const all = new Map<string, any>();
  let page = 1;
  const limit = 100;
  while (true) {
    const data = await dearGet('/purchaseList', { Page: page, Limit: limit, UpdatedSince: since.toISOString() });
    const batch: any[] = data.PurchaseList ?? [];
    for (const p of batch) all.set(String(p.ID ?? p.OrderNumber), p);
    if (batch.length < limit) break;
    page++;
    if (page > 100) break;
  }
  return [...all.values()];
}

// "2026-11-10T00:00:00" -> "2026-11-10". Blank, junk and DEAR's "no date" placeholder (year 0001) are nothing.
export function dayOf(v: unknown): string | null {
  const m = typeof v === 'string' ? /^(\d{4})-(\d{2})-(\d{2})/.exec(v) : null;
  if (!m || Number(m[1]) < 2000 || Number(m[2]) < 1 || Number(m[2]) > 12 || Number(m[3]) < 1 || Number(m[3]) > 31) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

export async function syncPurchaseDates(now = new Date(), fetchList = fetchPurchasesUpdatedSince): Promise<{ checked: number; updated: number; skipped?: string }> {
  const since = new Date(now.getTime() - 365 * 86400000);
  const list = await fetchList(since);
  if (list.length && !list.some(p => p && 'RequiredBy' in p)) {
    console.warn('Purchase dates: DEAR\'s purchase list has no RequiredBy field, so ETAs from purchase orders were not refreshed.');
    return { checked: list.length, updated: 0, skipped: 'no RequiredBy field in the DEAR purchase list' };
  }
  const rows = list.map(p => ({ number: p?.OrderNumber ? String(p.OrderNumber).trim() : '', day: dayOf(p?.RequiredBy) })).filter((r): r is { number: string; day: string } => !!r.number && !!r.day);
  let updated = 0;
  for (let i = 0; i < rows.length; i += 1000) {
    const batch = rows.slice(i, i + 1000);
    const changed = await prisma.$queryRaw<{ n: number }[]>`
      update crm.purchases p set required_by = v.day::date
      from unnest(${batch.map(r => r.number)}::text[], ${batch.map(r => r.day)}::text[]) as v(number, day)
      where p.number = v.number and p.required_by::date is distinct from v.day::date
      returning 1 as n`;
    updated += changed.length;
  }
  console.log(`Purchase dates: ${list.length} purchase orders read from DEAR, ${rows.length} with a required-by date, ${updated} changed here.`);
  return { checked: list.length, updated };
}