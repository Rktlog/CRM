// Finds standalone credit notes (a credit note with its own SQ number) among DEAR's sales, and works out which of them Radar does not have.
// Pure: no DEAR and no database in here, so it can be tested. scripts/find-standalone-credit-notes.ts feeds it.
export type DearSale = Record<string, any>;

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
// The fields that say what KIND of document a sale is (not how far along its payment or shipping is).
const OWN_KIND_KEYS = ['Status', 'OrderStatus', 'QuoteStatus', 'Type', 'SaleType', 'DocumentType'];
const AMOUNT_KEYS = ['InvoiceAmount', 'Total', 'OrderTotal', 'CreditNoteTotal', 'GrandTotal', 'TotalAmount'];
const DATE_KEYS = ['InvoiceDate', 'SaleOrderDate', 'OrderDate', 'Updated'];

// For every field with "status" in its name, how many sales have each value. Shows what DEAR calls things.
export function statusCounts(sales: DearSale[]): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const s of sales) for (const [k, v] of Object.entries(s)) {
    if (!/status/i.test(k) || typeof v !== 'string') continue;
    const bucket = (out[k] ??= {});
    const key = v.trim() || '(empty)';
    bucket[key] = (bucket[key] ?? 0) + 1;
  }
  return out;
}

export const amountOf = (s: DearSale): number | null => { for (const k of AMOUNT_KEYS) { const n = Number(s[k]); if (s[k] !== undefined && s[k] !== null && s[k] !== '' && Number.isFinite(n)) return n; } return null; };
export const dayOf = (s: DearSale): string | null => { for (const k of DATE_KEYS) { const v = text(s[k]); if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10); } return null; };

// Why a sale looks like a credit note, or null when it does not: its own kind or status says "credit", or it is a negative amount.
export function creditNoteReason(s: DearSale): string | null {
  for (const k of OWN_KIND_KEYS) { const v = text(s[k]); if (/credit/i.test(v)) return `${k} is "${v}"`; }
  const a = amountOf(s);
  if (a !== null && a < 0) return `the amount is negative (${a})`;
  return null;
}

export type Candidate = { number: string; day: string | null; customer: string; customerId: string | null; amount: number | null; reason: string; sale: DearSale };
export function candidates(sales: DearSale[]): Candidate[] {
  const out: Candidate[] = [];
  for (const s of sales) {
    const reason = creditNoteReason(s); if (!reason) continue;
    out.push({ number: text(s.OrderNumber) || text(s.SaleOrderNumber) || '(no number)', day: dayOf(s), customer: text(s.Customer), customerId: text(s.CustomerID) || null, amount: amountOf(s), reason, sale: s });
  }
  return out;
}

export type Located = Candidate & { inRadar: boolean; customerInRadar: boolean };
// radarNumbers: the order numbers Radar has. customerKnown: does Radar have a shop for this DEAR customer (by its DEAR id, or by name).
export function locate(cands: Candidate[], radarNumbers: Set<string>, customerKnown: (c: Candidate) => boolean): Located[] {
  return cands.map(c => ({ ...c, inRadar: radarNumbers.has(c.number), customerInRadar: customerKnown(c) }));
}

// The missing ones by month, to set beside the sales team's table (32 credit notes, -$9,895.89, for 2026).
export function missingByMonth(rows: Located[]): { month: string; count: number; total: number }[] {
  const m = new Map<string, { count: number; total: number }>();
  for (const r of rows) {
    if (r.inRadar) continue;
    const key = (r.day ?? 'no date').slice(0, 7);
    const e = m.get(key) ?? { count: 0, total: 0 }; e.count++; e.total += r.amount ?? 0; m.set(key, e);
  }
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, e]) => ({ month, count: e.count, total: Math.round(e.total * 100) / 100 }));
}
