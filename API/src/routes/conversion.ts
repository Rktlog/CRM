import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { territoryWhere } from '../lib/territory';
import { loadCarts } from './Abandonedcarts';

// Conversion: how much of the team's activity turns into business, in the Master Sales
// Terminology (Prospect, New Lead, Inactive Stockist P1 and P2). Five starting points, each
// followed to an Order and to a Sales Quote:
//   Abandoned cart        a B2B portal cart left behind
//   Prospect              a Prospect set up in DEAR in the period (now a New Lead)
//   New Lead              set up in DEAR earlier, worked by the team, never ordered
//   Inactive Stockist P1  set up in DEAR earlier, never ordered (includes the New Leads)
//   Inactive Stockist P2  has ordered before, but not in the 12 months before the period
// "Order" = a finalised order (not a draft or quote, voided or fully credited). Shows the order no.
// "Sales Quote" = a sales quote that is still open: the order has NOT been finalised yet.
//   A quote that has become an order shows under Order only, never under Sales Quote.
// Only things dated on or after the starting point count, and up to the end of the chosen
// period (a day count ending now, a calendar month, or a fiscal quarter). DEAR's SQ number is
// the same record from quote to order, so every order was first a sales quote.
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
  { key: 'new_lead', title: 'New Lead → Order → Sales Quote',
    description: 'Set up in DEAR before the period, being worked toward a first order, and never ordered.' },
  { key: 'inactive_p1', title: 'Inactive Stockist P1 (Never Ordered) → Order → Sales Quote',
    description: 'Set up in DEAR before the period and never ordered. Includes the New Leads.' },
  { key: 'inactive_p2', title: 'Inactive Stockist P2 (Inactive 12+ Months) → Order → Sales Quote',
    description: 'Has ordered before, but not within the 12 months before the period.' },
] as const;

export type ConvAccount = { id: string; name: string; region: string; repName: string | null; inDear: boolean; createdAt: Date; hasActivity: boolean };
export type ConvQuote = { id: string; accountId: string; number: string; sentAt: Date; status: string; history: boolean };
export type ConvCart = { id: string; abandonedAt: Date; contact: string; email: string; value: number; accountId: string | null; accountName: string | null; repName: string | null };
export type ConvRow = {
  who: string; state: string; rep: string | null; started: Date; email?: string; cartValue?: number; accountId: string | null;
  orderId: string | null; orderNo: string | null; orderDate: Date | null; quoteId: string | null; quoteNo: string | null; quoteDate: Date | null;
};
export type Funnel = { key: string; title: string; description: string; started: number; orders: number; quotes: number; rows: ConvRow[] };

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
      quoteId: s?.id ?? null, quoteNo: s?.number ?? null, quoteDate: s?.sentAt ?? null, ...extra,
    };
  };

  const inactiveBefore = new Date(from.getTime() - 365 * DAY);
  const rows: Record<string, ConvRow[]> = { abandoned_cart: [], prospect: [], new_lead: [], inactive_p1: [], inactive_p2: [] };

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
      if (!orderedBeforeSetup) rows.prospect.push(row(a.name, a.region, a.repName, a.createdAt, a.id));
    } else if (a.createdAt < from && past.length === 0) {
      // In DEAR before the period and never ordered: P1. The ones the team has worked are New Leads.
      rows.inactive_p1.push(row(a.name, a.region, a.repName, from, a.id));
      if (a.hasActivity) rows.new_lead.push(row(a.name, a.region, a.repName, from, a.id));
    }
    if (past.length > 0 && !past.some(q => q.sentAt >= inactiveBefore)) {
      rows.inactive_p2.push(row(a.name, a.region, a.repName, from, a.id));
    }
  }
  // States for the cart rows come from the customers list.
  for (const [i, c] of carts.entries()) if (c.accountId && acct.has(c.accountId)) rows.abandoned_cart[i].state = acct.get(c.accountId)!.region;

  return FUNNELS.map(f => {
    const r = rows[f.key];
    return { ...f, started: r.length, orders: r.filter(x => x.orderNo).length, quotes: r.filter(x => x.quoteNo).length, rows: r };
  });
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

  const [accountRows, quoteRows, carts] = await Promise.all([
    prisma.account.findMany({
      where: scope,
      select: { id: true, name: true, region: true, dearCustomerId: true, createdAt: true, rep: { select: { name: true } }, _count: { select: { activity: true } } },
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
      inDear: !!a.dearCustomerId, createdAt: a.createdAt, hasActivity: a._count.activity > 0,
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
      const key = req.query.funnel === 'inactive_stockist' ? 'inactive_p2' : req.query.funnel;   // old links
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