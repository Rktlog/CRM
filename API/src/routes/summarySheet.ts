import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { melDay } from '../lib/receivables';
import { summarySheet, currentFy } from '../lib/summarySheet';
import { summaryWorkbook } from '../lib/summarySheetXlsx';

// The Summary sheet (the team's Summary_Rhonda layout) for one rep.
//   GET /summary-sheet?fy=2026            a rep gets their own (fy is the year the financial year starts: 2026 is FY 2026/27)
//                                         a manager asks for a rep with &repId=
//   GET /summary-sheet/reps               managers only: every rep that has states, with those states (for the Dashboard's folded rep summaries)
//   GET /summary-sheet/download?fy=&repId=   managers only: the Excel file, one tab per rep (all reps with states if no repId)
export const summarySheetRouter = Router();

const fyOf = (q: unknown, today: string) => {
  const n = Number(q);
  return Number.isInteger(n) && n >= 2000 && n <= 2100 ? n : currentFy(today);
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

summarySheetRouter.get('/', async (req, res) => {
  try {
    const rep = req.rep!;
    const today = melDay();
    let repId = rep.id;
    if (rep.role === 'manager') {
      const asked = String(req.query.repId ?? '');
      if (!UUID.test(asked)) return res.status(400).json({ error: 'Pick a rep' });
      repId = asked;
    }   // anyone else only ever gets their own
    res.json(await summarySheet({ repId, fy: fyOf(req.query.fy, today), today }));
  } catch (e) {
    console.error('summary sheet failed:', (e as Error).message);
    res.status(500).json({ error: 'Could not load the summary' });
  }
});

const STATE_ORDER = ['NSW', 'ACT', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'NT', 'NZ'];
const stateRank = (s: string) => (STATE_ORDER.indexOf(s) < 0 ? 100 : STATE_ORDER.indexOf(s));
summarySheetRouter.get('/reps', async (req, res) => {
  try {
    if (req.rep!.role !== 'manager') return res.status(403).json({ error: 'Managers only' });
    const links = await prisma.repRegion.findMany({ select: { repId: true, region: true } });
    const ids = [...new Set(links.map(l => l.repId))];
    const reps = ids.length ? await prisma.rep.findMany({ where: { id: { in: ids } }, select: { id: true, name: true }, orderBy: { name: 'asc' } }) : [];
    res.json(reps.map(r => ({
      id: r.id, name: r.name,
      regions: [...new Set(links.filter(l => l.repId === r.id).map(l => l.region))].sort((a, b) => stateRank(a) - stateRank(b) || a.localeCompare(b)),   // each state once
    })));
  } catch (e) {
    console.error('summary sheet reps failed:', (e as Error).message);
    res.status(500).json({ error: 'Could not load the reps' });
  }
});

summarySheetRouter.get('/download', async (req, res) => {
  try {
    if (req.rep!.role !== 'manager') return res.status(403).json({ error: 'Managers only' });
    const today = melDay();
    const fy = fyOf(req.query.fy, today);
    const asked = String(req.query.repId ?? '');
    if (asked && !UUID.test(asked)) return res.status(400).json({ error: 'No such rep' });
    const reps = await prisma.rep.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } });
    let chosen = reps;
    if (asked) {
      chosen = reps.filter(r => r.id === asked);
      if (!chosen.length) return res.status(404).json({ error: 'No such rep' });
    } else {
      const withStates = new Set((await prisma.repRegion.findMany({ select: { repId: true } })).map(r => r.repId));
      chosen = reps.filter(r => withStates.has(r.id));   // a rep with no states has nothing to show
      if (!chosen.length) return res.status(404).json({ error: 'No rep has states assigned yet' });
    }
    const sheets = [];
    for (const r of chosen) sheets.push({ name: r.name, model: await summarySheet({ repId: r.id, fy, today }) });
    const buffer = await summaryWorkbook(sheets);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="rep-summary-FY${fy}-${String(fy + 1).slice(2)}.xlsx"`);
    res.send(buffer);
  } catch (e) {
    console.error('summary sheet download failed:', (e as Error).message);
    res.status(500).json({ error: 'Could not build the file' });
  }
});