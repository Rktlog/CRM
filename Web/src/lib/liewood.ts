import { supabase } from './supabase';
import { clearApiCache } from './api';

// Liewood orders: the types the pages use, the words for each stage, and sending a file (the Excel sales order, or the PDF confirmation).
const API_URL = import.meta.env.VITE_API_URL;
export type OrderStage = 'confirmed' | 'on_po' | 'part_invoiced' | 'invoiced' | 'part_received' | 'received';
export type LineStage = 'not_on_po' | 'short_on_po' | 'not_invoiced' | 'part_invoiced' | 'invoiced' | 'part_received' | 'received';
export type Check = { status: 'match' | 'mismatch' | 'not_checked'; reasons: string[]; pdf: { orderNo: string | null; totalUnits: number | null; totalAmount: number | null; currency: string | null } | null; checkedAt: string };
export type OrderSummary = { id: string; soNumber: string; name: string | null; season: string | null; eta: string | null; poNumber: string | null; units: number; amount: number; currency: string | null; stage: OrderStage; closed: boolean; confirmation: Check['status'] | 'none'; issues: number; overdue: boolean; createdAt: string };
export type OrderLine = { lineNo: number; display: boolean; styleNo: string; styleName: string | null; colour: string | null; colourCode: string | null; size: string | null; barcode: string | null; sku: string; inDear: boolean; qty: number; price: number | null; amount: number | null; rrp: number | null; deliveryWindow: string | null; onPo: number; invoiced: number; received: number; stage: LineStage | null };
export type Order = {
  id: string; soNumber: string; name: string | null; season: string | null; customerOrderNo: string | null; currency: string | null; deliveryWindow: string | null; eta: string | null; etaEnd: string | null; poNumber: string | null; notes: string | null;
  units: number; amount: number; sourceFile: string | null; confirmationName: string | null; confirmation: Check | null; closed: boolean; stage: OrderStage; overdue: boolean;
  po: { ok: boolean; error: string | null; fetchedAt: string; status: string | null } | null; sharedWith: string[];
  invoices: { number: string | null; date: string | null; units: number; allUnits: number; received: number | null; receivedOn: string | null }[];
  shortages: { invoice: string; sku: string; invoiced: number; received: number }[]; extraOnPo: { sku: string; qty: number }[]; lines: OrderLine[]; updatedAt: string;
};
export type Uploaded = { id: string; soNumber: string; replaced: boolean; lines: number; units: number; notInDear: number; problems: string[]; range: { added: number; updated: number } | null };

// The Liewood range (Products, Liewood, Range)
export type PriceCheck = 'match' | 'differs' | 'not_in_dear' | 'no_proposed';
export type RangeItem = {
  sku: string; ean: string | null; name: string | null; colour: string | null; season: string | null; essential: string | null; subbrand: string | null; category: string | null; subCategory: string | null;
  productType: string | null; orderIncrement: number | null; dropEur: string | null; dropAus: string | null; ranged: string | null; status: string | null; wspEur?: number | null; proposedRrp: number | null;
  notes: string | null; source: string; inDear: boolean; dearRrp: number | null; available: number | null; onOrder: number | null; check: PriceCheck; ordered: { so: string; qty: number }[]; orderedTotal: number;
};
export type RangeView = { items: RangeItem[]; files: { kind: 'product_data' | 'forecast'; file: string; skus: number; at: string }[]; catalogueSkus: number; orderSkusNotInRange: number };
export type RangeImport = { rows: number; added: number; updated: number; noSku: number; duplicates: string[]; problems: string[] };
export type SeasonImport = { kind: 'product_data' | 'forecast'; file: string; tabs: string[]; skus: number; onOrders: number; fed: { added: number; updated: number }; problems: string[] };
export const PRICE_CHECK: Record<PriceCheck, { label: string; tone: string }> = {
  match: { label: 'Matches DEAR', tone: 'teal' }, differs: { label: 'DEAR differs', tone: 'rust' }, not_in_dear: { label: 'Not in DEAR', tone: 'neutral' }, no_proposed: { label: 'No proposed RRP', tone: 'amber' },
};

export const ORDER_STAGE: Record<OrderStage, { label: string; tone: string }> = {
  confirmed: { label: 'Confirmed, no PO yet', tone: 'neutral' }, on_po: { label: 'On PO, not invoiced', tone: 'amber' }, part_invoiced: { label: 'Partly invoiced', tone: 'amber' },
  invoiced: { label: 'Invoiced, coming', tone: 'teal' }, part_received: { label: 'Partly received', tone: 'amber' }, received: { label: 'Received in full', tone: 'teal' },
};
export const LINE_STAGE: Record<LineStage, { label: string; tone: string }> = {
  not_on_po: { label: 'Not on the PO', tone: 'rust' }, short_on_po: { label: 'Less on the PO', tone: 'rust' }, not_invoiced: { label: 'Not invoiced yet', tone: 'neutral' },
  part_invoiced: { label: 'Partly invoiced', tone: 'amber' }, invoiced: { label: 'Invoiced, coming', tone: 'teal' }, part_received: { label: 'Partly received', tone: 'amber' }, received: { label: 'Received', tone: 'teal' },
};
export const CHECK_LABEL: Record<Check['status'] | 'none', { label: string; tone: string }> = {
  match: { label: 'PDF matches', tone: 'teal' }, mismatch: { label: 'PDF differs', tone: 'rust' }, not_checked: { label: 'PDF not checked', tone: 'neutral' }, none: { label: 'No PDF yet', tone: 'neutral' },
};
export const money = (n: number, cur: string | null) => `${cur ?? ''} ${n.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`.trim();
export const shortDay = (d: string | null) => (d ? new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : '');

/** Sends one file as it is. path is /liewood/orders (the Excel) or /liewood/orders/:id/confirmation (the PDF). */
export async function sendFile<T>(path: string, file: File): Promise<T> {
  const token = (await supabase.auth.getSession()).data.session?.access_token;
  try {
    const res = await fetch(`${API_URL}${path}`, { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name), ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
    let b: any = {}; try { b = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) { const e = new Error(typeof b.error === 'string' ? b.error : `The upload failed (${res.status}).`) as Error & { status?: number }; e.status = res.status; throw e; }
    return b as T;
  } finally { clearApiCache(); }
}
/** Opens the PDF confirmation in a new tab (it needs the sign-in, so it is fetched, not linked). */
export async function openPdf(id: string): Promise<void> {
  const tab = window.open('', '_blank');
  const token = (await supabase.auth.getSession()).data.session?.access_token;
  const res = await fetch(`${API_URL}/liewood/orders/${id}/confirmation`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) { tab?.close(); let m = 'The PDF could not be opened.'; try { m = (await res.json()).error ?? m; } catch { /* keep */ } throw new Error(m); }
  const url = URL.createObjectURL(await res.blob());
  if (tab) tab.location.href = url; else window.location.href = url;
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
