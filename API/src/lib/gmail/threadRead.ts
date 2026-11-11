import { GoogleApiError, googleFetch, parseGoogle } from './google';

// Reads ONE email thread, and only its labels, times and senders: never any text. Reading only.
// Used for the supplier emails Radar made a draft of, to see whether the draft was sent and whether someone replied.
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
export type ThreadMessage = { id: string; labelIds: string[]; internalDate: number; from: string | null };

/** The plain address in a header like `Anna <anna@liewood.com>`, lower case, or null. */
export const addressOf = (v: unknown): string | null => { const m = String(v ?? '').match(/[^\s<>"',;()]+@[^\s<>"',;()]+\.[^\s<>"',;()]+/); return m ? m[0].toLowerCase() : null; };

/** The messages in a thread, oldest first. null if the thread no longer exists (the draft was deleted). */
export async function getThreadMessages(accessToken: string, threadId: string): Promise<ThreadMessage[] | null> {
  try {
    const b = await parseGoogle(await googleFetch(`${API}/threads/${encodeURIComponent(threadId)}?format=metadata&metadataHeaders=From`, { headers: { Authorization: `Bearer ${accessToken}` } }));
    const msgs: ThreadMessage[] = (b.messages ?? []).map((m: any) => ({
      id: String(m.id), labelIds: Array.isArray(m.labelIds) ? m.labelIds.map(String) : [], internalDate: Number(m.internalDate ?? 0),
      from: addressOf((m.payload?.headers ?? []).find((h: any) => String(h?.name).toLowerCase() === 'from')?.value),
    }));
    return msgs.sort((a, c) => a.internalDate - c.internalDate);
  } catch (e) { if (e instanceof GoogleApiError && e.status === 404) return null; throw e; }
}
