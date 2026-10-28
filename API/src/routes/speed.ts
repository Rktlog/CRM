import { Router } from 'express';
import { promises as dnsp } from 'dns';
import net from 'net';
import { prisma } from '../lib/prisma';
import { slowestRoutes } from '../lib/timing';

// How fast is the API, and why? Started with the same secret as the other scheduled jobs (header x-sync-secret), from SQL:
//     select crm.call_api('/speed');
// then read the answer with:  select left(content::text, 4000) from net._http_response order by created desc limit 1;
// Add ?deep=1 (select crm.call_api('/speed?deep=1');) to also time the network to the database host below Prisma and the pooler: one DNS lookup,
// then four bare TCP connections, each followed by one Postgres SSLRequest round trip. That separates "the network is far" from "each query is
// paying for more than one trip", which the five Prisma queries below cannot tell apart.
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
  let network: unknown;
  if (req.query.deep === '1') {
    const d = describeDb();
    if (d) {
      let dnsMs: number | null = null;
      try { const t0 = process.hrtime.bigint(); await dnsp.lookup(d.host); dnsMs = r1(Number(process.hrtime.bigint() - t0) / 1e6); } catch { /* reported as null */ }
      const probes = [];
      for (let i = 0; i < 4; i++) probes.push(await probeOnce(d.host, Number(d.port)));
      const trips = probes.map(p => p.roundTripMs).filter((x): x is number => x !== null);
      const oneTrip = trips.length ? r1(median(trips)) : null;
      network = { dnsMs, tcpConnectMs: probes.map(p => p.connectMs), postgresRoundTripMs: probes.map(p => p.roundTripMs), replies: probes.map(p => p.reply), oneTripMs: oneTrip, verdict: networkVerdict(steady, oneTrip) };
    }
  }
  res.json({
    railwayRegion: process.env.RAILWAY_REPLICA_REGION ?? process.env.RAILWAY_REGION ?? null,
    database: describeDb(),
    databaseRoundTripMs: { first: pings[0], steadyMedian: steady, all: pings },
    verdict: dbVerdict(steady),
    ...(network ? { network } : {}),
    uptimeSeconds: Math.round(process.uptime()),
    memoryMb: Math.round(process.memoryUsage().rss / 1048576),
    slowestRoutes: slowestRoutes(12),
  });
});