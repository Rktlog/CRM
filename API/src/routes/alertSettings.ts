import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { AlertError, deleteContact, getState, isKind, saveContact, saveList, sendTest } from '../lib/alerts';

// Settings for the email alerts and the supplier contacts. Managers only, for every route.
//   GET    /alert-settings                 the lists (on or off, and who they go to), the supplier contacts, whether the sales mailbox can send, and what was sent lately
//   PUT    /alert-settings/lists/:kind     { enabled, addresses }   turn a list on or off and say who it goes to
//   POST   /alert-settings/test/:kind      send a test email to the manager who pressed it (never to the list)
//   PUT    /alert-settings/contacts        { id?, supplier, emails, cc, notes }   add or change a supplier's addresses
//   DELETE /alert-settings/contacts/:id
export const alertSettingsRouter = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const managersOnly = (req: any, res: any) => { if (req.rep!.role !== 'manager') { res.status(403).json({ error: 'Only a manager can change the email settings.' }); return false; } return true; };
const fail = (res: any, e: unknown, what: string) => {
  if (e instanceof AlertError) return res.status(e.status).json({ error: e.message });
  console.error(`alert-settings ${what} failed:`, e);
  return res.status(500).json({ error: 'Something went wrong. Try again in a moment.' });
};

alertSettingsRouter.get('/', async (req, res) => { try { if (!managersOnly(req, res)) return; res.json(await getState()); } catch (e) { fail(res, e, 'state'); } });

alertSettingsRouter.put('/lists/:kind', async (req, res) => {
  try {
    if (!managersOnly(req, res)) return;
    const kind = String(req.params.kind);
    if (!isKind(kind)) return res.status(404).json({ error: 'That kind of alert does not exist.' });
    if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'Say whether the list is on or off.' });
    await saveList(kind, req.body.enabled, req.body.addresses ?? [], req.rep!.id);
    res.json(await getState());
  } catch (e) { fail(res, e, 'list'); }
});

alertSettingsRouter.post('/test/:kind', async (req, res) => {
  try {
    if (!managersOnly(req, res)) return;
    const kind = String(req.params.kind);
    if (!isKind(kind)) return res.status(404).json({ error: 'That kind of alert does not exist.' });
    const [me] = await prisma.$queryRaw<{ email: string | null }[]>`select email from crm.reps where id = ${req.rep!.id}::uuid`;
    res.json(await sendTest(kind, me?.email ?? null));
  } catch (e) { fail(res, e, 'test'); }
});

alertSettingsRouter.put('/contacts', async (req, res) => {
  try {
    if (!managersOnly(req, res)) return;
    const id = req.body?.id;
    if (id !== undefined && (typeof id !== 'string' || !UUID.test(id))) return res.status(404).json({ error: 'That supplier was not found.' });
    await saveContact({ id, supplier: req.body?.supplier, emails: req.body?.emails, cc: req.body?.cc, notes: req.body?.notes }, req.rep!.id);
    res.json(await getState());
  } catch (e) { fail(res, e, 'contact'); }
});

alertSettingsRouter.delete('/contacts/:id', async (req, res) => {
  try {
    if (!managersOnly(req, res)) return;
    if (!UUID.test(String(req.params.id))) return res.status(404).json({ error: 'That supplier was not found.' });
    await deleteContact(String(req.params.id));
    res.json(await getState());
  } catch (e) { fail(res, e, 'delete contact'); }
});
