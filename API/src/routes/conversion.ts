import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { territoryWhere } from '../lib/territory';
import { loadCarts } from './Abandonedcarts';
// Conversion: how much of the team's activity turns into business.
// Four starting points, each followed to an Order and to a Sales Quote:
//   Abandoned cart   a B2B portal cart left behind
//   Prospect         a new customer record set up in DEAR in the period
//   New lead         set up in DEAR earlier, worked by the team, no order yet
//   Inactive stockist  has ordered before, but not in the 12 months before the period
// "Order" = a confirmed order (not a draft or quote, voided or fully credited).
// "Sales Quote" = a sales quote was raised (open, or since turned into an order).
// Only things dated on or after the starting point count. DEAR's SQ number is the
// same record from quote to order, so every order was first a sales quote.

export const conversionRouter = Router();

const NOT_AN_ORDER = ['DRAFT', 'ESTIMATING', 'ESTIMATED', 'ORDERING', 'VOIDED', 'CREDITED'];
const NO_QUOTE = ['DRAFT', 'VOIDED', 'CREDITED'];
const DAY = 86400000;

export const FUNNELS = [
  { key: 'abandoned_cart', title: 'Abandoned Cart → Order → Sales Quote',
    description: 'Track the conversions of activity to securing business' },
  { key: 'prospect', title: 'Prospect added to DEAR → Order → Sales Quote',
    description: 'Identified potential customer — enquiry, referral or outbound opportunity. Not yet set up in DEAR; no order placed.' },
  { key: 'new_lead', title: 'New Lead → Order → Sales Quote',
    description: 'Engaged prospect, set up in DEAR, being actively worked toward a first order.' },
  { key: 'inactive_stockist', title: 'Inactive Stockist → Order → Sales Quote',
    description: 'Has ordered before but not within the past 12 months.' },
] as const;

export type ConvAccount = { id: string; name: string; region: string; repName: string | null; inDear: boolean; createdAt: Date; hasActivity: boolean };
export type ConvQuote = { accountId: string; number: string; sentAt: Date; status: string; history: boolean };
export type ConvCart = { id: string; abandonedAt: Date; contact: string; email: string; value: number; accountId: string | null; accountName: string | null; repName: string | null };
export type ConvRow = {
  who: string; state: string; rep: string | null; started: Date; email?: string; cartValue?: number;
  orderNo: string | null; orderDate: Date | null; quoteNo: string | null; quoteDate: Date | null;
};
export type Funnel = { key: string; title: string; description: string; started: number; orders: number; quotes: number; rows: ConvRow[] };

const isOrder = (q: ConvQuote) => q.history || !NOT_AN_ORDER.includes(q.status.toUpperCase());
const isQuote = (q: ConvQuote) => !q.history && !NO_QUOTE.includes(q.status.toUpperCase());

// The pure calculation, kept apart from the database so it can be tested.
export function buildFunnels(input: { accounts: ConvAccount[]; quotes: ConvQuote[]; carts: ConvCart[]; from: Date; to: Date }): Funnel[] {
  const { accounts, quotes, carts, from, to } = input;
  const byAccount = new Map<string, ConvQuote[]>();
  for (const q of [...quotes].sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime())) {
    byAccount.set(q.accountId, [...(byAccount.get(q.accountId) ?? []), q]);
  }
  const mine = (id: string | null) => (id ? byAccount.get(id) ?? [] : []);
  const firstFrom = (id: string | null, since: Date, test: (q: ConvQuote) => boolean) =>
    mine(id).find(q => test(q) && q.sentAt >= since && q.sentAt <= to) ?? null;

  const row = (who: string, state: string, rep: string | null, started: Date, accountId: string | null, extra: Partial<ConvRow> = {}): ConvRow => {
    const o = firstFrom(accountId, started, isOrder);
    const s = firstFrom(accountId, started, isQuote);
    return { who, state, rep, started, orderNo: o?.number ?? null, orderDate: o?.sentAt ?? null, quoteNo: s?.number ?? null, quoteDate: s?.sentAt ?? null, ...extra };
  };

  const inactiveBefore = new Date(from.getTime() - 365 * DAY);
  const rows: Record<string, ConvRow[]> = { abandoned_cart: [], prospect: [], new_lead: [], inactive_stockist: [] };

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
    } else if (a.createdAt < from && a.hasActivity && past.length === 0) {
      rows.new_lead.push(row(a.name, a.region, a.repName, from, a.id));
    }
    if (past.length > 0 && !past.some(q => q.sentAt >= inactiveBefore)) {
      rows.inactive_stockist.push(row(a.name, a.region, a.repName, from, a.id));
    }
  }
  // Account names and states for the cart rows come from the accounts list.
  const acct = new Map(accounts.map(a => [a.id, a]));
  for (const [i, c] of carts.entries()) if (c.accountId && acct.has(c.accountId)) rows.abandoned_cart[i].state = acct.get(c.accountId)!.region;

  return FUNNELS.map(f => {
    const r = rows[f.key];
    return { ...f, started: r.length, orders: r.filter(x => x.orderNo).length, quotes: r.filter(x => x.quoteNo).length, rows: r };
  });
}

// Fetches what the calculation needs, for what this person can see.
export async function computeConversion(rep: { id: string; role: string }, days: number) {
  const to = new Date();
  const from = new Date(to.getTime() - days * DAY);
  const scope: any = { AND: [await territoryWhere(rep as any), { archived: false, misc: false }] };

  const [accountRows, quoteRows, carts] = await Promise.all([
    prisma.account.findMany({
      where: scope,
      select: { id: true, name: true, region: true, dearCustomerId: true, createdAt: true, rep: { select: { name: true } }, _count: { select: { activity: true } } },
    }),
    prisma.quote.findMany({
      where: { miscType: null, account: scope },
      select: { accountId: true, number: true, sentAt: true, fulfillmentStatus: true, source: true },
    }),
    loadCarts(rep, String(days)),
  ]);

  const funnels = buildFunnels({
    from, to,
    accounts: accountRows.map(a => ({
      id: a.id, name: a.name, region: a.region, repName: a.rep?.name ?? null,
      inDear: !!a.dearCustomerId, createdAt: a.createdAt, hasActivity: a._count.activity > 0,
    })),
    quotes: quoteRows.map(q => ({
      accountId: q.accountId, number: q.number, sentAt: q.sentAt, status: q.fulfillmentStatus ?? '',
      history: q.source === 'rhino-history' || q.number.startsWith('Q'),
    })),
    carts: carts.map(c => ({
      id: c.id, abandonedAt: c.abandonedAt, contact: c.contact, email: c.email, value: c.value,
      accountId: c.account?.id ?? null, accountName: c.account?.name ?? null, repName: c.account?.rep ?? null,
    })),
  });
  return { days, from, to, funnels };
}

// GET /conversion?days=90   (the Dashboard section; no per-account rows)
conversionRouter.get('/', async (req, res) => {
  try {
    const days = Math.min(365, Math.max(7, Math.round(Number(req.query.days)) || 90));
    const r = await computeConversion(req.rep!, days);
    res.json({ days, from: r.from, to: r.to, funnels: r.funnels.map(({ rows, ...f }) => f) });
  } catch (e) {
    console.error('conversion failed', e);
    res.status(500).json({ error: (e as Error).message });
  }
});