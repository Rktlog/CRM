import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { territoryWhere, canSeeAccount } from '../lib/territory';
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

  const activities = await prisma.activity.findMany({
    where: {
      ...(type ? { type: type as any } : {}),
      account: await territoryWhere(req.rep!),
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

  if (!(await canSeeAccount(req.rep!, account))) {
    return res.status(403).json({ error: 'This account is outside your states' });
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
// ---------- GET /activity/feed (managers) ----------
// Every log the team adds or edits, newest first, without opening each
// account. ?rep=<repId> ?type=call|email|visit ?days=1|7|30|90 ?q=<text>
// ?before=<ISO time> for the next page (pass the last row's sortAt).
activityRouter.get('/feed', async (req, res) => {
  if (req.rep!.role !== 'manager') return res.status(403).json({ error: 'Managers only' });

  const repId = typeof req.query.rep === 'string' && req.query.rep ? req.query.rep : null;
  const type = ['call', 'email', 'visit'].includes(String(req.query.type)) ? String(req.query.type) : null;
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 7));
  const since = new Date(Date.now() - days * 86400000);
  const q = typeof req.query.q === 'string' && req.query.q.trim() ? `%${req.query.q.trim()}%` : null;
  const before = typeof req.query.before === 'string' && !Number.isNaN(Date.parse(req.query.before)) ? new Date(req.query.before) : null;
  const PAGE = 50;

  const rows = await prisma.$queryRaw<any[]>`
    select x.id, x.type::text as type, x.note, x.photo_url as "photoUrl",
           x.occurred_at as "occurredAt", x.created_at as "createdAt", x.updated_at as "updatedAt",
           greatest(x.created_at, coalesce(x.updated_at, x.created_at)) as "sortAt",
           a.id as "accountId", a.name as "accountName", a.region as "accountRegion",
           r.id as "repId", r.name as "repName"
    from crm.activity x
    join crm.accounts a on a.id = x.account_id
    join crm.reps r on r.id = x.rep_id
    where greatest(x.created_at, coalesce(x.updated_at, x.created_at)) >= ${since}
      and (${repId}::uuid is null or x.rep_id = ${repId}::uuid)
      and (${type}::text is null or x.type::text = ${type}::text)
      and (${q}::text is null or x.note ilike ${q}::text or a.name ilike ${q}::text)
      and (${before}::timestamp is null or greatest(x.created_at, coalesce(x.updated_at, x.created_at)) < ${before}::timestamp)
    order by "sortAt" desc
    limit ${PAGE + 1}`;

  const reps = await prisma.rep.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } });
  res.json({
    rows: rows.slice(0, PAGE).map(r => ({ ...r, edited: !!r.updatedAt })),
    hasMore: rows.length > PAGE,
    reps,
  });
});

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
    data: { ...parsed.data, updatedAt: new Date() }, // so the team log shows the edit
  });

  res.json(updated);
});