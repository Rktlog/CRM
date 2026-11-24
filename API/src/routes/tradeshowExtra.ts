import express, { Router } from 'express';
import * as ts from '../lib/tradeshow';
import * as x from '../lib/tradeshowExtra';
import * as ai from '../lib/tradeshowClaude';
import * as badge from '../lib/tradeshowBadge';

// Trade shows, part 2 (mounted next to the part 1 routes, under /tradeshow). Managers set up offers, freight rates and old shows; everyone signed in can use them at a show.
//   GET/POST /shows/:id/offers    PATCH/DELETE /shows/:id/offers/:oid    POST /shows/:id/offers/copy { fromShowId }
//   GET/PUT/DELETE /freight       the freight rates (the team's calculator), editable, with a reset
//   GET /shows/:id/queue          payments, and the orders still to be entered in DEAR (with DEAR orders that look like them)    POST /orders/:id/reject-match { dearId }
//   GET/POST /shows/:id/appointments    PATCH/DELETE /shows/:id/appointments/:aid
//   GET/POST /shows/:id/checklist  POST /shows/:id/checklist/load  PATCH/DELETE /shows/:id/checklist/:cid    GET/PUT /checklist-template
//   GET/PUT /shows/:id/feedback
//   POST /history-shows           PUT /shows/:id/history        old shows, for the comparison
//   GET /compare?series=          the Sales Comparison, year on year
//   POST /shows/:id/import/read   an Excel file in (sent as text, JSON inside), what Claude found out    POST /shows/:id/import/save
//   POST /badge/read              { image (base64), mime }  a photo of a visitor badge in (sent as text, JSON inside), the printed words out, plus customers that look the same. Saves nothing; the photo is never kept.
//   POST /ask                     { showId?, question, history? }  Ask Claude
export const tradeshowExtraRouter = Router();
const fail = (res: any, e: unknown, what: string) => {
  if (e instanceof ts.TsError) return res.status(e.status).json({ error: e.message });
  console.error(`tradeshow ${what} failed:`, e);
  return res.status(500).json({ error: 'Something went wrong. Try again in a moment.' });
};
const rep = (req: any): ts.Rep => ({ id: req.rep!.id, role: req.rep!.role });
const h = (what: string, f: (req: any, res: any) => Promise<unknown>) => async (req: any, res: any) => { try { await f(req, res); } catch (e) { fail(res, e, what); } };
const big = express.text({ type: '*/*', limit: '30mb' });   // a workbook is too big for the normal 100 KB JSON limit; the page sends it as text with the JSON inside
const parse = (req: any) => { try { return typeof req.body === 'string' && req.body ? JSON.parse(req.body) : {}; } catch { throw new ts.TsError('That did not arrive properly. Try again.'); } };

const r = tradeshowExtraRouter;
r.get('/shows/:id/offers', h('offers', async (q, s) => s.json({ offers: await x.listOffers(q.params.id) })));
r.post('/shows/:id/offers', h('new offer', async (q, s) => s.status(201).json({ id: await x.saveOffer(rep(q), q.params.id, q.body) })));
r.post('/shows/:id/offers/copy', h('copy offers', async (q, s) => s.json({ copied: await x.copyOffers(rep(q), q.params.id, q.body?.fromShowId) })));
r.patch('/shows/:id/offers/:oid', h('save offer', async (q, s) => s.json({ id: await x.saveOffer(rep(q), q.params.id, q.body, q.params.oid) })));
r.delete('/shows/:id/offers/:oid', h('delete offer', async (q, s) => { await x.deleteOffer(rep(q), q.params.id, q.params.oid); s.json({ ok: true }); }));

r.get('/freight', h('freight rates', async (_q, s) => s.json(await x.getFreightCfg())));
r.put('/freight', h('save freight rates', async (q, s) => s.json(await x.saveFreightCfg(rep(q), q.body?.cfg))));
r.delete('/freight', h('reset freight rates', async (q, s) => s.json(await x.resetFreightCfg(rep(q)))));

r.get('/shows/:id/queue', h('queue', async (q, s) => s.json(await x.getQueue(q.params.id))));
r.post('/orders/:id/reject-match', h('reject match', async (q, s) => { await x.rejectMatch(rep(q), q.params.id, q.body?.dearId); s.json({ ok: true }); }));

r.get('/shows/:id/appointments', h('appointments', async (q, s) => s.json({ appointments: await x.listAppointments(q.params.id) })));
r.post('/shows/:id/appointments', h('new appointment', async (q, s) => s.status(201).json({ id: await x.saveAppointment(rep(q), q.params.id, q.body) })));
r.patch('/shows/:id/appointments/:aid', h('save appointment', async (q, s) => s.json({ id: await x.saveAppointment(rep(q), q.params.id, q.body, q.params.aid) })));
r.delete('/shows/:id/appointments/:aid', h('delete appointment', async (q, s) => { await x.deleteAppointment(rep(q), q.params.id, q.params.aid); s.json({ ok: true }); }));

r.get('/checklist-template', h('checklist template', async (_q, s) => s.json({ items: await x.getChecklistTemplate() })));
r.put('/checklist-template', h('save checklist template', async (q, s) => { await x.saveChecklistTemplate(rep(q), q.body?.items); s.json({ ok: true }); }));
r.get('/shows/:id/checklist', h('checklist', async (q, s) => s.json({ items: await x.getChecklist(q.params.id) })));
r.post('/shows/:id/checklist/load', h('load checklist', async (q, s) => s.json({ added: await x.loadChecklistTemplate(q.params.id) })));
r.post('/shows/:id/checklist', h('add checklist item', async (q, s) => { await x.addChecklistItems(q.params.id, Array.isArray(q.body?.items) ? q.body.items : [{ section: q.body?.section, item: q.body?.item }]); s.status(201).json({ ok: true }); }));
r.patch('/shows/:id/checklist/:cid', h('update checklist item', async (q, s) => { await x.updateChecklistItem(rep(q), q.params.id, q.params.cid, q.body ?? {}); s.json({ ok: true }); }));
r.delete('/shows/:id/checklist/:cid', h('delete checklist item', async (q, s) => { await x.deleteChecklistItem(q.params.id, q.params.cid); s.json({ ok: true }); }));

r.get('/shows/:id/feedback', h('feedback', async (q, s) => s.json(await x.getFeedback(q.params.id))));
r.put('/shows/:id/feedback', h('save feedback', async (q, s) => { await x.saveFeedback(rep(q), q.params.id, q.body ?? {}); s.json(await x.getFeedback(q.params.id)); }));

r.post('/history-shows', h('new old show', async (q, s) => s.status(201).json({ id: await x.createHistoryShow(rep(q), q.body) })));
r.put('/shows/:id/history', h('save old show figures', async (q, s) => s.json(await x.saveHistory(rep(q), q.params.id, q.body))));
r.get('/compare', h('comparison', async (q, s) => s.json(await x.getComparison(q.query.series))));

r.post('/shows/:id/import/read', big, h('read workbook', async (q, s) => s.json(await ai.readWorkbook(rep(q), q.params.id, parse(q).file ?? {}))));
r.post('/shows/:id/import/save', big, h('save workbook findings', async (q, s) => s.json(await ai.saveImport(rep(q), q.params.id, parse(q)))));
r.post('/badge/read', express.text({ type: '*/*', limit: '8mb' }), h('read badge', async (q, s) => s.json(await badge.readBadge(rep(q), parse(q)))));
r.post('/ask', h('ask Claude', async (q, s) => s.json(await ai.askClaude(rep(q), q.body ?? {}))));
