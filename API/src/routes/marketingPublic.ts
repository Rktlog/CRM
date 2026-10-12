import { Router } from 'express';
import express from 'express';
import { recordClick, recordOpen, unsubscribe, unsubscribeInfo, handleWebhook } from '../lib/marketing/tracking';
import { fromB64u, verifyLink } from '../lib/marketing/blocks';
import { linkSecret } from '../lib/marketing/sender';
import { runMarketing } from '../lib/marketing/automations';

// The pages and pictures recipients' email programs fetch. No login: the token in the address is the key.
// Mounted at /m, before the login check.
export const marketingPublicRouter = Router();

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const page = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title></head>
<body style="margin:0;background:#f3f4ef;font-family:Helvetica,Arial,sans-serif;color:#1d2530"><div style="max-width:440px;margin:60px auto;background:#fff;border-radius:8px;padding:32px;text-align:center">${body}</div></body></html>`;
const TOKEN = /^[a-f0-9]{32}$/;

marketingPublicRouter.get('/o/:file', async (req, res) => {
  const token = req.params.file.replace(/\.gif$/, '');
  if (TOKEN.test(token)) await recordOpen(token).catch(() => undefined);
  res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, no-cache, must-revalidate', 'Content-Length': String(GIF.length) }).send(GIF);   // always the picture, so a broken link never shows
});

// The click counter: check the signature, count it, send them on. A link that was tampered with goes nowhere.
marketingPublicRouter.get('/c/:token', async (req, res) => {
  const token = req.params.token; const u = String(req.query.u ?? ''); const sig = String(req.query.s ?? '');
  let url = ''; try { url = fromB64u(u); } catch { /* falls through */ }
  if (!TOKEN.test(token) || !/^https?:\/\//i.test(url) || !verifyLink(linkSecret(), token, url, sig)) return res.status(400).type('html').send(page('Link not valid', '<h2>This link is not valid</h2><p>It may have been changed. Please open the original email again.</p>'));
  await recordClick(token, url).catch(() => undefined);
  res.redirect(302, url);
});

// Unsubscribe. The page asks first (mail scanners open links without anyone clicking, and must not unsubscribe people).
marketingPublicRouter.get('/u/:token', async (req, res) => {
  const info = TOKEN.test(req.params.token) ? await unsubscribeInfo(req.params.token) : null;
  if (!info) return res.status(404).type('html').send(page('Not found', '<h2>We could not find that email</h2>'));
  if (info.already) return res.type('html').send(page('Unsubscribed', `<h2>You are unsubscribed</h2><p>${esc(info.email)} will not get any more marketing emails from us.</p>`));
  res.type('html').send(page('Unsubscribe', `<h2>Unsubscribe?</h2><p>Stop marketing emails to <b>${esc(info.email)}</b>.</p>
    <form method="post"><button type="submit" style="background:#2f6b5e;color:#fff;border:0;border-radius:6px;padding:12px 24px;font-size:15px;cursor:pointer">Yes, unsubscribe me</button></form>
    <p style="font-size:12px;color:#7a8290;margin-top:18px">You will still get emails about your orders, such as invoices and tracking.</p>`));
});
marketingPublicRouter.post('/u/:token', express.urlencoded({ extended: false }), async (req, res) => {
  const done = TOKEN.test(req.params.token) && await unsubscribe(req.params.token);
  if (!done) return res.status(404).type('html').send(page('Not found', '<h2>We could not find that email</h2>'));
  res.type('html').send(page('Unsubscribed', '<h2>You are unsubscribed</h2><p>You will not get any more marketing emails from us. Emails about your orders will still reach you.</p>'));   // also answers the one-click button in Gmail
});

// The sending service reporting back. The key is part of the address you give it.
marketingPublicRouter.post('/webhook', async (req, res) => {
  const want = process.env.MARKETING_WEBHOOK_KEY;
  if (!want || req.query.key !== want) return res.status(401).json({ error: 'Not allowed' });
  res.json({ result: await handleWebhook(req.body).catch(() => 'error') });
});

// The job that runs every few minutes (a Supabase schedule calls it, with the same secret the syncs use).
marketingPublicRouter.post('/run', async (req, res) => {
  const want = process.env.SYNC_SECRET;
  if (!want || req.get('x-sync-secret') !== want) return res.status(401).json({ error: 'Not allowed' });
  try { res.json(await runMarketing()); } catch (e) { console.error('marketing run failed', e); res.status(500).json({ error: 'Run failed' }); }
});