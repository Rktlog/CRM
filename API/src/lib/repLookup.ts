import { ttlCache } from './ttlCache';

// Who is calling, looked up in the database once a minute per person instead of on every request.
// Every request used to pay a database trip (the database is far from the API) just to learn the caller's role, and a page fires many requests.
// Only a person who exists is remembered: someone who has just been added is let in straight away, never refused for a minute.
export type RepRow = { id: string; role: 'rep' | 'manager' };
export function makeRepLookup(fetchRep: (id: string) => Promise<RepRow | null>, ttlMs: number, now?: () => number) {
  const cache = ttlCache<RepRow | null>({ ttlMs, max: 500, now });
  return {
    async find(id: string): Promise<RepRow | null> {
      const r = await cache.get(id, () => fetchRep(id));
      if (!r) cache.clear(id);
      return r;
    },
    clear: (id?: string) => cache.clear(id),
  };
}
