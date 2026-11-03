// Marketing and warranty orders, for the overall Sales report.
// They are billed to one miscellaneous account and sent all over the place, so they belong to no state. The overall Sales report (every state) now
// includes them: warranty orders carry real dollars (about $1,000 a month), marketing orders are $0 so only their number matters. The Ledger, the
// Summary sheet and the weekly tracker still leave them out: they never count as new or reactivated business, and never count toward performance.
export type MiscKind = 'marketing' | 'warranty';
export const MISC_KINDS: MiscKind[] = ['marketing', 'warranty'];
export type MiscTotals = Record<MiscKind, { orders: number; value: number }>;
type Row = { miscType?: string | null; number: string; amount: number; isCredit?: boolean };

// Rows are sales as Sales Data counts them (a tax invoice on its date, a credit note as a negative on its date). The value is their sum. The orders are
// the different orders among them; a credit note adds to the value but is not another order.
export function summariseMisc(rows: Row[]): MiscTotals {
  const value: Record<MiscKind, number> = { marketing: 0, warranty: 0 };
  const orders: Record<MiscKind, Set<string>> = { marketing: new Set(), warranty: new Set() };
  for (const r of rows) {
    const k = r.miscType;
    if (k !== 'marketing' && k !== 'warranty') continue;
    value[k] += r.amount;
    if (!r.isCredit) orders[k].add(r.number);
  }
  const cents = (n: number) => Math.round(n * 100) / 100;
  return { marketing: { orders: orders.marketing.size, value: cents(value.marketing) }, warranty: { orders: orders.warranty.size, value: cents(value.warranty) } };
}
