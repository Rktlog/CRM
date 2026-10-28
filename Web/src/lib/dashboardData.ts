import { apiGet } from './api';
import { daysBetween, isOverdueCustomer, type Account } from './types';

// Everything the Dashboard takes from the accounts: lead and prospect counts, the overdue customers ("Needs attention"), the follow-ups due, and the
// three figures per customer for its "Active customers" card.
//  - Normally the API works this out (GET /accounts/dashboard) and sends just this: a few hundred accounts at most, not all 7,700.
//  - With an older API that does not have that route, the same thing is worked out here from the full account list and the customers list.
// dashboardFromAccounts is the Dashboard's original rules and is what the API's version is checked against.
export type CustomerFigures = { lastOrderAt: string | null; avgOrderGapDays: number | null; spend365: number };
export type DashboardData = {
  counts: { approached: number; quoteSent: number; paymentCleared: number; prospects: number };
  inactive: Account[];
  dueFollowUps: Account[];
  customers: CustomerFigures[];
};

export function dashboardFromAccounts(accounts: Account[], customers: CustomerFigures[], now = Date.now()): DashboardData {
  const isLead = (a: Account) => a.status === 'New Lead';
  const overdueBy = (a: Account) => {
    const threshold = a.avgOrderGapDays ? Math.max(a.avgOrderGapDays * 1.5, 14) : 75;
    return daysBetween(a.lastOrderAt!) - threshold;
  };
  return {
    counts: {
      approached: accounts.filter(a => isLead(a) && a.stage === 'approached').length,
      quoteSent: accounts.filter(a => isLead(a) && a.stage === 'quote_sent').length,
      paymentCleared: accounts.filter(a => isLead(a) && a.stage === 'payment_cleared').length,
      prospects: accounts.filter(a => a.status === 'Prospect').length,
    },
    inactive: accounts.filter(isOverdueCustomer).sort((a, b) => overdueBy(b) - overdueBy(a)),
    dueFollowUps: accounts
      .filter(a => a.nextFollowUpAt && new Date(a.nextFollowUpAt).getTime() <= now)
      .sort((a, b) => new Date(a.nextFollowUpAt!).getTime() - new Date(b.nextFollowUpAt!).getTime()),
    customers,
  };
}

export async function loadDashboardData(): Promise<DashboardData> {
  try {
    return await apiGet('/accounts/dashboard');
  } catch {
    // An older API without that route (or a hiccup): do it the long way.
    const [accounts, customers] = await Promise.all([apiGet('/accounts'), apiGet('/accounts/customers').catch(() => [])]);
    return dashboardFromAccounts(accounts, customers);
  }
}