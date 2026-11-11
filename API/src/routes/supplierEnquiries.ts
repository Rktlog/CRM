import { Router } from 'express';
import { checkEnquiry, createEnquiry, enquiryOptions, EnquiryError, listEnquiries, setAnswer } from '../lib/supplierEnquiry';

// Supplier emails for special product requests. Managers only, for every route.
//   GET  /supplier-enquiries/options?requestId=   the suppliers with an email address, the likely supplier, and the other open requests that could go in the same email
//   GET  /supplier-enquiries                      the emails made in the last 60 days, each with its requests, whether it was sent, whether the supplier replied, and the proposed answers
//   POST /supplier-enquiries                      { supplier, requestIds }  make the draft in the manager's own Gmail (never sent from Radar)
//   POST /supplier-enquiries/:id/check            look at that email's thread now: sent? replied? (the scheduled job does the same every 15 minutes)
//   POST /supplier-enquiries/:id/answers/:requestId   { action: 'confirm' | 'dismiss', text? }   confirm (or correct) what the supplier answered, so the requester can see it
export const supplierEnquiriesRouter = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const managersOnly = (req: any, res: any) => { if (req.rep!.role !== 'manager') { res.status(403).json({ error: 'Only the ordering team can do that.' }); return false; } return true; };
const fail = (res: any, e: unknown, what: string) => {
  if (e instanceof EnquiryError) return res.status(e.status).json({ error: e.message, ...(e.needs === 'drafts' ? { needsDrafts: true } : {}), ...(e.needs === 'connect' ? { needsConnect: true } : {}) });
  console.error(`supplier-enquiries ${what} failed:`, e);
  return res.status(500).json({ error: 'Something went wrong. Try again in a moment.' });
};

supplierEnquiriesRouter.get('/options', async (req, res) => {
  try {
    if (!managersOnly(req, res)) return;
    const id = String(req.query.requestId ?? '');
    if (!UUID.test(id)) return res.status(404).json({ error: 'That request was not found.' });
    res.json(await enquiryOptions(id));
  } catch (e) { fail(res, e, 'options'); }
});

supplierEnquiriesRouter.get('/', async (req, res) => { try { if (!managersOnly(req, res)) return; res.json({ items: await listEnquiries() }); } catch (e) { fail(res, e, 'list'); } });

supplierEnquiriesRouter.post('/', async (req, res) => {
  try {
    if (!managersOnly(req, res)) return;
    const r = await createEnquiry(req.rep!.id, req.body?.supplier, req.body?.requestIds);
    res.status(r.duplicate ? 200 : 201).json(r);
  } catch (e) { fail(res, e, 'create'); }
});

supplierEnquiriesRouter.post('/:id/check', async (req, res) => {
  try {
    if (!managersOnly(req, res)) return;
    if (!UUID.test(String(req.params.id))) return res.status(404).json({ error: 'That email was not found.' });
    res.json({ enquiry: await checkEnquiry(String(req.params.id)) });
  } catch (e) { fail(res, e, 'check'); }
});

supplierEnquiriesRouter.post('/:id/answers/:requestId', async (req, res) => {
  try {
    if (!managersOnly(req, res)) return;
    res.json({ enquiry: await setAnswer(String(req.params.id), String(req.params.requestId), req.rep!.id, req.body?.action, req.body?.text) });
  } catch (e) { fail(res, e, 'answer'); }
});
