// What the Dashboard takes from the accounts, worked out here so it does not need all of them (7,700 and growing) sent to count a few things and pick out
// two short lists. These rules are the Dashboard's own, moved: keep them in step with web/src/lib/dashboardData.ts (a test runs both on the same data).

export const DAY = 86400000;

// Whole days since a date, rounded, as the web's daysBetween does.
export const daysSince = (d: Date | string, now: number) => Math.round((now - new Date(d).getTime()) / DAY);

// How many days a customer may go without ordering: 1.5 times their own usual gap (at least 14 days), or 75 days when there is not enough history.
const thresholdFor = (avgOrderGapDays: number | null) => (avgOrderGapDays ? Math.max(avgOrderGapDays * 1.5, 14) : 75);

type OverdueFields = { type: string; lastOrderAt: Date | string | null; avgOrderGapDays: number | null };

export function isOverdueCustomer(a: OverdueFields, now: number): boolean {
  if (a.type !== 'customer' || !a.lastOrderAt) return false;
  return daysSince(a.lastOrderAt, now) > thresholdFor(a.avgOrderGapDays);
}
export const overdueBy = (a: OverdueFields, now: number) => daysSince(a.lastOrderAt!, now) - thresholdFor(a.avgOrderGapDays);

// A status as the account list shows it: cold leads are their own; an account the status view knows nothing about is a Prospect.
export const statusOf = (a: { id: string; type: string }, statuses: Map<string, string>) => (a.type === 'cold_lead' ? 'Cold lead' : (statuses.get(a.id) ?? 'Prospect'));

// New leads by stage, and prospects.
export function leadCounts(accounts: { id: string; type: string; stage: string }[], statuses: Map<string, string>) {
  let approached = 0, quoteSent = 0, paymentCleared = 0, prospects = 0;
  for (const a of accounts) {
    const s = statusOf(a, statuses);
    if (s === 'New Lead') {
      if (a.stage === 'approached') approached++;
      else if (a.stage === 'quote_sent') quoteSent++;
      else if (a.stage === 'payment_cleared') paymentCleared++;
    } else if (s === 'Prospect') prospects++;
  }
  return { approached, quoteSent, paymentCleared, prospects };
}

// "Needs attention": the overdue customers, most overdue first. Ties keep the order the rows came in (the list's order: most recently updated first).
export const overdueList = <T extends OverdueFields>(rows: T[], now: number): T[] =>
  rows.filter(a => isOverdueCustomer(a, now)).sort((a, b) => overdueBy(b, now) - overdueBy(a, now));

// "Follow-ups due": soonest first. (The rows are already only the ones due; this is the order, with ties in the order they came in.)
export const dueList = <T extends { nextFollowUpAt: Date | string | null }>(rows: T[]): T[] =>
  [...rows].sort((a, b) => new Date(a.nextFollowUpAt!).getTime() - new Date(b.nextFollowUpAt!).getTime());