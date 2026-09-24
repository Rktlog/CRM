import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { createActivitySchema, updateActivitySchema } from '../schemas';
import { parseFollowUp } from '../lib/followup';

export const activityRouter = Router();

// List activity across all accounts a rep can see, optionally
// filtered by type — this is what the Visit log page reads, one
// query instead of the frontend fetching every account's full
// detail (which is what broke once the account count grew past a
// few hundred).
activityRouter.get('/', async (req, res) => {
  const type = req.query.type as string | undefined;
  const isManager = req.rep!.role === 'manager';

  const activities = await prisma.activity.findMany({
    where: {
      ...(type ? { type: type as any } : {}),
      account: isManager ? {} : { repId: req.rep!.id },
    },
    include: {
      account: { select: { id: true, name: true, region: true } },
      rep: { select: { name: true } },
    },
    orderBy: { occurredAt: 'desc' },
    take: 300,
  });

  const flattened = activities.map(({ account, rep, ...a }) => ({
    ...a,
    accountId: account.id,
    accountName: account.name,
    accountRegion: account.region,
    repName: rep?.name ?? null,
  }));

  res.json(flattened);
});

activityRouter.post('/', async (req, res) => {
  const parsed = createActivitySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const account = await prisma.account.findUnique({
    where: { id: parsed.data.accountId },
  });
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const isManager = req.rep!.role === 'manager';
  if (!isManager && account.repId !== req.rep!.id) {
    return res.status(403).json({ error: 'Not your account' });
  }

  const activity = await prisma.activity.create({
    data: { ...parsed.data, repId: req.rep!.id },
  });

  const updates: Record<string, unknown> = {};

  // The one manual stage transition: logging any activity against a
  // brand-new lead is what "approached" means. Every stage after this
  // is driven by Cin7 sync data once that job exists, not by this route.
  if (account.stage === 'new_lead') {
    updates.stage = 'approached';
  }

  // Read the note for a follow-up phrase ("follow up in 3 weeks") and
  // set the reminder automatically if one's found.
  const followUpDate = parseFollowUp(activity.note, activity.occurredAt);
  if (followUpDate) {
    updates.nextFollowUpAt = followUpDate;
  }

  if (Object.keys(updates).length > 0) {
    await prisma.account.update({ where: { id: account.id }, data: updates });
  }

  res.status(201).json(activity);
});

// Edit an activity note/type after the fact — fixing a typo or
// adding detail. Only the rep who logged it, or a manager, may edit
// it. Deliberately does NOT let occurredAt be changed — the
// timestamp is a real historical record, only the content of what
// was written is editable.
activityRouter.patch('/:id', async (req, res) => {
  const parsed = updateActivitySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const activity = await prisma.activity.findUnique({ where: { id: req.params.id } });
  if (!activity) return res.status(404).json({ error: 'Activity not found' });

  const isManager = req.rep!.role === 'manager';
  if (!isManager && activity.repId !== req.rep!.id) {
    return res.status(403).json({ error: 'You can only edit your own logged activity' });
  }

  const updated = await prisma.activity.update({
    where: { id: req.params.id },
    data: parsed.data,
  });

  res.json(updated);
});