import { prisma } from './prisma';
import { territoryWhere } from './territory';
import { isOwing } from './orderSource';

// The order-tracking views on the Orders page: open quotes, orders still to
// ship, unpaid invoices, and balances per customer with ageing. Scoped like
// the rest of the app: managers see everything, reps their states.
//
// Money comes from DEAR's own figures stored on each order by sync-sales:
// every invoice with its total, paid (cash), credited and due, plus credit
// still on account. Ageing uses each invoice's due date from DEAR, so a
// customer on 30-day terms isn't "late" the day after invoicing.

type Rep = { id: string; role: string };
const DAY = 86400000;
const QUOTE_STATUSES = ['DRAFT', 'ESTIMATING', 'ESTIMATED', 'ORDERING'];
const CLOSED_STATUSES = ['VOIDED', 'CREDITED', 'COMPLETED'];
const cents = (n: number) => Math.round(n * 100) / 100;
const daysSince = (d: Date) => Math.floor((Date.now() - d.getTime()) / DAY);

async function scope(rep: Rep, regions?: string[]) {
  const accounts = await prisma.account.findMany({
    where: { AND: [await territoryWhere(rep), regions?.length ? { region: { in: regions } } : {}] },
    select: { id: true, name: true, region: true, paymentTerms: true, rep: { select: { name: true } } },
  });
  return new Map(accounts.map(a => [a.id, a]));
}

// Live DEAR orders only (not the spreadsheet history).
const LIVE = { source: { not: 'rhino-history' }, NOT: { number: { startsWith: 'Q' } } };

// ---------- Open quotes: not yet confirmed, oldest first ----------
export async function openQuotes(rep: Rep, regions?: string[]) {
  const accounts = await scope(rep, regions);
  const quotes = await prisma.quote.findMany({
    where: { ...LIVE, accountId: { in: [...accounts.keys()] }, fulfillmentStatus: { in: QUOTE_STATUSES } },
    orderBy: { sentAt: 'asc' },
  });
  const rows = quotes.map(q => ({
    id: q.id,
    number: q.number,
    accountId: q.accountId,
    customer: accounts.get(q.accountId)?.name ?? 'Unknown',
    region: accounts.get(q.accountId)?.region ?? '',
    repName: accounts.get(q.accountId)?.rep?.name ?? null,
    date: q.sentAt,
    ageDays: daysSince(q.sentAt),
    stage: q.fulfillmentStatus === 'ORDERING' ? 'Draft order' : 'Quote',
    reference: q.reference,
    amount: cents(q.total ?? q.amount),
  }));
  return { rows, count: rows.length, total: cents(rows.reduce((s, r) => s + r.amount, 0)) };
}

// ---------- To ship: confirmed but not fully shipped, oldest first ----------
export async function toShip(rep: Rep, regions?: string[]) {
  const accounts = await scope(rep, regions);
  const quotes = await prisma.quote.findMany({
    where: {
      ...LIVE,
      accountId: { in: [...accounts.keys()] },
      fulfillmentStatus: { notIn: [...QUOTE_STATUSES, ...CLOSED_STATUSES] },
      OR: [{ shippingStatus: null }, { shippingStatus: { not: 'SHIPPED' } }],
    },
    orderBy: { sentAt: 'asc' },
  });
  const rows = quotes.map(q => {
    const status = (q.fulfillmentStatus ?? '').toUpperCase();
    const ship = (q.shippingStatus ?? '').toUpperCase();
    const pick = (q.pickingStatus ?? '').toUpperCase();
    const stage =
      ship === 'PARTIALLY SHIPPED' ? (status === 'BACKORDERED' ? 'Part shipped, rest backordered' : 'Part shipped')
      : status === 'BACKORDERED' ? 'Backordered'
      : pick === 'PICKED' ? 'Picked'
      : pick === 'PARTIALLY PICKED' ? 'Part picked'
      : 'Confirmed';
    return {
      id: q.id,
      number: q.number,
      accountId: q.accountId,
      customer: accounts.get(q.accountId)?.name ?? 'Unknown',
      region: accounts.get(q.accountId)?.region ?? '',
      repName: accounts.get(q.accountId)?.rep?.name ?? null,
      date: q.sentAt,
      ageDays: daysSince(q.sentAt),
      stage,
      backordered: status === 'BACKORDERED',
      type: q.miscType === 'marketing' ? 'Marketing' : q.miscType === 'warranty' ? 'Warranty' : 'Sale',
      amount: cents(q.total ?? q.amount),
    };
  });
  return { rows, count: rows.length, total: cents(rows.reduce((s, r) => s + r.amount, 0)) };
}

