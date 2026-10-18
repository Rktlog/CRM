import { prisma } from './prisma';

// The ETA a rep can quote for a product: when the next delivery should arrive.
//   1. It is the "required by" date on the purchase order in DEAR: the earliest incoming order that is still to come.
//      The sync keeps that date up to date from DEAR.
//   2. If every outstanding order is past its date, the most recent one shows, marked late. (A purchase order's date always
//      wins over a date typed in.)
//   3. Only when no outstanding order has a date: a date someone set on the product (by hand or in the import), while it is
//      still useful: stock is on order, or the date has not passed yet.
//   4. Otherwise nothing, or "on order, no date" when stock is on order but no order has a date.
export type Eta = { date: string | null; source: 'manual' | 'po'; ref: string | null; qty: number; late: boolean };
export type IncomingPo = { number: string | null; expected: Date | string | null; outstanding: number };

const day = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : null);

export function chooseEta(manual: Date | string | null | undefined, onOrder: number, pos: IncomingPo[], today: string): Eta | null {
  const open = pos.filter(p => p.outstanding > 0);
  const qty = open.reduce((s, p) => s + p.outstanding, 0);
  const m = day(manual);
  const dated = open.filter(p => p.expected).map(p => ({ ...p, d: day(p.expected)! })).sort((a, b) => a.d.localeCompare(b.d));
  const upcoming = dated.find(p => p.d >= today);
  if (upcoming) return { date: upcoming.d, source: 'po', ref: upcoming.number, qty: upcoming.outstanding, late: false };
  const past = dated.length ? dated[dated.length - 1] : null;
  if (past) return { date: past.d, source: 'po', ref: past.number, qty: past.outstanding, late: true };
  if (m && (onOrder > 0 || m >= today)) return { date: m, source: 'manual', ref: null, qty: qty || onOrder, late: m < today };
  if (open.length) return { date: null, source: 'po', ref: open[0].number, qty, late: false };
  return null;
}

// Outstanding purchase order lines for these products (same rules as the product search: not voided, credited or
// draft, and not fully received).
export async function incomingFor(skus: string[]): Promise<Map<string, IncomingPo[]>> {
  const out = new Map<string, IncomingPo[]>();
  if (!skus.length) return out;
  const rows = await prisma.$queryRaw<{ sku: string; number: string | null; required_by: Date | null; outstanding: number }[]>`
    select l.sku, p.number, p.required_by,
           greatest(l.quantity_ordered - l.quantity_received, 0)::float8 as outstanding
    from crm.purchase_lines l join crm.purchases p on p.id = l.purchase_id
    where l.sku = any(${skus}::text[])
      and upper(coalesce(p.status, '')) not in ('VOIDED', 'CREDITED', 'DRAFT')
      and not (upper(coalesce(p.receiving_status, '')) like '%FULLY RECEIVED%'
               or upper(coalesce(p.status, '')) like 'COMPLETED%' or upper(coalesce(p.status, '')) = 'RECEIVED')
      and l.quantity_ordered - l.quantity_received > 0`;
  for (const r of rows) out.set(r.sku, [...(out.get(r.sku) ?? []), { number: r.number, expected: r.required_by, outstanding: r.outstanding }]);
  return out;
}