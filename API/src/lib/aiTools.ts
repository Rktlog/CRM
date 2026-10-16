import Anthropic from '@anthropic-ai/sdk';
import { prisma } from './prisma';
import { territoryWhere, canSeeAccount } from './territory';
import { openQuotes } from './receivables';
import { chooseEta, incomingFor } from './eta';
import { wholesalePrice } from './pricing';
import { PRODUCT_STATUSES, isStatusKey, statusLabel } from './productImport';

// What the assistant can look up. Read only: it can read what the person asking can already see, and change nothing.
// Each tool checks the same territory rule as the rest of the app, so the assistant never shows someone another
// territory's accounts. Results are plain data; whatever is written inside them (notes, names) is never an instruction.
export type Ctx = { rep: { id: string; role: string }; today: string };

export const TOOLS: Anthropic.Tool[] = [
  {
    name: 'find_accounts',
    description: 'Find customer accounts by name. Returns the id, state, status (Active, Inactive, New Lead or Prospect), last order and spend. Use it first to get an account id.',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Part of the customer name, at least 2 letters' } }, required: ['query'] },
  },
  {
    name: 'account_summary',
    description: 'Everything useful about one account: contact, status, spend, recent orders, open quotes and the latest notes the team logged. Needs an account id from find_accounts.',
    input_schema: { type: 'object', properties: { accountId: { type: 'string' } }, required: ['accountId'] },
  },
  {
    name: 'open_quotes',
    description: 'Quotes and unpaid orders (an order stays until it is both paid and confirmed), oldest first, with age, total, paid so far, what is still to pay and the next follow-up. Optionally only one state or only those older than some days.',
    input_schema: { type: 'object', properties: { state: { type: 'string', description: 'For example VIC' }, minAgeDays: { type: 'number' } } },
  },
  {
    name: 'product_lookup',
    description: 'Look up products by SKU, name or brand: stock available, on order, ETA of the next delivery, status (EOL, Discontinued, Pre-order, New) and wholesale price. Can list by status, for example every EOL product still in stock.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'SKU, part of the name, or the brand' },
        status: { type: 'string', enum: PRODUCT_STATUSES.map(s => s.key) },
        inStockOnly: { type: 'boolean' },
      },
    },
  },
];

const LIMIT_CHARS = 7000;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const out = (v: unknown) => { const s = JSON.stringify(v); return s.length > LIMIT_CHARS ? `${s.slice(0, LIMIT_CHARS)}…(cut: ask for something narrower)` : s; };
const day = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function statuses(ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await prisma.$queryRaw<{ account_id: string; status: string }[]>`select account_id, status from crm.account_status where account_id = any(${ids}::uuid[])`;
  return new Map(rows.map(r => [r.account_id, r.status]));
}