// ---------- Unpaid invoices: one row per invoice with money owing ----------
type InvoiceDoc = { number: string | null; date: string | null; dueDate: string | null; total: number; paid: number; credited?: number; due?: number };

export async function unpaidInvoices(rep: Rep, regions?: string[]) {
  const accounts = await scope(rep, regions);
  const quotes = (await prisma.quote.findMany({
    where: { ...LIVE, accountId: { in: [...accounts.keys()] }, OR: [{ amountDue: { gt: 0.005 } }, { amountDue: null, paid: false, invoiceDate: { not: null } }] },
  })).filter(q => isOwing(q));

  const rows = quotes.flatMap(q => {
    const acct = accounts.get(q.accountId);
    const base = {
      orderId: q.id, number: q.number, accountId: q.accountId,
      customer: acct?.name ?? 'Unknown', region: acct?.region ?? '', repName: acct?.rep?.name ?? null,
      terms: acct?.paymentTerms ?? 'Prepayment', // no terms on record = Prepayment
      type: q.miscType === 'marketing' ? 'Marketing' : q.miscType === 'warranty' ? 'Warranty' : 'Sale',
    };
    const docs = (q.invoices ?? []) as InvoiceDoc[];
    const owingDocs = docs.filter(i => (i.due ?? (i.total - i.paid - (i.credited ?? 0))) > 0.005);
    if (owingDocs.length) {
      return owingDocs.map(i => {
        const invDate = i.date ? new Date(i.date) : q.invoiceDate ?? q.sentAt;
        const dueDate = i.dueDate ? new Date(i.dueDate) : new Date(invDate.getTime() + 30 * DAY);
        return {
          ...base,
          invoice: i.number ?? q.invoiceNumber ?? '',
          invoiceDate: invDate,
          dueDate,
          daysOverdue: Math.max(0, daysSince(dueDate)),
          total: cents(i.total),
          paid: cents(i.paid),
          credited: cents(i.credited ?? 0),
          due: cents(i.due ?? (i.total - i.paid - (i.credited ?? 0))),
        };
      });
    }
    // Not yet synced with invoice detail: the whole order, due 30 days after invoicing.
    const invDate = q.invoiceDate ?? q.sentAt;
    const dueDate = new Date(invDate.getTime() + 30 * DAY);
    const total = q.total ?? q.amount;
    return [{
      ...base,
      invoice: q.invoiceNumber ?? '',
      invoiceDate: invDate,
      dueDate,
      daysOverdue: Math.max(0, daysSince(dueDate)),
      total: cents(total),
      paid: cents(q.amountPaid ?? 0),
      credited: cents(q.creditedTotal ?? 0),
      due: cents(q.amountDue ?? Math.max(0, total - (q.amountPaid ?? 0))),
    }];
  }).sort((a, b) => b.daysOverdue - a.daysOverdue || b.due - a.due);

  return {
    rows,
    count: rows.length,
    total: cents(rows.reduce((s, r) => s + r.due, 0)),
    overdue: cents(rows.filter(r => r.daysOverdue > 0).reduce((s, r) => s + r.due, 0)),
  };
}

