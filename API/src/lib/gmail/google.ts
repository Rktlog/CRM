import { tokenKeyOk } from './crypto';

// Talks to Google, and keeps nothing. Plain web requests (no extra packages).
let fetchImpl: typeof fetch = (...a) => fetch(...a);
export const setFetchForTests = (f: typeof fetch | null) => { fetchImpl = f ?? ((...a) => fetch(...a)); };

export class GoogleApiError extends Error {
  constructor(message: string, public status: number, public reason?: string) { super(message); }
}

// Read-only access to the rep's own mailbox, plus their email address.
export const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly', 'openid', 'email'];

// The company's Google sign-in (one client for everything), and where Google sends people back to for each feature.
const apiBase = () => (process.env.PUBLIC_API_URL ?? '').replace(/\/+$/, '');
function clientCreds(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID, clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}
export function oauthConfig(): { clientId: string; clientSecret: string; redirectUri: string } | null {
  const c = clientCreds();
  const redirectUri = process.env.GMAIL_REDIRECT_URI || (apiBase() ? `${apiBase()}/gmail/callback` : '');
  return c && redirectUri ? { ...c, redirectUri } : null;
}
export function calendarOauthConfig(): { clientId: string; clientSecret: string; redirectUri: string } | null {
  const c = clientCreds();
  const redirectUri = process.env.CALENDAR_REDIRECT_URI || (apiBase() ? `${apiBase()}/calendar/callback` : '');
  return c && redirectUri ? { ...c, redirectUri } : null;
}
export const gmailConfigured = () => !!oauthConfig() && tokenKeyOk();
export const calendarConfigured = () => !!calendarOauthConfig() && tokenKeyOk();
// What is still missing on the server, in plain words, for the Settings cards.
function missing(redirectEnv: string): string[] {
  const miss: string[] = [];
  if (!process.env.GOOGLE_OAUTH_CLIENT_ID) miss.push('GOOGLE_OAUTH_CLIENT_ID');
  if (!process.env.GOOGLE_OAUTH_CLIENT_SECRET) miss.push('GOOGLE_OAUTH_CLIENT_SECRET');
  if (!tokenKeyOk()) miss.push('GMAIL_TOKEN_KEY');
  if (!process.env[redirectEnv] && !process.env.PUBLIC_API_URL) miss.push('PUBLIC_API_URL');
  return miss;
}
export const missingSetup = () => missing('GMAIL_REDIRECT_URI');
export const calendarMissingSetup = () => missing('CALENDAR_REDIRECT_URI');

export const CALENDAR_SCOPES = ['https://www.googleapis.com/auth/calendar.events', 'openid', 'email'];

export function authUrlFor(o: { scopes: string[]; redirectUri: string; state: string; loginHint?: string | null }): string {
  const c = clientCreds(); if (!c) throw new Error('Google sign-in is not set up on the server yet');
  const p = new URLSearchParams({
    client_id: c.clientId, redirect_uri: o.redirectUri, response_type: 'code', scope: o.scopes.join(' '),
    access_type: 'offline',   // so Google gives us a refresh token and the sync can run without the rep being here
    prompt: 'consent',        // ... and gives it every time, even if they connected before
    state: o.state,
  });
  if (o.loginHint) p.set('login_hint', o.loginHint);
  const hd = process.env.GOOGLE_ALLOWED_DOMAIN || process.env.GMAIL_ALLOWED_DOMAIN;
  if (hd) p.set('hd', hd);
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}
export function authUrl(state: string, loginHint?: string | null): string {
  const c = oauthConfig(); if (!c) throw new Error('Gmail is not set up on the server yet');
  return authUrlFor({ scopes: SCOPES, redirectUri: c.redirectUri, state, loginHint });
}

async function parse(res: Response) {
  const text = await res.text(); let body: any = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text.slice(0, 200) }; }
  if (!res.ok) {
    const e = body?.error;
    const reason = typeof e === 'string' ? e : e?.errors?.[0]?.reason ?? e?.status;
    throw new GoogleApiError(String(body?.error_description ?? e?.message ?? (typeof e === 'string' ? e : `Google answered ${res.status}`)), res.status, reason);
  }
  return body;
}
const form = (o: Record<string, string>) => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString() });

