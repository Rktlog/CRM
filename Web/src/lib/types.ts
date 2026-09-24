export type Stage =
  | 'new_lead'
  | 'approached'
  | 'quote_sent'
  | 'payment_cleared'
  | 'dispatched';

export const STAGE_LABELS: Record<Stage, string> = {
  new_lead: 'New Lead',
  approached: 'Approached',
  quote_sent: 'Quote Sent',
  payment_cleared: 'Payment Cleared',
  dispatched: 'Dispatched',
};

export const STAGES: Stage[] = [
  'new_lead',
  'approached',
  'quote_sent',
  'payment_cleared',
  'dispatched',
];

export type Account = {
  id: string;
  name: string;
  region: string;
  repId: string;
  repName: string | null;
  credit: 'prepay' | 'account';
  type: 'prospect' | 'customer';
  stage: Stage;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  nextFollowUpAt: string | null;
  spend30: number;
  spend90: number;
  spend365: number;
  lastOrderAt: string | null;
  avgOrderGapDays: number | null;
  archived: boolean;
  misc: boolean;
  createdAt: string;
  updatedAt: string;
};

export type QuoteLineItem = { sku: string; productName: string; brand: string | null; quantity: number; unitPrice: number; lineTotal: number };

export type Quote = {
  id: string;
  number: string;
  amount: number;
  sentAt: string;
  invoiceDate: string | null;
  paid: boolean;
  fulfillmentStatus: string | null;
  shippingCompany: string | null;
  shippingAddress: string | null;
  source?: string;
  lines?: QuoteLineItem[];
};

export type Activity = {
  id: string;
  type: 'call' | 'email' | 'visit';
  note: string;
  photoUrl: string | null;
  occurredAt: string;
  repId: string;
  repName: string | null;
};

export type ProductLine = { sku: string; productName: string; brand: string | null; quantity: number; total: number };

export type AccountDetail = Account & {
  activity: Activity[];
  quotes: Quote[];
  productBreakdown: ProductLine[];
};

export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Small, deliberately simple edit-distance check — good enough to
// catch an obvious near-duplicate while typing, not meant to be as
// thorough as the trigram-similarity SQL used for the real cleanup.
export function levenshtein(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

export function findLikelyDuplicates(name: string, existingNames: string[]): string[] {
  const key = normalizeName(name);
  if (key.length < 3) return [];
  return existingNames.filter(existing => {
    const existingKey = normalizeName(existing);
    if (existingKey === key) return true;
    if (existingKey.includes(key) || key.includes(existingKey)) return true;
    // Only worth an edit-distance check on names of similar length —
    // otherwise short names match everything.
    if (Math.abs(existingKey.length - key.length) <= 3) {
      return levenshtein(key, existingKey) <= 2;
    }
    return false;
  });
}

export function daysBetween(iso: string): number {
  return Math.round((Date.now() - new Date(iso).getTime()) / 86400000);
}

export function fmtMoney(n: number): string {
  return '$' + n.toLocaleString('en-AU');
}

export function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
}

export function fmtDateWithYear(iso: string): string {
  return new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}

// Same flag rules as the mock, but the inactivity threshold is now
// personal to each account: if they have 2+ past orders, "overdue"
// means 1.5x their own typical gap between orders (with a 14-day
// floor so a customer who orders every 3 days doesn't get flagged
// after being 5 days late). Falls back to a flat 75 days for anyone
// without enough order history to have a real pattern yet.
export function flagFor(account: Account, quotes?: Quote[]): 'amber' | 'rust' | null {
  const openQuote = quotes?.find(q => !q.paid);
  if (openQuote && daysBetween(openQuote.sentAt) > 5) return 'amber';

  if (account.type === 'customer' && account.lastOrderAt) {
    const threshold = account.avgOrderGapDays
      ? Math.max(account.avgOrderGapDays * 1.5, 14)
      : 75;
    if (daysBetween(account.lastOrderAt) > threshold) return 'rust';
  }
  return null;
}