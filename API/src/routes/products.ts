import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { HISTORY_SOURCE, LIVE_ORDER, isHistory } from '../lib/orderSource';

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
// DEAR releases allocated stock when the order is picked (not when it
// ships), so "allocated" means authorised and not yet fully picked.
const OPEN_PICKING_STATUSES = ['NOT PICKED', 'PARTIALLY PICKED'];
// Fallback for orders synced before picking status was captured.
const OPEN_SHIPPING_STATUSES = ['NOT SHIPPED', 'PARTIALLY SHIPPED'];
const DEAD_PURCHASE_STATUSES = ['VOIDED', 'CREDITED', 'DRAFT'];
// Order statuses where nothing has necessarily shipped yet. Used for
// older orders synced before per-SKU ship quantities were captured.
const UNSHIPPED_ORDER_STATUSES = ['DRAFT', 'ESTIMATING', 'ESTIMATED', 'ORDERING', 'ORDERED', 'BACKORDERED'];
const PURCHASES_SHOWN = 10;

// DEAR's own receiving status is the source of truth for "is anything
// still to come", even if the line-level received qty didn't parse.
function fullyReceived(status: string | null, receivingStatus: string | null): boolean {
  const r = (receivingStatus ?? '').toUpperCase();
  const s = (status ?? '').toUpperCase();
  return r.includes('FULLY RECEIVED') || s === 'COMPLETED' || s === 'RECEIVED';
}

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
    // Sales totals per SKU, all time and last 12 months. Like DEAR, a
    // sale counts when it ships, fulfilment by fulfilment: an order for 48
    // with 24 shipped counts 24. Orders synced before per-SKU ship qty was
    // captured count in full unless their status says nothing has gone.
    // Marketing and warranty orders aren't sales, so they're left out.
    prisma.$queryRaw<{ sku: string; units_all: number; value_all: number; units_12m: number; value_12m: number }[]>`
      with lines as (
        select l.sku, l.quantity, l.line_total, q.sent_at,
          case
            when q.source = ${HISTORY_SOURCE} or q.number like 'Q%' then 1  -- spreadsheet history: counts in full, as stored
            when q.line_fulfilment ? l.sku then least(1, greatest(0,
              coalesce((q.line_fulfilment -> l.sku ->> 'shipped')::float8, 0)
              / nullif(sum(l.quantity) over (partition by l.quote_id, l.sku), 0)))
            when upper(coalesce(q.fulfillment_status, '')) = any(${UNSHIPPED_ORDER_STATUSES})
              and upper(coalesce(q.shipping_status, '')) <> 'SHIPPED' then 0
            else 1
          end as shipped_share
        from crm.quote_lines l
        join crm.quotes q on q.id = l.quote_id
        where l.sku = any(${skus}) and q.misc_type is null
      )
      select sku,
        coalesce(sum(quantity * shipped_share), 0)::float8 as units_all,
        coalesce(sum(line_total * shipped_share), 0)::float8 as value_all,
        coalesce(sum(quantity * shipped_share) filter (where sent_at >= ${since12m}), 0)::float8 as units_12m,
        coalesce(sum(line_total * shipped_share) filter (where sent_at >= ${since12m}), 0)::float8 as value_12m
      from lines
      group by sku
    `,

    // Candidate orders for "reserved for orders": not closed and not
    // fully shipped. The exact per-SKU qty still to go is worked out below
    // from each order's own pick/ship progress.
    prisma.quoteLine.findMany({
      where: {
        sku: { in: skus },
        quote: {
          AND: [
            LIVE_ORDER, // spreadsheet history never holds stock
            { OR: [{ shippingStatus: null }, { shippingStatus: { not: 'SHIPPED' } }] },
            { OR: [{ fulfillmentStatus: null }, { fulfillmentStatus: { notIn: CLOSED_ORDER_STATUSES } }] },
          ],
        },
      },
      select: {
        sku: true,
        quantity: true,
        quote: { select: {
          id: true, number: true, sentAt: true, miscType: true, fulfillmentStatus: true,
          pickingStatus: true, shippingStatus: true, lineFulfilment: true, paid: true,
          account: { select: { id: true, name: true } },
        } },
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
          quote: { select: {
            id: true, number: true, sentAt: true, lineFulfilment: true, fulfillmentStatus: true, shippingStatus: true, source: true,
            account: { select: { id: true, name: true } },
          } },
        },
        orderBy: { quote: { sentAt: 'desc' } },
        take: HISTORY_SHOWN * 4,
      }),
    )),
  ]);

  const totalsBySku = new Map(salesTotals.map(t => [t.sku, t]));
  const round2 = (n: number) => Math.round(n * 100) / 100;

  const results = products.map((p, idx) => {
    const prices = (p.prices as Record<string, number>) ?? {};
    const totals = totalsBySku.get(p.sku);

    // Per order, how much of THIS item is still to go out. An order can
    // be backordered on another item while this one is already allocated
    // or picked, so this is judged per SKU, not by the order's status.
    const ordersForSku = new Map<string, { quote: (typeof allocatedLines)[number]['quote']; ordered: number }>();
    for (const l of allocatedLines.filter(l => l.sku === p.sku)) {
      const o = ordersForSku.get(l.quote.id);
      if (o) o.ordered += l.quantity;
      else ordersForSku.set(l.quote.id, { quote: l.quote, ordered: l.quantity });
    }

    // Allocated = ordered minus shipped, for whatever reason it's held
    // (unpaid, waiting to pick, waiting on another item). Other customers
    // can't have this stock.
    const allocatedOrders = [...ordersForSku.values()].flatMap(({ quote, ordered }) => {
      const progress = (quote.lineFulfilment as Record<string, { picked: number; shipped: number }>)?.[p.sku];
      let allocated: number;
      if (progress) {
        allocated = ordered - Math.min(progress.shipped, ordered);
      } else {
        // Nothing of this item shipped yet. For orders synced before
        // per-SKU progress was captured, trust the order-level status.
        const shippedAll = (quote.shippingStatus ?? '').toUpperCase() === 'SHIPPED';
        allocated = shippedAll ? 0 : ordered;
      }
      if (allocated <= 0) return [];
      return [{
        quoteId: quote.id,
        number: quote.number,
        date: quote.sentAt,
        accountId: quote.account.id,
        accountName: quote.account.name,
        miscType: quote.miscType,
        status: quote.fulfillmentStatus,
        paid: quote.paid,
        qty: allocated,
      }];
    });

    const skuPurchases = purchaseLines.filter(l => l.sku === p.sku);
    // One list of POs for this SKU, newest first: incoming ones show
    // what's still to come, received ones show what arrived.
    const purchaseOrders = skuPurchases
      .filter(l => !DEAD_PURCHASE_STATUSES.includes((l.purchase.status ?? '').toUpperCase()))
      .map(l => {
        const done = fullyReceived(l.purchase.status, l.purchase.receivingStatus);
        const received = done ? Math.max(l.quantityReceived, l.quantityOrdered) : l.quantityReceived;
        const outstanding = done ? 0 : Math.max(0, l.quantityOrdered - l.quantityReceived);
        return {
          number: l.purchase.number,
          supplier: l.purchase.supplier,
          orderDate: l.purchase.orderDate,
          expected: l.purchase.requiredBy,
          receivedAt: l.lastReceivedAt,
          ordered: l.quantityOrdered,
          received,
          outstanding,
          state: outstanding > 0 ? (received > 0 ? 'partial' : 'incoming') : 'received',
        };
      })
      .sort((a, b) => {
        const t = (x: typeof a) => (x.receivedAt ?? x.expected ?? x.orderDate)?.getTime() ?? 0;
        return t(b) - t(a);
      });
    const incomingRefs = purchaseOrders.filter(po => po.outstanding > 0).map(po => po.number).filter(Boolean);
    const incomingQty = purchaseOrders.reduce((sum, po) => sum + po.outstanding, 0);

    // Recent sales = what actually shipped, newest first.
    const orderedOnQuote = new Map<string, number>();
    for (const l of recentBySku[idx]) orderedOnQuote.set(l.quote.id, (orderedOnQuote.get(l.quote.id) ?? 0) + l.quantity);
    const recentOrders: any[] = [];
    for (const [quoteId, ordered] of orderedOnQuote) {
      if (recentOrders.length >= HISTORY_SHOWN) break;
      const q = recentBySku[idx].find(l => l.quote.id === quoteId)!.quote;
      const progress = (q.lineFulfilment as Record<string, { picked: number; shipped: number }>)?.[p.sku];
      const unshipped = UNSHIPPED_ORDER_STATUSES.includes((q.fulfillmentStatus ?? '').toUpperCase())
        && (q.shippingStatus ?? '').toUpperCase() !== 'SHIPPED';
      const shipped = isHistory(q) ? ordered : progress ? Math.min(progress.shipped, ordered) : unshipped ? 0 : ordered;
      if (shipped <= 0) continue;
      recentOrders.push({
        quoteId,
        number: q.number,
        date: q.sentAt,
        accountId: q.account.id,
        accountName: q.account.name,
        qty: shipped,
        partial: shipped < ordered,
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
      purchaseOrders: purchaseOrders.slice(0, PURCHASES_SHOWN),
      incomingRefs,
      incomingQty,
      recentOrders,
    };
  });

  res.json({ query: q, stockSyncedAt: stockState?.lastSyncedAt ?? null, results });
});