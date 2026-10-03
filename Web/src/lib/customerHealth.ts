import { daysBetween } from './types';

// Reorder health for an existing customer: is the store still ordering on
// its own usual schedule? Shared by the Customers board and the Dashboard
// so both always agree.
//   recent  inside their usual gap
//   due     from 80% of their usual gap
//   overdue past 1.5x their usual gap (the Dashboard's "inactive" rule)
//   lapsed  nothing for 6 months or more
// No pattern yet (one order): due at 45 days, overdue at 75.

export type Health = 'recent' | 'due' | 'overdue' | 'lapsed';

export const HEALTH_COLUMNS: { key: Health; title: string; hint: string }[] = [
  { key: 'recent', title: 'Ordered recently', hint: 'Inside their usual reorder gap' },
  { key: 'due', title: 'Due to reorder', hint: 'Getting close to their usual gap' },
  { key: 'overdue', title: 'Overdue', hint: 'Past 1.5× their usual gap' },
  { key: 'lapsed', title: 'Lapsed', hint: 'No order in 6 months or more' },
];

const LAPSED_DAYS = 180;

export function healthOf(c: { lastOrderAt: string | null; avgOrderGapDays: number | null }): Health {
  if (!c.lastOrderAt) return 'lapsed';
  const days = daysBetween(c.lastOrderAt);
  if (days >= LAPSED_DAYS) return 'lapsed';
  const overdueAt = c.avgOrderGapDays ? Math.max(c.avgOrderGapDays * 1.5, 14) : 75;
  if (days > overdueAt) return 'overdue';
  const dueAt = c.avgOrderGapDays ? Math.max(c.avgOrderGapDays * 0.8, 7) : 45;
  if (days >= dueAt) return 'due';
  return 'recent';
}