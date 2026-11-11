import { useEffect, useSyncExternalStore } from 'react';
import { apiGet } from './api';
import { requestsChanged } from './productRequests';

// The supplier emails Radar made drafts of (managers): which requests each covers, whether it was sent, whether the supplier replied, and the answers proposed.
// Loaded once and shared, so every request card shows the same state.
export type Answer = { availability: 'yes' | 'partial' | 'no' | 'unknown'; qty: number | null; leadTime: string | null; price: string | null; notes: string | null };
export type EnquiryItem = { requestId: string; sku: string | null; itemName: string; qty: number | null; answer: Answer | null; answerStatus: 'none' | 'proposed' | 'confirmed' | 'dismissed'; proposedText: string | null };
export type Enquiry = { id: string; supplier: string; status: 'drafted' | 'sent' | 'replied'; subject: string; to: string[]; createdAt: string; sentAt: string | null; replyAt: string | null; replyFrom: string | null; checkNote: string | null; draftLink: string | null; items: EnquiryItem[] };
type Snap = { loaded: boolean; ready: boolean; error: string | null; byRequest: Map<string, Enquiry> };
let snap: Snap = { loaded: false, ready: true, error: null, byRequest: new Map() };
let loading = false;
const listeners = new Set<() => void>();
const publish = (s: Snap) => { snap = s; listeners.forEach(l => l()); };

export async function refreshEnquiries() {
  if (loading) return;
  loading = true;
  try {
    const d: { items: Enquiry[] } = await apiGet('/supplier-enquiries', { fresh: true });
    const byRequest = new Map<string, Enquiry>();
    for (const e of [...d.items].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) for (const i of e.items) byRequest.set(i.requestId, e);   // the latest email for each request wins
    publish({ loaded: true, ready: true, error: null, byRequest });
  } catch (e) {
    const msg = (e as Error).message;
    publish({ loaded: true, ready: !/not set up/i.test(msg), error: msg, byRequest: new Map() });
  } finally { loading = false; }
}
export function useEnquiries(enabled: boolean): Snap {
  const s = useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => snap);
  useEffect(() => { if (enabled && !snap.loaded) void refreshEnquiries(); }, [enabled]);
  return s;
}
/** After anything changes a supplier email: reload the emails and the requests (a request's status moves with it). */
export function enquiriesChanged() { void refreshEnquiries(); requestsChanged(); }
