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

export async function apiGet(path: string) {
  const res = await fetch(`${API_URL}${path}`, { headers: await authHeader() });
  if (!res.ok) await fail(res, 'GET', path);
  return res.json();
}

export async function apiPost(path: string, body: unknown) {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify(body),
  });
  if (!res.ok) await fail(res, 'POST', path);
  return res.json();
}

export async function apiPatch(path: string, body: unknown) {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify(body),
  });
  if (!res.ok) await fail(res, 'PATCH', path);
  return res.json();
}

export async function apiPut(path: string, body: unknown) {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify(body),
  });
  if (!res.ok) await fail(res, 'PUT', path);
  return res.json();
}

export async function apiDelete(path: string) {
  const res = await fetch(`${API_URL}${path}`, { method: 'DELETE', headers: await authHeader() });
  if (!res.ok) await fail(res, 'DELETE', path);
  return res.json();
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
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': contentType, ...(await authHeader()) },
    body: text,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `POST ${path} failed: ${res.status}`);
  return body;
}