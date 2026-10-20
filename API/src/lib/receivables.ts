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
    select: { id: true, name: true, region: true, paymentTerms: true, repId: true, rep: { select: { name: true } } },
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

// Follow-ups on an open quote.
//   - The 1st is automatic: a week after payment was due. For a customer who pays first that is the order date; for a customer on
//     terms it is the due date of their unpaid invoice (followUpAnchor).
//   - There is no automatic 2nd. The sales team sets it by choosing a date (secondOn), and it is shown as the 2nd.
// The next follow-up shown is whichever pending one is earliest (the 1st wins a tie). Done ones drop out; none left is "done".
// secondRep: the rep the sales team asked to follow up the 2nd (crm.quotes.follow_up_rep_id); null when nobody was chosen.
export type FollowUp = {
  fu1Due: string; fu1DoneOn: string | null; fu2DoneOn: string | null; secondOn: string | null;
  secondRep: { id: string; name: string } | null;
  next: { kind: 'fu1' | 'fu2'; date: string } | null;
};
export function followUpState(anchorDay: string, f: { manualOn: string | null; fu1DoneOn: string | null; fu2DoneOn: string | null }, secondRep: { id: string; name: string } | null = null): FollowUp {
  const fu1Due = plusDays(anchorDay, 7);
  const first = f.fu1DoneOn ? null : { kind: 'fu1' as const, date: fu1Due };
  const second = f.manualOn ? { kind: 'fu2' as const, date: f.manualOn } : null;   // the date the team set: manualOn is the column's name
  const next: FollowUp['next'] = first && second ? (second.date < first.date ? second : first) : first ?? second;
  return { fu1Due, fu1DoneOn: f.fu1DoneOn, fu2DoneOn: f.fu2DoneOn, secondOn: f.manualOn, secondRep: f.manualOn ? secondRep : null, next };
}

// Who the sales team asked to follow up each order's 2nd (crm.quotes.follow_up_rep_id, added by follow-up-rep.sql). Before that
// column is added nobody is assigned and everything else still works.
export async function followUpReps(ids: string[]): Promise<Map<string, { id: string; name: string }>> {
  if (!ids.length) return new Map();
  try {
    const rows = await prisma.$queryRaw<{ id: string; rep_id: string; name: string }[]>`
      select q.id, r.id as rep_id, r.name from crm.quotes q join crm.reps r on r.id = q.follow_up_rep_id where q.id = any(${ids}::uuid[])`;
    return new Map(rows.map((r): [string, { id: string; name: string }] => [r.id, { id: r.rep_id, name: r.name }]));
  } catch (e) { return new Map(); }
}

// Keep only the orders a given rep has something to follow up on (row.involves): the rep the team gave the 2nd to, and the
// customer's own rep while the 1st is still to do (or when nobody else was given the 2nd).
export function filterFollowUpBy<T>(rows: T[], repId: string | undefined): T[] {
  return repId ? rows.filter(r => ((r as { involves?: string[] }).involves ?? []).includes(repId)) : rows;
}

// The day payment was due, which the 1st follow-up counts a week from: the earliest due date among the order's unpaid invoices
// (a draft, voided or cancelled invoice is ignored), otherwise the order date, because a customer who pays first owes it at once.
const DEAD_INVOICE = /^(void|delet|cancel|draft)/i;
export function followUpAnchor(sentAt: Date | string, invoices: unknown): string {
  const due = (Array.isArray(invoices) ? invoices : [])
    .filter((i: any) => !DEAD_INVOICE.test(String(i?.status ?? '').trim()) && Number(i?.due) > 0.005 && /^\d{4}-\d{2}-\d{2}/.test(String(i?.dueDate ?? '')))
    .map((i: any) => String(i.dueDate).slice(0, 10))
    .sort();
  return due[0] ?? melDay(sentAt);
}

// ---------- Open quotes and unpaid orders ----------
// Everything still waiting on the customer, oldest first:
//   - every quote or draft order, paid or not, until it is confirmed in DEAR; and
//   - every confirmed order (ordered, backordered, picking, shipped...) that is not fully paid, until its money is in.
// Which customers: by their payment terms, chosen with a filter. The default is the prepayment customers (no terms on record,
// terms that say Prepayment, or an account set to pay before dispatch: all labelled "Prepayment", the same meaning as on the
// account page and in Marketing). Ticking other terms (30 days, 30 Days EOM...) adds those customers. A customer can also be
// set aside by hand (skip_open_quotes), whatever is ticked.
// An order leaves only when it is BOTH paid and confirmed. Marketing and warranty orders never come in.
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

