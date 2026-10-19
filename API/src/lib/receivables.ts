import { prisma } from './prisma';
import { territoryWhere } from './territory';
import { isOwing } from './orderSource';
import { orderNoteSummary } from './orderNotes';

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
// A day as YYYY-MM-DD on the Melbourne calendar (the team's day, whatever the server's clock says).
export const melDay = (d: Date | string = new Date()) =>
  new Date(d).toLocaleDateString('en-CA', { timeZone: 'Australia/Melbourne' });
const plusDays = (day: string, n: number) => new Date(Date.parse(day) + n * DAY).toISOString().slice(0, 10);

// Follow-ups on an open quote: the 1st is 7 days after the order date, the 2nd is 14 days after the 1st was done.
// A date someone sets by hand (manualOn) comes first until it is done or cleared.
export type FollowUp = {
  fu1Due: string; fu1DoneOn: string | null; fu2Due: string | null; fu2DoneOn: string | null; manualOn: string | null;
  next: { kind: 'fu1' | 'fu2' | 'manual'; date: string } | null;
};
export function followUpState(orderDay: string, f: { manualOn: string | null; fu1DoneOn: string | null; fu2DoneOn: string | null }): FollowUp {
  const fu1Due = plusDays(orderDay, 7);
  const fu2Due = f.fu1DoneOn ? plusDays(f.fu1DoneOn, 14) : null;
  const next: FollowUp['next'] =
    f.manualOn ? { kind: 'manual', date: f.manualOn }
    : !f.fu1DoneOn ? { kind: 'fu1', date: fu1Due }
    : !f.fu2DoneOn && fu2Due ? { kind: 'fu2', date: fu2Due }
    : null;
  return { fu1Due, fu1DoneOn: f.fu1DoneOn, fu2Due, fu2DoneOn: f.fu2DoneOn, manualOn: f.manualOn, next };
}

// ---------- Open quotes and unpaid orders ----------
// Everything still waiting on the customer, oldest first:
//   - every quote or draft order, paid or not, until it is confirmed in DEAR; and
//   - every confirmed order (ordered, backordered, picking, shipped...) that is not fully paid, whoever the customer is and
//     whatever their payment terms, until its money is in. Money still owed on an invoice that is not yet due counts as unpaid.
// An order leaves only when it is BOTH paid and confirmed. Marketing and warranty orders never come in, and neither does a
// customer that has been set aside (Metro Baby).
// Amounts are what the customer pays (inc GST, DEAR's order total).
const nice = (s: string | null) => (s ? s.charAt(0) + s.slice(1).toLowerCase() : '');

// Paid = cash applied to invoices + any prepayment DEAR still holds against the order (what the Credit page calls
// "held"), less any of that prepayment the team has reserved for another order (reservedPrepay): that money is
// spoken for, so this order no longer counts it. An order that is fully invoiced with nothing due is settled, even if
// part of it was a credit note.
// "Fully paid" allows for GST rounding: DEAR's prepayment can fall a few cents short of the order total, and that is not money
// owed. A balance under $1 counts as paid (under 1% of a very small order). Open Quotes, the order page and the Credit page all use it.
export const paidTolerance = (total: number) => Math.min(1, Math.max(total, 0) * 0.01);
export const settleCents = (total: number, remaining: number) => (remaining < paidTolerance(total) ? 0 : remaining);

