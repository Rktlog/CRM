import { Router } from 'express';
import { checkRecipients, getGmailSignature, getStatus, knownFor, saveDraft, sendEmail, SendError, setAllow, setSignature, templateFor } from '../lib/emailSend';
import { AttachError, MAX_FILE, readBody, removeAttachment, stageAttachment } from '../lib/emailAttachments';
import { gmailConfigured } from '../lib/gmail/google';

// Email from Radar. For every signed-in rep (each uses their own Gmail). An email can be about an account, an order or an abandoned cart, and can be a reply in a conversation.
//   GET  /email-send/status               { configured, connected, status, canCompose, allowSend, email, signature }
//   POST /email-send/allow                { allow: true | false }   switch "Let Radar send emails I write here" on or off
//   PUT  /email-send/signature            { signature }             the plain-text signature saved in Radar
//   GET  /email-send/gmail-signature      the signature set up in the rep's Gmail (cleaned HTML, with its logo), or why it cannot be read
//   GET  /email-send/known?accountId=     (or ?orderId= or ?cartKey=)   the addresses already known for that customer (an order's own address first)
//   GET  /email-send/template?orderId=    (or ?cartKey= or ?accountId=)   how the email starts: the cart template, or the order number and a greeting
//   POST /email-send/attachments          the file itself as the body, its name in X-File-Name (URL-encoded) and its type in X-File-Type   DELETE /email-send/attachments/:id
//   POST /email-send/check                { accountId | orderId | cartKey, to, cc }   which addresses are new for this customer (nothing is sent)
//   POST /email-send/send                 { accountId | orderId | cartKey, to, cc, subject, body, clientId, signatureMode, attachmentIds, replyThreadId, confirmUnknown? }   send it from the rep's own Gmail and write the log
//   POST /email-send/draft                the same, saved as a draft in the rep's Gmail instead (nothing is sent or logged)
export const emailSendRouter = Router();

const fail = (res: any, e: unknown, what: string) => {
  if (e instanceof SendError) return res.status(e.status).json({ error: e.message, ...e.flags });
  if (e instanceof AttachError) return res.status(e.status).json({ error: e.message });
  console.error(`email-send ${what} failed:`, e);
  return res.status(500).json({ error: 'Something went wrong. Try again in a moment.' });
};
const decode = (v: unknown): string => { try { return decodeURIComponent(String(v ?? '')); } catch { return String(v ?? ''); } };

emailSendRouter.get('/status', async (req, res) => { try { res.json(await getStatus(req.rep!.id, gmailConfigured())); } catch (e) { fail(res, e, 'status'); } });
emailSendRouter.post('/allow', async (req, res) => { try { await setAllow(req.rep!.id, req.body?.allow); res.json(await getStatus(req.rep!.id, gmailConfigured())); } catch (e) { fail(res, e, 'allow'); } });
emailSendRouter.put('/signature', async (req, res) => { try { res.json({ signature: await setSignature(req.rep!.id, req.body?.signature) }); } catch (e) { fail(res, e, 'signature'); } });
emailSendRouter.get('/gmail-signature', async (req, res) => { try { res.json(await getGmailSignature(req.rep!)); } catch (e) { fail(res, e, 'gmail signature'); } });
emailSendRouter.get('/known', async (req, res) => { try { res.json({ known: await knownFor(req.rep!, req.query.accountId, req.query.cartKey, undefined, req.query.orderId) }); } catch (e) { fail(res, e, 'known'); } });
emailSendRouter.get('/template', async (req, res) => { try { res.json(await templateFor(req.rep!, { accountId: req.query.accountId, cartKey: req.query.cartKey, orderId: req.query.orderId })); } catch (e) { fail(res, e, 'template'); } });
emailSendRouter.post('/attachments', async (req, res) => {
  try {
    const len = Number(req.headers['content-length']);
    if (Number.isFinite(len) && len > MAX_FILE) throw new AttachError('That file is bigger than 10 MB. Send it another way, or make it smaller.', 413);
    const data = await readBody(req as any, MAX_FILE);
    res.status(201).json({ file: await stageAttachment(req.rep!.id, decode(req.headers['x-file-name']), String(req.headers['x-file-type'] ?? req.headers['content-type'] ?? ''), data) });
  } catch (e) { fail(res, e, 'attachment'); }
});
emailSendRouter.delete('/attachments/:id', async (req, res) => { try { await removeAttachment(req.rep!.id, req.params.id); res.json({ ok: true }); } catch (e) { fail(res, e, 'remove attachment'); } });
emailSendRouter.post('/check', async (req, res) => { try { res.json(await checkRecipients(req.rep!, req.body ?? {})); } catch (e) { fail(res, e, 'check'); } });
emailSendRouter.post('/send', async (req, res) => { try { const r = await sendEmail(req.rep!, req.body ?? {}); res.status(r.duplicate ? 200 : 201).json(r); } catch (e) { fail(res, e, 'send'); } });
emailSendRouter.post('/draft', async (req, res) => { try { res.status(201).json(await saveDraft(req.rep!, req.body ?? {})); } catch (e) { fail(res, e, 'draft'); } });
