// Tests the two small helpers behind the speed changes: the short-lived answer cache and the "who is calling" lookup. No database, no internet.
// Run:  npx tsx scripts/test-speed-helpers.ts
import { msFromEnv, ttlCache } from '../src/lib/ttlCache';
import { makeRepLookup, type RepRow } from '../src/lib/repLookup';

let pass = 0, fail = 0;
const ok = (n: string, c: unknown, x = '') => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (x ? '  ' + x : '')); } };
const eq = (n: string, got: unknown, want: unknown) => ok(n, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} wanted ${JSON.stringify(want)}`);
const clock = () => { let t = 1_000_000; return { now: () => t, tick: (ms: number) => { t += ms; } }; };
const rejects = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return String((e as Error).message); } };

async function main() {
  console.log('--- the answer cache');
  let c = clock(), loads = 0; let cache = ttlCache<any>({ ttlMs: 1000, now: c.now });
  const load = async () => ({ n: ++loads });
  const a = await cache.get('k', load), b = await cache.get('k', load);
  eq('a second ask inside the time costs no new load', [loads, a.n, b.n], [1, 1, 1]);
  ok('both get the very same answer', a === b);
  c.tick(999); await cache.get('k', load); eq('still kept at 999 ms', loads, 1);
  c.tick(2); const d = await cache.get('k', load); eq('loaded again once the time is up', [loads, d.n], [2, 2]);
  await cache.get('other', load); eq('a different key is its own answer', loads, 3);

  loads = 0; cache = ttlCache<any>({ ttlMs: 1000, now: c.now });
  const slow = () => new Promise<{ n: number }>(r => setTimeout(() => r({ n: ++loads }), 20));
  const [x, y, z] = await Promise.all([cache.get('k', slow), cache.get('k', slow), cache.get('k', slow)]);
  eq('three asks at the same moment share ONE load', [loads, x.n, y.n, z.n], [1, 1, 1, 1]);

  cache = ttlCache<any>({ ttlMs: 1000, now: c.now }); let tries = 0;
  const flaky = async () => { tries++; if (tries === 1) throw new Error('database down'); return 7; };
  eq('a failed load reaches the caller', await rejects(cache.get('k', flaky)), 'database down');
  eq('and is never kept: the next ask tries again and works', [await cache.get('k', flaky), tries], [7, 2]);
  cache = ttlCache<any>({ ttlMs: 1000, now: c.now });
  eq('a load that throws at once is handled the same way', await rejects(cache.get('k', (() => { throw new Error('sync boom'); }) as () => Promise<number>)), 'sync boom');
  eq('and not kept either', cache.size(), 0);

  cache = ttlCache<any>({ ttlMs: 1000, max: 2, now: c.now });
  await cache.get('a', async () => 1); await cache.get('b', async () => 2); await cache.get('c', async () => 3);
  eq('it never holds more than its limit', cache.size(), 2);
  let reloaded = 0; await cache.get('a', async () => { reloaded++; return 1; });
  eq('the oldest answer was the one dropped', reloaded, 1);

  let off = 0; cache = ttlCache<any>({ ttlMs: 0, now: c.now });
  await cache.get('k', async () => ++off); await cache.get('k', async () => ++off);
  eq('a time of 0 switches the cache off', off, 2);
  cache = ttlCache<any>({ ttlMs: 1000, now: c.now }); let cl = 0;
  await cache.get('k', async () => ++cl); cache.clear('k'); await cache.get('k', async () => ++cl);
  eq('clear(key) forgets one answer', cl, 2);
  await cache.get('p', async () => 1); cache.clear(); eq('clear() forgets everything', cache.size(), 0);
  eq('settings from the environment: missing, empty, junk and real', [msFromEnv(undefined, 60), msFromEnv('', 60), msFromEnv('abc', 60), msFromEnv('0', 60), msFromEnv('2500', 60)], [60, 60, 60, 0, 2500]);

  console.log('--- who is calling');
  c = clock(); let trips = 0; let people: Record<string, RepRow> = { u1: { id: 'u1', role: 'rep' }, u2: { id: 'u2', role: 'manager' } };
  let lookup = makeRepLookup(async id => { trips++; return people[id] ?? null; }, 60_000, c.now);
  eq('the first request looks the person up', [(await lookup.find('u1'))?.role, trips], ['rep', 1]);
  for (let i = 0; i < 9; i++) await lookup.find('u1');
  eq('the next nine requests cost no database trip at all', trips, 1);
  eq('another person is looked up separately', [(await lookup.find('u2'))?.role, trips], ['manager', 2]);
  people = { ...people, u1: { id: 'u1', role: 'manager' } };
  eq('a role changed in the database is not seen at once...', (await lookup.find('u1'))?.role, 'rep');
  c.tick(60_001); eq('...but is seen after a minute', (await lookup.find('u1'))?.role, 'manager');
  people = { ...people, u1: { id: 'u1', role: 'rep' } }; lookup.clear('u1');
  eq('clearing a person makes the change show straight away', (await lookup.find('u1'))?.role, 'rep');

  trips = 0; people = {};
  eq('someone who does not exist is refused (null)', await lookup.find('new1'), null);
  await lookup.find('new1'); eq('and the refusal is NOT remembered (two asks, two trips)', trips, 2);
  people = { new1: { id: 'new1', role: 'rep' } };
  eq('so a person added a second ago is let in at once', (await lookup.find('new1'))?.role, 'rep');

  trips = 0; lookup = makeRepLookup(async id => { trips++; await new Promise(r => setTimeout(r, 20)); return { id, role: 'rep' }; }, 60_000, c.now);
  await Promise.all(Array.from({ length: 12 }, () => lookup.find('u9')));
  eq('twelve requests at the same moment cost ONE trip', trips, 1);
  let boom = 0; lookup = makeRepLookup(async () => { boom++; if (boom === 1) throw new Error('db down'); return { id: 'u1', role: 'rep' }; }, 60_000, c.now);
  eq('a database error reaches the caller', await rejects(lookup.find('u1')), 'db down');
  eq('and is not remembered', [(await lookup.find('u1'))?.role, boom], ['rep', 2]);
  trips = 0; lookup = makeRepLookup(async id => { trips++; return { id, role: 'rep' }; }, 0, c.now);
  await lookup.find('u1'); await lookup.find('u1'); eq('with the time set to 0 every request looks up (the old behaviour)', trips, 2);

  console.log(`\npassed: ${pass}   failed: ${fail}`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
