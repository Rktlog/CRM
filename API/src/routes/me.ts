import { Router } from 'express';
import { prisma } from '../lib/prisma';

export const meRouter = Router();

meRouter.get('/', async (req, res) => {
  const rep = await prisma.rep.findUnique({
    where: { id: req.rep!.id },
    select: { name: true, dailyColdCallLimit: true, dailyNewLeadCount: true, dailyInactiveCount: true },
  });
  const syncState = await prisma.syncState.findUnique({ where: { key: 'sales' } });
  res.json({
    id: req.rep!.id,
    role: req.rep!.role,
    name: rep?.name,
    dailyColdCallLimit: rep?.dailyColdCallLimit ?? 10,
    dailyNewLeadCount: rep?.dailyNewLeadCount ?? 5,
    dailyInactiveCount: rep?.dailyInactiveCount ?? 5,
    lastSyncedAt: syncState?.lastSyncedAt ?? null,
  });
});

meRouter.patch('/', async (req, res) => {
  const patch: any = {};
  for (const field of ['dailyColdCallLimit', 'dailyNewLeadCount', 'dailyInactiveCount'] as const) {
    if (typeof req.body[field] === 'number' && req.body[field] >= 0) {
      patch[field] = Math.floor(req.body[field]);
    }
  }
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to update' });

  await prisma.rep.update({ where: { id: req.rep!.id }, data: patch });
  res.json({ ok: true });
});