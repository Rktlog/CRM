// What counts as a sale. The single definition behind Sales Data, the Dashboard and the rep Summary sheet (it used to live inside the
// reports routes). Moved here unchanged so every screen and download counts sales the same way.

// ---- What counts as a sale (Sales Data and the Dashboard) ----
// The sales team's definition: TAX INVOICE figures on the TAX INVOICE date.
//   - value: the invoice's product lines (already net of discount), ex GST,
//     ex freight and other charges (incl. the card surcharge)
//   - each invoice counts separately: a part-shipped order counts as each
//     tax invoice is issued, in that invoice's month
//   - credit notes are deducted, as negative sales on the credit note's date
//   - ship date is never used
// Drafts, quotes, voided and credited orders don't count. Spreadsheet history
// (before DEAR) keeps its own paid flag, date and amount.
// Customers' first/last order dates stay on the ORDER date (see firstOrderByAccount).
export const NOT_A_SALE = ['DRAFT', 'ESTIMATING', 'ESTIMATED', 'ORDERING', 'VOIDED', 'CREDITED'];
export const isHistoryOrder = (q: { source?: string | null; number: string }) => q.source === 'rhino-history' || q.number.startsWith('Q');
export type SaleSource = { source?: string | null; number: string; paid: boolean; amount: number; sentAt: Date;
  invoiceDate?: Date | null; fulfillmentStatus?: string | null; goodsTotal?: number | null; taxTotal?: number | null; invoices?: any; creditNotes?: any };
export type SaleRow<T> = T & { amount: number; sentAt: Date; invoiceNumber?: string; invoicePaid?: boolean; isCredit?: boolean };

export function asSales<T extends SaleSource>(q: T): SaleRow<T>[] {
  if (isHistoryOrder(q)) return q.paid ? [q] : [];
  const status = (q.fulfillmentStatus ?? '').toUpperCase();
  if (NOT_A_SALE.includes(status)) return [];
  const orderGoods = q.goodsTotal ?? q.amount - (q.taxTotal ?? 0);
  const invs = (Array.isArray(q.invoices) ? q.invoices : [])
    .filter((i: any) => i?.date && String(i.status ?? '').toUpperCase() !== 'VOIDED');
  // Credit notes: negative sales on the credit note's own date.
  const credits: SaleRow<T>[] = (Array.isArray(q.creditNotes) ? q.creditNotes : [])
    .filter((c: any) => c?.date && String(c.status ?? '').toUpperCase() !== 'VOIDED')
    .map((c: any) => ({
      ...q,
      amount: -(c.goods != null ? Number(c.goods)
        : Math.max(0, (Number(c.total) || 0) - (c.tax != null ? Number(c.tax) : (Number(c.total) || 0) / 11))),
      sentAt: new Date(c.date),
      invoiceNumber: c.number ? String(c.number) : undefined,
      isCredit: true,
    }));
  if (!invs.length) return [...(q.invoiceDate ? [{ ...q, amount: orderGoods, sentAt: q.invoiceDate } as SaleRow<T>] : []), ...credits];
  const invTotal = invs.reduce((s: number, i: any) => s + (Number(i.total) || 0), 0);
  const invoiceRows: SaleRow<T>[] = invs.map((i: any) => ({
    ...q,
    // The invoice's own goods (synced from DEAR). For an order not re-read
    // since, its share of the order's goods, in proportion to invoice totals.
    amount: i.goods != null ? Number(i.goods)
      : invTotal > 0 ? orderGoods * (Number(i.total) || 0) / invTotal
      : orderGoods / invs.length,
    sentAt: new Date(i.date),
    invoiceNumber: i.number ? String(i.number) : undefined,
    // paid in cash, or settled by a credit note
    invoicePaid: i.total != null && i.paid != null
      ? Number(i.paid) + Number(i.credited ?? 0) >= Number(i.total) - 0.005 : undefined,
  }));
  return [...invoiceRows, ...credits];
}
export const salesOf = <T extends SaleSource>(qs: T[]) => qs.flatMap(q => asSales(q));
// Product lines that are charges rather than goods (freight, card surcharge).
export const isChargeLine = (l: { sku?: string | null; productName?: string | null }) =>
  /surcharge|freight/i.test(`${l.sku ?? ''} ${l.productName ?? ''}`);