// Keep only rows whose next follow-up is the 1st, the 2nd, or none left ("done"), and/or overdue. 'manual' (what the 2nd was
// once called) still works as the 2nd.
export function filterFollowUp<T extends { followUp: { next: { kind: string; date: string } | null } }>(rows: T[], fu: string | undefined, overdue: boolean, today: string): T[] {
  return rows.filter(r => {
    const kind = r.followUp.next?.kind ?? 'done';
    const want = fu === 'manual' ? 'fu2' : fu;
    if (want && ['fu1', 'fu2', 'done'].includes(want) && kind !== want) return false;
    if (overdue && !(r.followUp.next && r.followUp.next.date < today)) return false;
    return true;
  });
}

export const PREPAYMENT = 'Prepayment';
// A customer's payment-terms label: every pay-first customer is "Prepayment", the rest keep their own wording.
export const termsLabel = (terms: string | null | undefined, credit: string | null | undefined) => {
  const t = String(terms ?? '').trim();
  return !t || /prepay/i.test(t) || credit === 'prepay' ? PREPAYMENT : t;
};

// terms: which customers to include by payment terms. Left out = the default, Prepayment customers only. 'all' = every customer.
// Otherwise the list of labels to include (an empty list includes nobody).
export async function openQuotes(rep: Rep, regions?: string[], terms?: string[] | 'all') {
  const accounts = await scope(rep, regions);
  const termsOf = accounts.size
    ? await prisma.$queryRaw<{ id: string; payment_terms: string | null; credit: string | null }[]>`
        select id, payment_terms, credit::text as credit from crm.accounts where id = any(${[...accounts.keys()]}::uuid[])`
    : [];
  const labelById = new Map<string, string>(termsOf.map((r): [string, string] => [r.id, termsLabel(r.payment_terms, r.credit)]));
  const termOptions = [...new Set(labelById.values())].sort((x, y) => (x === PREPAYMENT ? -1 : y === PREPAYMENT ? 1 : x.localeCompare(y)));
  const selected = terms === 'all' ? termOptions : terms ?? [PREPAYMENT];
  for (const [id, label] of labelById) if (!selected.includes(label)) accounts.delete(id);
  // Customers set aside by hand as well (crm.accounts.skip_open_quotes, added by open-quotes-exempt.sql), whatever is ticked.
  // Before that column is added nobody is set aside this way.
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
  const [fuRows, notes, repOf, repOptions] = await Promise.all([
    ids.length
      ? prisma.$queryRaw<{ id: string; follow_up_at: Date | null; fu1_done_on: Date | null; fu2_done_on: Date | null; invoices: unknown }[]>`
          select id, follow_up_at, fu1_done_on, fu2_done_on, invoices from crm.quotes where id = any(${ids}::uuid[])`
      : Promise.resolve([] as { id: string; follow_up_at: Date | null; fu1_done_on: Date | null; fu2_done_on: Date | null; invoices: unknown }[]),
    orderNoteSummary(ids),
    followUpReps(ids),
    prisma.$queryRaw<{ id: string; name: string }[]>`select id, name from crm.reps order by name`,   // for the "followed up by" choice
  ]);
  const day = (d: Date | null) => (d ? new Date(d).toISOString().slice(0, 10) : null);   // date columns come back as midnight UTC
  type FuState = { manualOn: string | null; fu1DoneOn: string | null; fu2DoneOn: string | null };
  const invoicesById = new Map<string, unknown>(fuRows.map((r): [string, unknown] => [r.id, r.invoices]));
  const fuById = new Map<string, FuState>(fuRows.map((r): [string, FuState] => [r.id, { manualOn: day(r.follow_up_at), fu1DoneOn: day(r.fu1_done_on), fu2DoneOn: day(r.fu2_done_on) }]));

  const rows = quotes.map(q => {
    const status = (q.fulfillmentStatus ?? '').toUpperCase();
    const confirmed = !QUOTE_STATUSES.includes(status);
    const pay = paymentState(q, reservedBy.get(q.number) ?? 0);
    const n = notes.get(q.id);
    const followUp = followUpState(followUpAnchor(q.sentAt, invoicesById.get(q.id)), fuById.get(q.id) ?? { manualOn: null, fu1DoneOn: null, fu2DoneOn: null }, repOf.get(q.id) ?? null);
    const acct = accounts.get(q.accountId);
    // Who is to follow it up: the rep the team chose for the 2nd, otherwise the customer's own rep.
    const followUpBy = followUp.next?.kind === 'fu2' && followUp.secondRep ? { ...followUp.secondRep, set: true } : { id: acct?.repId ?? null, name: acct?.rep?.name ?? null, set: false };
    // Everyone with something to do on it: the rep given the 2nd, and the account rep while the 1st is pending or when nobody else has it.
    const involves = [...new Set([
      ...(followUp.secondOn && followUp.secondRep ? [followUp.secondRep.id] : []),
      ...(acct?.repId && (!followUp.fu1DoneOn || !(followUp.secondOn && followUp.secondRep)) ? [acct.repId] : []),
    ])];
    return {
      id: q.id,
      number: q.number,
      accountId: q.accountId,
      customer: accounts.get(q.accountId)?.name ?? 'Unknown',
      region: accounts.get(q.accountId)?.region ?? '',
      repName: accounts.get(q.accountId)?.rep?.name ?? null,
      terms: labelById.get(q.accountId) ?? PREPAYMENT,               // the customer's payment terms (every pay-first customer is Prepayment)
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
      followUp,
      followUpBy,                                                   // who is to do the next one (the screen's column)
      involves,                                                     // every rep with something to do on it (the screen's filter)
      accountRepId: acct?.repId ?? null,
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
    terms: selected, termOptions,   // which payment terms are included, and every wording there is, for the filter
    repOptions,                     // every rep, for choosing who follows up
  };
}

// What one person is to chase, for their Dashboard: the orders whose next follow-up is overdue or due in the next `days` days and
// that are theirs to do:
//   - every follow-up the sales team gave them (the 2nd with their name on it), for any customer, wherever the customer is; and
//   - the 1st follow-up on their own customers' prepayment orders (the same customers the Open quotes screen starts with).
// A customer on terms only appears when it was given to them by name. Done ones are not listed. Most overdue first.
export async function myFollowUps(rep: Rep, today: string = melDay(), days = 7) {
  const all = await openQuotes({ ...rep, role: 'manager' } as Rep, undefined, 'all');   // not limited to their states: it was given to them
  const limit = plusDays(today, days);
  // What this person has to do on one order: the 2nd the team gave them (whatever else is pending), or the 1st on their own
  // customer's prepayment order. If both, the earlier one.
  const mineOn = (r: (typeof all.rows)[number]) => {
    const items: { kind: 'fu1' | 'fu2'; date: string; assigned: boolean }[] = [];
    if (r.followUp.secondOn && r.followUp.secondRep?.id === rep.id) items.push({ kind: 'fu2', date: r.followUp.secondOn, assigned: true });
    if (!r.followUp.fu1DoneOn && r.accountRepId === rep.id && r.terms === PREPAYMENT) items.push({ kind: 'fu1', date: r.followUp.fu1Due, assigned: false });
    return items.sort((a, b) => a.date.localeCompare(b.date) || Number(b.assigned) - Number(a.assigned))[0] ?? null;
  };
  const rows = all.rows
    .map(r => ({ r, mine: mineOn(r) }))
    .filter((x): x is { r: (typeof all.rows)[number]; mine: NonNullable<ReturnType<typeof mineOn>> } => !!x.mine && x.mine.date <= limit)
    .sort((a, b) => a.mine.date.localeCompare(b.mine.date) || b.r.ageDays - a.r.ageDays)
    .map(({ r, mine }) => ({
      id: r.id, number: r.number, accountId: r.accountId, customer: r.customer, region: r.region, stage: r.stage, terms: r.terms,
      amount: r.amount, remaining: r.remaining, payment: r.payment, ageDays: r.ageDays, noteCount: r.noteCount, lastNote: r.lastNote,
      followUp: { next: { kind: mine.kind, date: mine.date }, secondRep: r.followUp.secondRep },
      assigned: mine.assigned,   // true when the sales team gave it to this person by name
    }));
  return {
    repId: rep.id, days, today, rows, count: rows.length,
    overdue: rows.filter(r => r.followUp.next.date < today).length,
    dueToday: rows.filter(r => r.followUp.next.date === today).length,
    assigned: rows.filter(r => r.assigned).length,
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