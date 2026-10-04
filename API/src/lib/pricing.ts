// DEAR price tier names are set per account (e.g. "Wholesale", "RRP"),
// so wholesale and retail are found by name rather than tier number.
export type Prices = Record<string, number>;

export function pickPrice(prices: Prices | null | undefined, pattern: RegExp): { tier: string; price: number } | null {
  const hit = Object.entries(prices ?? {}).find(([name]) => pattern.test(name));
  return hit ? { tier: hit[0], price: hit[1] } : null;
}

export const WHOLESALE = /^wholesale$/i;
export const RETAIL = /retail|rrp/i;

export const wholesalePrice = (p: Prices | null | undefined) => pickPrice(p, WHOLESALE)?.price ?? null;
export const retailPrice = (p: Prices | null | undefined) => pickPrice(p, RETAIL)?.price ?? null;