/**
 * Looks for the real field DEAR uses for a "Personal"/Marketing/
 * Warranty division on customer records — checks Category, Tags,
 * and every AdditionalAttribute, since we don't know which one it's
 * actually in yet (Category held business type like "Gift and
 * concept stores" in the one sample we've seen so far, but that
 * doesn't mean it's the same field for this).
 *
 * Usage:
 *   npx tsx scripts/find-personal-division-field.ts
 */
import 'dotenv/config';
import { fetchAllCustomers } from '../src/sync/dearClient';

const TERMS = ['personal', 'marketing', 'warranty'];

async function main() {
  const customers = await fetchAllCustomers();
  console.log(`Checking ${customers.length} DEAR customers...`);

  const hits: { name: string; field: string; value: string }[] = [];

  for (const c of customers) {
    const fieldsToCheck: [string, unknown][] = [
      ['Category', c.Category],
      ['Tags', c.Tags],
      ['AdditionalAttribute1', c.AdditionalAttribute1],
      ['AdditionalAttribute2', c.AdditionalAttribute2],
      ['AdditionalAttribute3', c.AdditionalAttribute3],
      ['AdditionalAttribute4', c.AdditionalAttribute4],
      ['AdditionalAttribute5', c.AdditionalAttribute5],
    ];
    for (const [field, value] of fieldsToCheck) {
      const str = String(value ?? '').toLowerCase();
      if (TERMS.some(t => str.includes(t))) {
        hits.push({ name: c.Name, field, value: String(value) });
      }
    }
  }

  if (hits.length === 0) {
    console.log('\nNo customer record has "personal", "marketing", or "warranty" in Category, Tags, or AdditionalAttributes 1-5.');
    console.log('This classification likely lives elsewhere — possibly per-order (CustomerReference, already partly filtered) rather than per-account.');
    return;
  }

  console.log(`\nFound ${hits.length} matches:`);
  const byField = new Map<string, typeof hits>();
  for (const h of hits) {
    if (!byField.has(h.field)) byField.set(h.field, []);
    byField.get(h.field)!.push(h);
  }
  for (const [field, list] of byField) {
    console.log(`\n=== ${field} (${list.length} matches) ===`);
    for (const h of list.slice(0, 15)) console.log(`  "${h.name}" -> ${h.value}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
