import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { promises as dnsp } from 'dns';
import net from 'net';
import { prisma } from '../lib/prisma';
import { slowestRoutes, slowestSteps } from '../lib/timing';

// How fast is the API, and why? Started with the same secret as the other scheduled jobs (header x-sync-secret), from SQL:
//     select crm.call_api('/speed');
// then read the answer with:  select id, created, status_code, timed_out, left(content::text, 4000) as content from net._http_response order by created desc limit 8;
// (crm.call_api gives the API only 10 seconds to answer, and with a far-away database even a few queries take that long, so anything slow runs in the
// background: start it, wait a minute, fetch it.)
//
//   /speed                 three quick round trips to the database, where the API and the database are, and the slowest routes since the last restart.
//   /speed?full=1          starts the full test in the background and answers at once. It times the network to the database host below Prisma, five
//                          queries in a row and five started together (do the database connections run together?), and the same queries through
//                          DIRECT_URL (would changing DATABASE_URL help?).
//   /speed?full=result     the answer, once it has finished (about a minute). Say "running": true until then.
export function dbVerdict(ms: number | null): string {
  if (ms === null) return 'Could not reach the database.';
  if (ms <= 12) return 'Same region as the database: ideal.';
  if (ms <= 45) return 'Close to the database: good.';
  if (ms <= 110) return 'A different region from the database. Every database trip costs this much and a request makes several: moving Railway to the region closest to the database is the biggest single speed-up available.';
  return 'Far from the database (probably another continent). Every request pays this for each of its database trips: move Railway to the region closest to the database.';
}

// The settings after the "?" that matter for speed and carry no secret. Everything else (and the user and password) is never shown.
const SAFE_OPTIONS = ['pgbouncer', 'connection_limit', 'pool_timeout', 'connect_timeout', 'sslmode', 'statement_cache_size', 'max_idle_connection_lifetime', 'schema'];
export function describeDb(url: string | undefined = process.env.DATABASE_URL) {
  try {
    const u = new URL(String(url));   // the host, port and the safe settings only: never the user or the password
    const options: Record<string, string> = {};
    for (const k of SAFE_OPTIONS) { const v = u.searchParams.get(k); if (v !== null) options[k] = v; }
    return { host: u.hostname, port: u.port || '5432', pooled: /pooler|pgbouncer/i.test(u.hostname + u.search) || u.port === '6543', options };
  } catch { return null; }
}

/** Time a client the same way the main one is timed: five queries in a row, then five started together (the first burst is a warm-up). */
async function measureClient(client: { $queryRaw: (...a: any[]) => Promise<unknown> }) {
  const pings: number[] = [];
  for (let i = 0; i < 5; i++) { const t0 = process.hrtime.bigint(); await (client as any).$queryRaw`select 1`; pings.push(Math.round(Number(process.hrtime.bigint() - t0) / 1e5) / 10); }
  const burst = async () => { const t0 = process.hrtime.bigint(); await Promise.all([0, 1, 2, 3, 4].map(() => (client as any).$queryRaw`select 1`)); return Math.round(Number(process.hrtime.bigint() - t0) / 1e5) / 10; };
  await burst();
  const sorted = [...pings.slice(1)].sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  return { steadyMedianMs: sorted.length % 2 ? sorted[m] : Math.round(((sorted[m - 1] + sorted[m]) / 2) * 10) / 10, fiveAtOnceMs: await burst() };
}

/** Compare the live DATABASE_URL with the same host reached the other way (DIRECT_URL). */
export function alternativeVerdict(currentMs: number, altMs: number): string {
  const x = Math.round((currentMs / Math.max(altMs, 1)) * 10) / 10;
  if (altMs <= currentMs * 0.6) return `Through DIRECT_URL a query takes ${altMs} ms against ${currentMs} ms through DATABASE_URL: about ${x} times faster. Point DATABASE_URL at that address (port 5432, no pgbouncer=true, with connection_limit=10) and every page gets that much quicker.`;
  if (altMs >= currentMs * 1.3) return `Through DIRECT_URL a query takes ${altMs} ms against ${currentMs} ms through DATABASE_URL: slower, so keep DATABASE_URL as it is.`;
  return `Through DIRECT_URL a query takes ${altMs} ms against ${currentMs} ms through DATABASE_URL: about the same, so the connection style is not the cause. The distance to the database is: the API has to move closer.`;
}

