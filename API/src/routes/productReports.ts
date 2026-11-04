import { Router } from 'express';
import { listHidden, parseSkus, ReportHiddenError, setHidden } from '../lib/reportHidden';

// Which products are left out of the customer reports (the price list and the monthly stocklist).
//   GET /product-reports/hidden   everyone: what is left out, so a product can show it (and a rep knows why a SKU is missing from a report)
//   PUT /product-reports/hidden   managers only: { skus: ['LSB-219', ...], hidden: true | false }  leaves products out, or puts them back
export const productReportsRouter = Router();

productReportsRouter.get('/hidden', async (_req, res) => {
  try { res.json(await listHidden()); }
  catch (e) { console.error('product-reports list failed:', e); res.status(500).json({ error: 'Could not load the list' }); }
});

productReportsRouter.put('/hidden', async (req, res) => {
  try {
    if (req.rep!.role !== 'manager') return res.status(403).json({ error: 'Only a manager can change which products are left out of customer reports.' });
    if (typeof req.body?.hidden !== 'boolean') return res.status(400).json({ error: 'Say whether to leave them out (hidden: true) or put them back (hidden: false).' });
    const parsed = parseSkus(req.body?.skus);
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });
    const result = await setHidden(parsed.skus, req.body.hidden, req.rep!.id);
    res.json({ ...result, ...(await listHidden()) });
  } catch (e) {
    if (e instanceof ReportHiddenError) return res.status(e.status).json({ error: e.message });
    console.error('product-reports change failed:', e);
    res.status(500).json({ error: 'Could not save that' });
  }
});