export async function exchangeCodeFor(code: string, redirectUri: string): Promise<{ refreshToken: string | null; accessToken: string; scope: string }> {
  const c = clientCreds(); if (!c) throw new Error('Google sign-in is not set up on the server yet');
  const b = await parse(await fetchImpl('https://oauth2.googleapis.com/token', form({ code, client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' })));
  return { refreshToken: b.refresh_token ?? null, accessToken: b.access_token, scope: String(b.scope ?? '') };
}
export async function exchangeCode(code: string) {
  const c = oauthConfig(); if (!c) throw new Error('Gmail is not set up on the server yet');
  return exchangeCodeFor(code, c.redirectUri);
}
// The email address of whoever just signed in (needs only the "email" permission, so it works for Calendar too).
export async function getUserEmail(accessToken: string): Promise<string> {
  const b = await parse(await fetchImpl('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${accessToken}` } }));
  if (!b.email) throw new GoogleApiError('Google did not say which account signed in', 502, 'no_email');
  return String(b.email).toLowerCase();
}
// For the other Google features (Calendar) so they share the same web calls and the same test hook.
export const googleFetch = (...a: Parameters<typeof fetch>) => fetchImpl(...a);
export const parseGoogle = (res: Response) => parse(res);

export async function accessTokenFrom(refreshToken: string): Promise<string> {
  const c = clientCreds(); if (!c) throw new Error('Google sign-in is not set up on the server yet');
  const b = await parse(await fetchImpl('https://oauth2.googleapis.com/token', form({ refresh_token: refreshToken, client_id: c.clientId, client_secret: c.clientSecret, grant_type: 'refresh_token' })));
  return b.access_token;
}
export async function revoke(token: string): Promise<void> {
  try { await fetchImpl('https://oauth2.googleapis.com/revoke', form({ token })); } catch { /* best effort: the token is deleted here either way */ }
}

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const auth = (t: string) => ({ headers: { Authorization: `Bearer ${t}` } });

export async function getProfile(accessToken: string): Promise<{ emailAddress: string }> {
  return parse(await fetchImpl(`${API}/profile`, auth(accessToken)));
}
// Ids of the messages matching a Gmail search, newest first.
export async function listMessageIds(accessToken: string, q: string, maxPages = 20): Promise<string[]> {
  const ids: string[] = []; let pageToken = '';
  for (let i = 0; i < maxPages; i++) {
    const p = new URLSearchParams({ q, maxResults: '500', includeSpamTrash: 'false' }); if (pageToken) p.set('pageToken', pageToken);
    const b = await parse(await fetchImpl(`${API}/messages?${p}`, auth(accessToken)));
    for (const m of b.messages ?? []) ids.push(m.id);
    pageToken = b.nextPageToken ?? ''; if (!pageToken) break;
  }
  return ids;
}

// The Gmail label people use to keep an email, or a whole conversation, out of the CRM. They make it themselves in Gmail.
// It is never saved, and if it was saved before it is removed. GMAIL_PRIVATE_LABELS can name others, separated by commas.
export const privateLabels = (): string[] => (process.env.GMAIL_PRIVATE_LABELS || 'Private').split(',').map(s => s.trim()).filter(Boolean);
const labelTerm = (name: string) => `label:${name.toLowerCase().replace(/\s+/g, '-')}`;   // how Gmail's search spells a label
export const privateSearch = () => privateLabels().map(labelTerm).join(' OR ');                // finds them
export const privateExclusion = () => privateLabels().map(n => `-${labelTerm(n)}`).join(' ');   // leaves them out

// Every message carrying a private label, with its conversation, so the whole conversation can be left out. Spam and trash
// are included so nothing is missed.
export async function listPrivateMessages(accessToken: string, maxPages = 6): Promise<{ id: string; threadId: string }[]> {
  const out: { id: string; threadId: string }[] = []; let pageToken = '';
  for (let i = 0; i < maxPages; i++) {
    const p = new URLSearchParams({ q: `(${privateSearch()})`, maxResults: '500', includeSpamTrash: 'true' }); if (pageToken) p.set('pageToken', pageToken);
    const b = await parse(await fetchImpl(`${API}/messages?${p}`, auth(accessToken)));
    for (const m of b.messages ?? []) out.push({ id: m.id, threadId: m.threadId });
    pageToken = b.nextPageToken ?? ''; if (!pageToken) break;
  }
  return out;
}

export type GmailMeta = { id: string; threadId: string; labelIds: string[]; snippet: string; internalDate: string; headers: Record<string, string> };
const HEADERS = ['From', 'To', 'Cc', 'Subject', 'Date', 'List-Unsubscribe', 'Precedence', 'Auto-Submitted'];
// Only the headers: never the body of the email. null if it has been deleted since.
export async function getMessageMeta(accessToken: string, id: string): Promise<GmailMeta | null> {
  const p = new URLSearchParams({ format: 'metadata' }); for (const h of HEADERS) p.append('metadataHeaders', h);
  try {
    const b = await parse(await fetchImpl(`${API}/messages/${encodeURIComponent(id)}?${p}`, auth(accessToken)));
    const headers: Record<string, string> = {};
    for (const h of b.payload?.headers ?? []) { const k = String(h.name).toLowerCase(); if (!(k in headers)) headers[k] = String(h.value ?? ''); }
    return { id: b.id, threadId: b.threadId, labelIds: b.labelIds ?? [], snippet: b.snippet ?? '', internalDate: String(b.internalDate ?? '0'), headers };
  } catch (e) { if (e instanceof GoogleApiError && e.status === 404) return null; throw e; }
}