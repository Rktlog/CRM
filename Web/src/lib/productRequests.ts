import { useEffect, useState, useSyncExternalStore } from 'react';
import { apiGet } from './api';

// Special product requests (the sales team asks, the ordering team sees it when ordering).
// - useNewRequestCount: the number on the menu badge, for managers (checked every minute, when the window is used again, and straight after a change)
// - useOpenRequests: everything still open, loaded once and shared, so the Special requests section and the notes on the product rows always agree
export type RequestStatus = 'requested' | 'seen' | 'asked_supplier' | 'supplier_replied' | 'ordered' | 'declined' | 'cancelled';
export type RequestItem = {
  id: string; kind: 'existing' | 'new'; sku: string | null; itemName: string; brand: string | null; supplier: string | null; link: string | null; qty: number | null;
  customer: string | null; neededBy: string | null; notes: string | null; status: RequestStatus; decisionNote: string | null;
  requestedBy: { id: string | null; name: string | null }; handledByName: string | null; createdAt: string; seenAt: string | null; handledAt: string | null;
  stock: { available: number; onOrder: number } | null;
  supplierAnswer: string | null; supplierAnswerAt: string | null;   // what the supplier said, as a manager confirmed or typed it
};

export const STATUS_LABEL: Record<RequestStatus, string> = {
  requested: 'Requested', seen: 'Seen', asked_supplier: 'Asked supplier', supplier_replied: 'Supplier replied', ordered: 'Ordered', declined: 'Declined', cancelled: 'Cancelled',
};
export const STATUS_TONE: Record<RequestStatus, string> = {
  requested: 'amber', seen: 'neutral', asked_supplier: 'neutral', supplier_replied: 'teal', ordered: 'teal', declined: 'rust', cancelled: 'neutral',
};
export const isOpen = (s: RequestStatus) => s === 'requested' || s === 'seen' || s === 'asked_supplier' || s === 'supplier_replied';

const CHANGED = 'radar-product-requests-changed';
/** Call after any change, so the menu badge and the shared list update at once. */
export function requestsChanged() { void refreshOpen(); window.dispatchEvent(new Event(CHANGED)); }

export function useNewRequestCount(role: string | null | undefined): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (role !== 'manager') { setN(0); return; }
    let stop = false;
    const load = () => { apiGet('/product-requests/summary', { fresh: true }).then((d: { newCount?: number }) => { if (!stop) setN(Number(d.newCount ?? 0)); }).catch(() => {}); };
    load();
    const timer = setInterval(load, 60000);
    window.addEventListener('focus', load);
    window.addEventListener(CHANGED, load);
    return () => { stop = true; clearInterval(timer); window.removeEventListener('focus', load); window.removeEventListener(CHANGED, load); };
  }, [role]);
  return n;
}

type Snap = { loaded: boolean; ready: boolean; error: string | null; items: RequestItem[]; bySku: Map<string, RequestItem[]> };
let snap: Snap = { loaded: false, ready: true, error: null, items: [], bySku: new Map() };
let loading = false;
const listeners = new Set<() => void>();
const publish = (s: Snap) => { snap = s; listeners.forEach(l => l()); };

export async function refreshOpen() {
  if (loading) return;
  loading = true;
  try {
    const d: { items: RequestItem[] } = await apiGet('/product-requests/open', { fresh: true });
    const bySku = new Map<string, RequestItem[]>();
    for (const i of d.items) if (i.sku) { const k = i.sku.toUpperCase(); bySku.set(k, [...(bySku.get(k) ?? []), i]); }
    publish({ loaded: true, ready: true, error: null, items: d.items, bySku });
  } catch (e) {
    const msg = (e as Error).message;
    publish({ loaded: true, ready: !/not set up/i.test(msg), error: msg, items: [], bySku: new Map() });
  } finally { loading = false; }
}

export function useOpenRequests(enabled: boolean): Snap {
  const s = useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => snap);
  useEffect(() => { if (enabled && !snap.loaded) void refreshOpen(); }, [enabled]);
  return s;
}

export function ago(iso: string, now = Date.now()): string {
  const days = Math.floor((now - new Date(iso).getTime()) / 86400000);
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
}
export function shortDate(day: string): string {
  const d = new Date(day + 'T00:00:00');
  return isNaN(d.getTime()) ? day : d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
}
