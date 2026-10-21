import { supabase } from './supabase';

const API_URL = import.meta.env.VITE_API_URL;

async function authHeader(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

// Throws with the API's own message when it sends one (e.g. "Only $61.99
// of credit is free to reserve"), otherwise the method, path and status.
async function fail(res: Response, method: string, path: string): Promise<never> {
  let message = `${method} ${path} failed: ${res.status}`;
  try {
    const body = await res.json();
    const e = body?.error;
    if (typeof e === 'string') message = e;
    else if (e?.formErrors?.length || e?.fieldErrors) message = [...(e.formErrors ?? []), ...Object.values(e.fieldErrors ?? {}).flat()].join(', ') || message;
  } catch { /* not JSON: keep the default */ }
  throw new Error(message);
}

// ---- Looking things up (GET) ----
// A page is built from several requests, and the same question is often asked from more than one place (who am I, the list of
// accounts). Each trip to the server is slow, so:
//   1. The same question asked twice at the same moment is sent once, and both get the answer.
//   2. An answer is kept for 10 seconds, so going back to a page you have just left shows at once.
// Anything you change (save, add, delete, import) throws the kept answers away, and so does signing in or out, so you never see
// an old list after changing it, or someone else's after switching person. A few areas are never kept after they arrive,
// because they change on their own while you watch: the assistant, marketing progress, Gmail and calendar status.
// Pass { fresh: true } to skip the kept answer and ask the server.
const KEEP_MS = 10_000;
const NEVER_KEEP = ['/ai/', '/marketing/', '/gmail/', '/calendar/'];
type Entry = { text: Promise<string>; doneAt: number | null };
const answers = new Map<string, Entry>();

export function clearApiCache() { answers.clear(); }
try { supabase.auth.onAuthStateChange(() => clearApiCache()); } catch { /* no auth listener (tests): nothing to listen to */ }

function ask(path: string): Entry {
  const entry: Entry = {
    doneAt: null,
    text: (async () => {
      const res = await fetch(`${API_URL}${path}`, { headers: await authHeader() });
      if (!res.ok) await fail(res, 'GET', path);
      return res.text();
    })(),
  };
  answers.set(path, entry);
  const keep = !NEVER_KEEP.some(p => path.startsWith(p));
  entry.text.then(
    () => { if (answers.get(path) !== entry) return; if (keep) entry.doneAt = Date.now(); else answers.delete(path); },
    () => { if (answers.get(path) === entry) answers.delete(path); },   // a failure is never kept: the next ask tries again
  );
  return entry;
}

export async function apiGet(path: string, opts: { fresh?: boolean } = {}) {
  let entry = opts.fresh ? undefined : answers.get(path);
  if (entry && entry.doneAt !== null && Date.now() - entry.doneAt >= KEEP_MS) entry = undefined;
  if (!entry) entry = ask(path);
  return JSON.parse(await entry.text);   // each caller gets its own copy, so changing one never changes another
}

// ---- Changing things: each one clears the kept answers, whether it worked or not ----
export async function apiPost(path: string, body: unknown) {
  try {
    const res = await fetch(`${API_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
      body: JSON.stringify(body),
    });
    if (!res.ok) await fail(res, 'POST', path);
    return res.json();
  } finally { clearApiCache(); }
}

export async function apiPatch(path: string, body: unknown) {
  try {
    const res = await fetch(`${API_URL}${path}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
      body: JSON.stringify(body),
    });
    if (!res.ok) await fail(res, 'PATCH', path);
    return res.json();
  } finally { clearApiCache(); }
}

export async function apiPut(path: string, body: unknown) {
  try {
    const res = await fetch(`${API_URL}${path}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
      body: JSON.stringify(body),
    });
    if (!res.ok) await fail(res, 'PUT', path);
    return res.json();
  } finally { clearApiCache(); }
}

export async function apiDelete(path: string) {
  try {
    const res = await fetch(`${API_URL}${path}`, { method: 'DELETE', headers: await authHeader() });
    if (!res.ok) await fail(res, 'DELETE', path);
    return res.json();
  } finally { clearApiCache(); }
}

export async function apiDownload(path: string, filename: string) {
  const res = await fetch(`${API_URL}${path}`, { headers: await authHeader() });
  if (!res.ok) await fail(res, 'GET', path);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
// Sends a file's text as-is (e.g. a CSV import), not wrapped in JSON.
export async function apiPostText(path: string, text: string, contentType = 'text/csv') {
  try {
    const res = await fetch(`${API_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': contentType, ...(await authHeader()) },
      body: text,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `POST ${path} failed: ${res.status}`);
    return body;
  } finally { clearApiCache(); }
}