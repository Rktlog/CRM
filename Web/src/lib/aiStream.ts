import { supabase } from './supabase';

// Talks to POST /ai/chat and reads the answer as it streams in. Mistakes before the answer starts (a limit reached, a
// bad file) come back as an ordinary error with the API's own words.
const API_URL = import.meta.env.VITE_API_URL;

export type MadeFile = { id: string; name: string; size: number };
export type ChatEvent =
  | { type: 'status'; text: string }
  | { type: 'text'; delta: string }
  | { type: 'reset' }
  | { type: 'done'; reply: string; tools: string[]; files: MadeFile[]; usage: { inputTokens: number; outputTokens: number; calls: number } }
  | { type: 'error'; error: string };
export type SendMessage = { role: 'user' | 'assistant'; content: string; attachments?: { name: string; type: string; data: string }[] };

// Splits what has arrived into whole events and whatever is left over (an event cut in half waits for the next chunk).
export function parseSse(buffer: string): { events: ChatEvent[]; rest: string } {
  const events: ChatEvent[] = [];
  let rest = buffer, i: number;
  while ((i = rest.indexOf('\n\n')) >= 0) {
    const block = rest.slice(0, i); rest = rest.slice(i + 2);
    const data = block.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6)).join('');
    if (data) { try { events.push(JSON.parse(data)); } catch { /* a broken event is skipped */ } }
  }
  return { events, rest };
}

export async function readStream(res: Response, onEvent: (e: ChatEvent) => void): Promise<void> {
  const reader = res.body!.getReader(), dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const p = parseSse(buf); buf = p.rest; p.events.forEach(onEvent);
  }
  const tail = parseSse(buf + '\n\n'); tail.events.forEach(onEvent);
}

export async function streamChat(messages: SendMessage[], o: { signal?: AbortSignal; onEvent: (e: ChatEvent) => void }): Promise<void> {
  const { data } = await supabase.auth.getSession();
  const headers: Record<string, string> = { 'Content-Type': 'text/plain' };
  if (data.session?.access_token) headers.Authorization = `Bearer ${data.session.access_token}`;
  const res = await fetch(`${API_URL}/ai/chat`, { method: 'POST', headers, body: JSON.stringify({ messages }), signal: o.signal });
  if (!res.ok || !(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    let message = `The assistant is not available (${res.status})`;
    try { const b = await res.json(); if (typeof b?.error === 'string') message = b.error; } catch { /* keep the default */ }
    throw new Error(message);
  }
  await readStream(res, o.onEvent);
}