import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { syncPurchaseDates } from '../sync/syncPurchaseDates';
import { syncProductDetails } from '../sync/syncProductDetails';
import { syncCustomerDates } from '../sync/syncCustomers';
import { runFollowUpDrafts } from '../lib/followupDrafts';

// Jobs for Supabase's scheduler (pg_cron) to start by calling this API, so nothing extra has to be kept running anywhere:
//   POST /sync-cron/purchase-dates     the ETA: each purchase order's required-by date, from DEAR      (every 30 minutes)
//   POST /sync-cron/eol-check          EOL products with no stock for 24 hours become Discontinued      (every 30 minutes)
//   POST /sync-cron/product-details    product descriptions, order increments, EOL from the description (every 6 hours)
//   POST /sync-cron/customer-dates     DEAR's creation date for each customer                           (once a day)
//   POST /sync-cron/followup-drafts    payment reminder drafts in the sales mailbox on a first follow-up day (once a day, early morning)
// Sent with the header x-sync-secret (the SYNC_SECRET variable). The reply is immediate (202) and the job carries on in the
// background, so the scheduler never waits for it; add ?wait=1 to wait for the result (handy when testing with curl). A job
// that is still running is not started a second time.
type Job = { what: string; run: () => Promise<unknown> };

export const JOBS: Record<string, Job> = {
  'purchase-dates': { what: 'purchase order required-by dates', run: () => syncPurchaseDates() },
  'eol-check': {
    what: 'EOL products with no stock for 24 hours',
    run: async () => {
      const [r] = await prisma.$queryRaw<{ n: number }[]>`select crm.finish_eol_products() as n`;
      if (r?.n) console.log(`EOL check: ${r.n} product${r.n === 1 ? '' : 's'} moved to Discontinued.`);
      return { moved: r?.n ?? 0 };
    },
  },
  'product-details': { what: 'product descriptions, order increments and EOL from the description', run: () => syncProductDetails() },
  'customer-dates': { what: "DEAR's creation date for each customer", run: () => syncCustomerDates() },
  'followup-drafts': { what: 'payment reminder drafts on the first follow-up day', run: () => runFollowUpDrafts() },
};

export function createSyncCronRouter(jobs: Record<string, Job> = JOBS): Router {
  const router = Router();
  const running = new Set<string>();
  router.post('/:job', async (req, res) => {
    if (!process.env.SYNC_SECRET || req.headers['x-sync-secret'] !== process.env.SYNC_SECRET) return res.status(401).json({ error: 'Unauthorized' });
    const name = String(req.params.job), job = jobs[name];
    if (!job) return res.status(404).json({ error: `No such job. The jobs are: ${Object.keys(jobs).join(', ')}` });
    if (running.has(name)) return res.status(202).json({ job: name, started: false, running: true });
    running.add(name);
    const finished = (async () => { try { return await job.run(); } finally { running.delete(name); } })();
    if (req.query.wait === '1') {
      try { return res.json({ job: name, result: await finished }); }
      catch (e) { console.error(`Sync job ${name} failed:`, e); return res.status(500).json({ job: name, error: String((e as Error)?.message ?? e).slice(-300) }); }
    }
    finished.catch(e => console.error(`Sync job ${name} failed:`, e));   // the caller has gone: the log is where it is seen
    res.status(202).json({ job: name, started: true });
  });
  return router;
}

export const syncCronRouter = createSyncCronRouter();