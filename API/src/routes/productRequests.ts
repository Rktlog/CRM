import { Router } from 'express';
import { cancelOwn, createRequest, listClosed, listMine, listOpen, parseNewRequest, parseUpdate, RequestError, summary, updateRequest } from '../lib/productRequests';
import { notifyNewRequest } from '../lib/alerts';

// Special product requests.
//   POST  /product-requests            anyone: ask for a product (one we sell, or a new one)
//   GET   /product-requests/mine       anyone: my own requests and what the ordering team said
//   POST  /product-requests/:id/cancel the requester: take back a request nobody has started on
//   GET   /product-requests/open       managers: everything still open (the Special requests section of Order Forecast & Procurement)
//   GET   /product-requests/closed     managers: ordered, declined or cancelled in the last 30 days
//   GET   /product-requests/summary    managers: how many are new and how many are open (the menu badge); anyone else just gets zeros
//   PATCH /product-requests/:id        managers: move it along (seen, asked supplier, supplier replied, ordered, declined) and leave a note for the requester
export const productRequestsRouter = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const melbourneToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const managersOnly = (req: any, res: any) => { if (req.rep!.role !== 'manager') { res.status(403).json({ error: 'Only the ordering team can do that.' }); return false; } return true; };
const fail = (res: any, e: unknown, what: string) => {
  if (e instanceof RequestError) return res.status(e.status).json({ error: e.message });
  console.error(`product-requests ${what} failed:`, e);
  return res.status(500).json({ error: 'Something went wrong. Try again in a moment.' });
};

productRequestsRouter.post('/', async (req, res) => {
  try {
    const parsed = parseNewRequest(req.body, melbourneToday());
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });
    const { item, duplicate } = await createRequest(req.rep!.id, parsed.ok);
    if (!duplicate) void notifyNewRequest(item);   // an email to the ordering team, if a manager has switched that list on in Settings. It never delays or breaks the request.
    res.status(duplicate ? 200 : 201).json({ request: item, duplicate });
  } catch (e) { fail(res, e, 'create'); }
});

productRequestsRouter.get('/mine', async (req, res) => { try { res.json({ items: await listMine(req.rep!.id) }); } catch (e) { fail(res, e, 'mine'); } });

productRequestsRouter.get('/summary', async (req, res) => {
  try { res.json(req.rep!.role === 'manager' ? await summary() : { ready: true, newCount: 0, openCount: 0 }); } catch (e) { fail(res, e, 'summary'); }
});

productRequestsRouter.get('/open', async (req, res) => { try { if (!managersOnly(req, res)) return; res.json({ items: await listOpen() }); } catch (e) { fail(res, e, 'open'); } });
productRequestsRouter.get('/closed', async (req, res) => { try { if (!managersOnly(req, res)) return; res.json({ items: await listClosed(30) }); } catch (e) { fail(res, e, 'closed'); } });

productRequestsRouter.patch('/:id', async (req, res) => {
  try {
    if (!managersOnly(req, res)) return;
    if (!UUID.test(String(req.params.id))) return res.status(404).json({ error: 'That request was not found.' });
    const parsed = parseUpdate(req.body);
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });
    res.json({ request: await updateRequest(String(req.params.id), req.rep!.id, parsed.ok) });
  } catch (e) { fail(res, e, 'update'); }
});

productRequestsRouter.post('/:id/cancel', async (req, res) => {
  try {
    if (!UUID.test(String(req.params.id))) return res.status(404).json({ error: 'That request was not found.' });
    res.json({ request: await cancelOwn(String(req.params.id), req.rep!.id) });
  } catch (e) { fail(res, e, 'cancel'); }
});
