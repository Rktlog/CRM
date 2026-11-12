// The Dropbox client: signing in once for the whole company, making folders, saving a photo or video from a stream, and getting a link to show one.
// Radar keeps ONE Dropbox connection (the company's, made by a manager in Settings). Its refresh token is kept encrypted, like the Gmail ones (lib/gmail/crypto.ts).
// The app is set up with "App folder" access in Dropbox, so Radar can only ever see its own folder, never anything else in that Dropbox.
// Nothing here talks to the database: lib/media.ts does that.
export type Fetch = (url: string, init?: any) => Promise<Response>;
const URLS = { authorize: 'https://www.dropbox.com/oauth2/authorize', oauth: 'https://api.dropboxapi.com/oauth2/token', api: 'https://api.dropboxapi.com/2', content: 'https://content.dropboxapi.com/2' };
let urls = { ...URLS };
let fetchImpl: Fetch = (u, i) => fetch(u, i);
let chunkBytes = 8 * 1024 * 1024;
/** For tests only: point the client at a fake Dropbox. */
export function setDropboxForTests(o: { fetch?: Fetch; api?: string; content?: string; oauth?: string; chunk?: number } | null) {
  urls = { ...URLS, ...(o?.api ? { api: o.api } : {}), ...(o?.content ? { content: o.content } : {}), ...(o?.oauth ? { oauth: o.oauth } : {}) };
  fetchImpl = o?.fetch ?? ((u, i) => fetch(u, i));
  chunkBytes = o?.chunk ?? 8 * 1024 * 1024;
}

export class DropboxError extends Error { status: number; code: string | null; constructor(message: string, status = 502, code: string | null = null) { super(message); this.status = status; this.code = code; } }
export const MAX_PHOTO = 30 * 1024 * 1024;
export const MAX_VIDEO = 250 * 1024 * 1024;

// ---------- settings ----------
const apiBase = () => (process.env.PUBLIC_API_URL ?? '').replace(/\/+$/, '');
/** The address Dropbox sends the manager back to. It must be added in the Dropbox app's settings exactly as shown. */
export const redirectUri = (): string | null => process.env.DROPBOX_REDIRECT_URI || (apiBase() ? `${apiBase()}/dropbox/callback` : null);
export function dropboxConfig(): { appKey: string; appSecret: string; redirectUri: string } | null {
  const appKey = process.env.DROPBOX_APP_KEY, appSecret = process.env.DROPBOX_APP_SECRET, uri = redirectUri();
  return appKey && appSecret && uri ? { appKey, appSecret, redirectUri: uri } : null;
}
/** What is still missing from the API's settings, by name, so a manager can say exactly what to add. */
export function missingSetup(): string[] {
  const m: string[] = [];
  if (!process.env.DROPBOX_APP_KEY) m.push('DROPBOX_APP_KEY');
  if (!process.env.DROPBOX_APP_SECRET) m.push('DROPBOX_APP_SECRET');
  if (!process.env.DROPBOX_REDIRECT_URI && !apiBase()) m.push('PUBLIC_API_URL');
  return m;
}
/** Where to send a manager to approve access on Dropbox's own page. token_access_type=offline is what gives Radar a refresh token that does not expire. */
export function authorizeUrl(state: string): string {
  const c = dropboxConfig(); if (!c) throw new DropboxError('Dropbox is not set up on the server yet', 400);
  return `${urls.authorize}?${new URLSearchParams({ client_id: c.appKey, response_type: 'code', token_access_type: 'offline', redirect_uri: c.redirectUri, state }).toString()}`;
}

