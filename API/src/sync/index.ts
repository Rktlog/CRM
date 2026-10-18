import 'dotenv/config';
import cron from 'node-cron';
import { syncCustomers } from './syncCustomers';
import { syncSales } from './syncSales';
import { syncProductDetails } from './syncProductDetails';
import { syncPurchaseDates } from './syncPurchaseDates';
import { prisma } from '../lib/prisma';

async function runSync() {
  const start = Date.now();
  console.log(`\n=== Cin7 sync started ${new Date().toISOString()} ===`);
  try {
    await syncCustomers();
    await syncSales();
    console.log(`=== Sync finished in ${((Date.now() - start) / 1000).toFixed(1)}s ===\n`);
  } catch (e) {
    console.error('Sync failed:', e);
  }
  // Separate steps: if one fails, the sales sync above and the other step are not affected.
  try { await syncPurchaseDates(); } catch (e) { console.error('Purchase dates failed:', e); }
  // EOL products that have had no stock for 24 hours and that nothing has updated since (see product-stages.sql).
  try {
    const [r] = await prisma.$queryRaw<{ n: number }[]>`select crm.finish_eol_products() as n`;
    if (r?.n) console.log(`EOL products with no stock for 24 hours: ${r.n} moved to Discontinued.`);
  } catch (e) { console.error('EOL check failed:', e); }
}

// Product descriptions barely change, so this runs every 6 hours and once at the start, not every 30 minutes.
async function runProductDetails() {
  try { await syncProductDetails(); } catch (e) { console.error('Product details failed:', e); }
}

const runOnce = process.argv.includes('--once');

if (runOnce) {
  runSync().then(runProductDetails).then(() => process.exit(0));
} else {
  // Every 30 minutes. Adjust the schedule if this ends up spending
  // more of DEAR's rate limit than the team actually needs.
  cron.schedule('*/30 * * * *', runSync);
  cron.schedule('23 */6 * * *', runProductDetails);
  console.log('Sync worker started — running every 30 minutes. Ctrl+C to stop.');
  runSync().then(runProductDetails); // also run once immediately on startup
}