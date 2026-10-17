import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { canSeeAccount } from '../lib/territory';
import { authUrl, exchangeCode, getProfile, revoke, gmailConfigured, missingSetup } from '../lib/gmail/google';
import { decrypt, encrypt, signState, verifyState } from '../lib/gmail/crypto';
import { syncRep, syncAll } from '../lib/gmail/sync';

// Gmail: each rep connects THEIR OWN mailbox (read only). Emails to or from a customer already in the CRM are
// logged on that customer's account. Only the people, subject, date and a short preview: never the body.
export const gmailRouter = Router();

// The rep's email only pre-fills Google's account chooser, so if it can't be found the connection still works without it.
async function repEmail(repId: string): Promise<string | null> {
  try { return (await prisma.rep.findUnique({ where: { id: repId }, select: { email: true } }))?.email ?? null; } catch { return null; }
}
const uuid = (v: unknown) => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v);

// GET /gmail/status -> the signed-in rep's connection. Never includes any token.
gmailRouter.get('/status', async (req, res) => {
  const [c] = await prisma.$queryRaw<any[]>`
    select c.email, c.status, c.last_error as "lastError", c.connected_at as "connectedAt", c.last_sync_at as "lastSyncAt", c.logging_enabled as "loggingEnabled",
           c.save_preview as "savePreview", (select count(*)::int from crm.email_log l where l.rep_id = c.rep_id) as "emailsLogged"
    from crm.gmail_connections c where c.rep_id = ${req.rep!.id}::uuid`;
  const configured = gmailConfigured();
  res.json({ configured, missing: configured ? [] : missingSetup(), connected: !!c, email: c?.email ?? null, status: c?.status ?? null, error: c?.lastError ?? null,
             connectedAt: c?.connectedAt ?? null, lastSyncAt: c?.lastSyncAt ?? null, loggingEnabled: c?.loggingEnabled ?? true, savePreview: c?.savePreview ?? true, emailsLogged: c?.emailsLogged ?? 0 });
});

// GET /gmail/connect -> { url }: where to send the rep to approve access on Google's own page.
gmailRouter.get('/connect', async (req, res) => {
  if (!gmailConfigured()) return res.status(400).json({ error: 'Gmail is not set up on the server yet', missing: missingSetup() });
  res.json({ url: authUrl(signState(req.rep!.id), await repEmail(req.rep!.id)) });
});

// PATCH /gmail/settings { loggingEnabled?, savePreview? }
gmailRouter.patch('/settings', async (req, res) => {
  const b = req.body ?? {};
  const [c] = await prisma.$queryRaw<{ rep_id: string }[]>`select rep_id from crm.gmail_connections where rep_id = ${req.rep!.id}::uuid`;
  if (!c) return res.status(404).json({ error: 'Gmail is not connected' });
  if (typeof b.loggingEnabled === 'boolean') await prisma.$queryRaw`update crm.gmail_connections set logging_enabled = ${b.loggingEnabled}, updated_at = now() where rep_id = ${req.rep!.id}::uuid`;
  if (typeof b.savePreview === 'boolean') {
    await prisma.$queryRaw`update crm.gmail_connections set save_preview = ${b.savePreview}, updated_at = now() where rep_id = ${req.rep!.id}::uuid`;
    // Turning previews off also removes the ones already kept.
    if (!b.savePreview) await prisma.$queryRaw`update crm.email_log set snippet = null where rep_id = ${req.rep!.id}::uuid`;
  }
  res.json({ ok: true });
});

// POST /gmail/sync -> look for new emails now (not more than once a minute)
gmailRouter.post('/sync', async (req, res) => {
  const [c] = await prisma.$queryRaw<{ last_run_at: Date | null }[]>`select last_run_at from crm.gmail_connections where rep_id = ${req.rep!.id}::uuid`;
  if (!c) return res.status(400).json({ error: 'Connect Gmail first' });
  if (c.last_run_at && Date.now() - new Date(c.last_run_at).getTime() < 60_000) return res.status(429).json({ error: 'Just checked. Try again in a minute.' });
  res.json(await syncRep(req.rep!.id));
});

// POST /gmail/disconnect { deleteEmails? } -> removes the sign-in (and revokes it at Google). The logged emails stay unless asked.
gmailRouter.post('/disconnect', async (req, res) => {
  const [c] = await prisma.$queryRaw<{ refresh_token_enc: string }[]>`select refresh_token_enc from crm.gmail_connections where rep_id = ${req.rep!.id}::uuid`;
  if (!c) return res.json({ ok: true });
  try { await revoke(decrypt(c.refresh_token_enc)); } catch { /* unreadable or already gone: it is deleted below anyway */ }
  await prisma.$queryRaw`delete from crm.gmail_connections where rep_id = ${req.rep!.id}::uuid`;
  await prisma.$queryRaw`delete from crm.gmail_seen where rep_id = ${req.rep!.id}::uuid`;
  if (req.body?.deleteEmails === true) await prisma.$queryRaw`delete from crm.email_log where rep_id = ${req.rep!.id}::uuid`;
  res.json({ ok: true });
});

