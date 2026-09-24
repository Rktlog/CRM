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
  res.json(reps.map(r => ({ repId: r.id, repName: r.name, regions: (regionsByRep.get(r.id) ?? []).sort() })));
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