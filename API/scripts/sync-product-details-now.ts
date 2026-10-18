/**
 * Runs just the two new sync steps once, without the customer and sales sync: purchase order required-by dates (the ETA)
 * and product descriptions (and the move to EOL when a description says end of line).
 *
 * Usage (from the API folder):
 *   npx tsx scripts/sync-product-details-now.ts --preview    shows what WOULD change, changes nothing. Do this first.
 *   npx tsx scripts/sync-product-details-now.ts              does it
 *   add --catch-up-eol to either to also move every product whose description ALREADY says end of line to EOL. The normal
 *   sync only moves a product when its description begins to say it, so run this once for descriptions saved earlier.
 *
 * It uses the database in your .env (DATABASE_URL) and the DEAR keys (CIN7_ACCOUNT_ID, CIN7_APPLICATION_KEY).
 */
import 'dotenv/config';
import { syncProductDetails } from '../src/sync/syncProductDetails';
import { syncPurchaseDates, fetchPurchasesUpdatedSince } from '../src/sync/syncPurchaseDates';

async function main() {
  const dryRun = process.argv.includes('--preview'), catchUpEol = process.argv.includes('--catch-up-eol');
  console.log(dryRun ? 'PREVIEW: nothing will be changed.\n' : 'Running for real.\n');
  const dates = await syncPurchaseDates(new Date(), fetchPurchasesUpdatedSince, { dryRun });
  const details = await syncProductDetails(undefined, { dryRun, catchUpEol });
  if (details.skipped) console.log(`\nProduct details skipped: ${details.skipped}`);
  if (dates.skipped) console.log(`Purchase dates skipped: ${dates.skipped}`);
  if (dryRun && details.examples?.length) {
    console.log(`\nProducts that would move to EOL (first ${details.examples.length} of ${details.markedEol}):`);
    for (const e of details.examples) console.log(`  ${e.sku}   from: ${e.from ?? '(no stage)'}`);
    console.log('\nBy the stage they are in now:');
    for (const [stage, n] of Object.entries(details.fromStages ?? {}).sort((a, b) => b[1] - a[1])) console.log(`  ${stage}: ${n}`);
  }
  if (dryRun) console.log('\nIf that looks right, run it again without --preview.');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });