import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { territoryWhere } from '../lib/territory';
import { loadCarts } from './Abandonedcarts';

// Conversion: how much of the team's activity turns into business, in the Master Sales
// Terminology (Prospect, New Lead, Inactive Stockist P1 and P2). Four starting points, each
// followed to an Order and to a Sales Quote:
//   Abandoned cart        a B2B portal cart left behind
//   Prospect              a Prospect set up in DEAR in the period (now a New Lead)
//   Inactive Stockist P1  set up in DEAR earlier, never ordered. This is where the New Leads are counted:
//                         a New Lead is the same group, so it has no card of its own (it is still a status
//                         on the customer and elsewhere in the app)
//   Inactive Stockist P2  has ordered before, but not in the 12 months before the period
// "Order" = a finalised order (not a draft or quote, voided or fully credited). Shows the order no.
// "Sales Quote" = a sales quote that is still open: the order has NOT been finalised yet.
//   A quote that has become an order shows under Order only, never under Sales Quote.
// Only things dated on or after the starting point count, and up to the end of the chosen
// period (a day count ending now, a calendar month, or a fiscal quarter). DEAR's SQ number is
// the same record from quote to order, so every order was first a sales quote.
// The days matter as much as the counts. A prospect can take about 10 days to be set up in DEAR and a couple of months to
// place a first order, so a short period under-counts the recent ones. Every card therefore also says how long people took
// (the median days from the start to the order), and how many ordered within 30, 60 and 90 days of starting, counting only
// those who have had that long, so the percentages can be compared between periods. For Prospects, once the CRM has seen
// the moment a customer was linked to DEAR, it also splits the wait into "to set up in DEAR" and "from DEAR to the first
// order". For P1 and P2 it says how long the customer had been in DEAR, or since its previous order, when it ordered.
// Can be narrowed to some states (the customer's state; a cart not matched to a customer has
// no state, so it drops out when states are chosen). Every row carries the ids needed to open
// the customer, the order and the quote.

export const conversionRouter = Router();

const NOT_AN_ORDER = ['DRAFT', 'ESTIMATING', 'ESTIMATED', 'ORDERING', 'VOIDED', 'CREDITED'];
// Quote stages that are still open: issued, but the order is not finalised. (A DRAFT has not
// been issued yet, so it is not a Sales Quote here.)
const OPEN_QUOTE = ['ESTIMATING', 'ESTIMATED', 'ORDERING'];
const DAY = 86400000;

export const FUNNELS = [
  { key: 'abandoned_cart', title: 'Abandoned Cart → Order → Sales Quote',
    description: 'Track the conversions of activity to securing business' },
  { key: 'prospect', title: 'Prospect set up in DEAR → Order → Sales Quote',
    description: 'A Prospect set up in DEAR during the period (now a New Lead), with no order before that.' },
  { key: 'inactive_p1', title: 'Inactive Stockist P1 (Never Ordered) → Order → Sales Quote',
    description: 'Set up in DEAR before the period and never ordered. Includes the New Leads.', ageLabel: 'Days in DEAR before the first order' },
  { key: 'inactive_p2', title: 'Inactive Stockist P2 (Inactive 12+ Months) → Order → Sales Quote',
    description: 'Has ordered before, but not within the 12 months before the period.', ageLabel: 'Days since their previous order' },
] as const;

// Old links and bookmarks: the single Inactive Stockist card became P2, and the New Lead card was folded into P1.
const OLD_FUNNEL_KEYS: Record<string, string> = { inactive_stockist: 'inactive_p2', new_lead: 'inactive_p1' };
export const funnelKeyFor = (k: unknown): string => { const key = String(k ?? ''); return OLD_FUNNEL_KEYS[key] ?? key; };

export type ConvAccount = { id: string; name: string; region: string; repName: string | null; inDear: boolean; createdAt: Date; dearLinkedAt?: Date | null };
export type ConvQuote = { id: string; accountId: string; number: string; sentAt: Date; status: string; history: boolean };
export type ConvCart = { id: string; abandonedAt: Date; contact: string; email: string; value: number; accountId: string | null; accountName: string | null; repName: string | null };
export type ConvRow = {
  who: string; state: string; rep: string | null; started: Date; email?: string; cartValue?: number; accountId: string | null;
  orderId: string | null; orderNo: string | null; orderDate: Date | null; quoteId: string | null; quoteNo: string | null; quoteDate: Date | null;
  daysToOrder: number | null; daysToQuote: number | null;   // whole days from the start to the order / quote
  daysToDear?: number | null; daysDearToOrder?: number | null;   // Prospects, once the link to DEAR has been seen
  ageDays?: number | null;                                        // P1: days in DEAR before ordering. P2: days since the previous order
};
export type Timing = {
  medianDaysToOrder: number | null; averageDaysToOrder: number | null;
  within: { days: number; eligible: number; converted: number; pct: number | null }[];   // of those who have had that long
  dear?: { knownSetup: number; medianDaysToDear: number | null; knownOrder: number; medianDaysDearToOrder: number | null };
  age?: { label: string; known: number; medianDays: number | null };
};
export type Funnel = { key: string; title: string; description: string; started: number; orders: number; quotes: number; timing: Timing; rows: ConvRow[] };

