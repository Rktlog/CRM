/**
 * Searches DEAR's own customer list for a name pattern and prints
 * every distinct record found, with its real Customer ID. This is
 * the definitive answer to "does DEAR treat these as one customer or
 * several" — not a guess based on what's already in the CRM.
 *
 * Usage:
 *   npx tsx scripts/check-dear-customer.ts "toys and tales"
 */
import 'dotenv/config';
import { fetchAllCustomers } from '../src/sync/dearClient';

const [, , search] = process.argv;
if (!search) {
  console.error('Usage: npx tsx scripts/check-dear-customer.ts "<name pattern>"');
  process.exit(1);
}

async function main() {
  const customers = await fetchAllCustomers();
  const matches = customers.filter(c => String(c.Name ?? '').toLowerCase().includes(search.toLowerCase()));

  if (matches.length === 0) {
    console.log(`No DEAR customer records match "${search}".`);
    return;
  }

  console.log(`Found ${matches.length} distinct DEAR customer record(s) matching "${search}":\n`);
  for (const c of matches) {
    console.log(`- "${c.Name}" — Customer ID: ${c.ID ?? c.CustomerID}`);
  }

  console.log(
    matches.length > 1
      ? `\n${matches.length} different IDs means DEAR genuinely treats these as separate customers.`
      : `\nOnly one record — DEAR treats this as a single customer.`
  );
}

main().catch(e => { console.error(e); process.exit(1); });