// ---------- talking to Dropbox ----------
async function problem(res: Response): Promise<DropboxError> {
  let body: any = null; try { body = await res.json(); } catch { /* not JSON */ }
  const summary = String(body?.error_summary ?? body?.error_description ?? (typeof body?.error === 'string' ? body.error : '') ?? '').slice(0, 160);
  const code = typeof body?.error === 'string' ? body.error : String(body?.error?.['.tag'] ?? summary.split('/')[0] ?? '') || null;
  return new DropboxError(summary || `Dropbox answered ${res.status}`, res.status, code);
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function call(url: string, init: any, retries = 1): Promise<Response> {
  const res = await fetchImpl(url, init);
  if (res.status === 429 && retries > 0) { const wait = Math.min(Number(res.headers.get('retry-after') ?? 1), 5); await sleep(wait * 1000); return call(url, init, retries - 1); }
  return res;
}
const basic = (c: { appKey: string; appSecret: string }) => `Basic ${Buffer.from(`${c.appKey}:${c.appSecret}`).toString('base64')}`;
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
async function tokenCall(o: Record<string, string>): Promise<any> {
  const c = dropboxConfig(); if (!c) throw new DropboxError('Dropbox is not set up on the server yet', 400);
  const res = await call(urls.oauth, { method: 'POST', headers: { Authorization: basic(c), 'Content-Type': 'application/x-www-form-urlencoded' }, body: form(o) });
  if (!res.ok) throw await problem(res);
  return res.json();
}
export async function exchangeCode(code: string): Promise<{ refreshToken: string | null; accessToken: string; expiresIn: number; accountId: string | null }> {
  const c = dropboxConfig(); if (!c) throw new DropboxError('Dropbox is not set up on the server yet', 400);
  const b = await tokenCall({ code, grant_type: 'authorization_code', redirect_uri: c.redirectUri });
  return { refreshToken: b.refresh_token ? String(b.refresh_token) : null, accessToken: String(b.access_token ?? ''), expiresIn: Number(b.expires_in ?? 14400), accountId: b.account_id ? String(b.account_id) : null };
}
export async function refreshAccess(refreshToken: string): Promise<{ accessToken: string; expiresIn: number }> {
  const b = await tokenCall({ grant_type: 'refresh_token', refresh_token: refreshToken });
  if (!b.access_token) throw new DropboxError('Dropbox did not give an access token', 502);
  return { accessToken: String(b.access_token), expiresIn: Number(b.expires_in ?? 14400) };
}
async function rpc(token: string, route: string, body?: unknown): Promise<any> {
  const res = await call(`${urls.api}${route}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!res.ok) throw await problem(res);
  const t = await res.text(); return t ? JSON.parse(t) : null;
}
/** Takes Radar's access away at Dropbox too (disconnecting). Failing to do so is not an error: the connection is removed here either way. */
export async function revokeToken(accessToken: string): Promise<void> { try { await rpc(accessToken, '/auth/token/revoke'); } catch { /* already gone */ } }
/** The Dropbox account that was connected (best effort: it needs a permission that is not always given). */
export async function currentAccount(token: string): Promise<{ email: string | null; name: string | null }> {
  try { const b = await rpc(token, '/users/get_current_account'); return { email: b?.email ? String(b.email).toLowerCase() : null, name: b?.name?.display_name ? String(b.name.display_name) : null }; }
  catch { return { email: null, name: null }; }
}
/** Dropbox wants the details of an upload in a header, which can only hold plain characters: anything else is written as \uXXXX. */
export const argHeader = (o: unknown): string => JSON.stringify(o).replace(/[\u007f-\uffff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
const pathOf = (p: string) => p;
export async function createFolder(token: string, path: string): Promise<'created' | 'exists'> {
  try { await rpc(token, '/files/create_folder_v2', { path: pathOf(path), autorename: false }); return 'created'; }
  catch (e) { if (e instanceof DropboxError && e.status === 409 && /conflict/.test(e.message)) return 'exists'; throw e; }
}
export type Saved = { id: string; name: string; path: string; size: number };
async function contentCall(token: string, route: string, arg: unknown, body: Buffer): Promise<any> {
  const res = await call(`${urls.content}${route}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Dropbox-API-Arg': argHeader(arg), 'Content-Type': 'application/octet-stream' }, body });
  if (!res.ok) throw await problem(res);
  const t = await res.text(); return t ? JSON.parse(t) : null;
}
/** Saves what comes down the stream as one file. A small file is one call; a big one (a video) goes up in pieces, so it is never held in memory whole. Refuses more than maxBytes. */
export async function saveFromStream(token: string, path: string, source: AsyncIterable<Uint8Array>, maxBytes: number): Promise<Saved> {
  const commit = { path, mode: 'add', autorename: true, mute: true };
  let session: string | null = null, offset = 0, total = 0, parts: Buffer[] = [], have = 0;
  const meta = (m: any): Saved => ({ id: String(m.id), name: String(m.name), path: String(m.path_display ?? m.path_lower ?? path), size: Number(m.size ?? total) });
  const piece = async (buf: Buffer): Promise<void> => {
    if (!session) { const b = await contentCall(token, '/files/upload_session/start', { close: false }, buf); session = String(b.session_id); }
    else await contentCall(token, '/files/upload_session/append_v2', { cursor: { session_id: session, offset }, close: false }, buf);
    offset += buf.length;
  };
  for await (const chunk of source) {
    const b = Buffer.from(chunk); total += b.length;
    if (total > maxBytes) throw new DropboxError('That file is too big.', 413, 'too_large');
    parts.push(b); have += b.length;
    while (have >= chunkBytes) { const all = Buffer.concat(parts); await piece(all.subarray(0, chunkBytes)); const rest = all.subarray(chunkBytes); parts = rest.length ? [rest] : []; have = rest.length; }
  }
  if (total === 0) throw new DropboxError('That file is empty.', 400, 'empty');
  const last = Buffer.concat(parts);
  if (!session) return meta(await contentCall(token, '/files/upload', commit, last));
  return meta(await contentCall(token, '/files/upload_session/finish', { cursor: { session_id: session, offset }, commit }, last));
}
/** A link that shows the file for about four hours. */
export async function temporaryLink(token: string, path: string): Promise<string> { const b = await rpc(token, '/files/get_temporary_link', { path }); return String(b.link); }
/** Deletes a file. One that is already gone counts as deleted. */
export async function deleteFile(token: string, path: string): Promise<void> {
  try { await rpc(token, '/files/delete_v2', { path }); } catch (e) { if (e instanceof DropboxError && e.status === 409 && /not_found/.test(e.message)) return; throw e; }
}

// ---------- names ----------
/** A customer's name as a folder name Dropbox accepts: no \ / : * ? " < > |, no dots or spaces on the end, not too long, never empty. */
const tidy = (name: unknown, max: number): string => String(name ?? '').normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').replace(/[. ]+$/, '').slice(0, max).trim().replace(/[. ]+$/, '');
export function folderName(name: unknown): string { return tidy(name, 100) || 'Customer'; }
/** The file's own name made safe, and its extension (from its name, else its type). */
export function fileParts(original: unknown, mime: string): { stem: string; ext: string } {
  const base = String(original ?? '').split(/[\\/]/).pop() ?? '';
  const m = base.match(/^(.*?)(\.[A-Za-z0-9]{1,5})?$/);
  const stem = tidy(m?.[1] ?? '', 60) || 'file';
  const fromMime: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/heic': '.heic', 'image/heif': '.heif', 'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm', 'video/x-m4v': '.m4v', 'video/3gpp': '.3gp', 'video/mpeg': '.mpg' };
  return { stem, ext: (m?.[2] ?? fromMime[mime] ?? '').toLowerCase() };
}
const PHOTO = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif'];
const VIDEO = ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v', 'video/3gpp', 'video/mpeg'];
const BY_EXT: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.heic': 'image/heic', '.heif': 'image/heif', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.m4v': 'video/x-m4v', '.3gp': 'video/3gpp', '.mpg': 'video/mpeg', '.mpeg': 'video/mpeg' };
/** Photo or video, from the type the browser gave (some phones give none, so the extension is used). null for anything else. */
export function mediaKind(mime: unknown, filename: unknown): { kind: 'photo' | 'video'; mime: string } | null {
  const given = String(mime ?? '').toLowerCase().split(';')[0]!.trim();
  const ext = (String(filename ?? '').toLowerCase().match(/\.[a-z0-9]{1,5}$/) ?? [''])[0];
  const m = PHOTO.includes(given) || VIDEO.includes(given) ? given : (given === '' || given === 'application/octet-stream' ? BY_EXT[ext] ?? '' : '');
  if (PHOTO.includes(m)) return { kind: 'photo', mime: m };
  if (VIDEO.includes(m)) return { kind: 'video', mime: m };
  return null;
}