const WINDOWS = [30, 60, 90];
const daysBetween = (a: Date, b: Date) => Math.max(0, Math.floor((b.getTime() - a.getTime()) / DAY));
const median = (xs: number[]): number | null => { if (!xs.length) return null; const s = [...xs].sort((x, y) => x - y), m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
const average = (xs: number[]): number | null => (xs.length ? Math.round(xs.reduce((t, v) => t + v, 0) / xs.length) : null);

const isOrder = (q: ConvQuote) => q.history || !NOT_AN_ORDER.includes(q.status.toUpperCase());
const isOpenQuote = (q: ConvQuote) => !q.history && OPEN_QUOTE.includes(q.status.toUpperCase());

// The pure calculation, kept apart from the database so it can be tested.
export function buildFunnels(input: { accounts: ConvAccount[]; quotes: ConvQuote[]; carts: ConvCart[]; from: Date; to: Date; regions?: string[] }): Funnel[] {
  const { quotes, from, to, regions } = input;
  const stateOk = (state: string) => !regions?.length || regions.includes(state);
  const accounts = input.accounts.filter(a => stateOk(a.region));
  const acct = new Map(input.accounts.map(a => [a.id, a]));
  // Carts abandoned within the period; with states chosen, only carts matched to a customer in them.
  const carts = input.carts.filter(c => c.abandonedAt >= from && c.abandonedAt <= to && (!regions?.length || (c.accountId != null && acct.has(c.accountId) && stateOk(acct.get(c.accountId)!.region))));
  const byAccount = new Map<string, ConvQuote[]>();
  for (const q of [...quotes].sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime())) {
    byAccount.set(q.accountId, [...(byAccount.get(q.accountId) ?? []), q]);
  }
  const mine = (id: string | null) => (id ? byAccount.get(id) ?? [] : []);
  const firstFrom = (id: string | null, since: Date, test: (q: ConvQuote) => boolean) =>
    mine(id).find(q => test(q) && q.sentAt >= since && q.sentAt <= to) ?? null;

  const row = (who: string, state: string, rep: string | null, started: Date, accountId: string | null, extra: Partial<ConvRow> = {}): ConvRow => {
    const o = firstFrom(accountId, started, isOrder);
    const s = firstFrom(accountId, started, isOpenQuote);
    return {
      who, state, rep, started, accountId,
      orderId: o?.id ?? null, orderNo: o?.number ?? null, orderDate: o?.sentAt ?? null,
      quoteId: s?.id ?? null, quoteNo: s?.number ?? null, quoteDate: s?.sentAt ?? null,
      daysToOrder: o ? daysBetween(started, o.sentAt) : null, daysToQuote: s ? daysBetween(started, s.sentAt) : null, ...extra,
    };
  };

  const inactiveBefore = new Date(from.getTime() - 365 * DAY);
  const rows: Record<string, ConvRow[]> = { abandoned_cart: [], prospect: [], inactive_p1: [], inactive_p2: [] };

  for (const c of carts) {
    rows.abandoned_cart.push(row(c.accountName ?? c.contact ?? c.email, '', c.repName, c.abandonedAt, c.accountId, { email: c.email, cartValue: c.value }));
  }
  for (const a of accounts) {
    if (!a.inDear) continue;
    const past = mine(a.id).filter(q => isOrder(q) && q.sentAt < from);
    // Genuinely new: set up in the period, and never ordered before that. (An old DEAR
    // customer the CRM only just picked up, with past orders, is not a new prospect.)
    const orderedBeforeSetup = mine(a.id).some(q => isOrder(q) && q.sentAt < a.createdAt);
    if (a.createdAt >= from && a.createdAt <= to) {
      if (!orderedBeforeSetup) {
        const r = row(a.name, a.region, a.repName, a.createdAt, a.id);
        // Added to the CRM, then set up in DEAR, then the first order: where the wait went, once the link has been seen.
        if (a.dearLinkedAt) {
          r.daysToDear = daysBetween(a.createdAt, a.dearLinkedAt);
          r.daysDearToOrder = r.orderDate ? daysBetween(a.dearLinkedAt, r.orderDate) : null;
        }
        rows.prospect.push(r);
      }
    } else if (a.createdAt < from && past.length === 0) {
      // In DEAR before the period and never ordered: P1 (the New Leads are in here too).
      const r = row(a.name, a.region, a.repName, from, a.id);
      r.ageDays = r.orderDate ? daysBetween(a.createdAt, r.orderDate) : null;
      rows.inactive_p1.push(r);
    }
    if (past.length > 0 && !past.some(q => q.sentAt >= inactiveBefore)) {
      const r = row(a.name, a.region, a.repName, from, a.id);
      r.ageDays = r.orderDate ? daysBetween(past[past.length - 1].sentAt, r.orderDate) : null;
      rows.inactive_p2.push(r);
    }
  }
  // States for the cart rows come from the customers list.
  for (const [i, c] of carts.entries()) if (c.accountId && acct.has(c.accountId)) rows.abandoned_cart[i].state = acct.get(c.accountId)!.region;

  return FUNNELS.map(f => {
    const r = rows[f.key];
    const days = r.filter(x => x.daysToOrder !== null).map(x => x.daysToOrder!);
    const timing: Timing = {
      medianDaysToOrder: median(days), averageDaysToOrder: average(days),
      // Only those who have had the whole window inside the period are counted, so a customer started last week is not held against the 30 days.
      within: WINDOWS.map(w => {
        const eligible = r.filter(x => x.started.getTime() + w * DAY <= to.getTime());
        const converted = eligible.filter(x => x.orderDate && x.orderDate.getTime() - x.started.getTime() <= w * DAY).length;
        return { days: w, eligible: eligible.length, converted, pct: eligible.length ? Math.round((converted / eligible.length) * 1000) / 10 : null };
      }),
    };
    if (f.key === 'prospect') {
      const setup = r.filter(x => x.daysToDear != null).map(x => x.daysToDear!), after = r.filter(x => x.daysDearToOrder != null).map(x => x.daysDearToOrder!);
      timing.dear = { knownSetup: setup.length, medianDaysToDear: median(setup), knownOrder: after.length, medianDaysDearToOrder: median(after) };
    }
    if ('ageLabel' in f && f.ageLabel) {
      const ages = r.filter(x => x.ageDays != null).map(x => x.ageDays!);
      timing.age = { label: f.ageLabel, known: ages.length, medianDays: median(ages) };
    }
    const { ageLabel, ...meta } = f as typeof f & { ageLabel?: string };
    return { ...meta, started: r.length, orders: r.filter(x => x.orderNo).length, quotes: r.filter(x => x.quoteNo).length, timing, rows: r };
  });
}

