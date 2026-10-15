import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { parseDefinition, reportMeta, runReport, Definition } from '../lib/customReport';
import { reportWorkbook } from '../lib/customReportXlsx';
import { melDay } from '../lib/receivables';

// Custom reports (Reports page > Build a report). Anyone signed in can build one; what it shows follows their
// territory. A saved report is private unless its owner shares it with the team.
//   GET    /custom-reports/meta                   datasets, columns and the choices for each filter
//   GET    /custom-reports/run?def=...            a preview (first rows) of a report that isn't saved
//   GET    /custom-reports/download?def=...&name= the Excel file
//   GET    /custom-reports                        saved reports: yours and the shared ones
//   POST   /custom-reports   { name, shared, definition }
//   PUT    /custom-reports/:id                    owner or a manager
//   DELETE /custom-reports/:id                    owner or a manager
// `def` is the definition as JSON, base64 encoded.
export const customReportsRouter = Router();

const PREVIEW_ROWS = 100;

function definitionFrom(raw: unknown): Definition {
  let json: unknown;
  try { json = JSON.parse(Buffer.from(String(raw ?? ''), 'base64').toString('utf8')); }
  catch { throw new Error('Bad report definition'); }
  return parseDefinition(json);
}
const bad = (res: any, e: unknown) => res.status(400).json({ error: (e as Error).message });
const uuid = (v: string) => /^[0-9a-f-]{36}$/i.test(v);

customReportsRouter.get('/meta', async (req, res) => {
  try { res.json(await reportMeta(req.rep!)); }
  catch (e) { console.error('report meta failed', e); res.status(500).json({ error: (e as Error).message }); }
});

customReportsRouter.get('/run', async (req, res) => {
  try {
    const def = definitionFrom(req.query.def);
    const r = await runReport(def, req.rep!, melDay());
    res.json({ total: r.total, columns: r.columns, rows: r.rows.slice(0, PREVIEW_ROWS), truncated: r.total > PREVIEW_ROWS });
  } catch (e) { bad(res, e); }
});

customReportsRouter.get('/download', async (req, res) => {
  try {
    const def = definitionFrom(req.query.def);
    const name = String(req.query.name ?? '').trim().slice(0, 80) || 'Custom report';
    const r = await runReport(def, req.rep!, melDay());
    const [me] = await prisma.$queryRaw<{ name: string }[]>`select name from crm.reps where id = ${req.rep!.id}::uuid`;
    const buffer = reportWorkbook(r, def, { name, by: me?.name ?? '', on: melDay() });
    const file = `${name.replace(/[^A-Za-z0-9 _-]+/g, '').trim().replace(/\s+/g, '-') || 'report'}-${melDay()}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${file}"`);
    res.send(buffer);
  } catch (e) { bad(res, e); }
});

customReportsRouter.get('/', async (req, res) => {
  const rows = await prisma.$queryRaw<any[]>`
    select r.id, r.name, r.definition, r.shared, r.rep_id as "repId", p.name as "ownerName", r.updated_at as "updatedAt"
    from crm.custom_reports r left join crm.reps p on p.id = r.rep_id
    where r.rep_id = ${req.rep!.id}::uuid or r.shared
    order by r.name`;
  res.json(rows.map(r => ({ id: r.id, name: r.name, definition: r.definition, shared: r.shared, mine: r.repId === req.rep!.id, ownerName: r.ownerName ?? '', updatedAt: r.updatedAt })));
});

customReportsRouter.post('/', async (req, res) => {
  try {
    const name = String(req.body?.name ?? '').trim().slice(0, 80);
    if (!name) throw new Error('Give the report a name');
    const def = parseDefinition(req.body?.definition);
    const [row] = await prisma.$queryRaw<{ id: string }[]>`
      insert into crm.custom_reports (rep_id, name, definition, shared)
      values (${req.rep!.id}::uuid, ${name}, ${JSON.stringify(def)}::jsonb, ${req.body?.shared === true})
      returning id`;
    res.status(201).json({ id: row.id });
  } catch (e) { bad(res, e); }
});

async function ownReport(req: any, res: any): Promise<{ id: string } | null> {
  if (!uuid(req.params.id)) { res.status(400).json({ error: 'Bad report' }); return null; }
  const [r] = await prisma.$queryRaw<{ id: string; repId: string }[]>`select id, rep_id as "repId" from crm.custom_reports where id = ${req.params.id}::uuid`;
  if (!r) { res.status(404).json({ error: 'Report not found' }); return null; }
  if (r.repId !== req.rep!.id && req.rep!.role !== 'manager') { res.status(403).json({ error: 'Only the person who made this report can change it' }); return null; }
  return r;
}

customReportsRouter.put('/:id', async (req, res) => {
  try {
    const r = await ownReport(req, res); if (!r) return;
    const name = String(req.body?.name ?? '').trim().slice(0, 80);
    if (!name) throw new Error('Give the report a name');
    const def = parseDefinition(req.body?.definition);
    await prisma.$executeRaw`
      update crm.custom_reports set name = ${name}, definition = ${JSON.stringify(def)}::jsonb, shared = ${req.body?.shared === true}, updated_at = now()
      where id = ${r.id}::uuid`;
    res.json({ ok: true });
  } catch (e) { bad(res, e); }
});

customReportsRouter.delete('/:id', async (req, res) => {
  const r = await ownReport(req, res); if (!r) return;
  await prisma.$executeRaw`delete from crm.custom_reports where id = ${r.id}::uuid`;
  res.json({ ok: true });
});