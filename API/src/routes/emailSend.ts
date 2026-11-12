import { Router } from 'express';
import { checkRecipients, getStatus, knownFor, sendEmail, SendError, setAllow, setSignature } from '../lib/emailSend';
import { gmailConfigured } from '../lib/gmail/google';

// Email from Radar. For every signed-in rep (each uses their own Gmail).
//   GET  /email-send/status               { configured, connected, status, canCompose, allowSend, email, signature }
//   POST /email-send/allow                { allow: true | false }   switch "Let Radar send emails I write here" on or off
//   PUT  /email-send/signature            { signature }
//   GET  /email-send/known?accountId=     (or ?cartKey=)   the addresses already known for that customer
//   POST /email-send/check                { accountId | cartKey, to, cc }   which addresses are new for this customer (nothing is sent)
//   POST /email-send/send                 { accountId | cartKey, to, cc, subject, body, clientId, confirmUnknown? }   send it from the rep's own Gmail and write the log
export const emailSendRouter = Router();

const fail = (res: any, e: unknown, what: string) => {
  if (e instanceof SendError) return res.status(e.status).json({ error: e.message, ...e.flags });
  console.error(`email-send ${what} failed:`, e);
  return res.status(500).json({ error: 'Something went wrong. Try again in a moment.' });
};

emailSendRouter.get('/status', async (req, res) => { try { res.json(await getStatus(req.rep!.id, gmailConfigured())); } catch (e) { fail(res, e, 'status'); } });
emailSendRouter.post('/allow', async (req, res) => { try { await setAllow(req.rep!.id, req.body?.allow); res.json(await getStatus(req.rep!.id, gmailConfigured())); } catch (e) { fail(res, e, 'allow'); } });
emailSendRouter.put('/signature', async (req, res) => { try { res.json({ signature: await setSignature(req.rep!.id, req.body?.signature) }); } catch (e) { fail(res, e, 'signature'); } });
emailSendRouter.get('/known', async (req, res) => { try { res.json({ known: await knownFor(req.rep!, req.query.accountId, req.query.cartKey) }); } catch (e) { fail(res, e, 'known'); } });
emailSendRouter.post('/check', async (req, res) => { try { res.json(await checkRecipients(req.rep!, req.body ?? {})); } catch (e) { fail(res, e, 'check'); } });
emailSendRouter.post('/send', async (req, res) => { try { const r = await sendEmail(req.rep!, req.body ?? {}); res.status(r.duplicate ? 200 : 201).json(r); } catch (e) { fail(res, e, 'send'); } });