// The Excel workbook for Conversion: a summary (counts, percentages and the days), one sheet per card with every customer,
// and a note on how the days work. xlDate turns a date into what the sheet shows.
export function conversionSheets(r: { from: Date; to: Date; funnels: Funnel[] }, xlDate: (d: Date | null | undefined) => string): { name: string; rows: Record<string, unknown>[] }[] {
  const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : 0);
  const blank = (v: number | null | undefined) => (v === null || v === undefined ? '' : v);
  // Every row has the same columns, so the sheet lines up whichever funnels have data.
  const summary = r.funnels.map(f => ({
    Funnel: f.title, 'How it is counted': f.description,
    Started: f.started, Order: f.orders, 'Order %': pct(f.orders, f.started),
    'Sales Quote': f.quotes, 'Sales Quote %': pct(f.quotes, f.started),
    'Median days to order': blank(f.timing.medianDaysToOrder), 'Average days to order': blank(f.timing.averageDaysToOrder),
    ...Object.fromEntries(f.timing.within.map(w => [`Ordered within ${w.days} days %`, blank(w.pct)])),
    ...Object.fromEntries(f.timing.within.map(w => [`Started at least ${w.days} days before the end`, w.eligible])),
    'Median days to set up in DEAR (Prospects)': blank(f.timing.dear?.medianDaysToDear),
    'Median days from DEAR to the first order (Prospects)': blank(f.timing.dear?.medianDaysDearToOrder),
    'Median of the extra measure (P1: days in DEAR before ordering, P2: days since the previous order)': blank(f.timing.age?.medianDays),
    'Period from': xlDate(r.from), 'Period to': xlDate(r.to),
  }));
  const detail = (key: string) => {
    const f = r.funnels.find(x => x.key === key);
    return (f?.rows ?? []).map(x => ({
      Customer: x.who, State: x.state, Rep: x.rep ?? '', 'Started on': xlDate(x.started),
      ...(x.email !== undefined ? { Email: x.email, 'Cart value': x.cartValue ?? 0 } : {}),
      Order: x.orderNo ?? '', 'Order date': xlDate(x.orderDate), 'Days to order': blank(x.daysToOrder),
      'Sales Quote': x.quoteNo ?? '', 'Sales Quote date': xlDate(x.quoteDate), 'Days to quote': blank(x.daysToQuote),
      ...(key === 'prospect' ? { 'Days to set up in DEAR': blank(x.daysToDear), 'Days from DEAR to the order': blank(x.daysDearToOrder) } : {}),
      ...(f?.timing.age ? { [f.timing.age.label]: blank(x.ageDays) } : {}),
    }));
  };
  const sheets: { name: string; rows: Record<string, unknown>[] }[] = [
    { name: 'Summary', rows: summary },
    { name: 'Abandoned carts', rows: detail('abandoned_cart') },
    { name: 'Prospects added to DEAR', rows: detail('prospect') },
    { name: 'Inactive P1 (never ordered)', rows: detail('inactive_p1') },
    { name: 'Inactive P2 (12+ months)', rows: detail('inactive_p2') },
  ].map(sh => (sh.rows.length ? sh : { ...sh, rows: [{ Note: 'None in this period' }] }));
  sheets.push({ name: 'How the days work', rows: [
    { Note: 'Days run from when each one started to the order. Abandoned cart: the day the cart was left. Prospect: the day the customer was added to the CRM. P1 and P2: the first day of the period.' },
    { Note: '"Ordered within N days" counts only those who have had N days before the end of the period, so a customer who started last week is not held against the 30 days. That keeps the percentages comparable between periods.' },
    { Note: 'Days to set up in DEAR are known from the day the CRM first saw the customer linked to DEAR, so they fill in as new prospects are linked. Earlier prospects show nothing there.' },
  ] });
  return sheets;
}

