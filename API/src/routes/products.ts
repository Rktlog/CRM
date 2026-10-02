import { Router } from 'express';
import { prisma } from '../lib/prisma';

export const productsRouter = Router();

// Reads only from our own tables. crm.products is kept current by the
// sync-products Edge Function; sales history comes from quote_lines.
// No DEAR calls here, so searching costs nothing against the rate limit.
// Company-wide like Sales Data: every rep sees the same stock picture.

const MAX_RESULTS = 25;
const CANDIDATES = 200; // fetched before ranking, then trimmed to MAX_RESULTS
const RECENT_SALES_SHOWN = 8;

type Location = { location: string; onHand: number; allocated: number; available: number; onOrder: number };

function rank(sku: string, name: string, q: string): number {
  const s = sku.toLowerCase();
  const n = name.toLowerCase();
  if (s === q) return 0;
  if (s.startsWith(q)) return 1;
  if (s.includes(q)) return 2;
  if (n.startsWith(q)) return 3;
  return 4;
}

productsRouter.get('/search', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (q.length < 2) return res.status(400).json({ error: 'Search needs at least 2 characters' });
  const qLower = q.toLowerCase();

  const [candidates, stockState] = await Promise.all([
    prisma.product.findMany({
      where: {
        AND: [
          { OR: [
            { sku: { contains: q, mode: 'insensitive' } },
            { name: { contains: q, mode: 'insensitive' } },
          ] },
          { OR: [{ status: null }, { status: { not: 'Deprecated' } }] },
        ],
      },
      take: CANDIDATES,
    }),
    prisma.syncState.findUnique({ where: { key: 'stock' } }),
  ]);

  const products = candidates
    .sort((a, b) => rank(a.sku, a.name, qLower) - rank(b.sku, b.name, qLower) || b.available - a.available)
    .slice(0, MAX_RESULTS);
  const skus = products.map(p => p.sku);

  const since = new Date(Date.now() - 365 * 86400000);
  const lines = skus.length
    ? await prisma.quoteLine.findMany({
        where: { sku: { in: skus }, quote: { miscType: null, sentAt: { gte: since } } },
        select: {
          sku: true,
          quantity: true,
          quote: { select: { id: true, number: true, sentAt: true, account: { select: { id: true, name: true } } } },
        },
        orderBy: { quote: { sentAt: 'desc' } },
      })
    : [];

  const results = products.map(p => {
    const skuLines = lines.filter(l => l.sku === p.sku);
    const units12m = skuLines.reduce((s, l) => s + l.quantity, 0);

    // One order can carry the same SKU on several lines.
    const byOrder = new Map<string, { quoteId: string; number: string; date: Date; accountId: string; accountName: string; qty: number }>();
    for (const l of skuLines) {
      const existing = byOrder.get(l.quote.number);
      if (existing) existing.qty += l.quantity;
      else byOrder.set(l.quote.number, {
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
      units12m,
      monthlyAvg: Math.round((units12m / 12) * 10) / 10,
      customers12m: new Set(skuLines.map(l => l.quote.account.id)).size,
      recentSales: [...byOrder.values()].slice(0, RECENT_SALES_SHOWN),
    };
  });

  res.json({ query: q, stockSyncedAt: stockState?.lastSyncedAt ?? null, results });
});