// Finds which DEAR product field holds the order increment. For the products whose description says "ORDER INCREMENT: n" we
// know the right answer, so every numeric-looking field is scored by how often it equals that answer, and by how many products
// have a value in it at all. Used by scripts/find-dear-increment-field.ts.
const SKIP = /^(ID|SKU|Name|Barcode|HSCode|CreatedDate|LastModifiedOn|AverageCost|QuantityToProduce|Price|Length|Width|Height|Weight|CartonHeight|CartonWidth|CartonLength|Cost)/i;

// A whole number from 1 to 99999, as a number or as text ("12", " 12 "). Nothing else.
export function wholeNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 1 && v <= 99999 ? v : null;
  if (typeof v === 'string' && /^\s*\d{1,5}\s*$/.test(v)) { const n = Number(v); return n >= 1 ? n : null; }
  return null;
}

// Every field of a product that holds a whole number: top level, and the first supplier or reorder level.
export function candidateValues(p: any): Record<string, number> {
  const out: Record<string, number> = {};
  if (!p || typeof p !== 'object') return out;
  for (const [k, v] of Object.entries(p)) { if (SKIP.test(k)) continue; const n = wholeNumber(v); if (n !== null) out[k] = n; }
  for (const list of ['Suppliers', 'ReorderLevels']) {
    const first = Array.isArray(p[list]) ? p[list][0] : null;
    if (first && typeof first === 'object') for (const [k, v] of Object.entries(first)) { if (SKIP.test(k)) continue; const n = wholeNumber(v); if (n !== null) out[`${list}[0].${k}`] = n; }
  }
  return out;
}

export type Candidate = { field: string; filled: number; compared: number; matches: number; common: { value: number; products: number }[] };

// wanted: sku -> the increment we know from the description. Best match first.
export function rankFields(products: any[], wanted: Map<string, number>): Candidate[] {
  const stats = new Map<string, { filled: number; compared: number; matches: number; values: Map<number, number> }>();
  for (const p of products) {
    const known = wanted.get(String(p?.SKU));
    for (const [field, n] of Object.entries(candidateValues(p))) {
      const s = stats.get(field) ?? { filled: 0, compared: 0, matches: 0, values: new Map<number, number>() };
      s.filled++; s.values.set(n, (s.values.get(n) ?? 0) + 1);
      if (known !== undefined) { s.compared++; if (n === known) s.matches++; }
      stats.set(field, s);
    }
  }
  return [...stats.entries()]
    .map(([field, s]) => ({ field, filled: s.filled, compared: s.compared, matches: s.matches, common: [...s.values.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([value, products]) => ({ value, products })) }))
    .sort((a, b) => b.matches - a.matches || b.filled - a.filled || a.field.localeCompare(b.field));
}