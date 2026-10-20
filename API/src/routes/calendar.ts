import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { calendarConfigured, connectionOf, listEvents, dropCachedToken, CalendarNotConnectedError } from '../lib/googleCalendar';
import { syncRepCalendar, clearRepCalendar } from '../lib/calendarSync';
import { authUrlFor, calendarMissingSetup, calendarOauthConfig, CALENDAR_SCOPES, exchangeCodeFor, getUserEmail, revoke } from '../lib/gmail/google';
import { decrypt, encrypt, signState, verifyState } from '../lib/gmail/crypto';

// Each rep's Planner in their own Google Calendar, and their Google Calendar in the Planner.
// Each rep connects THEIR OWN calendar with a button in Settings. The CRM never acts as anyone else.
export const calendarRouter = Router();
const eventCache = new Map<string, { at: number; data: any }>();

// GET /calendar/status -> the signed-in rep's calendar connection and sync. Never includes any token.
calendarRouter.get('/status', async (req, res) => {
  const rep = await prisma.rep.findUnique({
    where: { id: req.rep!.id },
    select: { calendarSync: true, calendarShow: true, calendarSyncedAt: true, calendarError: true },
  }).catch(() => null);   // those columns come from calendar-setup.sql: until it is run, show the defaults instead of failing
  const configured = calendarConfigured();
  const conn = configured ? await connectionOf(req.rep!.id) : null;
  res.json({
    configured,
    missing: configured ? [] : calendarMissingSetup(),
    connected: !!conn,
    connectionOk: conn?.status === 'ok',
    connectionError: conn && conn.status !== 'ok' ? conn.lastError : null,
    email: conn?.email ?? null,
    enabled: !!rep?.calendarSync,
    show: rep?.calendarShow ?? true,
    syncedAt: rep?.calendarSyncedAt ?? null,
    error: rep?.calendarError ?? null,
  });
});

// GET /calendar/connect -> { url }: where to send the rep to approve access on Google's own page.
calendarRouter.get('/connect', async (req, res) => {
  const cfg = calendarOauthConfig();
  if (!calendarConfigured() || !cfg) return res.status(400).json({ error: 'Google Calendar is not set up on the server yet', missing: calendarMissingSetup() });
  // The email only pre-fills Google's account chooser, so if it can't be found the connection still works without it.
  const rep = await prisma.rep.findUnique({ where: { id: req.rep!.id }, select: { email: true } }).catch(() => null);
  res.json({ url: authUrlFor({ scopes: CALENDAR_SCOPES, redirectUri: cfg.redirectUri, state: signState(req.rep!.id), loginHint: rep?.email }) });
});

// POST /calendar/disconnect -> removes the CRM's events from their calendar, then the sign-in (revoked at Google too)
calendarRouter.post('/disconnect', async (req, res) => {
  const id = req.rep!.id;
  const conn = await connectionOf(id);
  if (!conn) return res.json({ ok: true });
  await clearRepCalendar(id).catch(() => {});   // while their sign-in still works
  try { await revoke(decrypt(conn.refreshTokenEnc)); } catch { /* unreadable or already gone: it is deleted below anyway */ }
  await prisma.$queryRaw`delete from crm.calendar_connections where rep_id = ${id}::uuid`;
  await prisma.rep.update({ where: { id }, data: { calendarSync: false, calendarError: null } });
  dropCachedToken(id); eventCache.clear();
  res.json({ ok: true });
});

// POST /calendar/enable { enabled } -> turn it on (syncs now) or off (removes the events)
calendarRouter.post('/enable', async (req, res) => {
  const enabled = !!req.body?.enabled;
  if (enabled) {
    if (!calendarConfigured()) return res.status(400).json({ error: 'Google Calendar is not set up on the server yet' });
    const conn = await connectionOf(req.rep!.id);
    if (!conn) return res.status(400).json({ error: 'Connect Google Calendar first' });
    if (conn.status !== 'ok') return res.status(400).json({ error: 'Google Calendar needs reconnecting. Press Connect Google Calendar again.' });
  }
  await prisma.rep.update({ where: { id: req.rep!.id }, data: { calendarSync: enabled, calendarError: null } });
  try {
    if (enabled) return res.json({ ok: true, result: await syncRepCalendar(req.rep!.id) });
    await clearRepCalendar(req.rep!.id);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(502).json({ error: e?.message ?? 'Calendar sync failed' });
  }
});

// POST /calendar/show { enabled } -> show or hide Google events in the Planner
calendarRouter.post('/show', async (req, res) => {
  await prisma.rep.update({ where: { id: req.rep!.id }, data: { calendarShow: !!req.body?.enabled } });
  eventCache.clear();
  res.json({ ok: true });
});

// GET /calendar/events?from=YYYY-MM-DD&to=YYYY-MM-DD
// The signed-in person's own Google Calendar events, for the Planner. Read
// only; nobody else's calendar is ever shown. Events the CRM itself put in
// Google (visits and calls) are left out, since the Planner already shows them.
const isoDate = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

