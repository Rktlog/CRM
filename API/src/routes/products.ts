import { Router } from 'express';
import { prisma } from '../lib/prisma';

export const productsRouter = Router();

// Reads only from our own tables, never DEAR:
//   crm.products        stock + price tiers  (sync-products)
//   crm.purchases/lines incoming POs, history (sync-purchases)
//   crm.quotes/lines    sales, open orders    (sync-sales)
// Company-wide like Sales Data: every rep sees the same picture.

const MAX_RESULTS = 25;
const CANDIDATES = 200; // fetched before ranking, then trimmed
const HISTORY_SHOWN = 8;

// Order statuses that never hold stock.
const CLOSED_ORDER_STATUSES = ['COMPLETED', 'VOIDED', 'CREDITED', 'DRAFT', 'ESTIMATING', 'ESTIMATED'];
// DEAR shipping statuses where allocated stock hasn't left yet.
const OPEN_SHIPPING_STATUSES = ['NOT SHIPPED', 'PARTIALLY SHIPPED'];
const CLOSED_PURCHASE_STATUSES = ['VOIDED', 'COMPLETED', 'CREDITED', 'DRAFT'];

type Location = { location: string; onHand: number; allocated: number; available: number; onOrder: number };

// Split into words; every word must match the SKU, name or brand, in
// any order. "miffy offwhite" finds "Miffy ECO Corduroy Offwhite - 23 cm".
export function searchWords(q: string): string[] {
  return q.split(/\s+/).map(w => w.trim()).filter(Boolean).slice(0, 8);
}

function rank(sku: string, name: string, q: string, words: string[]): number {
  const s = sku.toLowerCase();
  const n = name.toLowerCase();
  if (s === q) return 0;
  if (s.startsWith(q)) return 1;
  if (n.startsWith(words[0])) return 2;
  if (n.includes(q)) return 3; // words appear together, in order
  return 4;
}

// DEAR price tier names are set per account, so find wholesale and
// retail by name rather than by tier number.
function pickPrice(prices: Record<string, number>, pattern: RegExp): { tier: string; price: number } | null {
  const hit = Object.entries(prices).find(([name]) => pattern.test(name));
  return hit ? { tier: hit[0], price: hit[1] } : null;
}

