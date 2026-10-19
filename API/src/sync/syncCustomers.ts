/**
 * IMPORTANT: this file NEVER creates new crm.accounts rows. It only
 * matches DEAR data against accounts that already exist (by
 * dearCustomerId or by name). A DEAR customer/sale with no match is
 * skipped and counted as unmatched — deliberately, so one-off retail
 * buyers and unrelated sales channels (e.g. an old Shopify storefront)
 * never spam the Accounts page with junk. If you ever need account
 * auto-creation from DEAR, that is a deliberate new decision, not a
 * bug to "fix" here.
 *
 * DEAR's own creation date for each customer is saved too (crm.accounts.dear_created_at), when DEAR sends one. The CRM's own
 * "created" date is the day the data was loaded for most customers, so Conversion uses the DEAR date to tell a customer set up
 * in DEAR this period from one that has been there for years.
 *
 * The moment a CRM customer is first linked to its DEAR record is saved (crm.accounts.dear_linked_at, added by
 * conversion-days.sql), so Conversion can tell how long a new prospect took to be set up in DEAR, and how long after that
 * to the first order.
 */
import { prisma } from '../lib/prisma';
import { normalize } from '../lib/normalize';
import { fetchAllCustomers } from './dearClient';

// The date DEAR created the customer, if its record carries one. DEAR dates are UTC, written without a zone.
export function createdFrom(c: any): Date | null {
  for (const k of ['CreatedDate', 'CreatedOn', 'CreationDate', 'DateCreated', 'Created']) {
    const v = c?.[k];
    if (typeof v !== 'string' && !(v instanceof Date)) continue;
    const text = typeof v === 'string' ? (/(Z|[+-]\d{2}:?\d{2})$/.test(v.trim()) ? v.trim() : `${v.trim()}Z`) : v;
    const d = new Date(text);
    if (!Number.isNaN(d.getTime()) && d.getUTCFullYear() >= 2000 && d.getTime() <= Date.now() + 86400000) return d;
  }
  return null;
}

/**
 * Only updates accounts already marked type: 'customer' — a prospect's
 * contact details stay rep-owned until they're actually onboarded.
 * Matches by dearCustomerId first (fast, exact), falls back to name
 * matching only for accounts that have never been linked yet.
 */
export async function syncCustomers() {
  const dearCustomers = await fetchAllCustomers();
  console.log(`Fetched ${dearCustomers.length} customers from DEAR.`);

  const accounts = await prisma.account.findMany({
    where: { type: 'customer' },
    select: { id: true, name: true, dearCustomerId: true },
  });

  const byDearId = new Map(accounts.filter(a => a.dearCustomerId).map(a => [a.dearCustomerId!, a]));
  const byName = new Map(accounts.filter(a => !a.dearCustomerId).map(a => [normalize(a.name), a]));

  let updated = 0;
  let newlyLinked = 0;
  let unmatched = 0;
  let warnedNoColumn = false;
  const created: { id: string; at: Date }[] = [];   // DEAR's creation date for each matched customer that has one

  for (const c of dearCustomers) {
    const dearId = String(c.ID ?? c.CustomerID ?? '');
    if (!dearId) continue;

    let account = byDearId.get(dearId);
    let linkedNow = false;   // found by name: this is the first time it is linked to DEAR
    if (!account) {
      const key = normalize(String(c.Name ?? ''));
      account = byName.get(key);
      if (account) { newlyLinked++; linkedNow = true; }
    }
    if (!account) {
      unmatched++;
      continue;
    }

    const addressParts = [c.Address1 ?? c.Line1, c.City, c.Postcode].filter(Boolean);

    await prisma.account.update({
      where: { id: account.id },
      data: {
        dearCustomerId: dearId,
        // Real address's State is a documented field shape (matches
        // Sale's Billing/ShippingAddress structure) — use it to fix
        // any account that was left as 'Unknown' or wrongly guessed
        // by the original spreadsheet import.
        region: c.State ?? undefined,
        contactName: c.AttentionTo ?? c.Contact ?? undefined,
        phone: c.Phone ?? undefined,
        email: c.Email ?? undefined,
        address: addressParts.length ? addressParts.join(', ') : undefined,
      },
    });
    updated++;
    const madeAt = createdFrom(c);
    if (madeAt) created.push({ id: account.id, at: madeAt });
    if (linkedNow) {
      try { await prisma.$executeRaw`update crm.accounts set dear_linked_at = now() where id = ${account.id}::uuid and dear_linked_at is null`; }
      catch (e) {
        if (!warnedNoColumn) { console.warn('Could not record when this customer was linked to DEAR (run conversion-days.sql to add the column):', (e as Error).message); warnedNoColumn = true; }
      }
    }
  }

  // DEAR's creation dates, saved in batches, only where they differ from what is there.
  if (created.length) {
    try {
      for (let i = 0; i < created.length; i += 1000) {
        const batch = created.slice(i, i + 1000);
        await prisma.$executeRaw`
          update crm.accounts a set dear_created_at = v.at::timestamptz
          from unnest(${batch.map(x => x.id)}::uuid[], ${batch.map(x => x.at.toISOString())}::text[]) as v(id, at)
          where a.id = v.id and a.dear_created_at is distinct from v.at::timestamptz`;
      }
    } catch (e) {
      if (!warnedNoColumn) console.warn('Could not save the DEAR creation dates (run conversion-days.sql to add the column):', (e as Error).message);
    }
  }
  console.log(`DEAR creation dates: ${created.length} of ${updated} matched customers have one${created.length === 0 && updated > 0 ? ' (DEAR does not seem to send one, so the CRM relies on the moment a customer is first linked)' : ''}.`);
  console.log(`Accounts updated from DEAR: ${updated} (${newlyLinked} newly linked by name)`);
  console.log(`DEAR customers with no matching CRM account: ${unmatched}`);
}

// Fills in DEAR's creation date (crm.accounts.dear_created_at) for customers already linked to DEAR, and touches nothing else.
// For when customers are synced somewhere else (a Supabase function, say) and this is only wanted for the dates. Safe to run
// as often as wanted: it only writes a date that is different.
export async function syncCustomerDates(): Promise<{ read: number; withDate: number; updated: number }> {
  const customers = await fetchAllCustomers();
  const pairs = customers.map(c => ({ id: c?.ID ? String(c.ID) : null, at: createdFrom(c) })).filter((x): x is { id: string; at: Date } => !!x.id && !!x.at);
  let updated = 0;
  for (let i = 0; i < pairs.length; i += 1000) {
    const batch = pairs.slice(i, i + 1000);
    const changed = await prisma.$queryRaw<{ n: number }[]>`
      update crm.accounts a set dear_created_at = v.at::timestamptz
      from unnest(${batch.map(x => x.id)}::text[], ${batch.map(x => x.at.toISOString())}::text[]) as v(dear_id, at)
      where a.dear_customer_id = v.dear_id and a.dear_created_at is distinct from v.at::timestamptz
      returning 1 as n`;
    updated += changed.length;
  }
  console.log(`Customer dates: ${customers.length} customers read from DEAR, ${pairs.length} with a creation date, ${updated} saved or changed.`);
  return { read: customers.length, withDate: pairs.length, updated };
}