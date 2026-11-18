// Standalone credit notes as negative sales. A standalone credit note (crm.standalone_credit_notes, see standaloneCredits.ts) is on no order, so
// salesOf() in salesRules.ts never sees it. This turns each stored note into the same kind of row salesOf() gives for a credit note on an order:
// negative, goods ex GST (ex freight and card surcharge), on the credit note's own date. Reports add these rows to the ones salesOf() gives.
// Voided notes never count; a note with no shop (no account) is left out, as nobody's figures could show it.
import { prisma } from './prisma';

export type StoredCredit = { dear_sale_id: string; sale_number: string; credit_note_number: string; day: string; goods: number; account_id: string };

export type CreditSale = {
  id: string; accountId: string; number: string; source: string; paid: boolean; amount: number; sentAt: Date; invoiceDate: null; fulfillmentStatus: null;
  invoiceNumber: string; invoicePaid: true; isCredit: true;
};

// Always negative, whichever sign DEAR gave the goods.
export const creditSaleRows = (rows: StoredCredit[]): CreditSale[] => rows.map(r => ({
  id: `credit-${r.dear_sale_id}`, accountId: r.account_id, number: r.sale_number, source: 'dear', paid: true,
  amount: -Math.abs(Number(r.goods) || 0), sentAt: new Date(r.day), invoiceDate: null, fulfillmentStatus: null,
  invoiceNumber: r.credit_note_number, invoicePaid: true, isCredit: true,
}));

// Notes of these shops (the same ones salesOf() is run for).
export async function creditSalesFor(accountIds: string[]): Promise<CreditSale[]> {
  if (!accountIds.length) return [];
  const rows = await prisma.$queryRaw<StoredCredit[]>`
    select n.dear_sale_id, n.sale_number, n.credit_note_number, n.note_day::text as day, n.goods::float8 as goods, n.account_id::text as account_id
    from crm.standalone_credit_notes n
    where upper(coalesce(n.status, '')) <> 'VOIDED' and n.account_id = any(${accountIds}::text[]::uuid[])`;
  return creditSaleRows(rows);
}

// Notes of marketing/warranty shops: they count in the company-wide totals only, like marketing and warranty orders do. A manager's hidden shops stay out.
export async function creditSalesMisc(hidden: string[]): Promise<CreditSale[]> {
  const rows = await prisma.$queryRaw<StoredCredit[]>`
    select n.dear_sale_id, n.sale_number, n.credit_note_number, n.note_day::text as day, n.goods::float8 as goods, n.account_id::text as account_id
    from crm.standalone_credit_notes n join crm.accounts a on a.id = n.account_id
    where upper(coalesce(n.status, '')) <> 'VOIDED' and a.misc = true and not (n.account_id::text = any(${hidden}::text[]))`;
  return creditSaleRows(rows);
}