calendarRouter.get('/events', async (req, res) => {
  const from = isoDate(req.query.from);
  const to = isoDate(req.query.to);
  if (!from || !to) return res.status(400).json({ error: 'from and to (YYYY-MM-DD) are required' });

  const rep = await prisma.rep.findUnique({ where: { id: req.rep!.id }, select: { calendarShow: true } }).catch(() => null);   // column not added yet: show
  const conn = calendarConfigured() ? await connectionOf(req.rep!.id) : null;
  if (!conn || conn.status !== 'ok') return res.json({ connected: false, events: [] });
  if (rep && !rep.calendarShow) return res.json({ connected: true, hidden: true, events: [] });

  const key = `${req.rep!.id}|${from}|${to}`;
  const hit = eventCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return res.json(hit.data);

  try {
    // A day either side, so time zones never cut an event off.
    const min = new Date(`${from}T00:00:00+10:00`); min.setDate(min.getDate() - 1);
    const max = new Date(`${to}T23:59:59+10:00`); max.setDate(max.getDate() + 1);
    const items = await listEvents(req.rep!.id, min.toISOString(), max.toISOString());
    const events = items
      .filter(e => e.status !== 'cancelled')
      .filter(e => e.extendedProperties?.private?.rhinoCrm !== '1')
      .filter(e => !(e.attendees ?? []).some((a: any) => a.self && a.responseStatus === 'declined'))
      .map(e => ({
        id: e.id,
        title: e.summary || (e.visibility === 'private' ? 'Private event' : '(No title)'),
        allDay: !!e.start?.date,
        start: e.start?.dateTime ?? e.start?.date,
        end: e.end?.dateTime ?? e.end?.date,
        location: e.location ?? null,
        link: e.htmlLink ?? null,
      }));
    const data = { connected: true, events };
    eventCache.set(key, { at: Date.now(), data });
    if (eventCache.size > 500) eventCache.clear();
    res.json(data);
  } catch (e: any) {
    if (e instanceof CalendarNotConnectedError) return res.json({ connected: false, error: e.message, events: [] });
    res.json({ connected: true, error: e?.message ?? 'Could not read Google Calendar', events: [] });
  }
});

// POST /calendar/sync -> sync the signed-in rep now
calendarRouter.post('/sync', async (req, res) => {
  try {
    res.json(await syncRepCalendar(req.rep!.id));
  } catch (e: any) {
    res.status(502).json({ error: e?.message ?? 'Calendar sync failed' });
  }
});

// ---- Google sends the rep back here after they approve (or refuse). No login: the signed "state" says who it is. ----
export const calendarCallbackRouter = Router();
calendarCallbackRouter.get('/', async (req, res) => {
  const app = (process.env.APP_URL ?? '').replace(/\/+$/, '');
  const back = (q: string) => res.redirect(`${app}/settings?calendar=${q}`);
  if (req.query.error) return back(`error&reason=${encodeURIComponent(String(req.query.error))}`);   // for example access_denied
  const st = verifyState(String(req.query.state ?? ''));
  if (!st) return back('error&reason=expired');
  const code = String(req.query.code ?? '');
  if (!code) return back('error&reason=no_code');
  const cfg = calendarOauthConfig();
  if (!cfg) return back('error&reason=failed');
  try {
    const tok = await exchangeCodeFor(code, cfg.redirectUri);
    if (!tok.refreshToken) return back('error&reason=no_refresh');
    // Google lets people untick the box that allows managing events. Without it there is nothing to do, so undo it.
    if (!tok.scope.includes('calendar.events')) { await revoke(tok.refreshToken); return back('error&reason=no_scope'); }
    const email = await getUserEmail(tok.accessToken);
    const dom = (process.env.GOOGLE_ALLOWED_DOMAIN || process.env.GMAIL_ALLOWED_DOMAIN || '').toLowerCase();
    if (dom && !email.endsWith('@' + dom)) { await revoke(tok.refreshToken); return back('error&reason=wrong_domain'); }
    await prisma.$queryRaw`
      insert into crm.calendar_connections (rep_id, email, refresh_token_enc, scope) values (${st.repId}::uuid, ${email}, ${encrypt(tok.refreshToken)}, ${tok.scope})
      on conflict (rep_id) do update set email = excluded.email, refresh_token_enc = excluded.refresh_token_enc, scope = excluded.scope,
        status = 'ok', last_error = null, connected_at = now(), updated_at = now()`;
    await prisma.$executeRaw`update crm.reps set calendar_error = null where id = ${st.repId}::uuid`;
    dropCachedToken(st.repId); eventCache.clear();
    void syncRepCalendar(st.repId).catch(e => console.error('calendar first sync failed', e));   // does nothing unless their sync is switched on
    return back('connected');
  } catch (e) {
    console.error('calendar callback failed', e);
    return back('error&reason=failed');
  }
});

// POST /calendar-cron (no login; x-sync-secret header) -> hourly sync for every
// rep who has it on, catching anything that changed outside the app.
export const calendarCronRouter = Router();
calendarCronRouter.post('/', async (req, res) => {
  if (!process.env.SYNC_SECRET || req.headers['x-sync-secret'] !== process.env.SYNC_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const reps = await prisma.rep.findMany({ where: { calendarSync: true }, select: { id: true, name: true } });
  const results: any[] = [];
  for (const r of reps) {
    try { results.push({ rep: r.name, ...(await syncRepCalendar(r.id)) }); }
    catch (e: any) { results.push({ rep: r.name, error: String(e?.message ?? e) }); }
  }
  res.json({ reps: results.length, results });
});