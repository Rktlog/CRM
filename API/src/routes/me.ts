import { Router } from 'express';
import { prisma } from '../lib/prisma';

export const meRouter = Router();

meRouter.get('/', async (req, res) => {
  const rep = await prisma.rep.findUnique({
    where: { id: req.rep!.id },
    select: { name: true, regions: { select: { region: true } } },
  });
  const syncState = await prisma.syncState.findUnique({ where: { key: 'sales' } });
  res.json({
    id: req.rep!.id,
    role: req.rep!.role,
    name: rep?.name,
    regions: (rep?.regions ?? []).map(r => r.region),
    lastSyncedAt: syncState?.lastSyncedAt ?? null,
  });
});