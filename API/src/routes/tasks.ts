import { Router } from 'express';
import { hiddenAccountIds } from '../lib/territory';
import { prisma } from '../lib/prisma';
import { z } from 'zod';

// The planner's plan is fixed, not a setting: 5 new-lead calls and 5 inactive-customer
// calls a day (10 in all). Calls a rep schedules by hand are capped at 10 a day.
const NEW_LEADS_PER_DAY = 5;
const INACTIVE_PER_DAY = 5;
const SCHEDULED_CALLS_PER_DAY = 10;

export const tasksRouter = Router();

// "Today" as the rep's own calendar date. The browser sends it as
// ?date=YYYY-MM-DD, because the server runs in UTC: in Melbourne, before
// 10 or 11am the UTC date is still yesterday. Falls back to UTC.
function dateOnly(value?: unknown): Date {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date(`${value}T00:00:00Z`);
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// Nothing unfinished gets lost: anything not done by the end of its day
// moves to the next day the rep opens the planner.
//   - visits and auto-planned tasks: all come forward to today
//   - manually scheduled cold calls: up to the rep's daily limit today,
//     the rest pushed one more day, so a big backlog drains gradually
async function rolloverTasks(repId: string, today: Date) {
  await prisma.task.updateMany({
    where: { repId, completed: false, scheduledDate: { lt: today }, OR: [{ fixed: true }, { reason: { not: null } }] },
    data: { scheduledDate: today },
  });

  const limit = SCHEDULED_CALLS_PER_DAY;

  const pending = await prisma.task.findMany({
    where: { repId, type: 'cold_call', fixed: false, reason: null, completed: false, scheduledDate: { lte: today } },
    orderBy: { scheduledDate: 'asc' },
  });
  const todays = pending.filter(t => t.scheduledDate.getTime() === today.getTime());
  const overdue = pending.filter(t => t.scheduledDate.getTime() < today.getTime());
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

// Accounts worth contacting, from the rep's assigned states: new leads
// nobody has approached, and customers overdue against their own usual
// reorder gap (the Dashboard's "Needs attention" rule). Skips accounts
// that already have an unfinished task, or one today.
async function findSuggestions(repId: string, today: Date, newLeadCount: number, inactiveCount: number) {
  const assignedRegions = (await prisma.repRegion.findMany({ where: { repId }, select: { region: true } })).map(r => r.region);
  // Accounts a manager has hidden from this rep are never suggested to them.
  const hidden = await hiddenAccountIds(repId);
  const regionFilter = assignedRegions.length ? { region: { in: assignedRegions } } : { id: { in: [] } };

  const busy = new Set(
    (await prisma.task.findMany({
      where: { repId, OR: [{ completed: false }, { scheduledDate: today }] },
      select: { accountId: true },
    })).map(t => t.accountId),
  );
  for (const id of hidden) busy.add(id);

  const newLeads = newLeadCount > 0
    ? await prisma.account.findMany({
        where: { ...regionFilter, type: 'prospect', stage: 'new_lead', archived: false, misc: false, id: { notIn: [...busy] } },
        select: { id: true, name: true, region: true, phone: true },
        orderBy: { createdAt: 'desc' },
        take: newLeadCount,
      })
    : [];

  let inactive: { id: string; name: string; region: string; phone: string | null }[] = [];
  if (inactiveCount > 0) {
    const candidates = await prisma.account.findMany({
      where: { ...regionFilter, type: 'customer', archived: false, misc: false, lastOrderAt: { not: null }, id: { notIn: [...busy] } },
      select: { id: true, name: true, region: true, phone: true, lastOrderAt: true, avgOrderGapDays: true },
    });
    const now = Date.now();
    inactive = candidates
      .map(a => {
        const threshold = a.avgOrderGapDays ? Math.max(a.avgOrderGapDays * 1.5, 14) : 75;
        const daysSince = (now - a.lastOrderAt!.getTime()) / 86400000;
        return { a, overdueBy: daysSince - threshold };
      })
      .filter(x => x.overdueBy > 0)
      .sort((x, y) => y.overdueBy - x.overdueBy) // most overdue first
      .slice(0, inactiveCount)
      .map(({ a }) => ({ id: a.id, name: a.name, region: a.region, phone: a.phone }));
  }

  return { newLeads, inactive, regions: assignedRegions };
}

// Keeps the day topped up to 5 open new-lead calls and 5 open inactive-customer
// calls. Finish one and the next fills its place. Tasks rolled over from
// yesterday count toward the 5 and 5, so the list never piles up.
// Fills for one rep run one at a time, so two requests at once can't both fill
// the same gap and leave more than 5.
const fills = new Map<string, Promise<unknown>>();
function autoPlan(repId: string, today: Date) {
  const run = (fills.get(repId) ?? Promise.resolve()).then(() => fillPlan(repId, today));
  const tail = run.catch(() => {});
  fills.set(repId, tail);
  tail.then(() => { if (fills.get(repId) === tail) fills.delete(repId); });
  return run;
}

async function fillPlan(repId: string, today: Date) {
  const open = await prisma.task.groupBy({
    by: ['reason'],
    where: { repId, scheduledDate: today, completed: false, reason: { not: null } },
    _count: true,
  });
  const openCount = (reason: string) => open.find(o => o.reason === reason)?._count ?? 0;
  const needLeads = Math.max(0, NEW_LEADS_PER_DAY - openCount('new_lead'));
  const needInactive = Math.max(0, INACTIVE_PER_DAY - openCount('inactive'));
  if (!needLeads && !needInactive) return;   // already full: nothing to look up

  const { newLeads, inactive } = await findSuggestions(repId, today, needLeads, needInactive);
  const data = [
    ...newLeads.map(a => ({ repId, accountId: a.id, type: 'cold_call' as const, scheduledDate: today, fixed: false, reason: 'new_lead' })),
    ...inactive.map(a => ({ repId, accountId: a.id, type: 'cold_call' as const, scheduledDate: today, fixed: false, reason: 'inactive' })),
  ];
  if (data.length) await prisma.task.createMany({ data });
}

// The day's plan. Rolls over anything unfinished, auto-fills from the
// fixed 5 + 5 (refilled as tasks are done), then returns every task for the day,
// including ones already done (shown crossed out, not removed).
tasksRouter.get('/today', async (req, res) => {
  const repId = req.rep!.id;
  const today = dateOnly(req.query.date);
  await rolloverTasks(repId, today);
  await autoPlan(repId, today);

  const [tasks, regions] = await Promise.all([
    prisma.task.findMany({
      where: { repId, scheduledDate: today },
      include: {
        account: {
          select: {
            id: true, name: true, region: true, phone: true, email: true, contactName: true,
            lastOrderAt: true, spend365: true, stage: true, type: true,
            activity: { orderBy: { occurredAt: 'desc' }, take: 1, select: { type: true, note: true, occurredAt: true } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.repRegion.findMany({ where: { repId }, select: { region: true } }),
  ]);

  res.json({
    tasks: tasks.map(t => {
      const { activity, ...account } = t.account;
      return {
        id: t.id,
        type: t.type,
        fixed: t.fixed,
        reason: t.reason,
        completed: t.completed,
        note: t.note,
        account: { ...account, lastActivity: activity[0] ?? null },
      };
    }),
    limit: SCHEDULED_CALLS_PER_DAY,
    counts: { newLeads: NEW_LEADS_PER_DAY, inactive: INACTIVE_PER_DAY },
    regions: regions.map(r => r.region),
  });
});

tasksRouter.get('/upcoming', async (req, res) => {
  const repId = req.rep!.id;
  const days = Number(req.query.days) || 7;
  const today = dateOnly(req.query.date);
  const end = new Date(today);
  end.setUTCDate(end.getUTCDate() + days);

  const tasks = await prisma.task.findMany({
    where: { repId, scheduledDate: { gte: today, lt: end }, completed: false },
    include: { account: { select: { id: true, name: true } } },
    orderBy: { scheduledDate: 'asc' },
  });

  res.json(tasks);
});

// Every task in a date range, done or not, for the calendar view.
// ?from=YYYY-MM-DD&to=YYYY-MM-DD (inclusive, at most ~3 months).
tasksRouter.get('/range', async (req, res) => {
  const from = dateOnly(req.query.from);
  const to = dateOnly(req.query.to);
  if (to < from) return res.status(400).json({ error: 'to must be on or after from' });
  if (to.getTime() - from.getTime() > 100 * 86400000) return res.status(400).json({ error: 'Range too long' });

  const tasks = await prisma.task.findMany({
    where: { repId: req.rep!.id, scheduledDate: { gte: from, lte: to } },
    include: { account: { select: { id: true, name: true, region: true, phone: true } } },
    orderBy: [{ scheduledDate: 'asc' }, { fixed: 'desc' }, { createdAt: 'asc' }],
  });
  res.json(tasks.map(t => ({
    id: t.id,
    date: t.scheduledDate.toISOString().slice(0, 10),
    type: t.type,
    fixed: t.fixed,
    completed: t.completed,
    note: t.note,
    account: t.account,
  })));
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

// Suggestions without adding them (the planner now auto-adds these each
// day; kept for anything that wants a preview).
tasksRouter.get('/suggested', async (req, res) => {
  const repId = req.rep!.id;
  res.json(await findSuggestions(repId, dateOnly(req.query.date), NEW_LEADS_PER_DAY, INACTIVE_PER_DAY));
});