// GET /gmail/team (managers) -> who has connected, and whether it is working
gmailRouter.get('/team', async (req, res) => {
  if (req.rep!.role !== 'manager') return res.status(403).json({ error: 'Managers only' });
  res.json(await prisma.$queryRaw`
    select r.name, c.email, c.status, c.last_error as "error", c.last_sync_at as "lastSyncAt", c.logging_enabled as "loggingEnabled",
           (select count(*)::int from crm.email_log l where l.rep_id = c.rep_id) as "emailsLogged"
    from crm.gmail_connections c join crm.reps r on r.id = c.rep_id order by r.name`);
});

// GET /gmail/account/:id/emails -> the emails logged on a customer, grouped into conversations
gmailRouter.get('/account/:id/emails', async (req, res) => {
  if (!uuid(req.params.id)) return res.status(400).json({ error: 'Bad account' });
  const [a] = await prisma.$queryRaw<any[]>`select id, region from crm.accounts where id = ${req.params.id}::uuid`;
  if (!a) return res.status(404).json({ error: 'Account not found' });
  if (!(await canSeeAccount(req.rep!, a as any))) return res.status(403).json({ error: 'This account is outside your states' });
  const rows = await prisma.$queryRaw<any[]>`
    select l.id, l.thread_id as "threadId", l.gmail_message_id as "messageId", l.direction, l.subject, l.snippet, l.occurred_at as "occurredAt",
           l.rep_id as "repId", r.name as "repName", c.email as "ownerEmail"
    from crm.email_log l join crm.reps r on r.id = l.rep_id left join crm.gmail_connections c on c.rep_id = l.rep_id
    where l.account_id = ${req.params.id}::uuid order by l.occurred_at desc limit 300`;
  const threads = new Map<string, any>();
  for (const m of rows) {
    const mine = m.repId === req.rep!.id;
    const msg = {
      id: m.id, direction: m.direction, occurredAt: m.occurredAt, snippet: m.snippet, repName: m.repName, mine,
      // The link opens the email in the mailbox it is in, so it is only offered to the person who owns that mailbox.
      link: mine && m.ownerEmail ? `https://mail.google.com/mail/?authuser=${encodeURIComponent(m.ownerEmail)}#all/${m.messageId}` : null,
    };
    const t = threads.get(m.threadId) ?? { threadId: m.threadId, subject: '', lastAt: m.occurredAt, lastDirection: m.direction, count: 0, messages: [] };
    t.count++; t.messages.push(msg); t.subject = String(m.subject ?? '').replace(/^\s*((re|fwd?)\s*:\s*)+/i, '').trim() || t.subject;   // ends as the oldest message's subject
    threads.set(m.threadId, t);
  }
  const out = [...threads.values()].map(t => ({ ...t, subject: t.subject || '(no subject)', messages: t.messages.slice(0, 10) }));
  res.json({ threads: out, total: rows.length });
});

// ---- Google sends the rep back here after they approve (or refuse). No login: the signed "state" says who it is. ----
export const gmailCallbackRouter = Router();
gmailCallbackRouter.get('/', async (req, res) => {
  const app = (process.env.APP_URL ?? '').replace(/\/+$/, '');
  const back = (q: string) => res.redirect(`${app}/settings?gmail=${q}`);
  if (req.query.error) return back(`error&reason=${encodeURIComponent(String(req.query.error))}`);   // for example access_denied
  const st = verifyState(String(req.query.state ?? ''));
  if (!st) return back('error&reason=expired');
  const code = String(req.query.code ?? '');
  if (!code) return back('error&reason=no_code');
  try {
    const tok = await exchangeCode(code);
    if (!tok.refreshToken) return back('error&reason=no_refresh');
    // Google lets people untick the box that allows reading email. Without it there is nothing to do, so undo it.
    if (!tok.scope.includes('gmail.readonly')) { await revoke(tok.refreshToken); return back('error&reason=no_scope'); }
    const email = (await getProfile(tok.accessToken)).emailAddress.toLowerCase();
    const dom = (process.env.GMAIL_ALLOWED_DOMAIN ?? '').toLowerCase();
    if (dom && !email.endsWith('@' + dom)) { await revoke(tok.refreshToken); return back('error&reason=wrong_domain'); }
    await prisma.$queryRaw`
      insert into crm.gmail_connections (rep_id, email, refresh_token_enc, scope) values (${st.repId}::uuid, ${email}, ${encrypt(tok.refreshToken)}, ${tok.scope})
      on conflict (rep_id) do update set email = excluded.email, refresh_token_enc = excluded.refresh_token_enc, scope = excluded.scope,
        status = 'ok', last_error = null, connected_at = now(), updated_at = now()`;   // reconnecting keeps their pause and preview choices
    void syncRep(st.repId).catch(e => console.error('gmail first sync failed', e));
    return back('connected');
  } catch (e) {
    console.error('gmail callback failed', e);
    return back('error&reason=failed');
  }
});

// ---- The scheduled job (every 15 minutes): no login, but the secret header the other syncs use ----
export const gmailCronRouter = Router();
gmailCronRouter.post('/', async (req, res) => {
  if (!process.env.SYNC_SECRET || req.headers['x-sync-secret'] !== process.env.SYNC_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const results = await syncAll();
  res.json({ reps: results.length, results });
});