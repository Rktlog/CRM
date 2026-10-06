import { Router } from 'express';
import { prisma } from '../lib/prisma';

export const repRegionsRouter = Router();

repRegionsRouter.get('/', async (req, res) => {
  const repId = (req.query.repId as string) || req.rep!.id;
  if (repId !== req.rep!.id && req.rep!.role !== 'manager') {
    return res.status(403).json({ error: 'Only a manager can view another rep\'s regions' });
  }
  const regions = await prisma.repRegion.findMany({ where: { repId }, select: { region: true } });
  res.json(regions.map(r => r.region));
});

// Every rep's current territory at once — the summary shown under
// the assignment picker in Settings.
repRegionsRouter.get('/all', async (req, res) => {
  if (req.rep!.role !== 'manager') {
    return res.status(403).json({ error: 'Only a manager can view territory assignments' });
  }
  const reps = await prisma.rep.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } });
  const allRegions = await prisma.repRegion.findMany({ select: { repId: true, region: true } });
  const regionsByRep = new Map<string, string[]>();
  for (const r of allRegions) {
    if (!regionsByRep.has(r.repId)) regionsByRep.set(r.repId, []);
    regionsByRep.get(r.repId)!.push(r.region);
  }
  const hiddenCounts = new Map((await prisma.$queryRaw<{ rep_id: string; n: number }[]>`
    select rep_id, count(*)::int as n from crm.rep_account_exclusions group by rep_id`).map(h => [h.rep_id, h.n]));
  res.json(reps.map(r => ({
    repId: r.id, repName: r.name, regions: (regionsByRep.get(r.id) ?? []).sort(),
    hiddenAccounts: hiddenCounts.get(r.id) ?? 0,
  })));
});

repRegionsRouter.put('/', async (req, res) => {
  if (req.rep!.role !== 'manager') {
    return res.status(403).json({ error: 'Only a manager can assign territories' });
  }
  const { repId, regions } = req.body as { repId: string; regions: string[] };
  if (!repId || !Array.isArray(regions)) {
    return res.status(400).json({ error: 'repId and regions[] required' });
  }

  // Replace wholesale — simplest correct semantics for "set this
  // rep's territory to exactly these states."
  await prisma.$transaction([
    prisma.repRegion.deleteMany({ where: { repId } }),
    prisma.repRegion.createMany({ data: regions.map(region => ({ repId, region })) }),
  ]);

  res.json({ ok: true, regions });
});

// ---------- Hidden accounts (managers) ----------
// Accounts kept off a rep's lists even though they're in the rep's states,
// e.g. house accounts or ones someone else looks after. Managers always
// see everything; the account itself (orders, logs, balance) is untouched.

// GET /rep-regions/hidden?repId=  -> the accounts hidden from that rep
repRegionsRouter.get('/hidden', async (req, res) => {
  if (req.rep!.role !== 'manager') return res.status(403).json({ error: 'Only a manager can view hidden accounts' });
  const repId = String(req.query.repId ?? '');
  if (!repId) return res.status(400).json({ error: 'repId required' });
  const rows = await prisma.$queryRaw<any[]>`
    select e.account_id as "accountId", a.name, a.region, e.created_at as "createdAt", r.name as "hiddenBy"
    from crm.rep_account_exclusions e
    join crm.accounts a on a.id = e.account_id
    left join crm.reps r on r.id = e.created_by
    where e.rep_id = ${repId}::uuid
    order by a.name`;
  res.json(rows);
});

// POST /rep-regions/hidden  { repId, accountId }
repRegionsRouter.post('/hidden', async (req, res) => {
  if (req.rep!.role !== 'manager') return res.status(403).json({ error: 'Only a manager can hide accounts' });
  const { repId, accountId } = req.body ?? {};
  if (!repId || !accountId) return res.status(400).json({ error: 'repId and accountId required' });
  await prisma.$executeRaw`
    insert into crm.rep_account_exclusions (rep_id, account_id, created_by)
    values (${repId}::uuid, ${accountId}::uuid, ${req.rep!.id}::uuid)
    on conflict (rep_id, account_id) do nothing`;
  res.status(201).json({ ok: true });
});

// DELETE /rep-regions/hidden/:repId/:accountId  -> show it to the rep again
repRegionsRouter.delete('/hidden/:repId/:accountId', async (req, res) => {
  if (req.rep!.role !== 'manager') return res.status(403).json({ error: 'Only a manager can change hidden accounts' });
  await prisma.$executeRaw`
    delete from crm.rep_account_exclusions
    where rep_id = ${req.params.repId}::uuid and account_id = ${req.params.accountId}::uuid`;
  res.json({ ok: true });
});