import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { slowestRoutes } from '../lib/timing';

// How fast is the API, and why? Started with the same secret as the other scheduled jobs (header x-sync-secret), from SQL:
//     select crm.call_api('/speed');
// then read the answer with:  select left(content::text, 4000) from net._http_response order by created desc limit 1;
// It times five round trips from the API to the database (the cost every request pays, several times over), says where the API
// and the database are, and lists the routes that have been slowest since the API last started.
export function dbVerdict(ms: number | null): string {
  if (ms === null) return 'Could not reach the database.';
  if (ms <= 12) return 'Same region as the database: ideal.';
  if (ms <= 45) return 'Close to the database: good.';
  if (ms <= 110) return 'A different region from the database. Every database trip costs this much and a request makes several: moving Railway to the region closest to the database is the biggest single speed-up available.';
  return 'Far from the database (probably another continent). Every request pays this for each of its database trips: move Railway to the region closest to the database.';
}

export function describeDb(url: string | undefined = process.env.DATABASE_URL) {
  try {
    const u = new URL(String(url));   // the host and port only: never the user or the password
    return { host: u.hostname, port: u.port || '5432', pooled: /pooler|pgbouncer/i.test(u.hostname + u.search) || u.port === '6543' };
  } catch { return null; }
}

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r1 = (v: number) => Math.round(v * 10) / 10;

export const speedRouter = Router();
speedRouter.all('/', async (req, res) => {
  if (!process.env.SYNC_SECRET || req.headers['x-sync-secret'] !== process.env.SYNC_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const pings: number[] = [];
  try {
    for (let i = 0; i < 5; i++) { const t0 = process.hrtime.bigint(); await prisma.$queryRaw`select 1`; pings.push(r1(Number(process.hrtime.bigint() - t0) / 1e6)); }
  } catch (e) {
    return res.status(500).json({ error: `Could not reach the database: ${String((e as Error)?.message ?? e).slice(-200)}`, verdict: dbVerdict(null) });
  }
  const steady = r1(median(pings.slice(1)));   // the first one may include opening the connection
  res.json({
    railwayRegion: process.env.RAILWAY_REPLICA_REGION ?? process.env.RAILWAY_REGION ?? null,
    database: describeDb(),
    databaseRoundTripMs: { first: pings[0], steadyMedian: steady, all: pings },
    verdict: dbVerdict(steady),
    uptimeSeconds: Math.round(process.uptime()),
    memoryMb: Math.round(process.memoryUsage().rss / 1048576),
    slowestRoutes: slowestRoutes(12),
  });
});