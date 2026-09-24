/**
 * "Rhino Rhino Marketing" is a real, deliberate internal DEAR
 * account that consolidates marketing orders (previously spread
 * across each real customer's own account under the old DEAR
 * account, before the transfer). Since no matching CRM account
 * exists for it, every one of its orders currently gets rejected as
 * "unmatched" during sync and never even created — they can't be
 * tagged or shown on the Misc page because they don't exist yet.
 *
 * This creates the account, linked to its real DEAR customer ID, so
 * future syncs match it via dearCustomerId (the primary, reliable
 * match path) — not name matching. Reference text ("RR. Marketing")
 * then does the rest automatically, tagging every order on it as
 * marketing via the existing sync logic.
 *
 * Usage:
 *   npx tsx scripts/create-marketing-bucket-account.ts <rep-uuid>
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { fetchAllCustomers } from '../src/sync/dearClient';

const prisma = new PrismaClient();
const [, , repId] = process.argv;

async function main() {
  if (!repId) {
    console.error('Usage: npx tsx scripts/create-marketing-bucket-account.ts <rep-uuid>');
    process.exit(1);
  }

  console.log('Looking up "Rhino Rhino Marketing" in DEAR...');
  const customers = await fetchAllCustomers();
  const matches = customers.filter(c => String(c.Name ?? '').toLowerCase().includes('rhino rhino marketing'));

  if (matches.length === 0) {
    console.log('No DEAR customer record found matching "Rhino Rhino Marketing". Nothing created.');
    return;
  }
  if (matches.length > 1) {
    console.log(`Found ${matches.length} matches — expected exactly one. Names found:`);
    matches.forEach(m => console.log(`  "${m.Name}" — ID: ${m.ID}`));
    console.log('Not creating automatically — tell me which one is the real bucket account.');
    return;
  }

  const dearCustomer = matches[0];
  console.log(`Found: "${dearCustomer.Name}" — ID: ${dearCustomer.ID}`);

  const existing = await prisma.account.findUnique({ where: { dearCustomerId: dearCustomer.ID } });

  if (existing) {
    console.log(`Account already exists ("${existing.name}") and is already linked to this DEAR ID. Nothing to do.`);
    if (!existing.misc) {
      await prisma.account.update({ where: { id: existing.id }, data: { misc: true } });
      console.log('It wasn\'t flagged misc — fixed that now.');
    }
    return;
  }

  const created = await prisma.account.create({
    data: {
      name: dearCustomer.Name,
      region: 'Unknown',
      repId,
      credit: 'account',
      type: 'customer',
      stage: 'dispatched',
      dearCustomerId: dearCustomer.ID,
      misc: true, // this is never a real commercial sale, by definition
    },
  });

  console.log(`\nCreated account "${created.name}" (${created.id}), linked to DEAR ID ${dearCustomer.ID}, flagged misc.`);
  console.log('Run the backfill or regular sync again — orders that were previously "unmatched" for this name should now import and tag correctly.');
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());