import { Router } from 'express';
import { prisma } from '../lib/prisma';

// When each DEAR sync last recorded itself, for the Data sync panel on the Settings page (anyone signed in).
// Each of these runs every 30 minutes from Supabase's scheduler, and records the time when a run finishes, so a time older than a run or two
// means a run was missed or did not finish.
export const SYNCS = [
  { key: 'sales', label: 'Orders' },
  { key: 'stock', label: 'Stock levels' },
  { key: 'products', label: 'Products and prices' },
  { key: 'purchases', label: 'Purchase orders' },
  { key: 'customers', label: 'Customers' },
];
export const LATE_AFTER_MIN = 40;       // a run is missed once it is this long since the last (runs are 30 minutes apart)
export const STOPPED_AFTER_MIN = 120;   // several in a row

export const syncStatusRouter = Router();
syncStatusRouter.get('/', async (_req, res) => {
  try {
    // The age is worked out in the database: these times are stored without a time zone, as UTC.
    const rows = await prisma.$queryRaw<{ key: string; t: Date; minutes: number }[]>`
      select key, last_synced_at as t, round(extract(epoch from ((now() at time zone 'utc') - last_synced_at)) / 60)::int as minutes
      from crm.sync_state where key = any(${SYNCS.map(s => s.key)}::text[])`;
    const by = new Map(rows.map(r => [r.key, r]));
    res.json({
      lateAfterMinutes: LATE_AFTER_MIN, stoppedAfterMinutes: STOPPED_AFTER_MIN,
      items: SYNCS.map(s => {
        const r = by.get(s.key), minutes = r ? Math.max(r.minutes, 0) : null;
        return { key: s.key, label: s.label, lastSyncedAt: r ? new Date(r.t).toISOString() : null, minutesAgo: minutes,
          state: minutes === null ? 'none' : minutes > STOPPED_AFTER_MIN ? 'stopped' : minutes > LATE_AFTER_MIN ? 'late' : 'ok' };
      }),
    });
  } catch (e) { res.status(500).json({ error: String((e as Error)?.message ?? e).slice(0, 200) }); }
});