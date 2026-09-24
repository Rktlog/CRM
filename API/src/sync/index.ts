import 'dotenv/config';
import cron from 'node-cron';
import { syncCustomers } from './syncCustomers';
import { syncSales } from './syncSales';

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
}

const runOnce = process.argv.includes('--once');

if (runOnce) {
  runSync().then(() => process.exit(0));
} else {
  // Every 30 minutes. Adjust the schedule if this ends up spending
  // more of DEAR's rate limit than the team actually needs.
  cron.schedule('*/30 * * * *', runSync);
  console.log('Sync worker started — running every 30 minutes. Ctrl+C to stop.');
  runSync(); // also run once immediately on startup
}