productsRouter.get('/search', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (q.length < 2) return res.status(400).json({ error: 'Search needs at least 2 characters' });
  const qLower = q.toLowerCase();
  const words = searchWords(qLower);

  const [candidates, stockState] = await Promise.all([
    prisma.product.findMany({
      where: {
        AND: [
          ...words.map(w => ({
            OR: [
              { sku: { contains: w, mode: 'insensitive' as const } },
              { name: { contains: w, mode: 'insensitive' as const } },
              { brand: { contains: w, mode: 'insensitive' as const } },
            ],
          })),
          { OR: [{ status: null }, { status: { not: 'Deprecated' } }] },
        ],
      },
      take: CANDIDATES,
    }),
    prisma.syncState.findUnique({ where: { key: 'stock' } }),
  ]);

  const products = candidates
    .sort((a, b) => rank(a.sku, a.name, qLower, words) - rank(b.sku, b.name, qLower, words) || b.available - a.available)
    .slice(0, MAX_RESULTS);
  const skus = products.map(p => p.sku);

  if (!skus.length) {
    return res.json({ query: q, stockSyncedAt: stockState?.lastSyncedAt ?? null, results: [] });
  }

  const since12m = new Date(Date.now() - 365 * 86400000);

  const [salesTotals, allocatedLines, purchaseLines, recentBySku] = await Promise.all([
    // Sales totals per SKU, all time and last 12 months. Marketing and
    // warranty orders aren't sales, so they're left out.
    prisma.$queryRaw<{ sku: string; units_all: number; value_all: number; units_12m: number; value_12m: number }[]>`
      select l.sku,
        coalesce(sum(l.quantity), 0)::float8 as units_all,
        coalesce(sum(l.line_total), 0)::float8 as value_all,
        coalesce(sum(l.quantity) filter (where q.sent_at >= ${since12m}), 0)::float8 as units_12m,
        coalesce(sum(l.line_total) filter (where q.sent_at >= ${since12m}), 0)::float8 as value_12m
      from crm.quote_lines l
      join crm.quotes q on q.id = l.quote_id
      where l.sku = any(${skus}) and q.misc_type is null
      group by l.sku
    `,

    // Open orders holding stock: not shipped yet and not closed.
    // Marketing/warranty orders count here, since they hold stock too.
    prisma.quoteLine.findMany({
      where: {
        sku: { in: skus },
        quote: {
          shippingStatus: { in: OPEN_SHIPPING_STATUSES },
          OR: [{ fulfillmentStatus: null }, { fulfillmentStatus: { notIn: CLOSED_ORDER_STATUSES } }],
        },
      },
      select: {
        sku: true,
        quantity: true,
        quote: { select: { id: true, number: true, sentAt: true, miscType: true, account: { select: { id: true, name: true } } } },
      },
      orderBy: { quote: { sentAt: 'asc' } },
    }),

    prisma.purchaseLine.findMany({
      where: { sku: { in: skus } },
      include: { purchase: true },
    }),

    // Per SKU, so one fast seller can't crowd out the others' history.
    Promise.all(skus.map(sku =>
      prisma.quoteLine.findMany({
        where: { sku, quote: { miscType: null } },
        select: {
          quantity: true,
          quote: { select: { id: true, number: true, sentAt: true, account: { select: { id: true, name: true } } } },
        },
        orderBy: { quote: { sentAt: 'desc' } },
        take: HISTORY_SHOWN * 2,
      }),
    )),
  ]);

  const totalsBySku = new Map(salesTotals.map(t => [t.sku, t]));
  const round2 = (n: number) => Math.round(n * 100) / 100;

  const results = products.map((p, idx) => {
    const prices = (p.prices as Record<string, number>) ?? {};
    const totals = totalsBySku.get(p.sku);

    // One order can carry the same SKU on several lines: sum per order.
    const allocatedOrders = new Map<string, any>();
    for (const l of allocatedLines.filter(l => l.sku === p.sku)) {
      const o = allocatedOrders.get(l.quote.id);
      if (o) o.qty += l.quantity;
      else allocatedOrders.set(l.quote.id, {
        quoteId: l.quote.id,
        number: l.quote.number,
        date: l.quote.sentAt,
        accountId: l.quote.account.id,
        accountName: l.quote.account.name,
        miscType: l.quote.miscType,
        qty: l.quantity,
      });
    }

    const skuPurchases = purchaseLines.filter(l => l.sku === p.sku);
    const incoming = skuPurchases
      .filter(l => !CLOSED_PURCHASE_STATUSES.includes((l.purchase.status ?? '').toUpperCase()))
      .map(l => ({
        number: l.purchase.number,
        supplier: l.purchase.supplier,
        orderDate: l.purchase.orderDate,
        expected: l.purchase.requiredBy,
        status: l.purchase.status,
        ordered: l.quantityOrdered,
        outstanding: Math.max(0, l.quantityOrdered - l.quantityReceived),
      }))
      .filter(l => l.outstanding > 0)
      .sort((a, b) => (a.expected?.getTime() ?? Infinity) - (b.expected?.getTime() ?? Infinity));

    const purchaseHistory = skuPurchases
      .filter(l => l.quantityReceived > 0)
      .map(l => ({
        number: l.purchase.number,
        supplier: l.purchase.supplier,
        received: l.lastReceivedAt ?? l.purchase.orderDate,
        qty: l.quantityReceived,
      }))
      .sort((a, b) => (b.received?.getTime() ?? 0) - (a.received?.getTime() ?? 0))
      .slice(0, HISTORY_SHOWN);

    const recentOrders = new Map<string, any>();
    for (const l of recentBySku[idx]) {
      const o = recentOrders.get(l.quote.id);
      if (o) o.qty += l.quantity;
      else if (recentOrders.size < HISTORY_SHOWN) recentOrders.set(l.quote.id, {
        quoteId: l.quote.id,
        number: l.quote.number,
        date: l.quote.sentAt,
        accountId: l.quote.account.id,
        accountName: l.quote.account.name,
        qty: l.quantity,
      });
    }

    return {
      sku: p.sku,
      name: p.name,
      brand: p.brand,
      category: p.category,
      uom: p.uom,
      onHand: p.onHand,
      allocated: p.allocated,
      available: p.available,
      onOrder: p.onOrder,
      locations: (p.locations as Location[]) ?? [],
      wholesale: pickPrice(prices, /wholesale|trade/i),
      retail: pickPrice(prices, /retail|rrp/i),
      prices,
      sales: {
        units12m: totals?.units_12m ?? 0,
        value12m: round2(totals?.value_12m ?? 0),
        unitsAll: totals?.units_all ?? 0,
        valueAll: round2(totals?.value_all ?? 0),
      },
      allocatedOrders: [...allocatedOrders.values()],
      incoming,
      purchaseHistory,
      recentOrders: [...recentOrders.values()],
    };
  });

  res.json({ query: q, stockSyncedAt: stockState?.lastSyncedAt ?? null, results });
});