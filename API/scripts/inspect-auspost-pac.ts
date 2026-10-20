/**
 * Checks the Australia Post calculator (PAC) really answers the way the freight quote expects, with YOUR key.
 * Prints what it gets for New Zealand and for an Australian postcode, and how each answer is read.
 *
 * Usage (from the API folder, with AUSPOST_PAC_KEY in your .env):
 *   npx tsx scripts/inspect-auspost-pac.ts
 *   npx tsx scripts/inspect-auspost-pac.ts "united states"        any other country, by name or code
 */
import 'dotenv/config';
import { configured, fromPostcode, resolveCountry, internationalServices, domesticServices, AusPostError } from '../src/lib/auspost';

async function main() {
  console.log(configured() ? `Key found. Sending from postcode ${fromPostcode()}.\n` : 'AUSPOST_PAC_KEY is not set in .env: nothing below will work.\n');
  const countryName = process.argv[2] ?? 'New Zealand';
  const c = await resolveCountry(countryName);
  console.log(`Country "${countryName}" -> ${c ? `${c.name} (${c.code})` : 'NOT FOUND in Australia Post\'s list'}`);
  if (c && c.code !== 'AU') for (const kg of [0.5, 2, 7.7, 15]) {
    try {
      const s = await internationalServices(c.code, kg);
      console.log(`\n${kg} kg to ${c.name}: ${s.length} services`);
      for (const x of s) console.log(`  ${x.code.padEnd(34)} ${x.name.padEnd(40)} $${x.price.toFixed(2)}`);
    } catch (e) { console.log(`\n${kg} kg to ${c.name}: ${e instanceof AusPostError ? e.message : e}`); }
  }
  try {
    const d = await domesticServices({ toPostcode: '2000', lengthCm: 60, widthCm: 40, heightCm: 10, weightKg: 5 });
    console.log(`\nWithin Australia, 60 x 40 x 10 cm and 5 kg to 2000: ${d.length} services`);
    for (const x of d) console.log(`  ${x.code.padEnd(34)} ${x.name.padEnd(40)} $${x.price.toFixed(2)}`);
  } catch (e) { console.log(`\nWithin Australia: ${e instanceof AusPostError ? e.message : e}`); }
}
main().catch(e => { console.error(e); process.exit(1); });