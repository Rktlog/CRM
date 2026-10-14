import { prisma } from './prisma';
import { decrypt } from './gmail/crypto';
import { accessTokenFrom, googleFetch, GoogleApiError, calendarConfigured } from './gmail/google';

// Google Calendar for each rep, through THEIR OWN Google sign-in: the rep presses "Connect Google Calendar" in Settings and
// approves access to their own calendar's events. The CRM never acts as anyone else. Each rep's sign-in is kept encrypted
// (crm.calendar_connections) and swapped for a short-lived access token when needed.
export { calendarConfigured };

// "This rep's Google Calendar is not usable right now" (not connected, or Google no longer accepts the sign-in).
export class CalendarNotConnectedError extends Error {}
const RECONNECT = 'Your Google Calendar sign-in has expired or was removed. Press Connect Google Calendar again.';
const NO_SCOPE = 'Google Calendar access was not granted. Press Connect Google Calendar again and tick the box that allows managing events.';

export type CalendarConnection = { email: string; status: string; lastError: string | null; refreshTokenEnc: string };
export async function connectionOf(repId: string): Promise<CalendarConnection | null> {
  const [c] = await prisma.$queryRaw<CalendarConnection[]>`
    select email, status, last_error as "lastError", refresh_token_enc as "refreshTokenEnc" from crm.calendar_connections where rep_id = ${repId}::uuid`;
  return c ?? null;
}
async function markProblem(repId: string, message: string) {
  await prisma.$queryRaw`update crm.calendar_connections set status = 'needs_reconnect', last_error = ${message}, updated_at = now() where rep_id = ${repId}::uuid`;
}

// Access tokens per rep, kept until shortly before they expire (they last an hour).
const tokenCache = new Map<string, { token: string; expiresAt: number }>();
export const dropCachedToken = (repId: string) => { tokenCache.delete(repId); };

async function accessToken(repId: string, fresh = false): Promise<string> {
  const hit = tokenCache.get(repId);
  if (!fresh && hit && hit.expiresAt > Date.now() + 60_000) return hit.token;
  const c = await connectionOf(repId);
  if (!c) throw new CalendarNotConnectedError('Google Calendar is not connected. Press Connect Google Calendar in Settings.');
  if (c.status === 'needs_reconnect') throw new CalendarNotConnectedError(c.lastError || RECONNECT);   // do not keep asking Google with a sign-in it has refused
  let token: string;
  try { token = await accessTokenFrom(decrypt(c.refreshTokenEnc)); }
  catch (e) {
    const refused = e instanceof GoogleApiError ? (e.reason === 'invalid_grant' || e.status === 401)
      : /GMAIL_TOKEN_KEY|known format|authenticate data|Unsupported state/i.test(String((e as Error)?.message));   // a changed key makes the saved sign-in unreadable
    if (refused) { await markProblem(repId, RECONNECT); tokenCache.delete(repId); throw new CalendarNotConnectedError(RECONNECT); }
    throw new Error(`Google sign-in failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
  }
  tokenCache.set(repId, { token, expiresAt: Date.now() + 50 * 60_000 });
  return token;
}

async function call(repId: string, method: string, path: string, body?: unknown, retried = false): Promise<any> {
  const token = await accessToken(repId, retried);
  const res = await googleFetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data: any = await res.json().catch(() => ({}));
  // A token Google no longer accepts: get a fresh one once, and only then give up.
  if (res.status === 401 && !retried) { tokenCache.delete(repId); return call(repId, method, path, body, true); }
  if (res.status === 401) { await markProblem(repId, RECONNECT); tokenCache.delete(repId); throw new CalendarNotConnectedError(RECONNECT); }
  if (res.status === 403 && /insufficient|scope/i.test(JSON.stringify(data?.error ?? ''))) { await markProblem(repId, NO_SCOPE); tokenCache.delete(repId); throw new CalendarNotConnectedError(NO_SCOPE); }
  if (!res.ok) {
    const err: any = new Error(`Google Calendar ${method} failed (${res.status}): ${data?.error?.message ?? 'unknown error'}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Events in the rep's main calendar between two times (recurring ones expanded).
export async function listEvents(repId: string, timeMin: string, timeMax: string): Promise<any[]> {
  const q = new URLSearchParams({ timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: '250' });
  const data = await call(repId, 'GET', `?${q.toString()}`);
  return data?.items ?? [];
}

export type CalendarEvent = {
  summary: string;
  description?: string;
  location?: string;
  start: { date: string };
  end: { date: string };
  transparency?: 'transparent' | 'opaque';
  colorId?: string;
  source?: { title: string; url: string };
  // Marks events the CRM created, so the Planner doesn't show them twice.
  extendedProperties?: { private: Record<string, string> };
};

export const createEvent = (repId: string, ev: CalendarEvent) => call(repId, 'POST', '', ev);
export const updateEvent = (repId: string, id: string, ev: CalendarEvent) => call(repId, 'PUT', `/${encodeURIComponent(id)}`, ev);
export async function deleteEvent(repId: string, id: string) {
  try {
    await call(repId, 'DELETE', `/${encodeURIComponent(id)}`);
  } catch (e: any) {
    if (e.status !== 404 && e.status !== 410) throw e; // already gone is fine
  }
}