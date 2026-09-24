/**
 * Prints the full raw JSON of one real DEAR customer record — same
 * technique used earlier to find Contact/Phone/Email. We assumed
 * region lives on a flat `State` field; if it's actually nested
 * under an Addresses array (common in DEAR/Cin7's real schema),
 * that's why almost every account created since then shows
 * "Unknown" instead of a real state.
 *
 * Usage:
 *   npx tsx scripts/inspect-dear-customer-fields.ts "MeeQ Sydney"
 */
import 'dotenv/config';
import { fetchAllCustomers } from '../src/sync/dearClient';

const [, , search] = process.argv;

async function main() {
  const customers = await fetchAllCustomers();
  const match = search
    ? customers.find(c => String(c.Name ?? '').toLowerCase().includes(search.toLowerCase()))
    : customers[0];

  if (!match) {
    console.log('No match found.');
    return;
  }

  console.log(JSON.stringify(match, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });