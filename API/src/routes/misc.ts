import { Router } from 'express';
import { prisma } from '../lib/prisma';

export const miscRouter = Router();

// Company-wide, same as Sales Data — everyone sees the same list,
// not scoped to "your own accounts."
miscRouter.get('/', async (req, res) => {
  const type = req.query.type as string; // 'marketing' | 'warranty'
  if (!['marketing', 'warranty'].includes(type)) {
    return res.status(400).json({ error: 'type must be "marketing" or "warranty"' });
  }

  const quotes = await prisma.quote.findMany({
    where: { miscType: type },
    include: { account: { select: { id: true, name: true, region: true } } },
    orderBy: { sentAt: 'desc' },
    take: 1000,
  });

  const rows = quotes.map(q => ({
    id: q.id,
    number: q.number,
    date: q.sentAt,
    accountId: q.account.id,
    accountName: q.account.name,
    region: q.account.region,
    amount: q.amount,
    reference: q.reference,
    source: q.source,
  }));

  res.json({ type, count: rows.length, total: Math.round(rows.reduce((s, r) => s + r.amount, 0) * 100) / 100, rows });
});