export async function runTool(name: string, input: any, ctx: Ctx): Promise<string> {
  try {
    switch (name) {
      case 'find_accounts': {
        const q = String(input?.query ?? '').trim();
        if (q.length < 2) return out({ error: 'Give at least 2 letters of the name' });
        const accounts = await prisma.account.findMany({
          where: { AND: [await territoryWhere(ctx.rep), { name: { contains: q, mode: 'insensitive' } }] },
          select: { id: true, name: true, region: true, archived: true, spend365: true, lastOrderAt: true },
          orderBy: { spend365: 'desc' }, take: 8,
        });
        const st = await statuses(accounts.map(a => a.id));
        return out({ matches: accounts.map(a => ({ id: a.id, name: a.name, state: a.region, status: st.get(a.id) ?? null, hiddenFromLists: a.archived, lastOrder: day(a.lastOrderAt), spend365: a.spend365 })) });
      }
      case 'account_summary': {
        const id = String(input?.accountId ?? '');
        if (!UUID.test(id)) return out({ error: 'accountId must come from find_accounts' });
        const a = await prisma.account.findUnique({ where: { id }, select: { id: true, name: true, region: true, repId: true, contactName: true, phone: true, email: true, type: true, spend30: true, spend90: true, spend365: true, lastOrderAt: true, rep: { select: { name: true } } } });
        if (!a || !(await canSeeAccount(ctx.rep, a))) return out({ error: 'That account is not available to you' });
        const [st, activity, quotes] = await Promise.all([
          statuses([id]),
          prisma.activity.findMany({ where: { accountId: id }, orderBy: { occurredAt: 'desc' }, take: 8, select: { type: true, note: true, occurredAt: true, rep: { select: { name: true } } } }),
          prisma.quote.findMany({ where: { accountId: id, source: { not: 'rhino-history' }, NOT: { number: { startsWith: 'Q' } } }, orderBy: { sentAt: 'desc' }, take: 10, select: { number: true, sentAt: true, fulfillmentStatus: true, total: true, amount: true } }),
        ]);
        const open = ['DRAFT', 'ESTIMATING', 'ESTIMATED', 'ORDERING'];
        return out({
          name: a.name, state: a.region, rep: a.rep?.name ?? null, status: st.get(id) ?? null, contact: { name: a.contactName, phone: a.phone, email: a.email },
          spend: { last30days: a.spend30, last90days: a.spend90, last365days: a.spend365 }, lastOrder: day(a.lastOrderAt),
          recentOrders: quotes.map(q => ({ number: q.number, date: day(q.sentAt), status: q.fulfillmentStatus, totalIncGst: q.total ?? q.amount, open: open.includes((q.fulfillmentStatus ?? '').toUpperCase()) })),
          recentNotes: activity.map(x => ({ date: day(x.occurredAt), type: x.type, by: x.rep?.name ?? null, note: clip(x.note, 300) })),
        });
      }
      case 'open_quotes': {
        const state = String(input?.state ?? '').trim().toUpperCase();
        const min = Number(input?.minAgeDays);
        const r = await openQuotes(ctx.rep, state ? [state] : undefined);
        const rows = r.rows.filter(x => !Number.isFinite(min) || x.ageDays >= min).slice(0, 25);
        return out({ count: r.count, showing: rows.length, totalIncGst: r.total, stillToPay: r.remaining,
          quotes: rows.map(x => ({ number: x.number, customer: x.customer, state: x.region, date: day(x.date), ageDays: x.ageDays, totalIncGst: x.amount, paidSoFar: x.paid, remaining: x.remaining, payment: x.payment, stage: x.stage, nextFollowUp: x.followUp.next })) });
      }
      case 'product_lookup': {
        const q = String(input?.query ?? '').trim();
        const status = isStatusKey(input?.status) ? input.status : null;
        if (!q && !status) return out({ error: 'Give a SKU, a name, a brand or a status' });
        const where: any[] = [{ OR: [{ status: null }, { status: { not: 'Deprecated' } }] }];
        if (q) where.push({ OR: [{ sku: { contains: q, mode: 'insensitive' } }, { name: { contains: q, mode: 'insensitive' } }, { brand: { contains: q, mode: 'insensitive' } }] });
        if (status) where.push({ lifecycle: status });
        if (input?.inStockOnly === true) where.push({ available: { gt: 0 } });
        const products = await prisma.product.findMany({ where: { AND: where }, orderBy: [{ brand: 'asc' }, { sku: 'asc' }], take: 15 });
        const incoming = await incomingFor(products.map(p => p.sku));
        return out({ showing: products.length, products: products.map(p => {
          const eta = chooseEta(p.eta, p.onOrder, incoming.get(p.sku) ?? [], ctx.today);
          return { sku: p.sku, name: p.name, brand: p.brand, status: statusLabel(isStatusKey(p.lifecycle) ? p.lifecycle : null) || null, available: p.available, onOrder: p.onOrder,
            eta: eta ? { date: eta.date, late: eta.late, from: eta.source === 'manual' ? 'set by hand' : eta.ref ? `order ${eta.ref}` : 'incoming order' } : null, wholesaleExGst: wholesalePrice(p.prices as any) };
        }) });
      }
      default:
        return out({ error: `Unknown tool ${name}` });
    }
  } catch (e) {
    console.error('assistant tool failed', name, e);
    return out({ error: 'That look-up failed. Say so, do not guess.' });
  }
}