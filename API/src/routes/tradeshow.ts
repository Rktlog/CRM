import { Router } from 'express';
import * as XLSX from 'xlsx';
import * as ts from '../lib/tradeshow';

// Trade shows. Everyone signed in can write orders and take leads at a show; managers set up shows and give discounts.
//   GET    /tradeshow/shows                      every show with its counts           POST /tradeshow/shows   PATCH/DELETE /tradeshow/shows/:id   (managers)
//   GET    /tradeshow/shows/:id                  one show: its orders, leads and results
//   GET    /tradeshow/shows/:id/export           everything about the show as an Excel file (orders, lines, products, leads, log, follow-ups)
//   GET    /tradeshow/products?q=                products with wholesale price, stock free to sell, what is coming
//   GET    /tradeshow/customers?q=               existing customers
//   POST   /tradeshow/orders                     { showId, kind, accountId | newCustomer }   starts an order (a draft)
//   GET    /tradeshow/orders/:id                 PATCH /tradeshow/orders/:id (lines, discount, freight, card, reference...)
//   POST   /tradeshow/orders/:id/confirm         confirm, email sales@ with the DEAR file, book the 1st follow-up
//   POST   /tradeshow/orders/:id/resend          POST /tradeshow/orders/:id/cancel { reason }   POST /tradeshow/orders/:id/link { number }
//   POST   /tradeshow/leads                      GET/PATCH /tradeshow/leads/:id
//   POST   /tradeshow/log                        { orderId | leadId, kind, note }
//   GET    /tradeshow/followups?who=mine|team|all&showId=     POST /tradeshow/followups { orderId | leadId, date, repId }
//   POST   /tradeshow/followups/:id/done         { kind, note, next: { date, repId } | null }
//   GET    /tradeshow/reps
export const tradeshowRouter = Router();
const fail = (res: any, e: unknown, what: string) => {
  if (e instanceof ts.TsError) return res.status(e.status).json({ error: e.message, ...((e as any).matches ? { matches: (e as any).matches } : {}) });
  console.error(`tradeshow ${what} failed:`, e);
  return res.status(500).json({ error: 'Something went wrong. Try again in a moment.' });
};
const rep = (req: any): ts.Rep => ({ id: req.rep!.id, role: req.rep!.role });
const h = (what: string, f: (req: any, res: any) => Promise<unknown>) => async (req: any, res: any) => { try { await f(req, res); } catch (e) { fail(res, e, what); } };

tradeshowRouter.get('/shows', h('shows', async (_q, res) => res.json({ shows: await ts.listShows() })));
tradeshowRouter.post('/shows', h('new show', async (req, res) => res.status(201).json({ id: await ts.saveShow(rep(req), req.body) })));
tradeshowRouter.get('/shows/:id', h('show', async (req, res) => res.json(await ts.getShow(req.params.id))));
tradeshowRouter.get('/shows/:id/export', h('export', async (req, res) => {
  const x = await ts.exportShow(req.params.id);
  const wb = XLSX.utils.book_new();
  for (const sh of x.sheets) {
    const ws = sh.rows.length ? XLSX.utils.json_to_sheet(sh.rows) : XLSX.utils.aoa_to_sheet([['Nothing yet']]);
    if (sh.rows.length) ws['!cols'] = Object.keys(sh.rows[0]!).map(k => ({ wch: Math.min(60, Math.max(k.length + 2, ...sh.rows.slice(0, 200).map(r => String(r[k] ?? '').length + 2))) }));
    XLSX.utils.book_append_sheet(wb, ws, sh.name);
  }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${x.filename}"`);
  res.send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}));
tradeshowRouter.patch('/shows/:id', h('save show', async (req, res) => res.json({ id: await ts.saveShow(rep(req), req.body, req.params.id) })));
tradeshowRouter.delete('/shows/:id', h('delete show', async (req, res) => { await ts.deleteShow(rep(req), req.params.id); res.json({ ok: true }); }));
tradeshowRouter.get('/products', h('products', async (req, res) => res.json({ products: await ts.searchProducts(req.query.q) })));
tradeshowRouter.get('/customers', h('customers', async (req, res) => res.json({ customers: await ts.searchCustomers(req.query.q) })));
tradeshowRouter.get('/reps', h('reps', async (_q, res) => res.json({ reps: await ts.repsList() })));

tradeshowRouter.post('/orders', h('start order', async (req, res) => res.status(201).json({ id: await ts.startOrder(rep(req), req.body) })));
tradeshowRouter.get('/orders/:id', h('order', async (req, res) => res.json({ order: await ts.getOrder(req.params.id) })));
tradeshowRouter.patch('/orders/:id', h('save order', async (req, res) => { await ts.saveOrder(rep(req), req.params.id, req.body ?? {}); res.json({ order: await ts.getOrder(req.params.id) }); }));
tradeshowRouter.post('/orders/:id/confirm', h('confirm', async (req, res) => { const r = await ts.confirmOrder(rep(req), req.params.id); res.json({ ...r, order: await ts.getOrder(req.params.id) }); }));
tradeshowRouter.post('/orders/:id/resend', h('resend', async (req, res) => { const r = await ts.resendOrder(rep(req), req.params.id); res.json({ ...r, order: await ts.getOrder(req.params.id) }); }));
tradeshowRouter.post('/orders/:id/cancel', h('cancel', async (req, res) => { await ts.cancelOrder(rep(req), req.params.id, req.body?.reason); res.json({ ok: true }); }));
tradeshowRouter.post('/orders/:id/link', h('link', async (req, res) => { await ts.linkDear(rep(req), req.params.id, req.body?.number); res.json({ order: await ts.getOrder(req.params.id) }); }));

tradeshowRouter.post('/leads', h('new lead', async (req, res) => res.status(201).json({ id: await ts.createLead(rep(req), req.body) })));
tradeshowRouter.get('/leads/:id', h('lead', async (req, res) => res.json({ lead: await ts.getLead(req.params.id) })));
tradeshowRouter.patch('/leads/:id', h('save lead', async (req, res) => { await ts.updateLead(rep(req), req.params.id, req.body ?? {}); res.json({ lead: await ts.getLead(req.params.id) }); }));

tradeshowRouter.post('/log', h('log', async (req, res) => { await ts.addLog(rep(req), { orderId: req.body?.orderId, leadId: req.body?.leadId }, req.body?.kind, req.body?.note); res.status(201).json({ ok: true }); }));
tradeshowRouter.get('/followups', h('follow-ups', async (req, res) => res.json({ followUps: await ts.listFollowUps(rep(req), { who: req.query.who, showId: req.query.showId }) })));
tradeshowRouter.post('/followups', h('book follow-up', async (req, res) => { await ts.addFollowUp(rep(req), req.body); res.status(201).json({ ok: true }); }));
tradeshowRouter.post('/followups/:id/done', h('follow-up done', async (req, res) => { await ts.doneFollowUp(rep(req), req.params.id, req.body ?? {}); res.json({ ok: true }); }));
