import { Router } from 'express';
import { attachConfirmation, deleteOrder, getConfirmation, getOrder, LiewoodError, listOrders, MAX_PDF, MAX_SHEET, syncLiewoodPos, updateOrder, uploadSalesOrder } from '../lib/liewood';

// Liewood orders (Products, Liewood). Everyone signed in can look; managers add, change and delete.
//   GET    /liewood/orders                       every order with its stage
//   POST   /liewood/orders?replace=1             the Excel sales order as the body (application/octet-stream), its name in X-File-Name (URL-encoded)
//   GET    /liewood/orders/:id                   one order: its lines tallied against the DEAR PO, the invoices and receipts
//   PATCH  /liewood/orders/:id                   { name, eta, poNumber, notes, closed }
//   DELETE /liewood/orders/:id
//   POST   /liewood/orders/:id/confirmation      the PDF order confirmation as the body
//   GET    /liewood/orders/:id/confirmation      the PDF back
//   POST   /liewood/check                        read the linked POs from DEAR now (at most once a minute)
export const liewoodRouter = Router();

const fail = (res: any, e: unknown, what: string) => {
  if (e instanceof LiewoodError) return res.status(e.status).json({ error: e.message });
  console.error(`liewood ${what} failed:`, e);
  return res.status(500).json({ error: 'Something went wrong. Try again in a moment.' });
};
const managersOnly = (req: any, res: any) => { if (req.rep!.role !== 'manager') { res.status(403).json({ error: 'Only managers can change Liewood orders.' }); return false; } return true; };
const decode = (v: unknown): string => { try { return decodeURIComponent(String(v ?? '')); } catch { return String(v ?? ''); } };
async function readBody(req: AsyncIterable<Uint8Array>, max: number): Promise<Buffer> {
  const parts: Buffer[] = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > max) throw new LiewoodError(`That file is bigger than ${Math.round(max / 1024 / 1024)} MB.`, 413); parts.push(Buffer.from(c)); }
  return Buffer.concat(parts);
}

liewoodRouter.get('/orders', async (_req, res) => { try { res.json({ orders: await listOrders() }); } catch (e) { fail(res, e, 'list'); } });
liewoodRouter.post('/orders', async (req, res) => {
  try {
    if (!managersOnly(req, res)) return;
    const buf = await readBody(req as unknown as AsyncIterable<Uint8Array>, MAX_SHEET + 1);
    const r = await uploadSalesOrder(req.rep!.id, buf, decode(req.headers['x-file-name']), req.query.replace === '1');
    res.status(r.replaced ? 200 : 201).json(r);
  } catch (e) { fail(res, e, 'upload'); }
});
liewoodRouter.get('/orders/:id', async (req, res) => { try { res.json({ order: await getOrder(req.params.id) }); } catch (e) { fail(res, e, 'get'); } });
liewoodRouter.patch('/orders/:id', async (req, res) => {
  try { if (!managersOnly(req, res)) return; await updateOrder(req.params.id, req.body ?? {}); res.json({ order: await getOrder(req.params.id) }); } catch (e) { fail(res, e, 'update'); }
});
liewoodRouter.delete('/orders/:id', async (req, res) => { try { if (!managersOnly(req, res)) return; await deleteOrder(req.params.id); res.json({ ok: true }); } catch (e) { fail(res, e, 'delete'); } });
liewoodRouter.post('/orders/:id/confirmation', async (req, res) => {
  try {
    if (!managersOnly(req, res)) return;
    const buf = await readBody(req as unknown as AsyncIterable<Uint8Array>, MAX_PDF + 1);
    res.json({ check: await attachConfirmation(req.params.id, buf, decode(req.headers['x-file-name'])) });
  } catch (e) { fail(res, e, 'confirmation'); }
});
liewoodRouter.get('/orders/:id/confirmation', async (req, res) => {
  try {
    const { name, pdf } = await getConfirmation(req.params.id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${name.replace(/[^\w.\- ]+/g, '_')}"`);
    res.send(pdf);
  } catch (e) { fail(res, e, 'pdf'); }
});
let lastCheck = 0;
liewoodRouter.post('/check', async (req, res) => {
  try {
    if (!managersOnly(req, res)) return;
    if (Date.now() - lastCheck < 60_000) return res.status(429).json({ error: 'DEAR was checked less than a minute ago. Try again shortly.' });
    lastCheck = Date.now();
    res.json(await syncLiewoodPos());
  } catch (e) { fail(res, e, 'check'); }
});
