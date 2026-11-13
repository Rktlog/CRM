// Photos and videos on accounts, kept in the company Dropbox. Radar keeps only where each file is; the file itself is in Dropbox, in the customer's own folder.
// - One Dropbox connection for the whole company, made by a manager in Settings (see routes/dropbox.ts).
// - A customer's folder is /Customers/<name>. It is made ahead of time for customers linked to DEAR (a job, and a button in Settings) and the first time a file is added for anyone else.
// - A rep uploads a file, and ONLY THEN is the log entry made: so a failed upload can never leave a half-saved log. The file is linked to the log entry afterwards.
// - Who can see what is the same as everywhere in Radar: a rep sees the accounts in their states; a rep deletes their own files, a manager any.
import { prisma } from './prisma';
import { decrypt, encrypt, signState, verifyState } from './gmail/crypto';
import { canSeeAccount } from './territory';
import * as dbx from './dropbox';

export class MediaError extends Error { status: number; constructor(message: string, status = 400) { super(message); this.status = status; } }
export type Rep = { id: string; role: string };
export type Deps = { canSeeAccount: (rep: Rep, a: { id: string; region: string }) => Promise<boolean> };
const realDeps: Deps = { canSeeAccount: (rep, a) => canSeeAccount(rep as any, a) };
export const UPLOADS_PER_HOUR = 60;
export const MAX_IDS = 10;
const tableMissing = (e: any) => e?.code === '42P01' || e?.meta?.code === '42P01' || (/dropbox_|\bmedia\b/.test(String(e?.message ?? e)) && /does not exist|relation/i.test(String(e?.message ?? e)));
const NOT_SET_UP = 'Dropbox is not set up in the database yet. Ask whoever looks after Radar to run dropbox.sql.';
const uuidOk = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
async function guard<T>(f: () => Promise<T>): Promise<T> { try { return await f(); } catch (e) { if (tableMissing(e)) throw new MediaError(NOT_SET_UP, 503); throw e; } }

