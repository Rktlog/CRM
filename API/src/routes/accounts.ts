import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { createAccountSchema } from '../schemas';

export const accountsRouter = Router();

// Registered before '/:id' — otherwise Express would treat
// "backorders" as an :id value and this route would never match.
accountsRouter.get('/backorders', async (req, res) => {
  const isManager = req.rep!.role === 'manager';
  const accounts = await prisma.account.findMany({
    where: {
      ...(isManager ? {} : { repId: req.rep!.id }),
      quotes: { some: { fulfillmentStatus: 'BACKORDERED' } },
    },
    include: {
      rep: { select: { name: true } },
      quotes: { where: { fulfillmentStatus: 'BACKORDERED' }, orderBy: { sentAt: 'desc' } },
    },
    orderBy: { updatedAt: 'desc' },
  });

  const flattened = accounts.map(({ rep, ...a }) => ({ ...a, repName: rep?.name ?? null }));
  res.json(flattened);
});

// Reps see only their own accounts, managers see everything.
// This mirrors the RLS policy — belt and suspenders, not a
// replacement for it. Archived accounts (one-off buyers, sports
// clubs — not real sales targets) are excluded by default; pass
// ?archived=true to see them.
accountsRouter.get('/', async (req, res) => {
  const isManager = req.rep!.role === 'manager';
  const showArchived = req.query.archived === 'true';
  const showAll = req.query.scope === 'all'; // opt-in company-wide view (e.g. Pipeline) — everything else stays "your own accounts" by default
  const region = req.query.region as string | undefined;
  const accounts = await prisma.account.findMany({
    where: {
      ...((isManager || showAll) ? {} : { repId: req.rep!.id }),
      ...(region ? { region: { in: region.split(',') } } : {}),
      archived: showArchived,
      misc: false, // manual "Mark as Misc" override — always respected
      // An account is hidden automatically only if EVERY order it has
      // is marketing/warranty-tagged — one real order (even mixed in
      // with a mostly-personal history, like a one-off business
      // purchase) is enough to keep it visible. A fresh account with
      // no orders yet always shows too, since there's nothing to judge it by.
      OR: [
        { quotes: { none: {} } },
        { quotes: { some: { miscType: null } } },
      ],
    },
    include: { rep: { select: { name: true } } },
    orderBy: { updatedAt: 'desc' },
  });

  // Flatten rep.name onto repName, matching the rest of the API's flat shape.
  const flattened = accounts.map(({ rep, ...a }) => ({ ...a, repName: rep?.name ?? null }));
  res.json(flattened);
});

accountsRouter.get('/:id', async (req, res) => {
  const account = await prisma.account.findUnique({
    where: { id: req.params.id },
    include: {
      rep: { select: { name: true } },
      activity: {
        orderBy: { occurredAt: 'desc' },
        include: { rep: { select: { name: true } } },
      },
      quotes: { orderBy: { sentAt: 'desc' }, include: { lines: true } },
    },
  });

  if (!account) return res.status(404).json({ error: 'Account not found' });

  const isManager = req.rep!.role === 'manager';
  if (!isManager && account.repId !== req.rep!.id) {
    return res.status(403).json({ error: 'Not your account' });
  }

  const { rep, activity, ...rest } = account;

  // Aggregate every product/brand this account has ever bought,
  // across all their orders — real line-item history.
  const productTotals = new Map<string, { productName: string; brand: string | null; quantity: number; total: number }>();
  for (const q of rest.quotes) {
    for (const l of (q as any).lines ?? []) {
      const existing = productTotals.get(l.sku) ?? { productName: l.productName, brand: l.brand, quantity: 0, total: 0 };
      existing.quantity += l.quantity;
      existing.total += l.lineTotal;
      productTotals.set(l.sku, existing);
    }
  }
  const productBreakdown = [...productTotals.entries()]
    .map(([sku, v]) => ({ sku, ...v, total: Math.round(v.total * 100) / 100 }))
    .sort((a, b) => b.total - a.total);

  const flattened = {
    ...rest,
    repName: rep?.name ?? null,
    activity: activity.map(({ rep: activityRep, ...a }) => ({ ...a, repName: activityRep?.name ?? null })),
    productBreakdown,
  };

  res.json(flattened);
});

accountsRouter.post('/', async (req, res) => {
  const parsed = createAccountSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const account = await prisma.account.create({ data: parsed.data });
  res.status(201).json(account);
});

// Toggle the misc flag — marketing/warranty/internal orders that are
// real but shouldn't count toward a rep's sales performance. Unlike
// archived, a misc account stays fully visible everywhere except
// performance reporting specifically.
accountsRouter.patch('/:id/misc', async (req, res) => {
  const account = await prisma.account.findUnique({ where: { id: req.params.id } });
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const misc = typeof req.body.misc === 'boolean' ? req.body.misc : !account.misc;
  const updated = await prisma.account.update({ where: { id: req.params.id }, data: { misc } });
  res.json(updated);
});