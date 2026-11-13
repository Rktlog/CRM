import { Router } from 'express';
import { MktError } from '../lib/mktShared';
import { parsePeriod } from '../lib/mktCore';
import { createInitiative, decideGoal, deleteInitiative, proposeGoal, setResult, updateInitiative } from '../lib/mktGoals';
import { addGift, addPost, deleteGift, deletePost, importDaily, importPosts, updateGift } from '../lib/mktInstagram';
import { edmPage, eventsPage, giveawaysPage, instagramPage, overview } from '../lib/mktPages';
import { syncMailchimp } from '../lib/mailchimp';

// The marketing dashboard. MANAGERS ONLY, for every route. Radar never writes to Mailchimp or Instagram: Mailchimp is read, Instagram comes from Meta's reports imported by hand.
//   GET  /mkt/overview?from=&to=          the three stockist cards, the four focus rows, the calendar and the goals waiting for approval (default: the last 30 days)
//   GET  /mkt/edm | /mkt/events | /mkt/giveaways | /mkt/instagram   (?from=&to=)   the detail pages
//   POST /mkt/mailchimp/sync               read Mailchimp now (also done every 3 hours once scheduled)
//   POST /mkt/initiatives { kind: event | giveaway, ... }   PATCH /mkt/initiatives/:id   DELETE /mkt/initiatives/:id   PUT /mkt/initiatives/:id/results { metric, value }
//   POST /mkt/goals { kind, initiativeId?, scope?, metric, goal, failure, outcome? }   propose;   POST /mkt/goals/:id/decision { approve }   a different manager approves
//   POST /mkt/instagram/import-daily { csv, metric? } | /import-posts { csv } | /posts {...}   DELETE /mkt/instagram/posts/:id   POST /mkt/instagram/gifts   PATCH|DELETE /mkt/instagram/gifts/:id
export const marketingDashboardRouter = Router();

const fail = (res: any, e: unknown, what: string) => {
  if (e instanceof MktError) return res.status(e.status).json({ error: e.message });
  console.error(`mkt ${what} failed:`, e);
  return res.status(500).json({ error: 'Something went wrong. Try again in a moment.' });
};
const run = (what: string, f: (req: any, res: any) => Promise<unknown>) => async (req: any, res: any) => {
  try { if (req.rep!.role !== 'manager') return res.status(403).json({ error: 'Only managers can use the marketing dashboard.' }); res.json(await f(req, res)); } catch (e) { fail(res, e, what); }
};
const period = (req: any) => { const p = parsePeriod(req.query ?? {}); if ('error' in p) throw new MktError(p.error); return p; };

marketingDashboardRouter.get('/overview', run('overview', req => overview(req.rep, period(req))));
marketingDashboardRouter.get('/edm', run('edm', req => edmPage(period(req))));
marketingDashboardRouter.get('/events', run('events', req => eventsPage(period(req))));
marketingDashboardRouter.get('/giveaways', run('giveaways', req => giveawaysPage(period(req))));
marketingDashboardRouter.get('/instagram', run('instagram', req => instagramPage(period(req))));
const lastSync = new Map<string, number>();
marketingDashboardRouter.post('/mailchimp/sync', run('mailchimp sync', async req => {
  const now = Date.now(), prev = lastSync.get(req.rep.id) ?? 0;
  if (now - prev < 30_000) throw new MktError('It was only just run. Wait half a minute.', 429);
  lastSync.set(req.rep.id, now);
  return syncMailchimp();
}));
marketingDashboardRouter.post('/initiatives', run('create', req => createInitiative(req.rep, req.body?.kind, req.body ?? {})));
marketingDashboardRouter.patch('/initiatives/:id', run('update', req => updateInitiative(req.params.id, req.body ?? {})));
marketingDashboardRouter.delete('/initiatives/:id', run('delete', async req => { await deleteInitiative(req.params.id); return { ok: true }; }));
marketingDashboardRouter.put('/initiatives/:id/results', run('result', async req => { await setResult(req.rep, req.params.id, req.body?.metric, req.body?.value); return { ok: true }; }));
marketingDashboardRouter.post('/goals', run('propose', req => proposeGoal(req.rep, req.body ?? {})));
marketingDashboardRouter.post('/goals/:id/decision', run('decide', req => decideGoal(req.rep, req.params.id, req.body?.approve)));
marketingDashboardRouter.post('/instagram/import-daily', run('import daily', req => importDaily(req.body?.csv, req.body?.metric)));
marketingDashboardRouter.post('/instagram/import-posts', run('import posts', req => importPosts(req.body?.csv)));
marketingDashboardRouter.post('/instagram/posts', run('add post', req => addPost(req.body ?? {})));
marketingDashboardRouter.delete('/instagram/posts/:id', run('delete post', async req => { await deletePost(req.params.id); return { ok: true }; }));
marketingDashboardRouter.post('/instagram/gifts', run('add gift', req => addGift(req.rep, req.body ?? {})));
marketingDashboardRouter.patch('/instagram/gifts/:id', run('update gift', req => updateGift(req.params.id, req.body ?? {})));
marketingDashboardRouter.delete('/instagram/gifts/:id', run('delete gift', async req => { await deleteGift(req.params.id); return { ok: true }; }));
