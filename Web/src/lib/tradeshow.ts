// Trade shows: the shapes the pages use, and small helpers.
export type Show = { id: string; name: string; refName: string; startsOn: string; endsOn: string; venue: string | null; stand: string | null; staff: string | null; notes: string | null; target: number | null;
  costs: { stand: number | null; travel: number | null; samples: number | null; other: number | null }; cardSurchargePct: number | null; archived: boolean; orders?: number; quotes?: number; leads?: number };
export type Customer = { id: string; name: string; region: string; contact: string | null; email: string | null; phone: string | null; address: string | null; terms: string | null; archived: boolean };
export type Incoming = { qty: number; date: string | null; po: string | null } | null;
export type Product = { sku: string; name: string; brand: string | null; price: number | null; increment: number | null; image: string | null; status: string | null; available: number; pending: number; free: number; incoming: Incoming; eta: string | null };
export type Stock = { available: number; pending: number; free: number; canShip: number; backorder: number; incoming: Incoming; eta: string | null; note: string };
export type Totals = { goods: number; linePct: number; discount: number; goodsAfter: number; freight: number; surcharge: number; surchargePct: number; exGst: number; gst: number; total: number; lineTotals: number[] };
export type LogEntry = { id: string; kind: 'call' | 'email' | 'visit' | 'note' | 'system'; note: string; at: string; by: string | null };
export type FollowUp = { id: string; dueOn: string; who: { id: string; name: string } | null; doneOn: string | null; doneBy: string | null; doneNote: string | null };
export type Order = {
  id: string; number: string; kind: 'order' | 'quote'; status: 'draft' | 'sent' | 'cancelled'; stage: string; stageLabel: string; show: Show; customer: Customer; newCustomer: boolean;
  orderDate: string; reference: string; customerPo: string | null; notes: string | null; repId: string | null; repName: string | null;
  contact: { name: string | null; email: string | null; phone: string | null; address: string | null };
  discount: { kind: 'pct' | 'amount'; value: number } | null; freight: number; cardPayment: boolean; cardSurchargePct: number | null; gstRate: number;
  lines: { lineNo: number; sku: string; name: string; brand: string | null; qty: number; price: number; comment: string | null; lineTotal: number; increment: number | null; packNote: string | null; stock: Stock | null }[];
  totals: Totals; dear: { number: string; status: string | null; id: string; linkedByHand: boolean } | null;
  emailedAt: string | null; emailError: string | null; emailVersion: number; cancelReason: string | null; log: LogEntry[]; followUps: FollowUp[]; followUpsClosed: boolean;
};
export type Lead = { id: string; show: Show; customer: Customer; newAccount: boolean; contact: { name: string | null; email: string | null; phone: string | null }; brands: string | null; notes: string | null;
  status: 'open' | 'won' | 'lost'; lostReason: string | null; takenOn: string; repName: string | null; log: LogEntry[]; followUps: FollowUp[]; followUpsClosed: boolean };
export type FollowUpItem = { id: string; dueOn: string; overdue: boolean; who: { id: string; name: string } | null; kind: 'order' | 'quote' | 'lead'; targetId: string; label: string; customer: string; region: string | null; show: { id: string; name: string }; amount: number | null; stage: string };
export type ShowPage = {
  show: Show;
  orders: { id: string; number: string; kind: 'order' | 'quote'; status: string; stage: string; stageLabel: string; customer: string; region: string; newCustomer: boolean; orderDate: string; rep: string | null; reference: string; exGst: number; total: number; lines: number; dear: string | null; emailError: string | null; nextFollowUp: { dueOn: string; who: string } | null }[];
  leads: { id: string; customer: string; region: string; contact: string | null; brands: string | null; status: 'open' | 'won' | 'lost'; lostReason: string | null; takenOn: string; rep: string | null; newAccount: boolean; nextFollowUp: { dueOn: string; who: string } | null }[];
  results: {
    orders: number; orderValue: number; quotes: number; quoteValue: number; averageOrder: number; target: number | null; toTarget: number | null;
    newCustomers: { count: number; value: number }; existingCustomers: { count: number; value: number }; cost: number; costPerOrder: number | null; returnOnCost: number | null;
    byRep: { name: string; orders: number; value: number }[]; byBrand: { name: string; value: number }[];
    products: { sku: string; name: string; units: number; value: number; available: number | null; free: number | null; incoming: Incoming }[];
    leads: { taken: number; won: number; lost: number; winRate: number | null; wonSales: number }; stillWithSales: number;
  };
};
export const STATES = ['NSW', 'ACT', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'NT', 'NZ', 'NSW/HO', 'VIC/HO', 'INTL'];
export const $ = (n: number | null | undefined) => (n === null || n === undefined ? '' : `$${n.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
export const shortDay = (d: string | null | undefined) => (d ? new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
export const pct = (n: number | null | undefined) => (n === null || n === undefined ? '' : `${(n * 100).toFixed(n < 0.1 ? 1 : 0)}%`);
export const STAGE_TONE: Record<string, string> = { draft: 'neutral', sent: 'amber', in_dear_quote: 'amber', in_dear: 'teal', invoiced: 'teal', paid: 'teal', cancelled: 'neutral', voided_in_dear: 'rust' };
export const todayLocal = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export const plusDaysLocal = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// A POST that keeps the whole answer, so a "this customer already exists" reply can show the matches.
import { supabase } from './supabase';
import { clearApiCache } from './api';
export async function postFull<T = any>(path: string, body: unknown): Promise<{ ok: boolean; status: number; body: T & { error?: string; matches?: Customer[] } }> {
  const token = (await supabase.auth.getSession()).data.session?.access_token;
  try {
    const res = await fetch(`${import.meta.env.VITE_API_URL}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    let b: any = {}; try { b = await res.json(); } catch { /* not JSON */ }
    if (!res.ok && typeof b.error !== 'string') b.error = `Something went wrong (${res.status}).`;
    return { ok: res.ok, status: res.status, body: b };
  } finally { clearApiCache(); }
}
