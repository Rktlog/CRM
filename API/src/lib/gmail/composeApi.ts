import { googleFetch, parseGoogle, GoogleApiError } from './google';

// The three things composing an email needs from Gmail besides sending it: the person's own signature, the headers that make a reply part of its conversation, and saving a draft.
// None of them sends anything. They only use the permission Radar already has for drafts, and reading the signature uses the read permission.
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const auth = (t: string) => ({ headers: { Authorization: `Bearer ${t}` } });
export type SigResult = { status: 'ok' | 'none' | 'needs_permission'; html: string | null };
/** The signature set up in the person's Gmail (the one for the address they are connected as), as HTML with its picture links. */
export async function gmailSignature(accessToken: string, email: string): Promise<SigResult> {
  try {
    const b = await parseGoogle(await googleFetch(`${API}/settings/sendAs`, auth(accessToken)));
    const list: any[] = Array.isArray(b?.sendAs) ? b.sendAs : [];
    const me = list.find(s => String(s?.sendAsEmail ?? '').toLowerCase() === email.toLowerCase()) ?? list.find(s => s?.isPrimary) ?? list[0];
    const html = typeof me?.signature === 'string' ? me.signature.trim() : '';
    return html ? { status: 'ok', html } : { status: 'none', html: null };
  } catch (e) { if (e instanceof GoogleApiError && (e.status === 401 || e.status === 403)) return { status: 'needs_permission', html: null }; throw e; }
}
export type ReplyHeaders = { inReplyTo: string; references: string };
/** What a reply needs from the last message of a conversation. null if the conversation is not in this mailbox. */
export async function replyHeaders(accessToken: string, threadId: string): Promise<ReplyHeaders | null> {
  try {
    const b = await parseGoogle(await googleFetch(`${API}/threads/${encodeURIComponent(threadId)}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References`, auth(accessToken)));
    const msgs: any[] = Array.isArray(b?.messages) ? b.messages : []; const last = msgs[msgs.length - 1];
    const get = (n: string) => String((last?.payload?.headers ?? []).find((h: any) => String(h?.name ?? '').toLowerCase() === n.toLowerCase())?.value ?? '').replace(/[\r\n]+/g, ' ').trim();
    const id = get('Message-ID'); if (!id) return null;
    return { inReplyTo: id, references: `${get('References')} ${id}`.trim().slice(-1500) };
  } catch (e) { if (e instanceof GoogleApiError && e.status === 404) return null; throw e; }
}
/** Saves a ready-made message as a draft in the person's Gmail (never sends it). */
export async function createDraftRaw(accessToken: string, raw: string, threadId?: string | null): Promise<{ id: string; messageId: string; threadId: string }> {
  const b = await parseGoogle(await googleFetch(`${API}/drafts`, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: { raw, ...(threadId ? { threadId } : {}) } }) }));
  return { id: String(b?.id ?? ''), messageId: String(b?.message?.id ?? ''), threadId: String(b?.message?.threadId ?? '') };
}
