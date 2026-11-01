// A small in-memory cache for answers that are slow to work out and fine to be a little old.
//   - Asks that arrive together share ONE load (the same promise), so a burst of identical requests costs one.
//   - A fresh answer is kept for ttlMs, then loaded again.
//   - A load that fails is never kept.
//   - It holds at most `max` answers (the oldest go first), so it cannot grow without limit.
//   - ttlMs of 0 (or less) switches it off: every ask loads.
// Everyone who asks for the same key gets the SAME answer object, so callers must only read it.
export function ttlCache<T>(opts: { ttlMs: number; max?: number; now?: () => number }) {
  const now = opts.now ?? Date.now, max = Math.max(1, opts.max ?? 100);
  const store = new Map<string, { at: number; p: Promise<T> }>();
  return {
    get(key: string, load: () => Promise<T>): Promise<T> {
      if (!(opts.ttlMs > 0)) return Promise.resolve().then(load);
      const hit = store.get(key);
      if (hit && now() - hit.at < opts.ttlMs) return hit.p;
      store.delete(key);
      while (store.size >= max) store.delete(store.keys().next().value as string);
      const p = Promise.resolve().then(load);
      store.set(key, { at: now(), p });
      p.catch(() => { if (store.get(key)?.p === p) store.delete(key); });
      return p;
    },
    clear(key?: string) { if (key === undefined) store.clear(); else store.delete(key); },
    size: () => store.size,
  };
}
// A number of milliseconds from an environment setting, or the default when it is missing or not a number.
export const msFromEnv = (v: string | undefined, fallback: number): number => { const n = Number(v); return v !== undefined && v !== '' && Number.isFinite(n) ? n : fallback; };
