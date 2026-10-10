import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { shipTo } from './exports';

export const miscRouter = Router();

// Company-wide, same as Sales Data — everyone sees the same list,
// not scoped to "your own accounts."
// Marketing and warranty orders are billed to one account but sent to many people
// and stores, so each row also carries where it was sent: the ship-to name, state
// and suburb. It uses the same helper as the Excel report, so the two always agree.
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

  const rows = quotes.map(q => {
    const to = shipTo(q);
    return {
      id: q.id,
      number: q.number,
      date: q.sentAt,
      accountId: q.account.id,
      accountName: q.account.name,
      region: q.account.region,
      sentTo: to.name,
      sentToContact: to.contact,
      sentToSuburb: to.suburb,
      sentToState: to.state,
      amount: q.amount,
      reference: q.reference,
      source: q.source,
    };
  });

  res.json({ type, count: rows.length, total: Math.round(rows.reduce((s, r) => s + r.amount, 0) * 100) / 100, rows });
});