/** One bare connection to the database host: how long the TCP connect took, and how long one Postgres SSLRequest question and answer took (one real round trip). */
export function probeOnce(host: string, port: number, timeoutMs = 8000): Promise<{ connectMs: number | null; roundTripMs: number | null; reply: string | null }> {
  return new Promise(resolve => {
    const t0 = process.hrtime.bigint();
    const since = () => Number(process.hrtime.bigint() - t0) / 1e6;
    let connectMs: number | null = null, sentAt = 0, finished = false;
    const sock = net.connect({ host, port });
    const done = (roundTripMs: number | null, reply: string | null) => {
      if (finished) return;
      finished = true; sock.destroy();
      resolve({ connectMs: connectMs === null ? null : r1(connectMs), roundTripMs: roundTripMs === null ? null : r1(roundTripMs), reply });
    };
    sock.setTimeout(timeoutMs, () => done(null, 'timed out'));
    sock.once('error', e => done(null, String(e.message).slice(0, 120)));
    sock.once('connect', () => { connectMs = since(); sentAt = since(); sock.write(Buffer.from([0, 0, 0, 8, 4, 210, 22, 47])); });   // Postgres SSLRequest: 8 bytes, code 80877103
    sock.once('data', d => done(since() - sentAt, d.toString('latin1', 0, 1)));   // 'S' = "yes, start TLS"
  });
}

/** What the two measurements mean together: queryMs is Prisma's steady `select 1`, tripMs one bare network round trip. */
export function networkVerdict(queryMs: number, tripMs: number | null): string {
  if (tripMs === null) return 'Could not measure the network to the database host directly from the API.';
  if (tripMs >= 150) return `The network itself is slow: one trip to the database takes ${tripMs} ms. The API has to run closer to the database, in the same city if possible.`;
  const ratio = queryMs / Math.max(tripMs, 1);
  if (ratio >= 3) return `The network is fine (${tripMs} ms a trip) but one query takes ${queryMs} ms, about ${Math.round(ratio)} trips' worth. Each query is paying for more than the network: usually a new database connection every time, or the pooler. Check the settings on DATABASE_URL (connection_limit, pgbouncer) and try the session pooler on port 5432.`;
  return `The network and the queries agree: about ${tripMs} ms a trip. The gain now is fewer database trips per page, or running the API in the same region as the database.`;
}

/** Five queries started together, against one: tells whether the database connections run together or one at a time. */
export function parallelVerdict(oneMs: number, fiveMs: number): string {
  const ratio = fiveMs / Math.max(oneMs, 1);
  if (ratio >= 3.5) return `Five queries at once took ${fiveMs} ms, ${Math.round(ratio * 10) / 10} times one query (${oneMs} ms): the database connections are being used one at a time, so a page's queries queue up. Raise connection_limit on DATABASE_URL (for example connection_limit=10) so they can run together.`;
  if (ratio <= 1.8) return `Five queries at once took ${fiveMs} ms against ${oneMs} ms for one: they run together, so a page's queries do not queue behind each other.`;
  return `Five queries at once took ${fiveMs} ms against ${oneMs} ms for one: only partly together, so the pool is small. Raise connection_limit on DATABASE_URL a little (for example connection_limit=10).`;
}

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r1 = (v: number) => Math.round(v * 10) / 10;

// The comparison with DIRECT_URL is slow (a new connection, then ten more queries), too slow to wait for in one call: the database's HTTP helper gives up
// first and stores an empty reply. So it runs in the background: ?alt=1 starts it and answers at once, ?alt=result fetches the answer a minute later.
// ---- the full test, in the background ----
const job: { running: boolean; startedAt: number | null; finishedAt: number | null; result: unknown } = { running: false, startedAt: null, finishedAt: null, result: null };