// ---------- the connection ----------
type Conn = { email: string | null; name: string | null; refresh_token_enc: string; status: 'ok' | 'needs_reconnect'; last_error: string | null; connected_at: Date };
let cached: { token: string; until: number } | null = null;
export const forgetToken = () => { cached = null; };
async function connection(): Promise<Conn | null> {
  const r = await prisma.$queryRaw<Conn[]>`select email, name, refresh_token_enc, status, last_error, connected_at from crm.dropbox_connection where id`;
  return r[0] ?? null;
}
/** A working access token for Dropbox: the last one while it is good, otherwise a fresh one from the saved sign-in. If Dropbox no longer accepts the sign-in, it is marked as needing a reconnect. */
export async function accessToken(): Promise<string> {
  if (cached && cached.until > Date.now() + 60_000) return cached.token;
  const c = await guard(connection);
  if (!c) throw new MediaError('Dropbox is not connected. A manager can connect it in Settings.', 409);
  if (c.status !== 'ok') throw new MediaError('Dropbox needs to be connected again. A manager can do that in Settings.', 409);
  try {
    const t = await dbx.refreshAccess(decrypt(c.refresh_token_enc));
    cached = { token: t.accessToken, until: Date.now() + t.expiresIn * 1000 };
    return t.accessToken;
  } catch (e) {
    if (e instanceof dbx.DropboxError && (e.code === 'invalid_grant' || e.status === 401 || e.status === 400)) {
      await prisma.$queryRaw`update crm.dropbox_connection set status = 'needs_reconnect', last_error = ${String(e.message).slice(0, 200)}, updated_at = now() where id`;
      throw new MediaError('Dropbox needs to be connected again. A manager can do that in Settings.', 409);
    }
    console.error('dropbox token refresh failed', String((e as Error)?.message ?? e).slice(0, 160));
    throw new MediaError('Dropbox would not answer just now. Try again in a minute.', 502);
  }
}
export type Capabilities = { enabled: boolean; reason: string | null; maxPhotoMb: number; maxVideoMb: number };
/** Whether photos and videos can be added at all right now (the pages ask this to decide what to show). */
export async function capabilities(): Promise<Capabilities> {
  const sizes = { maxPhotoMb: Math.round(dbx.MAX_PHOTO / 1048576), maxVideoMb: Math.round(dbx.MAX_VIDEO / 1048576) };
  try {
    const c = await connection();
    if (!c) return { enabled: false, reason: 'Dropbox is not connected. A manager can connect it in Settings.', ...sizes };
    if (c.status !== 'ok') return { enabled: false, reason: 'Dropbox needs to be connected again. A manager can do that in Settings.', ...sizes };
    return { enabled: true, reason: null, ...sizes };
  } catch (e) { if (tableMissing(e)) return { enabled: false, reason: NOT_SET_UP, ...sizes }; throw e; }
}
export type Status = { configured: boolean; missing: string[]; redirectUri: string | null; connected: boolean; status: string | null; email: string | null; name: string | null; lastError: string | null; folders: number; waiting: number; photos: number; videos: number };
export async function dropboxStatus(): Promise<Status> {
  const cfg = dbx.dropboxConfig(), missing = dbx.missingSetup();
  return guard(async () => {
    const c = await connection();
    const [n] = await prisma.$queryRaw<{ folders: number; waiting: number; photos: number; videos: number }[]>`
      select (select count(*) from crm.dropbox_folders)::int as folders,
             (select count(*) from crm.accounts a where a.dear_customer_id is not null and not a.archived and not coalesce(a.misc, false) and not exists (select 1 from crm.dropbox_folders f where f.account_id = a.id))::int as waiting,
             (select count(*) from crm.media where kind = 'photo')::int as photos, (select count(*) from crm.media where kind = 'video')::int as videos`;
    return { configured: !!cfg, missing, redirectUri: dbx.redirectUri(), connected: !!c, status: c?.status ?? null, email: c?.email ?? null, name: c?.name ?? null, lastError: c?.last_error ?? null, folders: n?.folders ?? 0, waiting: n?.waiting ?? 0, photos: n?.photos ?? 0, videos: n?.videos ?? 0 };
  });
}
export function connectUrl(repId: string): string {
  if (!dbx.dropboxConfig()) throw new MediaError(`Dropbox is not set up on the server yet. Add ${dbx.missingSetup().join(', ')} to the API's settings.`, 400);
  return dbx.authorizeUrl(signState(repId));
}
/** Dropbox sends the manager back to the callback with a code. Returns what to put after /settings?dropbox= . Only a manager can connect it. */
export async function finishConnect(q: { error?: unknown; state?: unknown; code?: unknown }): Promise<string> {
  if (q.error) return `error&reason=${encodeURIComponent(String(q.error).slice(0, 60))}`;
  const st = verifyState(String(q.state ?? ''));
  if (!st) return 'error&reason=expired';
  const code = String(q.code ?? '');
  if (!code) return 'error&reason=no_code';
  try {
    const [r] = await prisma.$queryRaw<{ role: string }[]>`select role::text as role from crm.reps where id = ${st.repId}::uuid`;
    if (!r || r.role !== 'manager') return 'error&reason=not_manager';
    const tok = await dbx.exchangeCode(code);
    if (!tok.refreshToken) return 'error&reason=no_refresh';
    const who = await dbx.currentAccount(tok.accessToken);
    await prisma.$queryRaw`
      insert into crm.dropbox_connection (id, email, name, dropbox_account_id, refresh_token_enc, connected_by) values (true, ${who.email}, ${who.name}, ${tok.accountId}, ${encrypt(tok.refreshToken)}, ${st.repId}::uuid)
      on conflict (id) do update set email = excluded.email, name = excluded.name, dropbox_account_id = excluded.dropbox_account_id, refresh_token_enc = excluded.refresh_token_enc, status = 'ok', last_error = null, connected_by = excluded.connected_by, connected_at = now(), updated_at = now()`;
    cached = { token: tok.accessToken, until: Date.now() + tok.expiresIn * 1000 };
    return 'connected';
  } catch (e) { console.error('dropbox callback failed', String((e as Error)?.message ?? e).slice(0, 160)); return 'error&reason=failed'; }
}
export async function disconnect(): Promise<void> {
  await guard(async () => {
    try { const t = await accessToken(); await dbx.revokeToken(t); } catch { /* already unusable: just remove it */ }
    await prisma.$queryRaw`delete from crm.dropbox_connection where id`;
  });
  forgetToken();
}