// ---- The period ----
// Either ?days=90 (the last N days, ending now) or ?from=2026-07-01&to=2026-09-30 (whole days,
// Melbourne time: a calendar month or a fiscal quarter). A period that ends in the future is
// cut off at now.
const MEL = 'Australia/Melbourne';
function melbourneOffsetMinutes(at: Date): number {
  const parts = new Intl.DateTimeFormat('en-AU', { timeZone: MEL, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(at);
  const g = (t: string) => Number(parts.find(x => x.type === t)!.value);
  return Math.round((Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - Math.floor(at.getTime() / 1000) * 1000) / 60000);
}
export function melbourneDayStart(ymd: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  const midnightUtc = Date.UTC(y, m - 1, d);
  const guess = midnightUtc - melbourneOffsetMinutes(new Date(midnightUtc + 2 * 3600000)) * 60000;   // offset around noon
  return new Date(midnightUtc - melbourneOffsetMinutes(new Date(guess)) * 60000);                    // then at that very moment
}
export function parsePeriod(q: Record<string, unknown>): { from: Date; to: Date; days: number } {
  const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
  const now = new Date();
  if (isDay(q.from) && isDay(q.to)) {
    const from = melbourneDayStart(q.from);
    let to = new Date(melbourneDayStart(q.to).getTime() + 86400000 - 1);
    if (to > now) to = now;
    if (from > to) throw new Error('That period starts after it ends');
    if (to.getTime() - from.getTime() > 800 * DAY) throw new Error('That period is too long (the most is about two years)');
    return { from, to, days: Math.max(1, Math.round((to.getTime() - from.getTime()) / DAY)) };
  }
  const days = Math.min(365, Math.max(7, Math.round(Number(q.days)) || 90));
  return { from: new Date(now.getTime() - days * DAY), to: now, days };
}
export const regionsOf = (v: unknown) => (typeof v === 'string' && v ? v.split(',').map(x => x.trim()).filter(Boolean) : undefined);

// Fetches what the calculation needs, for what this person can see.
export async function computeConversion(rep: { id: string; role: string }, opts: { from: Date; to: Date; regions?: string[] }) {
  const { from, to, regions } = opts;
  const scope: any = { AND: [await territoryWhere(rep as any), { archived: false, misc: false }] };
  const daysBack = String(Math.ceil((Date.now() - from.getTime()) / DAY) + 1);

  // When each customer was linked to DEAR (crm.accounts.dear_linked_at, added by conversion-days.sql and filled by the sync).
  const linked = new Map<string, Date>();
  try { for (const r of await prisma.$queryRaw<{ id: string; at: Date }[]>`select id, dear_linked_at as at from crm.accounts where dear_linked_at is not null`) linked.set(r.id, new Date(r.at)); }
  catch (e) { /* the column has not been added yet: the days to DEAR just are not known */ }
  const [accountRows, quoteRows, carts] = await Promise.all([
    prisma.account.findMany({
      where: scope,
      select: { id: true, name: true, region: true, dearCustomerId: true, createdAt: true, rep: { select: { name: true } } },
    }),
    prisma.quote.findMany({
      where: { miscType: null, account: scope },
      select: { id: true, accountId: true, number: true, sentAt: true, fulfillmentStatus: true, source: true },
    }),
    loadCarts(rep, daysBack),
  ]);

  const funnels = buildFunnels({
    from, to, regions,
    accounts: accountRows.map(a => ({
      id: a.id, name: a.name, region: a.region, repName: a.rep?.name ?? null,
      inDear: !!a.dearCustomerId, createdAt: a.createdAt, dearLinkedAt: linked.get(a.id) ?? null,
    })),
    quotes: quoteRows.map(q => ({
      id: q.id, accountId: q.accountId, number: q.number, sentAt: q.sentAt, status: q.fulfillmentStatus ?? '',
      history: q.source === 'rhino-history' || q.number.startsWith('Q'),
    })),
    carts: carts.map(c => ({
      id: c.id, abandonedAt: c.abandonedAt, contact: c.contact, email: c.email, value: c.value,
      accountId: c.account?.id ?? null, accountName: c.account?.name ?? null, repName: c.account?.rep ?? null,
    })),
  });
  return { from, to, funnels };
}

// GET /conversion?days=90            or  ?from=2026-07-01&to=2026-09-30     (a month, a fiscal quarter)
//     &region=NSW,ACT                 only these states
//     &funnel=prospect&detail=1       one funnel with every customer in it (to open them)
conversionRouter.get('/', async (req, res) => {
  try {
    const { from, to, days } = parsePeriod(req.query);
    const r = await computeConversion(req.rep!, { from, to, regions: regionsOf(req.query.region) });
    const base = { days, from: r.from, to: r.to };
    if (req.query.detail === '1') {
      const key = funnelKeyFor(req.query.funnel);
      const f = r.funnels.find(x => x.key === key);
      if (!f) return res.status(400).json({ error: 'Unknown funnel' });
      return res.json({ ...base, funnel: f });
    }
    res.json({ ...base, funnels: r.funnels.map(({ rows, ...f }) => f) });
  } catch (e) {
    const msg = (e as Error).message;
    const mine = /period|starts after|too long/.test(msg);
    if (!mine) console.error('conversion failed', e);
    res.status(mine ? 400 : 500).json({ error: msg });
  }
});