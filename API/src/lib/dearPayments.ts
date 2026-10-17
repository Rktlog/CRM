// What DEAR itself says about the money on one order: the prepayments taken, what has been applied to invoices,
// credit notes, and so what DEAR still holds against the order. Read from DEAR's own Sale record, not from the CRM's
// synced copy, so it is right even if a sync is behind.
//
//   held = prepaid in total - paid on invoices   (never below zero)
//
// The field names follow the Sale GET the sync already reads (Quote.Prepayments, Invoices, CreditNotes,
// CombinedPaymentStatus). Anything not found is left out, never guessed. `raw` carries the pieces as DEAR sent them.

export type DearPayments = {
  orderTotal: number | null;
  paymentStatus: string | null;
  prepayments: { date: string | null; reference: string | null; amount: number }[];
  prepaidTotal: number;
  invoices: { number: string | null; date: string | null; status: string | null; total: number; paid: number }[];
  paidOnInvoices: number;
  creditNotes: { number: string | null; status: string | null; total: number }[];
  held: number;
  raw: { prepayments: unknown[]; invoices: unknown[]; creditNotes: unknown[] };
};

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const text = (v: unknown) => (v == null || v === '' ? null : String(v));
const cents = (n: number) => Math.round(n * 100) / 100;
const dead = (status: unknown) => /^(VOID|DELET|CANCEL)/i.test(String(status ?? '').trim());
const day = (v: unknown) => { const t = text(v); return t ? t.slice(0, 10) : null; };

export function readDearPayments(d: any): DearPayments {
  // Prepayments sit on the order once it is one, otherwise on the quote. Take one list, never both (DEAR may copy them across).
  const rawPre = arr(d?.Order?.Prepayments).length ? arr(d.Order.Prepayments) : arr(d?.Quote?.Prepayments).length ? arr(d.Quote.Prepayments) : arr(d?.Prepayments);
  const prepayments = rawPre.filter(p => !dead(p?.Status)).map(p => ({
    date: day(p?.Date ?? p?.DatePaid ?? p?.PaidDate), reference: text(p?.Reference ?? p?.Number), amount: cents(num(p?.Amount ?? p?.Total ?? p?.Paid)),
  }));
  const rawInv = arr(d?.Invoices).length ? arr(d.Invoices) : d?.Invoice ? [d.Invoice] : [];
  const invoices = rawInv.filter(i => !dead(i?.Status)).map(i => ({
    number: text(i?.InvoiceNumber ?? i?.Number), date: day(i?.InvoiceDate), status: text(i?.Status), total: cents(num(i?.Total)), paid: cents(num(i?.Paid)),
  }));
  const rawCn = arr(d?.CreditNotes);
  const creditNotes = rawCn.filter(c => !dead(c?.Status)).map(c => ({ number: text(c?.CreditNoteNumber ?? c?.Number), status: text(c?.Status), total: cents(num(c?.Total)) }));

  const prepaidTotal = cents(prepayments.reduce((t, p) => t + p.amount, 0));
  const paidOnInvoices = cents(invoices.reduce((t, i) => t + i.paid, 0));
  const total = d?.Order?.Total ?? d?.Quote?.Total;
  const strip = (list: any[]) => list.map(({ Lines, ...rest }) => rest);   // the lines are long and not what we are looking for
  return {
    orderTotal: total == null ? null : cents(num(total)),
    paymentStatus: text(d?.CombinedPaymentStatus),
    prepayments, prepaidTotal, invoices, paidOnInvoices, creditNotes,
    held: cents(Math.max(0, prepaidTotal - paidOnInvoices)),
    raw: { prepayments: rawPre, invoices: strip(rawInv), creditNotes: strip(rawCn) },
  };
}