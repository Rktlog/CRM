import { addDays, localISO, startOfWeek } from './dates';

// The date choices on the Activity log page, and the address the page asks the server for.
export type Range = 'all' | 'today' | 'week' | 'last7' | 'last30' | 'month' | 'lastmonth' | 'custom';
export const RANGE_LABEL: Record<Range, string> = {
  all: 'Any date', today: 'Today', week: 'This week', last7: 'Last 7 days', last30: 'Last 30 days', month: 'This month', lastmonth: 'Last month', custom: 'Pick dates…',
};

// The first and last day (YYYY-MM-DD, both included) a choice means. Empty means no limit on that side.
export function rangeDates(r: Range, custom: { from: string; to: string }, now: Date = new Date()): { from: string; to: string } {
  const today = localISO(now);
  switch (r) {
    case 'today': return { from: today, to: today };
    case 'week': return { from: localISO(startOfWeek(now)), to: today };                       // Monday to today
    case 'last7': return { from: localISO(addDays(now, -6)), to: today };                      // today and the 6 days before
    case 'last30': return { from: localISO(addDays(now, -29)), to: today };
    case 'month': return { from: localISO(new Date(now.getFullYear(), now.getMonth(), 1)), to: today };
    case 'lastmonth': return { from: localISO(new Date(now.getFullYear(), now.getMonth() - 1, 1)), to: localISO(new Date(now.getFullYear(), now.getMonth(), 0)) };
    case 'custom': return { from: custom.from, to: custom.to };
    default: return { from: '', to: '' };
  }
}

export function activityQuery(f: { type: string; repId: string; from: string; to: string }): string {
  const p = new URLSearchParams();
  if (f.type) p.set('type', f.type);
  if (f.repId) p.set('repId', f.repId);
  if (f.from) p.set('from', f.from);
  if (f.to) p.set('to', f.to);
  const s = p.toString();
  return s ? `?${s}` : '';
}