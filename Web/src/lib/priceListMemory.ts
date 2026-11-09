// Remembers what a person last chose in the price list window, in their own browser (like the Ordering and Planner settings). Nothing goes to the server.
// - BRANDS are remembered per store: every store stocks different brands.
// - PRODUCTS (current range, new, rest) and AVAILABILITY are remembered across stores: they are the person's habit ("never the discontinued").
// - It is saved when the price list is downloaded, so it is what was actually sent. Cancelling remembers nothing.
// - A brand that did not exist when the choice was saved (or that the store has started buying since) follows the normal rule: ticked if the store stocks it.
// Everything read back is checked, so a damaged or old entry is ignored instead of breaking the window. If the browser will not store anything, it just is not remembered.

export type BrandOption = { brand: string; products: number; bought: boolean };
type StoreChoice = { selected: string[]; seen: string[]; at: number };
type Habit = { statuses: string[]; availability: string[] };
export type Remembered = { brands: { selected: string[]; seen: string[] } | null; statuses: string[] | null; availability: string[] | null };

const PREFIX = 'radar-pricelist-v1';
const MAX_STORES = 150;   // the most recent stores are kept; the oldest are forgotten

const storeKey = (userId: string) => `${PREFIX}:${userId}:stores`;
const habitKey = (userId: string) => `${PREFIX}:${userId}:habit`;
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string');

function load(key: string): unknown {
  try { const raw = window.localStorage.getItem(key); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function store(key: string, value: unknown) {
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage is off or full: it just is not remembered */ }
}

const only = (list: unknown, allowed: readonly string[]): string[] | null => {
  if (!isStrings(list)) return null;
  const kept = allowed.filter(k => list.includes(k));
  return kept.length ? kept : null;
};

/** What this person last chose: the brands for this store, and their products and availability habit. Anything missing or unusable comes back as null. */
export function readChoice(userId: string, accountId: string, allowed: { statuses: readonly string[]; availability: readonly string[] }): Remembered {
  if (!userId) return { brands: null, statuses: null, availability: null };
  const stores = load(storeKey(userId));
  const one = stores && typeof stores === 'object' ? (stores as Record<string, unknown>)[accountId] : null;
  const c = one as Partial<StoreChoice> | null;
  const brands = c && isStrings(c.selected) && isStrings(c.seen) && c.selected.length ? { selected: c.selected, seen: c.seen } : null;
  const h = load(habitKey(userId)) as Partial<Habit> | null;
  return { brands, statuses: only(h?.statuses, allowed.statuses), availability: only(h?.availability, allowed.availability) };
}

/** The brands to tick for this store: what was chosen before, but a brand that is new since follows the normal rule. Null if nothing usable is left. */
export function brandsFromMemory(options: BrandOption[], saved: { selected: string[]; seen: string[] }): Set<string> | null {
  const selected = new Set(saved.selected), seen = new Set(saved.seen);
  const out = new Set<string>();
  for (const b of options) if (seen.has(b.brand) ? selected.has(b.brand) : b.bought) out.add(b.brand);
  return out.size ? out : null;
}

/** Called when the price list has been downloaded. */
export function saveChoice(userId: string, accountId: string, choice: { selected: string[]; seen: string[]; statuses: string[]; availability: string[] }) {
  if (!userId || !choice.selected.length) return;
  const raw = load(storeKey(userId));
  const stores: Record<string, StoreChoice> = raw && typeof raw === 'object' ? { ...(raw as Record<string, StoreChoice>) } : {};
  stores[accountId] = { selected: choice.selected, seen: choice.seen, at: Date.now() };
  const ids = Object.keys(stores);
  if (ids.length > MAX_STORES) {
    ids.sort((a, b) => (stores[b]?.at ?? 0) - (stores[a]?.at ?? 0)).slice(MAX_STORES).forEach(id => { delete stores[id]; });
  }
  store(storeKey(userId), stores);
  store(habitKey(userId), { statuses: choice.statuses, availability: choice.availability } satisfies Habit);
}

/** "Back to the usual choice": forget this store's brands and the products and availability habit. */
export function forgetChoice(userId: string, accountId: string) {
  if (!userId) return;
  const raw = load(storeKey(userId));
  if (raw && typeof raw === 'object') {
    const stores = { ...(raw as Record<string, unknown>) };
    delete stores[accountId];
    if (Object.keys(stores).length) store(storeKey(userId), stores);
    else { try { window.localStorage.removeItem(storeKey(userId)); } catch { /* nothing to do */ } }   // nothing left: leave nothing behind
  }
  try { window.localStorage.removeItem(habitKey(userId)); } catch { /* nothing to do */ }
}
