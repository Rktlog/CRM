// Trade shows, part 2: the shapes the new pages use, and small helpers.
import type { CSSProperties } from 'react';
import type { FreightCfg, Offer } from './tsOffers';

export type Payment = { status: 'cancelled' | 'not_in_dear' | 'not_invoiced' | 'unpaid' | 'part' | 'paid'; label: string; paid: number | null; owing: number | null };
export type OrderPlus = {
  dearReference: string;
  offers: Offer[]; applied: { offerId: string; name: string; text: string }[]; prompts: { offerId: string; text: string }[]; payBy: string | null; payByOverdue: boolean;
  freightInfo: { regionType: string; largeItems: boolean; pantone: boolean; manual: boolean; note: string | null; state: string | null; cfg: FreightCfg; customRates: boolean };
  payment: Payment;
};
export type QueueRow = {
  id: string; number: string; kind: 'order' | 'quote'; customer: string; region: string; overseas: boolean; orderDate: string; total: number; exGst: number; rep: string | null; dearReference: string; stage: string; dear: string | null;
  payment: Payment; payBy: string | null; payByOverdue: boolean; emailedAt: string | null; emailError: string | null; daysWaiting: number;
  candidates: { id: string; number: string; reference: string | null; sentAt: string; total: number; status: string | null }[];
};
export type Queue = { toEnter: QueueRow[]; payments: QueueRow[]; summary: { orders: number; value: number; paidValue: number; paidPct: number | null; paid: number; unpaid: number; notInDear: number; overdue: number; owing: number } };
export type Appointment = {
  id: string; stockist: string; accountId: string | null; accountName: string | null; contact: string | null; state: string | null; dayText: string | null; timeText: string | null; who: string | null; comments: string | null;
  targetRange: string | null; reportRequest: string | null; reportLink: string | null; followUp: string | null; status: 'booked' | 'came' | 'no_show' | 'cancelled'; rep: string | null; orders: number; ordered: number;
};
export type ChecklistItem = { id: string; section: string; item: string; done: boolean; doneAt: string | null; doneBy: string | null; owner: { id: string; name: string } | null; note: string | null };
export type Feedback = { general: string; pros: string; cons: string; improvements: string; updatedAt: string | null; previous: { showId: string; showName: string; general: string | null; pros: string | null; cons: string | null; improvements: string | null } | null };
export type CompareDay = { n: number; day: string; sales: number; orders: number; newSales: number | null; newReturningSales: number | null; existingSales: number | null; newStockists: number | null; newOrders: number | null };
export type CompareShow = {
  id: string; name: string; year: number; startsOn: string; endsOn: string; history: boolean; days: CompareDay[]; bundles: { name: string; qty: number }[]; byState: { state: string; sales: number; orders: number }[];
  totals: { sales: number; orders: number; averageOrder: number | null; newSales: number | null; newReturningSales: number | null; existingSales: number | null; newPct: number | null; paidPct: number | null; newSignedUp: number | null; newOrders: number | null; conversion: number | null; cost: number; returnOnCost: number | null; target: number | null; toTarget: number | null };
  vsPrevious: { sales: number | null; orders: number | null; previousName: string | null };
};
export type Compare = { series: string[]; selected: string | null; shows: CompareShow[] };
export type OfferInput = Omit<Offer, 'id'>;
export type Proposal = {
  sheetsRead: string[]; offers: OfferInput[]; appointments: Omit<Appointment, 'id' | 'accountName' | 'rep' | 'orders' | 'ordered' | 'accountId'>[]; checklist: { section: string; item: string }[];
  feedback: { general: string; pros: string; cons: string; improvements: string } | null;
  oldShows: { name: string; series: string | null; startsOn: string; endsOn: string; days: Omit<CompareDay, 'n'>[]; bundles: { name: string; qty: number }[] }[]; notes: string[]; warnings: string[]; skippedRows: number;
};

export const sel: CSSProperties = { padding: '7px 10px', border: '1px solid var(--line)', borderRadius: 3, font: 'inherit', fontSize: 15 };
export const th: CSSProperties = { textAlign: 'left', fontSize: 13, color: 'var(--muted)', fontWeight: 500, padding: '8px 10px', borderBottom: '1px solid var(--line)', whiteSpace: 'nowrap' };
export const td: CSSProperties = { padding: '9px 10px', borderBottom: '1px solid var(--line)', fontSize: 14, verticalAlign: 'top' };
export const tdr: CSSProperties = { ...td, textAlign: 'right', whiteSpace: 'nowrap' };
export const tableBox: CSSProperties = { overflowX: 'auto', border: '1px solid var(--line)', borderRadius: 4, background: 'var(--panel)' };
export const PAY_TONE: Record<Payment['status'], string> = { cancelled: 'neutral', not_in_dear: 'amber', not_invoiced: 'amber', unpaid: 'rust', part: 'amber', paid: 'teal' };
export const pctText = (n: number | null | undefined) => (n === null || n === undefined ? '' : `${Math.round(n * 1000) / 10}%`);
export const signedPct = (n: number | null | undefined) => (n === null || n === undefined ? '' : `${n >= 0 ? '+' : ''}${Math.round(n * 1000) / 10}%`);
/** Reads a chosen file as base64 (for the Excel reader). */
export function fileToBase64(f: File): Promise<string> {
  return new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] ?? ''); r.onerror = () => no(new Error('That file could not be read.')); r.readAsDataURL(f); });
}
export const csvList = (v: string) => v.split(/[,\n]/).map(x => x.trim()).filter(Boolean);
