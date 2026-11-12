import { googleFetch, parseGoogle } from './google';

// THE ONLY PLACE IN THIS APP THAT SENDS AN EMAIL.
// Radar's Gmail connections are for reading and for making drafts that a person sends themselves (lib/gmail/google.ts says so, and nothing in it sends).
// This one small function is used by two files only: lib/alerts.ts, for the alert emails a manager has switched on in Settings (sent from the company mailbox to the
// addresses a manager typed in Settings), and lib/emailSend.ts, for an email a rep has written, reviewed and pressed Send on, from that rep's own Gmail (after the rep
// switched on "Let Radar send emails I write here"). It is not used by the Gmail routes, the drafts, or anything else.
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

export async function sendRawMessage(accessToken: string, raw: string): Promise<{ id: string; threadId: string }> {
  const b = await parseGoogle(await googleFetch(`${API}/messages/send`, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ raw }) }));
  return { id: String(b.id ?? ''), threadId: String(b.threadId ?? '') };
}