// ---------- Balances: one row per customer, with ageing ----------
export const AGE_BUCKETS = [
  { key: 'current', label: 'Not yet due', test: (d: number) => d <= 0 },
  { key: 'd30', label: 'Up to 1 month overdue', test: (d: number) => d >= 1 && d <= 30 },
  { key: 'd60', label: '1–2 months overdue', test: (d: number) => d >= 31 && d <= 60 },
  { key: 'd90', label: '2–3 months overdue', test: (d: number) => d >= 61 && d <= 90 },
  { key: 'd90plus', label: 'Over 3 months overdue', test: (d: number) => d > 90 },
] as const;
type BucketKey = (typeof AGE_BUCKETS)[number]['key'];

export async function balances(rep: Rep, regions?: string[]) {
  const accounts = await scope(rep, regions);
  const invoices = await unpaidInvoices(rep, regions);

  // Credit still on account (unused credit notes, unapplied prepayments),
  // from any live order, paid or not.
  const creditRows = await prisma.quote.groupBy({
    by: ['accountId'],
    where: { ...LIVE, accountId: { in: [...accounts.keys()] }, unappliedCredit: { gt: 0.005 } },
    _sum: { unappliedCredit: true },
  });
  const creditBy = new Map(creditRows.map(c => [c.accountId, c._sum.unappliedCredit ?? 0]));

  // Overpaid orders (DEAR balance below zero) leave the customer in credit too.
  const overpaid = await prisma.quote.groupBy({
    by: ['accountId'],
    where: { ...LIVE, accountId: { in: [...accounts.keys()] }, amountDue: { lt: -0.005 } },
    _sum: { amountDue: true },
  });
  for (const o of overpaid) creditBy.set(o.accountId, (creditBy.get(o.accountId) ?? 0) - (o._sum.amountDue ?? 0));

  type Bal = { accountId: string; customer: string; region: string; repName: string | null; terms: string; invoices: number; oldestDays: number; owing: number; credit: number; balance: number } & Record<BucketKey, number>;
  const byAccount = new Map<string, Bal>();
  const blank = (accountId: string): Bal => {
    const a = accounts.get(accountId);
    return {
      accountId, customer: a?.name ?? 'Unknown', region: a?.region ?? '', repName: a?.rep?.name ?? null,
      terms: a?.paymentTerms ?? 'Prepayment',
      invoices: 0, oldestDays: 0, owing: 0, credit: 0, balance: 0,
      current: 0, d30: 0, d60: 0, d90: 0, d90plus: 0,
    };
  };
  for (const r of invoices.rows) {
    const b = byAccount.get(r.accountId) ?? blank(r.accountId);
    b.invoices++;
    b.owing += r.due;
    b.oldestDays = Math.max(b.oldestDays, r.daysOverdue);
    const bucket = AGE_BUCKETS.find(x => x.test(r.daysOverdue))!;
    b[bucket.key] += r.due;
    byAccount.set(r.accountId, b);
  }
  for (const [accountId, credit] of creditBy) {
    const b = byAccount.get(accountId) ?? blank(accountId);
    b.credit += credit;
    byAccount.set(accountId, b);
  }

  const rows = [...byAccount.values()].map(b => {
    const out = { ...b };
    for (const k of ['owing', 'credit', 'current', 'd30', 'd60', 'd90', 'd90plus'] as const) out[k] = cents(out[k]);
    out.balance = cents(out.owing - out.credit);
    return out;
  })
    // Outstanding = anything not zero, owing (+) or in credit (-).
    .filter(b => Math.abs(b.balance) > 0.005)
    .sort((a, b) => b.balance - a.balance);

  const sum = (k: keyof Bal) => cents(rows.reduce((s, r) => s + (r[k] as number), 0));
  return {
    rows,
    count: rows.length,
    totals: {
      owing: sum('owing'), credit: sum('credit'), balance: sum('balance'),
      current: sum('current'), d30: sum('d30'), d60: sum('d60'), d90: sum('d90'), d90plus: sum('d90plus'),
      over60: cents(sum('d90') + sum('d90plus')), // more than 60 days past due
    },
  };
}