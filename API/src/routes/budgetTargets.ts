import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { z } from 'zod';

export const budgetTargetsRouter = Router();

budgetTargetsRouter.get('/', async (req, res) => {
  const isManager = req.rep!.role === 'manager';
  const year = Number(req.query.year) || new Date().getFullYear();
  const repId = (req.query.repId as string) || (isManager ? undefined : req.rep!.id);

  if (!isManager && repId !== req.rep!.id) {
    return res.status(403).json({ error: 'You can only view your own targets' });
  }

  const targets = await prisma.budgetTarget.findMany({
    where: { year, ...(repId ? { repId } : {}) },
    include: { rep: { select: { name: true } } },
    orderBy: [{ repId: 'asc' }, { quarter: 'asc' }],
  });

  res.json(targets.map(({ rep, ...t }) => ({ ...t, repName: rep.name })));
});

const upsertSchema = z.object({
  repId: z.string().uuid(),
  year: z.number().int(),
  quarter: z.number().int().min(1).max(4),
  amount: z.number().min(0),
});

budgetTargetsRouter.put('/', async (req, res) => {
  const parsed = upsertSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const isManager = req.rep!.role === 'manager';
  if (!isManager && parsed.data.repId !== req.rep!.id) {
    return res.status(403).json({ error: 'You can only set your own targets' });
  }

  const target = await prisma.budgetTarget.upsert({
    where: { repId_year_quarter: { repId: parsed.data.repId, year: parsed.data.year, quarter: parsed.data.quarter } },
    create: parsed.data,
    update: { amount: parsed.data.amount },
  });

  res.json(target);
});