async function runFull() {
  const d = describeDb();
  const out: Record<string, unknown> = { database: d };
  const current = await measureClient(prisma);   // five in a row, then five together (the first burst is a warm-up)
  out.query = current;
  if (d) {
    let dnsMs: number | null = null;
    try { const t0 = process.hrtime.bigint(); await dnsp.lookup(d.host); dnsMs = r1(Number(process.hrtime.bigint() - t0) / 1e6); } catch { /* reported as null */ }
    const probes = [];
    for (let i = 0; i < 4; i++) probes.push(await probeOnce(d.host, Number(d.port)));
    const trips = probes.map(p => p.roundTripMs).filter((x): x is number => x !== null);
    const oneTrip = trips.length ? r1(median(trips)) : null;
    out.network = { dnsMs, tcpConnectMs: probes.map(p => p.connectMs), postgresRoundTripMs: probes.map(p => p.roundTripMs), oneTripMs: oneTrip, verdict: networkVerdict(current.steadyMedianMs, oneTrip) };
  }
  out.parallel = { oneQueryMs: current.steadyMedianMs, fiveAtOnceMs: current.fiveAtOnceMs, verdict: parallelVerdict(current.steadyMedianMs, current.fiveAtOnceMs) };

  // The same host reached through DIRECT_URL (the session pooler when it is port 5432), in a throw-away client with a pool of 5.
  const direct = process.env.DIRECT_URL;
  if (direct && direct !== process.env.DATABASE_URL) {
    let alt: PrismaClient | null = null;
    try {
      alt = new PrismaClient({ datasources: { db: { url: `${direct}${direct.includes('?') ? '&' : '?'}connection_limit=5` } } });
      const other = await measureClient(alt);
      out.directUrl = { what: 'DIRECT_URL, tried with a pool of 5', database: describeDb(direct), ...other, verdict: alternativeVerdict(current.steadyMedianMs, other.steadyMedianMs) };
    } catch (e) {
      out.directUrl = { database: describeDb(direct), error: String((e as Error)?.message ?? e).replace(/postgres(ql)?:\/\/\S+/gi, '[url]').slice(0, 200) };
    } finally { try { await alt?.$disconnect(); } catch { /* nothing to do */ } }
  }
  return out;
}

export const speedRouter = Router();
speedRouter.all('/', async (req, res) => {
  if (!process.env.SYNC_SECRET || req.headers['x-sync-secret'] !== process.env.SYNC_SECRET) return res.status(401).json({ error: 'Unauthorized' });

  const full = req.query.full ?? req.query.deep ?? req.query.alt;   // ?deep=1 and ?alt=1 are older names for the same thing
  if (full === '1') {
    if (!job.running) {
      Object.assign(job, { running: true, startedAt: Date.now(), finishedAt: null, result: null });
      runFull().then(r => { job.result = r; }, e => { job.result = { error: String((e as Error)?.message ?? e).replace(/postgres(ql)?:\/\/\S+/gi, '[url]').slice(0, 200) }; })
        .finally(() => { job.running = false; job.finishedAt = Date.now(); });
    }
    return res.json({ started: true, running: job.running, next: 'Wait about a minute, then call /speed?full=result' });
  }
  if (full === 'result') {
    return res.json({ running: job.running, startedSecondsAgo: job.startedAt ? Math.round((Date.now() - job.startedAt) / 1000) : null, result: job.result });
  }

  // The plain call: three quick round trips, small enough to come back inside the 10 seconds crm.call_api allows even when each one is slow.
  const pings: number[] = [];
  try {
    for (let i = 0; i < 3; i++) { const t0 = process.hrtime.bigint(); await prisma.$queryRaw`select 1`; pings.push(r1(Number(process.hrtime.bigint() - t0) / 1e6)); }
  } catch (e) {
    return res.status(500).json({ error: `Could not reach the database: ${String((e as Error)?.message ?? e).slice(-200)}`, verdict: dbVerdict(null) });
  }
  const steady = r1(median(pings.slice(1)));   // the first one may include opening the connection
  res.json({
    railwayRegion: process.env.RAILWAY_REPLICA_REGION ?? process.env.RAILWAY_REGION ?? null,
    database: describeDb(),
    databaseRoundTripMs: { first: pings[0], steadyMedian: steady, all: pings },
    verdict: dbVerdict(steady),
    // Which code is running: the commit Railway built it from, so "is my change live?" does not need the Railway dashboard.
    deployed: {
      commit: process.env.RAILWAY_GIT_COMMIT_SHA ? process.env.RAILWAY_GIT_COMMIT_SHA.slice(0, 7) : null,
      message: process.env.RAILWAY_GIT_COMMIT_MESSAGE ? process.env.RAILWAY_GIT_COMMIT_MESSAGE.split('\n')[0].slice(0, 100) : null,
      branch: process.env.RAILWAY_GIT_BRANCH ?? null,
    },
    uptimeSeconds: Math.round(process.uptime()),
    memoryMb: Math.round(process.memoryUsage().rss / 1048576),
    slowestRoutes: slowestRoutes(12),
    slowestSteps: slowestSteps(14),   // the stages inside the slow routes (see lib/timing.ts, stopwatch)
    more: 'For the network test and the DIRECT_URL comparison: /speed?full=1, then a minute later /speed?full=result',
  });
});