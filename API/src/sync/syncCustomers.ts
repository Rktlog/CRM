/**
 * IMPORTANT: this file NEVER creates new crm.accounts rows. It only
 * matches DEAR data against accounts that already exist (by
 * dearCustomerId or by name). A DEAR customer/sale with no match is
 * skipped and counted as unmatched — deliberately, so one-off retail
 * buyers and unrelated sales channels (e.g. an old Shopify storefront)
 * never spam the Accounts page with junk. If you ever need account
 * auto-creation from DEAR, that is a deliberate new decision, not a
 * bug to "fix" here.
 */
import { prisma } from '../lib/prisma';
import { normalize } from '../lib/normalize';
import { fetchAllCustomers } from './dearClient';

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

  for (const c of dearCustomers) {
    const dearId = String(c.ID ?? c.CustomerID ?? '');
    if (!dearId) continue;

    let account = byDearId.get(dearId);
    if (!account) {
      const key = normalize(String(c.Name ?? ''));
      account = byName.get(key);
      if (account) newlyLinked++;
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
  }

  console.log(`Accounts updated from DEAR: ${updated} (${newlyLinked} newly linked by name)`);
  console.log(`DEAR customers with no matching CRM account: ${unmatched}`);
}
