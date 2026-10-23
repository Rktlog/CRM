import { useEffect, useSyncExternalStore } from 'react';
import { apiGet } from './api';

// The product statuses (EOL, Discontinued, Preorder Only, New, ...), as shown on the Products page and the catalogue. Managers add and
// remove them, so the list comes from the server (/products/statuses) and is kept here, shared by every tag and picker on the page.
// Until it has arrived the built-in list is used, so a tag never flickers away.
export type StatusInfo = { key: string; label: string; tone: string; meaning: string | null; system: boolean; count: number };

const BUILT_IN: StatusInfo[] = [
  { key: 'eol', label: 'EOL', tone: 'rust', meaning: 'End of line: being cleared, will not be reordered', system: true, count: 0 },
  { key: 'discontinued', label: 'Discontinued', tone: 'neutral', meaning: 'No longer available', system: true, count: 0 },
  { key: 'preorder_only', label: 'Preorder Only', tone: 'amber', meaning: 'Only available to pre-order', system: false, count: 0 },
  { key: 'new', label: 'New', tone: 'teal', meaning: 'New to the range', system: false, count: 0 },
  { key: 'ranging', label: 'Confirmed for Ranging', tone: 'teal', meaning: 'Confirmed to be ranged', system: false, count: 0 },
  { key: 'customer_only', label: 'For Customer Only Then Cease', tone: 'amber', meaning: 'Only for customer orders, then the product ceases', system: false, count: 0 },
  { key: 'phasing_out', label: 'Phasing Out', tone: 'amber', meaning: 'Being phased out of the range', system: false, count: 0 },
  { key: 'new_ss27', label: 'New-SS27', tone: 'teal', meaning: 'New for Spring/Summer 2027', system: false, count: 0 },
];

let list: StatusInfo[] = BUILT_IN;
let loaded = false;
let inflight: Promise<void> | null = null;
const subscribers = new Set<() => void>();
const changed = () => subscribers.forEach(f => f());

const clean = (s: any): StatusInfo => ({ key: String(s.key), label: String(s.label ?? s.key), tone: ['rust', 'amber', 'teal', 'neutral'].includes(s.tone) ? s.tone : 'neutral', meaning: s.meaning ?? null, system: !!s.system, count: Number(s.count) || 0 });

// Use the list the server just sent (after a manager adds or removes one): every tag and picker updates at once.
export function setStatuses(next: unknown): void {
  if (!Array.isArray(next)) return;
  list = next.map(clean);
  loaded = true;
  changed();
}

export function refreshStatuses(): Promise<void> {
  if (inflight) return inflight;
  inflight = apiGet('/products/statuses', { fresh: true })
    .then(d => setStatuses(d?.statuses))
    .catch(() => { /* keep what there is */ })
    .finally(() => { inflight = null; });
  return inflight;
}

// For a component: the statuses, loaded once for the whole page, and the component redraws when they change.
export function useProductStatuses(): StatusInfo[] {
  useEffect(() => { if (!loaded) void refreshStatuses(); }, []);
  return useSyncExternalStore(cb => { subscribers.add(cb); return () => { subscribers.delete(cb); }; }, () => list);
}

export const statusInfo = (key: string | null | undefined): StatusInfo | null => list.find(s => s.key === key) ?? null;