import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { z } from 'zod';

export const tasksRouter = Router();

function todayDateOnly(): Date {
  const d = new Date();
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}

// Rolls forward overdue, incomplete, non-fixed tasks so today's cold
// call list never silently loses anything. Anything beyond the rep's
// daily limit is pushed one more day rather than piling onto today —
// a big backlog drains gradually instead of dumping all at once.
async function rolloverColdCalls(repId: string) {
  const today = todayDateOnly();
  const rep = await prisma.rep.findUnique({ where: { id: repId }, select: { dailyColdCallLimit: true } });
  const limit = rep?.dailyColdCallLimit ?? 10;

  const pending = await prisma.task.findMany({
    where: { repId, type: 'cold_call', fixed: false, completed: false, scheduledDate: { lte: today } },
    orderBy: { scheduledDate: 'asc' },
  });

  const todays = pending.filter(t => t.scheduledDate.getTime() === today.getTime());
  const overdue = pending.filter(t => t.scheduledDate.getTime() < today.getTime());

  // Bring overdue ones onto today first (oldest first), up to the limit.
  const keepToday = [...overdue, ...todays].slice(0, limit);
  const pushForward = [...overdue, ...todays].slice(limit);

  const tomorrow = new Date(today);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);

  for (const t of keepToday) {
    if (t.scheduledDate.getTime() !== today.getTime()) {
      await prisma.task.update({ where: { id: t.id }, data: { scheduledDate: today } });
    }
  }
  for (const t of pushForward) {
    await prisma.task.update({ where: { id: t.id }, data: { scheduledDate: tomorrow } });
  }
}

tasksRouter.get('/today', async (req, res) => {
  const repId = req.rep!.id;
  await rolloverColdCalls(repId);
  const today = todayDateOnly();

  const [fixedVisits, coldCalls, rep] = await Promise.all([
    prisma.task.findMany({
      where: { repId, fixed: true, scheduledDate: today, completed: false },
      include: { account: { select: { id: true, name: true, region: true, phone: true } } },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.task.findMany({
      where: { repId, type: 'cold_call', fixed: false, scheduledDate: today, completed: false },
      include: { account: { select: { id: true, name: true, region: true, phone: true } } },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.rep.findUnique({ where: { id: repId }, select: { dailyColdCallLimit: true } }),
  ]);

  res.json({ fixedVisits, coldCalls, limit: rep?.dailyColdCallLimit ?? 10 });
});

tasksRouter.get('/upcoming', async (req, res) => {
  const repId = req.rep!.id;
  const days = Number(req.query.days) || 7;
  const today = todayDateOnly();
  const end = new Date(today);
  end.setUTCDate(end.getUTCDate() + days);

  const tasks = await prisma.task.findMany({
    where: { repId, scheduledDate: { gte: today, lt: end }, completed: false },
    include: { account: { select: { id: true, name: true } } },
    orderBy: { scheduledDate: 'asc' },
  });

  res.json(tasks);
});

const createTaskSchema = z.object({
  accountId: z.string().uuid(),
  type: z.enum(['cold_call', 'visit']),
  scheduledDate: z.string(), // 'YYYY-MM-DD'
  fixed: z.boolean().optional(),
  note: z.string().optional(),
});

tasksRouter.post('/', async (req, res) => {
  const parsed = createTaskSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { accountId, type, scheduledDate, note } = parsed.data;
  // A visit is inherently fixed — that's the whole point of scheduling
  // one; a cold call is never fixed, it's exactly the kind of task
  // that should roll forward if it doesn't happen.
  const fixed = type === 'visit';

  const task = await prisma.task.create({
    data: {
      repId: req.rep!.id,
      accountId,
      type,
      scheduledDate: new Date(scheduledDate),
      fixed,
      note,
    },
  });
  res.status(201).json(task);
});

tasksRouter.patch('/:id', async (req, res) => {
  const task = await prisma.task.findUnique({ where: { id: req.params.id } });
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (task.repId !== req.rep!.id && req.rep!.role !== 'manager') {
    return res.status(403).json({ error: 'Not your task' });
  }

  const patch: any = {};
  if (typeof req.body.completed === 'boolean') {
    patch.completed = req.body.completed;
    patch.completedAt = req.body.completed ? new Date() : null;
  }
  if (req.body.scheduledDate) patch.scheduledDate = new Date(req.body.scheduledDate);
  if (typeof req.body.note === 'string') patch.note = req.body.note;

  const updated = await prisma.task.update({ where: { id: req.params.id }, data: patch });
  res.json(updated);
});

// Auto-suggested outreach — real new leads and real inactive
// customers, scoped to the rep's assigned regions, counted by the
// rep's own planner settings. This does NOT create Task rows itself
// — the rep adds a suggestion to today's plan explicitly, so the two
// lists (manually scheduled vs suggested) stay clearly distinct.
tasksRouter.get('/suggested', async (req, res) => {
  const repId = req.rep!.id;
  const rep = await prisma.rep.findUnique({
    where: { id: repId },
    select: { dailyNewLeadCount: true, dailyInactiveCount: true },
  });
  const newLeadCount = rep?.dailyNewLeadCount ?? 5;
  const inactiveCount = rep?.dailyInactiveCount ?? 5;

  const assignedRegions = (await prisma.repRegion.findMany({ where: { repId }, select: { region: true } })).map(r => r.region);
  // No assigned territory yet — fall back to whatever the rep already
  // owns, so this isn't just empty while waiting on a manager.
  const regionFilter = assignedRegions.length ? { region: { in: assignedRegions } } : { repId };

  const today = new Date();
  const todayOnly = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
  const alreadyScheduled = new Set(
    (await prisma.task.findMany({ where: { repId, scheduledDate: todayOnly, completed: false }, select: { accountId: true } }))
      .map(t => t.accountId)
  );

  const newLeads = await prisma.account.findMany({
    where: { ...regionFilter, type: 'prospect', stage: 'new_lead', archived: false, id: { notIn: [...alreadyScheduled] } },
    select: { id: true, name: true, region: true, phone: true },
    orderBy: { createdAt: 'desc' },
    take: newLeadCount,
  });

  // Same "overdue relative to their own pace" rule as the Dashboard's
  // "Needs attention" list.
  const candidates = await prisma.account.findMany({
    where: { ...regionFilter, type: 'customer', archived: false, lastOrderAt: { not: null }, id: { notIn: [...alreadyScheduled] } },
    select: { id: true, name: true, region: true, phone: true, lastOrderAt: true, avgOrderGapDays: true },
  });
  const now = Date.now();
  const inactive = candidates
    .filter(a => {
      const threshold = a.avgOrderGapDays ? Math.max(a.avgOrderGapDays * 1.5, 14) : 75;
      const daysSince = (now - a.lastOrderAt!.getTime()) / 86400000;
      return daysSince > threshold;
    })
    .slice(0, inactiveCount);

  res.json({ newLeads, inactive, regions: assignedRegions });
});