export function paymentState(q: { total: number | null; amount: number; amountPaid: number | null; unappliedCredit: number | null; amountDue: number | null; invoicedTotal: number | null; creditNotes: unknown }, reservedPrepay = 0) {
  const total = q.total ?? q.amount;
  const onAccount = Array.isArray(q.creditNotes) ? (q.creditNotes as any[]).reduce((s, c) => s + (Number(c?.onAccount) || 0), 0) : 0;
  const held = Math.max((q.unappliedCredit ?? 0) - onAccount, 0);                       // prepaid money DEAR holds against this order
  const prepayment = Math.max(held - Math.max(reservedPrepay, 0), 0);                    // what still counts towards paying it
  let paid = (q.amountPaid ?? 0) + prepayment;
  if (q.amountDue != null && q.amountDue <= 0.005 && (q.invoicedTotal ?? 0) >= total - 0.005) paid = Math.max(paid, total);
  const remaining = settleCents(total, cents(Math.max(total - paid, 0)));
  if (remaining === 0) paid = Math.max(paid, total);   // within the tolerance: paid in full
  return { total: cents(total), paid: cents(paid), held: cents(held), remaining, payment: (remaining <= 0.005 ? 'paid' : paid > 0.005 ? 'part' : 'unpaid') as 'paid' | 'part' | 'unpaid' };
}

// Keep only rows whose next follow-up is the 1st, the 2nd, a date someone set, or none left ("done"), and/or overdue.
export function filterFollowUp<T extends { followUp: { next: { kind: string; date: string } | null } }>(rows: T[], fu: string | undefined, overdue: boolean, today: string): T[] {
  return rows.filter(r => {
    const kind = r.followUp.next?.kind ?? 'done';
    if (fu && ['fu1', 'fu2', 'manual', 'done'].includes(fu) && kind !== fu) return false;
    if (overdue && !(r.followUp.next && r.followUp.next.date < today)) return false;
    return true;
  });
}

