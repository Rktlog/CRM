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
  hasHistoricalOrders?: boolean;
  dearCustomerId?: string | null; // set when the account is linked to a DEAR customer
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
  miscType?: string | null;
  // DEAR's separate shipping/picking/payment progress (see lib/orderStatus)
  shippingStatus?: string | null;
  pickingStatus?: string | null;
  paymentStatus?: string | null;
  invoiceNumber?: string | null;
  total?: number | null;       // exact order total from DEAR
  amountPaid?: number | null;  // paid so far, across all invoices
  invoicedTotal?: number | null;
  creditedTotal?: number | null;
  amountDue?: number | null;   // DEAR balance: invoiced - paid - credited (null = not synced yet)
  unappliedCredit?: number | null; // credit on account from this order (unused credit notes, unapplied prepayments)
  creditNotes?: unknown;
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

// Always to the cent: rounding to whole dollars adds up across thousands
// of orders and makes totals disagree with DEAR.
export function fmtMoney(n: number): string {
  return '$' + (Number(n) || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
// A customer is overdue when they haven't ordered for longer than usual
// for them: 1.5x their own typical gap between orders (at least 14 days),
// or 75 days if there isn't enough history to know their pattern.
export function isOverdueCustomer(account: Account): boolean {
  if (account.type !== 'customer' || !account.lastOrderAt) return false;
  const threshold = account.avgOrderGapDays ? Math.max(account.avgOrderGapDays * 1.5, 14) : 75;
  return daysBetween(account.lastOrderAt) > threshold;
}

export function flagFor(account: Account, quotes?: Quote[]): 'amber' | 'rust' | null {
  // Live DEAR orders only: spreadsheet history's old unpaid flags would
  // otherwise mark the account amber forever.
  const openQuote = quotes?.find(q => isOwingOrder(q));
  if (openQuote && daysBetween(openQuote.sentAt) > 5) return 'amber';

  if (isOverdueCustomer(account)) return 'rust';
  return null;
}

// Orders imported from the old spreadsheet (numbers start "Q") count in
// sales figures, but their statuses are frozen history: never show them
// as unpaid, backordered or still to ship. Live DEAR orders start "SQ".
export const isHistoryOrder = (q: { source?: string | null; number?: string | null }) =>
  q.source === 'rhino-history' || /^Q/.test(q.number ?? '');

// Is money owed on this order? DEAR's balance (invoiced - paid - credited)
// once synced; before that, the paid flag. Same rule as the API.
export function isOwingOrder(q: {
  source?: string | null; number?: string | null; paid: boolean; miscType?: string | null;
  amountDue?: number | null; fulfillmentStatus?: string | null;
}): boolean {
  if (isHistoryOrder(q)) return false;
  if (['VOIDED', 'CREDITED'].includes((q.fulfillmentStatus ?? '').toUpperCase())) return false;
  // DEAR's balance decides, including on warranty and marketing orders.
  if (q.amountDue != null) return q.amountDue > 0.005;
  if (q.miscType) return false;
  return !q.paid;
}

// What's actually still owed on an order.
export function amountOwing(q: { amount: number; total?: number | null; amountPaid?: number | null; amountDue?: number | null }): number {
  if (q.amountDue != null) return q.amountDue;
  return Math.max(0, (q.total ?? q.amount) - (q.amountPaid ?? 0));
}