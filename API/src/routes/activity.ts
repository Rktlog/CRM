import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { territoryWhere, canSeeAccount } from '../lib/territory';
import { createActivitySchema, updateActivitySchema } from '../schemas';
import { parseFollowUp } from '../lib/followup';

export const activityRouter = Router();

// A log can be given a past date (a call made yesterday, logged today) but not a future one.
// A day and a half of slack covers time zones; anything before 2015 is a typing mistake.
function badLogDate(iso?: string): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (t > Date.now() + 36 * 3600 * 1000) return "A log can't be dated in the future";
  if (new Date(iso).getFullYear() < 2015) return 'That date looks wrong';
  return null;
}

const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z')) && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;

// GET /activity/reps -> everyone who has logged any activity, for the rep filter on the Activity log page.
activityRouter.get('/reps', async (_req, res) => {
  const rows = await prisma.$queryRaw<{ id: string; name: string }[]>`select r.id, r.name from crm.reps r where exists (select 1 from crm.activity a where a.rep_id = r.id) order by r.name`;
  res.json(rows);
});

// List activity across all accounts a rep can see, optionally
// filtered by type — this is what the Visit log page reads, one
// query instead of the frontend fetching every account's full
// detail (which is what broke once the account count grew past a
// few hundred).
// Filters (all optional): ?type=call  ?repId=<rep>  ?from=2026-10-01&to=2026-10-31 (both days included, Melbourne time).
// They are applied here, not on the page, because the page only ever receives the most recent 300.
activityRouter.get('/', async (req, res) => {
  const type = req.query.type as string | undefined;
  const repId = req.query.repId as string | undefined, from = req.query.from as string | undefined, to = req.query.to as string | undefined;
  if (repId && !/^[0-9a-f-]{36}$/i.test(repId)) return res.status(400).json({ error: 'Bad rep' });
  if ((from && !isDay(from)) || (to && !isDay(to))) return res.status(400).json({ error: 'Dates must look like 2026-10-31' });
  if (from && to && to < from) return res.status(400).json({ error: 'The end date is before the start date' });
  // A day is midnight to midnight in Melbourne, which is not always 24 hours long, so the database works the edges out.
  let occurredAt: { gte?: Date; lt?: Date } | undefined;
  if (from || to) {
    const [edge] = await prisma.$queryRaw<{ start: Date | null; end: Date | null }[]>`
      select (${from ?? null}::date::timestamp at time zone 'Australia/Melbourne') as start, ((${to ?? null}::date + 1)::timestamp at time zone 'Australia/Melbourne') as end`;
    occurredAt = { ...(from && edge?.start ? { gte: new Date(edge.start) } : {}), ...(to && edge?.end ? { lt: new Date(edge.end) } : {}) };
  }

  const activities = await prisma.activity.findMany({
    where: {
      ...(type ? { type: type as any } : {}),
      ...(repId ? { repId } : {}),
      ...(occurredAt ? { occurredAt } : {}),
      account: await territoryWhere(req.rep!),
    },
    include: {
      account: { select: { id: true, name: true, region: true } },
      rep: { select: { name: true } },
      quote: { select: { id: true, number: true } },
    },
    orderBy: { occurredAt: 'desc' },
    take: 300,
  });

  const flattened = activities.map(({ account, rep, quote, ...a }) => ({
    ...a,
    orderId: quote?.id ?? null,
    orderNumber: quote?.number ?? null,
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

  const dateProblem = badLogDate(parsed.data.occurredAt);
  if (dateProblem) return res.status(400).json({ error: dateProblem });

  const account = await prisma.account.findUnique({
    where: { id: parsed.data.accountId },
  });
  if (!account) return res.status(404).json({ error: 'Account not found' });

  if (!(await canSeeAccount(req.rep!, account))) {
    return res.status(403).json({ error: 'This account is outside your states' });
  }

  // A log can be about one of this account's orders ("chasing payment on SQ36566"). It is the same log, so it
  // shows in the account's main log too.
  const { orderId, ...logData } = parsed.data;
  if (orderId) {
    const order = await prisma.quote.findUnique({ where: { id: orderId }, select: { accountId: true } });
    if (!order || order.accountId !== account.id) return res.status(400).json({ error: "That order doesn't belong to this account" });
  }
 
  const activity = await prisma.activity.create({
    data: {
      ...logData,
      ...(orderId ? { quoteId: orderId } : {}),
      ...(parsed.data.occurredAt ? { occurredAt: new Date(parsed.data.occurredAt) } : {}),   // else the database stamps "now"
      repId: req.rep!.id,
    },
  });

  const updates: Record<string, unknown> = {};

  // The one manual stage transition: logging any activity against a
  // brand-new lead is what "approached" means. Every stage after this
  // is driven by Cin7 sync data once that job exists, not by this route.
  // A remark (a comment or feedback) is not a contact with the customer, so it does not count as approaching them.
  const isRemark = parsed.data.type === 'remark';
  if (!isRemark && account.stage === 'new_lead') {
    updates.stage = 'approached';
  }

  // Read the note for a follow-up phrase ("follow up in 3 weeks") and
  // set the reminder automatically if one's found.
  const followUpDate = isRemark ? null : parseFollowUp(activity.note, activity.occurredAt);
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
// account. ?rep=<repId> ?type=call|email|visit|remark ?days=1|7|30|90 ?q=<text>
// ?before=<ISO time> for the next page (pass the last row's sortAt).
activityRouter.get('/feed', async (req, res) => {
  if (req.rep!.role !== 'manager') return res.status(403).json({ error: 'Managers only' });

  const repId = typeof req.query.rep === 'string' && req.query.rep ? req.query.rep : null;
  const type = ['call', 'email', 'visit', 'remark'].includes(String(req.query.type)) ? String(req.query.type) : null;
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
           qq.id as "orderId", qq.number as "orderNumber",
           r.id as "repId", r.name as "repName"
    from crm.activity x
     join crm.accounts a on a.id = x.account_id
    join crm.reps r on r.id = x.rep_id
    left join crm.quotes qq on qq.id = x.quote_id
    where greatest(x.created_at, coalesce(x.updated_at, x.created_at)) >= ${since}
      and (${repId}::uuid is null or x.rep_id = ${repId}::uuid)
      and (${type}::text is null or x.type::text = ${type}::text)
      and (${q}::text is null or x.note ilike ${q}::text or a.name ilike ${q}::text or qq.number ilike ${q}::text)
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

  const dateProblem = badLogDate(parsed.data.occurredAt);
  if (dateProblem) return res.status(400).json({ error: dateProblem });

  const activity = await prisma.activity.findUnique({ where: { id: req.params.id } });
  if (!activity) return res.status(404).json({ error: 'Activity not found' });

  const isManager = req.rep!.role === 'manager';
  if (!isManager && activity.repId !== req.rep!.id) {
    return res.status(403).json({ error: 'You can only edit your own logged activity' });
  }

  const updated = await prisma.activity.update({
    where: { id: req.params.id },
    data: {
      ...parsed.data,
      ...(parsed.data.occurredAt ? { occurredAt: new Date(parsed.data.occurredAt) } : {}),
      updatedAt: new Date(), // so the team log shows the edit
    },
  });

  res.json(updated);
});