export async function openQuotes(rep: Rep, regions?: string[]) {
  const accounts = await scope(rep, regions);
  // Customers set aside from Open Quotes altogether, quotes and orders (crm.accounts.skip_open_quotes: Metro Baby). Set by
  // open-quotes-exempt.sql. Before that column is added nobody is set aside.
  try { for (const r of await prisma.$queryRaw<{ id: string }[]>`select id from crm.accounts where skip_open_quotes`) accounts.delete(r.id); }
  catch (e) { /* the column has not been added yet */ }
  const accountIds = [...accounts.keys()];

  // Confirmed orders that are not fully paid, for any customer. Picked in the database so only those are read.
  const owing = accountIds.length
    ? await prisma.$queryRaw<{ id: string }[]>`
        select q.id from crm.quotes q join crm.accounts a on a.id = q.account_id
        left join lateral (
          select coalesce(sum(r.amount), 0) as taken from crm.credit_reservations r
          where r.source_kind = 'prepayment' and r.source_order = q.number
            and (r.status = 'reserved' or (r.status = 'used' and r.resolved_at > now() - interval '2 days'))
        ) rv on true
        where q.account_id = any(${accountIds}::uuid[])
          and q.source <> 'rhino-history' and q.number not like 'Q%' and q.misc_type is null
          and upper(coalesce(q.fulfillment_status, '')) not in ('VOIDED', 'CREDITED', 'DRAFT', 'ESTIMATING', 'ESTIMATED', 'ORDERING')
          and not (q.amount_due is null and q.paid)   -- no invoice detail yet, and DEAR has it as paid (the same fallback isOwing uses)
          and coalesce(q.total, q.amount) - (coalesce(q.amount_paid, 0) + greatest(greatest(coalesce(q.unapplied_credit, 0)
                - coalesce(case when jsonb_typeof(q.credit_notes) = 'array'
                                then (select sum(nullif(c->>'onAccount', '')::numeric) from jsonb_array_elements(q.credit_notes) c) end, 0), 0) - rv.taken, 0)) >= greatest(least(1, 0.01 * coalesce(q.total, q.amount)), 0.005)
          and not (q.amount_due is not null and q.amount_due <= 0.005 and coalesce(q.invoiced_total, 0) >= coalesce(q.total, q.amount) - 0.005)`
    : [];
  const quotes = await prisma.quote.findMany({
    where: {
      OR: [
        { id: { in: owing.map(r => r.id) } },
        { ...LIVE, accountId: { in: accountIds }, fulfillmentStatus: { in: QUOTE_STATUSES } },
      ],
    },
    orderBy: { sentAt: 'asc' },
    select: { id: true, number: true, accountId: true, sentAt: true, fulfillmentStatus: true, reference: true, total: true, amount: true, amountPaid: true, unappliedCredit: true, amountDue: true, invoicedTotal: true, creditNotes: true },
  });
  const ids = quotes.map(q => q.id);
  // Prepayments on these orders that have been reserved for another order (a use in the last 2 days counts until the sync catches up).
  const reservedBy = new Map<string, number>(quotes.length
    ? (await prisma.$queryRaw<{ number: string; taken: number }[]>`
        select source_order as number, sum(amount)::float8 as taken from crm.credit_reservations
        where source_kind = 'prepayment' and source_order = any(${quotes.map(q => q.number)}::text[])
          and (status = 'reserved' or (status = 'used' and resolved_at > now() - interval '2 days'))
        group by source_order`).map((r): [string, number] => [r.number, r.taken])
    : []);
  const [fuRows, notes] = await Promise.all([
    ids.length
      ? prisma.$queryRaw<{ id: string; follow_up_at: Date | null; fu1_done_on: Date | null; fu2_done_on: Date | null }[]>`
          select id, follow_up_at, fu1_done_on, fu2_done_on from crm.quotes where id = any(${ids}::uuid[])`
      : Promise.resolve([] as { id: string; follow_up_at: Date | null; fu1_done_on: Date | null; fu2_done_on: Date | null }[]),
    orderNoteSummary(ids),
  ]);
  const day = (d: Date | null) => (d ? new Date(d).toISOString().slice(0, 10) : null);   // date columns come back as midnight UTC
  type FuState = { manualOn: string | null; fu1DoneOn: string | null; fu2DoneOn: string | null };
  const fuById = new Map<string, FuState>(fuRows.map((r): [string, FuState] => [r.id, { manualOn: day(r.follow_up_at), fu1DoneOn: day(r.fu1_done_on), fu2DoneOn: day(r.fu2_done_on) }]));

  const rows = quotes.map(q => {
    const status = (q.fulfillmentStatus ?? '').toUpperCase();
    const confirmed = !QUOTE_STATUSES.includes(status);
    const pay = paymentState(q, reservedBy.get(q.number) ?? 0);
    const n = notes.get(q.id);
    return {
      id: q.id,
      number: q.number,
      accountId: q.accountId,
      customer: accounts.get(q.accountId)?.name ?? 'Unknown',
      region: accounts.get(q.accountId)?.region ?? '',
      repName: accounts.get(q.accountId)?.rep?.name ?? null,
      date: q.sentAt,
      ageDays: daysSince(q.sentAt),
      status,                                                       // DEAR's status
      confirmed,                                                    // false while it is still a quote or draft order
      stage: status === 'ORDERING' ? 'Draft order' : confirmed ? nice(status) : 'Quote',
      reference: q.reference,
      amount: pay.total,                                            // total, inc GST
      paid: pay.paid,                                               // paid so far, deposit and prepayments included
      remaining: pay.remaining,                                     // still to pay
      payment: pay.payment,                                         // unpaid, part (part paid) or paid
      followUp: followUpState(melDay(q.sentAt), fuById.get(q.id) ?? { manualOn: null, fu1DoneOn: null, fu2DoneOn: null }),
      noteCount: n?.noteCount ?? 0,
      lastNote: n?.lastNote ?? null,
    };
  })
  // It leaves only when it is both paid and confirmed.
  .filter(r => !(r.confirmed && r.payment === 'paid'));
  return {
    rows, count: rows.length,
    total: cents(rows.reduce((s, r) => s + r.amount, 0)),
    remaining: cents(rows.reduce((s, r) => s + r.remaining, 0)),
  };
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
type InvoiceDoc = { number: string | null; date: string | null; dueDate: string | null; total: number; paid: number; paidAt?: string | null; credited?: number; due?: number };

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
          paidAt: i.paidAt ?? null,
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