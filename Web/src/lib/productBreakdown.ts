import type { Quote, ProductLine, ProductYearRow } from './types';

// The "Products purchased" list on the account page for the year picked ('all', or a year such as '2026'), biggest total first.
//  - From the answer's productsByYear when it has one (the lean answer: the database added up every product for each year, so the page is not sent
//    every line of every order).
//  - Otherwise worked out from the lines of every order (the full answer, which is what an older API sends).
// Either way a product's name and brand are those of its most recent order that has them.
export function productBreakdownFor(account: { quotes: Quote[]; productsByYear?: ProductYearRow[] }, year: string): ProductLine[] {
  const bySku = new Map<string, ProductLine & { latest: number }>();
  const add = (sku: string, productName: string, brand: string | null, quantity: number, total: number, when: number) => {
    const e = bySku.get(sku);
    if (!e) { bySku.set(sku, { sku, productName, brand, quantity, total, latest: when }); return; }
    e.quantity += quantity; e.total += total;
    if (when >= e.latest) { e.latest = when; e.productName = productName; e.brand = brand ?? e.brand; }
  };

  if (account.productsByYear) {
    for (const r of account.productsByYear) {
      if (year !== 'all' && r.year !== Number(year)) continue;
      add(r.sku, r.productName, r.brand, r.quantity, r.total, r.year);
    }
  } else {
    const quotes = year === 'all' ? account.quotes : account.quotes.filter(q => new Date(q.sentAt).getFullYear() === Number(year));
    for (const q of quotes) for (const l of q.lines ?? []) add(l.sku, l.productName, l.brand, l.quantity, l.lineTotal, new Date(q.sentAt).getTime());
  }
  return [...bySku.values()]
    .map(({ latest, ...p }) => p)
    .sort((a, b) => Math.round(b.total * 100) - Math.round(a.total * 100) || a.sku.localeCompare(b.sku));   // by the total as shown (to the cent); equal totals by SKU, so the order is steady and adding the same numbers in a different order cannot reorder it
}