// ---------- customer folders ----------
const ROOT = '/Customers';
/** The customer's folder, made if it does not exist yet. A name already taken by another customer gets the state added, then a number, then a short id, so no two customers ever share a folder. */
export async function ensureFolder(accountId: string, token: string): Promise<string> {
  const [have] = await prisma.$queryRaw<{ path: string }[]>`select path from crm.dropbox_folders where account_id = ${accountId}::uuid`;
  if (have) return have.path;
  const [a] = await prisma.$queryRaw<{ id: string; name: string; region: string | null }[]>`select id, name, region from crm.accounts where id = ${accountId}::uuid`;
  if (!a) throw new MediaError('Account not found', 404);
  const base = dbx.folderName(a.name), region = dbx.folderName(a.region ?? '').slice(0, 20) || 'AU';
  const names = [base, `${base} (${region})`, ...[2, 3, 4].map(n => `${base} (${region} ${n})`), `${base} (${a.id.slice(0, 6)})`];
  for (const n of names) {
    const path = `${ROOT}/${n}`;
    const claimed = await prisma.$queryRaw<{ account_id: string }[]>`insert into crm.dropbox_folders (account_id, path) values (${accountId}::uuid, ${path}) on conflict do nothing returning account_id`;
    if (!claimed.length) {
      const [mine] = await prisma.$queryRaw<{ path: string }[]>`select path from crm.dropbox_folders where account_id = ${accountId}::uuid`;
      if (mine) return mine.path;   // another request made it a moment ago
      continue;                     // the name belongs to another customer
    }
    try { await dbx.createFolder(token, path); return path; }   // a folder that was already in Dropbox, made by hand, is simply used
    catch (e) { await prisma.$queryRaw`delete from crm.dropbox_folders where account_id = ${accountId}::uuid`; throw e; }
  }
  throw new MediaError('Could not find a free folder name for this customer.', 500);
}
export type FolderRun = { created: number; failed: number; remaining: number; stopped: string | null };
/** Makes folders for customers linked to DEAR that do not have one yet, a batch at a time. */
export async function runFolderJob(limit = 40): Promise<FolderRun> {
  const out: FolderRun = { created: 0, failed: 0, remaining: 0, stopped: null };
  try {
    const c = await connection();
    if (!c) return { ...out, stopped: 'Dropbox is not connected' };
    if (c.status !== 'ok') return { ...out, stopped: 'Dropbox needs to be connected again' };
    let token: string;
    try { token = await accessToken(); } catch (e) { return { ...out, stopped: e instanceof MediaError ? e.message : 'Dropbox would not answer' }; }
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      select a.id from crm.accounts a where a.dear_customer_id is not null and not a.archived and not coalesce(a.misc, false)
        and not exists (select 1 from crm.dropbox_folders f where f.account_id = a.id) order by a.created_at, a.id limit ${limit}::int`;
    for (const r of rows) {
      try { await ensureFolder(r.id, token); out.created++; }
      catch (e) { out.failed++; console.error('dropbox folder failed', String((e as Error)?.message ?? e).slice(0, 140)); if (e instanceof dbx.DropboxError && (e.status === 401 || e.status === 429)) { out.stopped = e.status === 429 ? 'Dropbox asked to slow down: the rest will be done next time' : 'Dropbox no longer accepts the connection'; break; } }
    }
    const [n] = await prisma.$queryRaw<{ n: number }[]>`select count(*)::int as n from crm.accounts a where a.dear_customer_id is not null and not a.archived and not coalesce(a.misc, false) and not exists (select 1 from crm.dropbox_folders f where f.account_id = a.id)`;
    return { ...out, remaining: n?.n ?? 0 };
  } catch (e) { if (tableMissing(e)) return { ...out, stopped: 'not set up in the database yet' }; throw e; }
}

// ---------- the files ----------
export type MediaItem = { id: string; accountId: string; activityId: string | null; kind: 'photo' | 'video'; name: string; mime: string; size: number; createdAt: string; by: string | null; mine: boolean; canDelete: boolean; url: string | null; missing: boolean; fromOld: boolean };   // fromOld: a copy of an old Supabase photo that was moved to Dropbox
type Row = { id: string; account_id: string; activity_id: string | null; uploaded_by: string | null; kind: 'photo' | 'video'; name: string; mime: string; size: string | number; dropbox_path: string; created_at: Date; by_name?: string | null; source_url?: string | null };
const toItem = (r: Row, rep: Rep, url: string | null, missing = false): MediaItem => ({
  id: r.id, accountId: r.account_id, activityId: r.activity_id, kind: r.kind, name: r.name, mime: r.mime, size: Number(r.size), createdAt: new Date(r.created_at).toISOString(),
  by: r.by_name ?? null, mine: r.uploaded_by === rep.id, canDelete: r.uploaded_by === rep.id || rep.role === 'manager', url, missing, fromOld: !!r.source_url,
});
const links = new Map<string, { url: string; until: number }>();
async function linkFor(token: string, path: string): Promise<{ url: string | null; missing: boolean }> {
  const hit = links.get(path); if (hit && hit.until > Date.now()) return { url: hit.url, missing: false };
  try { const url = await dbx.temporaryLink(token, path); links.set(path, { url, until: Date.now() + 3 * 3600_000 }); return { url, missing: false }; }
  catch (e) { return { url: null, missing: e instanceof dbx.DropboxError && e.status === 409 }; }
}
async function mapLimit<T, R>(items: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await f(items[k]!); } }));
  return out;
}
const stamp = () => new Date().toLocaleString('sv-SE', { timeZone: 'Australia/Melbourne' }).replace(/:/g, '').slice(0, 17);   // 2026-11-12 103015

async function visibleAccount(rep: Rep, accountId: unknown, d: Deps): Promise<{ id: string; region: string }> {
  if (!uuidOk(accountId)) throw new MediaError('Bad account', 400);
  const [a] = await prisma.$queryRaw<{ id: string; region: string }[]>`select id, region from crm.accounts where id = ${accountId}::uuid`;
  if (!a) throw new MediaError('Account not found', 404);
  if (!(await d.canSeeAccount(rep, a))) throw new MediaError('This account is outside your states', 403);
  return a;
}

/** Saves one photo or video from the request, in the customer's folder. `length` is what the browser said the size is (checked at once, and again as it arrives). */
export async function uploadMedia(rep: Rep, p: { accountId: unknown; activityId?: unknown; name: unknown; type: unknown; length: number | null }, stream: AsyncIterable<Uint8Array>, d: Deps = realDeps): Promise<MediaItem> {
  const k = dbx.mediaKind(p.type, p.name);
  if (!k) throw new MediaError('Only photos and videos can be attached (JPG, PNG, HEIC, MP4, MOV and similar).', 415);
  const max = k.kind === 'photo' ? dbx.MAX_PHOTO : dbx.MAX_VIDEO, maxMb = Math.round(max / 1048576);
  if (p.length != null && p.length > max) throw new MediaError(`That ${k.kind} is too big. The most is ${maxMb} MB: ${k.kind === 'video' ? 'trim it or record it at a lower quality' : 'make it smaller'}.`, 413);
  if (p.length === 0) throw new MediaError('That file is empty.', 400);
  return guard(async () => {
    const acct = await visibleAccount(rep, p.accountId, d);
    let activityId: string | null = null;
    if (p.activityId != null && p.activityId !== '') {
      if (!uuidOk(p.activityId)) throw new MediaError('Bad log entry', 400);
      const [a] = await prisma.$queryRaw<{ account_id: string; rep_id: string }[]>`select account_id, rep_id from crm.activity where id = ${p.activityId}::uuid`;
      if (!a || a.account_id !== acct.id) throw new MediaError("That log entry doesn't belong to this account", 400);
      if (a.rep_id !== rep.id && rep.role !== 'manager') throw new MediaError('You can only add files to your own log entries', 403);
      activityId = p.activityId;
    }
    const [lim] = await prisma.$queryRaw<{ n: number }[]>`select count(*)::int as n from crm.media where uploaded_by = ${rep.id}::uuid and created_at > now() - interval '1 hour'`;
    if ((lim?.n ?? 0) >= UPLOADS_PER_HOUR) throw new MediaError(`That is ${UPLOADS_PER_HOUR} files in the last hour. Try again later.`, 429);
    const token = await accessToken();
    let folder: string;
    try { folder = await ensureFolder(acct.id, token); }
    catch (e) { if (e instanceof MediaError) throw e; console.error('dropbox folder failed', String((e as Error)?.message ?? e).slice(0, 140)); throw new MediaError("Could not make this customer's Dropbox folder just now. Nothing was saved. Try again in a minute.", 502); }
    const { stem, ext } = dbx.fileParts(p.name, k.mime);
    let saved: dbx.Saved;
    try { saved = await dbx.saveFromStream(token, `${folder}/${stamp()} ${stem}${ext}`, stream, max); }
    catch (e) {
      if (e instanceof dbx.DropboxError && e.code === 'too_large') throw new MediaError(`That ${k.kind} is too big. The most is ${maxMb} MB.`, 413);
      if (e instanceof dbx.DropboxError && e.code === 'empty') throw new MediaError('That file is empty.', 400);
      if (e instanceof dbx.DropboxError && e.status === 401) { forgetToken(); throw new MediaError('Dropbox would not accept it. Try again in a minute.', 502); }
      console.error('dropbox upload failed', String((e as Error)?.message ?? e).slice(0, 140));
      throw new MediaError('Dropbox would not take the file just now. Nothing was saved. Try again in a minute.', 502);
    }
    try {
      const [row] = await prisma.$queryRaw<Row[]>`
        with ins as (insert into crm.media (account_id, activity_id, uploaded_by, kind, name, mime, size, dropbox_id, dropbox_path)
          values (${acct.id}::uuid, ${activityId}::uuid, ${rep.id}::uuid, ${k.kind}, ${saved.name}, ${k.mime}, ${saved.size}, ${saved.id}, ${saved.path}) returning *)
        select ins.*, (select name from crm.reps where id = ${rep.id}::uuid) as by_name from ins`;
      const l = await linkFor(token, saved.path);
      return toItem(row!, rep, l.url);
    } catch (e) {
      try { await dbx.deleteFile(token, saved.path); } catch { /* the file stays in Dropbox: nothing is lost, only not shown */ }
      throw e;
    }
  });
}
/** The account's photos and videos, newest first, each with a link that shows it for a few hours. */
export async function listMedia(rep: Rep, accountId: unknown, d: Deps = realDeps): Promise<{ items: MediaItem[]; linksAvailable: boolean }> {
  return guard(async () => {
    const acct = await visibleAccount(rep, accountId, d);
    const rows = await prisma.$queryRaw<Row[]>`select m.*, r.name as by_name from crm.media m left join crm.reps r on r.id = m.uploaded_by where m.account_id = ${acct.id}::uuid order by m.created_at desc limit 120`;
    if (!rows.length) return { items: [], linksAvailable: true };
    let token: string | null = null;
    try { token = await accessToken(); } catch { token = null; }
    if (!token) return { items: rows.map(r => toItem(r, rep, null)), linksAvailable: false };
    const t = token;
    const done = await mapLimit(rows, 6, async r => { const l = await linkFor(t, r.dropbox_path); return toItem(r, rep, l.url, l.missing); });
    return { items: done, linksAvailable: true };
  });
}
/** Ties files a rep has just uploaded to the log entry they have just made. Only their own, not already tied, on the same account. */
export async function linkMedia(rep: Rep, mediaIds: unknown, activityId: unknown): Promise<{ linked: number }> {
  if (!Array.isArray(mediaIds) || !mediaIds.length || mediaIds.length > MAX_IDS || !mediaIds.every(uuidOk)) throw new MediaError('Choose the files to link.', 400);
  if (!uuidOk(activityId)) throw new MediaError('Bad log entry', 400);
  return guard(async () => {
    const [a] = await prisma.$queryRaw<{ account_id: string; rep_id: string }[]>`select account_id, rep_id from crm.activity where id = ${activityId}::uuid`;
    if (!a) throw new MediaError('That log entry was not found', 404);
    if (a.rep_id !== rep.id && rep.role !== 'manager') throw new MediaError('You can only add files to your own log entries', 403);
    const r = await prisma.$queryRaw<{ id: string }[]>`
      update crm.media set activity_id = ${activityId}::uuid where id = any(${[...new Set(mediaIds as string[])]}::uuid[]) and uploaded_by = ${rep.id}::uuid and activity_id is null and account_id = ${a.account_id}::uuid returning id`;
    return { linked: r.length };
  });
}
/** Deletes a file from Dropbox and from Radar. The person who added it can, and any manager. */
export async function deleteMedia(rep: Rep, id: unknown, d: Deps = realDeps): Promise<void> {
  if (!uuidOk(id)) throw new MediaError('That file was not found', 404);
  await guard(async () => {
    const [m] = await prisma.$queryRaw<Row[]>`select * from crm.media where id = ${id}::uuid`;
    if (!m) throw new MediaError('That file was not found', 404);
    await visibleAccount(rep, m.account_id, d);
    if (m.uploaded_by !== rep.id && rep.role !== 'manager') throw new MediaError('Only the person who added it, or a manager, can delete it', 403);
    const token = await accessToken();
    try { await dbx.deleteFile(token, m.dropbox_path); }
    catch (e) { console.error('dropbox delete failed', String((e as Error)?.message ?? e).slice(0, 140)); throw new MediaError('Could not delete it from Dropbox just now. Try again in a minute.', 502); }
    links.delete(m.dropbox_path);
    await prisma.$queryRaw`delete from crm.media where id = ${id}::uuid`;
  });
}
