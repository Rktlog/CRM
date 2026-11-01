import { Router } from 'express';
import { prisma } from '../lib/prisma';

export const meRouter = Router();

meRouter.get('/', async (req, res) => {
  // The two lookups do not depend on each other, so they are asked at the same time (one trip to the database, not two).
  const [rep, syncState] = await Promise.all([
    prisma.rep.findUnique({
      where: { id: req.rep!.id },
      select: { name: true, regions: { select: { region: true } } },
    }),
    prisma.syncState.findUnique({ where: { key: 'sales' } }),
  ]);
  res.json({
    id: req.rep!.id,
    role: req.rep!.role,
    name: rep?.name,
    regions: (rep?.regions ?? []).map(r => r.region),
    lastSyncedAt: syncState?.lastSyncedAt ?? null,
  });
});