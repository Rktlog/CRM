import { Router } from 'express';
import { connectUrl, disconnect, dropboxStatus, finishConnect, MediaError, runFolderJob } from '../lib/media';

// Dropbox, for managers (the connection and the folders). The callback is the page Dropbox sends the manager back to: no login, so it is mounted separately.
//   GET  /dropbox/status        what is set up, what is connected, how many folders and files
//   GET  /dropbox/connect       { url } where to send the manager to approve access on Dropbox's own page
//   POST /dropbox/disconnect    takes Radar's access away (the files stay in Dropbox)
//   POST /dropbox/folders/run   makes folders for the next batch of DEAR customers that have none
//   GET  /dropbox/callback      Dropbox sends the manager back here (no login)
export const dropboxRouter = Router();
export const dropboxCallbackRouter = Router();

const managersOnly = (req: any, res: any) => { if (req.rep!.role !== 'manager') { res.status(403).json({ error: 'Only managers can do that.' }); return false; } return true; };
const fail = (res: any, e: unknown, what: string) => {
  if (e instanceof MediaError) return res.status(e.status).json({ error: e.message });
  console.error(`dropbox ${what} failed:`, e);
  return res.status(500).json({ error: 'Something went wrong. Try again in a moment.' });
};

dropboxRouter.get('/status', async (req, res) => { try { if (!managersOnly(req, res)) return; res.json(await dropboxStatus()); } catch (e) { fail(res, e, 'status'); } });
dropboxRouter.get('/connect', async (req, res) => { try { if (!managersOnly(req, res)) return; res.json({ url: connectUrl(req.rep!.id) }); } catch (e) { fail(res, e, 'connect'); } });
dropboxRouter.post('/disconnect', async (req, res) => { try { if (!managersOnly(req, res)) return; await disconnect(); res.json(await dropboxStatus()); } catch (e) { fail(res, e, 'disconnect'); } });
const lastRun = new Map<string, number>();
dropboxRouter.post('/folders/run', async (req, res) => {
  try {
    if (!managersOnly(req, res)) return;
    const now = Date.now(), prev = lastRun.get(req.rep!.id) ?? 0;
    if (now - prev < 15_000) return res.status(429).json({ error: 'It was only just run. Wait a few seconds.' });
    lastRun.set(req.rep!.id, now);
    res.json(await runFolderJob());
  } catch (e) { fail(res, e, 'folders'); }
});
dropboxCallbackRouter.get('/', async (req, res) => {
  const app = (process.env.APP_URL ?? '').replace(/\/+$/, '');
  try { return res.redirect(`${app}/settings?dropbox=${await finishConnect(req.query)}`); }
  catch (e) { console.error('dropbox callback failed', e); return res.redirect(`${app}/settings?dropbox=error&reason=failed`); }
});
