/**
 * Fixes region and category for every account already linked to a
 * real DEAR customer, using the correct nested field structure
 * (Addresses[] / Contacts[]) instead of the flat fields the sync
 * incorrectly assumed existed. Also fills in contact info for any
 * account that's still missing it.
 *
 * Fast: fetchAllCustomers() pulls every DEAR customer in one bulk
 * call, so this is a single API round-trip plus local matching, not
 * a rate-limited per-account loop.
 *
 * Usage:
 *   npx tsx scripts/backfill-region-and-category.ts
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { fetchAllCustomers } from '../src/sync/dearClient';

const prisma = new PrismaClient();

async function main() {
  console.log('Fetching all DEAR customers...');
  const customers = await fetchAllCustomers();
  const byDearId = new Map(customers.map(c => [c.ID, c]));
  console.log(`Fetched ${customers.length} DEAR customers.`);

  const accounts = await prisma.account.findMany({
    where: { dearCustomerId: { not: null } },
    select: { id: true, name: true, region: true, category: true, contactName: true, phone: true, email: true, dearCustomerId: true, misc: true },
  });
  console.log(`Checking ${accounts.length} linked accounts...`);

  let regionFixed = 0;
  let categoryFilled = 0;
  let contactFilled = 0;
  let noMatch = 0;

  for (const a of accounts) {
    const c = byDearId.get(a.dearCustomerId!);
    if (!c) { noMatch++; continue; }

    const businessAddress = (c.Addresses ?? []).find((addr: any) => addr.Type === 'Business' && addr.DefaultForType) ?? (c.Addresses ?? [])[0];
    const primaryContact = (c.Contacts ?? []).find((ct: any) => ct.Default) ?? (c.Contacts ?? [])[0];

    const patch: any = {};
    const realState = businessAddress?.State || null;
    if (realState && realState !== a.region) { patch.region = realState; regionFixed++; }

    const realCategory = c.AdditionalAttribute1 || null;
    if (realCategory && !a.category) { patch.category = realCategory; categoryFilled++; }
    if (realCategory === 'Personal' && !a.misc) { patch.misc = true; }

    if (!a.contactName && primaryContact?.Name) {
      patch.contactName = primaryContact.Name;
      patch.phone = primaryContact.Phone || primaryContact.MobilePhone || null;
      patch.email = primaryContact.Email || null;
      contactFilled++;
    }

    if (Object.keys(patch).length) {
      await prisma.account.update({ where: { id: a.id }, data: patch });
    }
  }

  console.log(`\nRegion corrected: ${regionFixed}`);
  console.log(`Category filled in: ${categoryFilled}`);
  console.log(`Contact info filled in: ${contactFilled}`);
  console.log(`No matching DEAR record found (unusual): ${noMatch}`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());