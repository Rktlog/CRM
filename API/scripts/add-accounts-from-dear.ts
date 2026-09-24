/**
 * Adds real accounts to the CRM for DEAR customers who were never in
 * the original NSW_ACT_SALES_MASTER spreadsheet — genuine wholesale
 * customers outside that territory (other states, NZ), found during
 * the full-history backfill.
 *
 * This is a DELIBERATE, one-time, reviewable expansion of scope. It
 * does NOT change the ongoing sync's behavior — that still never
 * auto-creates accounts. Run this once, review what it created, then
 * go back to the normal sync for everything after.
 *
 * Filters out: the old disconnected Shopify channel, your own
 * internal/test DEAR accounts, already-closed accounts, and names
 * that look like a one-off individual rather than a business.
 *
 * Usage:
 *   npx tsx scripts/add-accounts-from-dear.ts <rep-uuid>
 *
 * <rep-uuid> is who these new accounts get assigned to — reassign
 * individually later if a different rep should own some of them.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { normalize } from '../src/lib/normalize';
import { fetchAllCustomers } from '../src/sync/dearClient';

const prisma = new PrismaClient();
const [, , repId] = process.argv;
if (!repId) {
  console.error('Usage: npx tsx scripts/add-accounts-from-dear.ts <rep-uuid>');
  process.exit(1);
}

const COMPANY_KEYWORDS = [
  'pty', 'ltd', 'llc', 'inc', 'group', 'store', 'shop', 'gallery', 'museum',
  'co', 'company', 'gifts', 'cafe', 'boutique', 'trading', 'trust', 'holdings',
  'wholesale', 'imports', 'design', 'studio', 'collective', 'emporium',
  'living', 'home', 'kids', 'baby', 'toys', 'books', 'card', 'floral',
  'flowers', 'market', 'centre', 'center', 'foundation', 'association',
  'club', 'health', 'duty free', 'apothecary',
];

function shouldExclude(name: string): { exclude: boolean; reason?: string } {
  const trimmed = name.trim();
  if (/^shopify\s*-/i.test(trimmed)) return { exclude: true, reason: 'old Shopify channel' };
  if (/rhino rhino/i.test(trimmed)) return { exclude: true, reason: 'internal/test account' };
  if (/^\(closed\)|^zz\(closed\)/i.test(trimmed)) return { exclude: true, reason: 'already closed' };
  // Deliberately no more name-shape guessing here — a keyword list
  // can never keep up with real 2-word business names ("Go Dutch",
  // "Green Tangerine", "Knoxfield Florist" all silently vanished
  // this way, with zero trace, which took a long debugging session
  // to even notice). Create everyone; genuine individuals get swept
  // into Archived afterward by archive-non-leads.ts using real
  // evidence (order history), not a guess from the name alone — and
  // a wrongly-created prospect costs nothing until it earns a real
  // order, since type only ever promotes to customer on a real
  // paid order.
  return { exclude: false };
}

async function main() {
  const dearCustomers = await fetchAllCustomers();
  console.log(`Fetched ${dearCustomers.length} DEAR customers.`);

  const existingAccounts = await prisma.account.findMany({ select: { id: true, name: true, dearCustomerId: true } });
  const existingNames = new Map(existingAccounts.map(a => [normalize(a.name), a]));
  const existingDearIds = new Set(existingAccounts.filter(a => a.dearCustomerId).map(a => a.dearCustomerId));

  let created = 0;
  let linkedExisting = 0;
  let skippedIndividual = 0;
  let skippedOther = 0;
  let skippedNoName = 0;

  for (const c of dearCustomers) {
    const dearId = String(c.ID ?? c.CustomerID ?? '');
    const name = String(c.Name ?? '').trim();
    if (!name) { skippedNoName++; continue; }
    if (existingDearIds.has(dearId)) continue; // already linked

    const existingMatch = existingNames.get(normalize(name));
    if (existingMatch) {
      // Already in the CRM by name, but never linked — fix that
      // instead of silently skipping it. This was the actual bug:
      // "Meeq Sydney" existed from the spreadsheet import but sat
      // with no dear_customer_id forever because this case fell
      // through to a plain `continue`.
      if (!existingMatch.dearCustomerId) {
        await prisma.account.update({ where: { id: existingMatch.id }, data: { dearCustomerId: dearId } });
        linkedExisting++;
      }
      continue;
    }

    const { exclude, reason } = shouldExclude(name);
    if (exclude) {
      if (reason === 'looks like an individual, not a business') skippedIndividual++;
      else skippedOther++;
      continue;
    }

    // Real DEAR shape: address fields live inside Addresses[], not
    // flat on the customer — and contact fields live inside
    // Contacts[], not flat either. This was the actual bug behind
    // almost every synced account showing "Unknown" region.
    const businessAddress = (c.Addresses ?? []).find((a: any) => a.Type === 'Business' && a.DefaultForType)
      ?? (c.Addresses ?? [])[0];
    const primaryContact = (c.Contacts ?? []).find((ct: any) => ct.Default) ?? (c.Contacts ?? [])[0];
    const addressParts = [businessAddress?.Line1, businessAddress?.City, businessAddress?.Postcode].filter(Boolean);

    await prisma.account.create({
      data: {
        name,
        region: businessAddress?.State || 'Unknown',
        repId,
        credit: 'account',
        // Deliberately 'prospect'/'new_lead', not 'customer' — this
        // script only knows they exist in DEAR's customer list, not
        // that they've ever had a real completed order. The regular
        // sales sync promotes them to a real customer automatically
        // the first time it finds a genuine paid order for them.
        type: 'prospect',
        stage: 'new_lead',
        dearCustomerId: dearId || null,
        contactName: primaryContact?.Name || null,
        phone: primaryContact?.Phone || primaryContact?.MobilePhone || null,
        email: primaryContact?.Email || null,
        address: addressParts.length ? addressParts.join(', ') : null,
        // AdditionalAttribute1 is genuinely the business category
        // field ("Gift and concept stores", "Toy", etc.) — the exact
        // classification the spreadsheet used, just under a generic name.
        category: c.AdditionalAttribute1 || null,
        // "Personal" accounts are marketing/warranty/individual-use,
        // not real wholesale customers — never count toward performance.
        misc: c.AdditionalAttribute1 === 'Personal',
      },
    });
    created++;
  }

  console.log(`\nAccounts created: ${created}`);
  console.log(`Existing accounts newly linked to their real DEAR ID: ${linkedExisting}`);
  console.log(`Skipped — looked like an individual, not a business: ${skippedIndividual}`);
  console.log(`Skipped — excluded (Shopify/internal/closed): ${skippedOther}`);
  console.log(`Skipped — no name at all: ${skippedNoName}`);
  console.log(`\nRun the regular sync now (npm run sync:once or the backfill) to pull in their order history — these new accounts have no quotes yet, only their contact details.`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
