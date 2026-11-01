import { GoogleApiError, type DraftInput, type ThreadMessage } from './google';

// A payment reminder should sit in the SAME email conversation as the quote it is about, not start a new one.
//
// How it finds that conversation, in the sales mailbox the reminder is drafted in (a conversation id only means something in its own mailbox):
//   1. the emails the CRM has already saved for this shop that name the quote number (SQ#), newest sent one first;
//   2. otherwise a Gmail search for the quote number, leaving out conversations marked Private.
// It only uses a conversation that really involves THIS customer (one of their addresses is on a From, To, Cc or Reply-To), so a reminder can
// never land in another customer's conversation. If nothing is found, or anything goes wrong, the draft is a new email, as it always was.
// Only email HEADERS are read, never what an email says. Nothing is sent: the one thing written is the draft.

const MSG_ID = /^<[^<>\s]{1,200}>$/;
const NOT_USABLE = ['DRAFT', 'TRASH', 'SPAM'];
const ADDR = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const MAX_CHECKS = 4;          // conversations looked at per quote, so one quote can never cause a flood of Gmail calls

export const addressesIn = (v: string | undefined): string[] => (v ?? '').match(ADDR)?.map(a => a.toLowerCase()) ?? [];

// "Re: Sales Quote SQ36721 ..." from whatever the conversation's own subject is (Gmail only files a draft in a conversation when the subjects match).
export function replySubject(s: string | undefined): string | null {
  const core = String(s ?? '').replace(/[\r\n]+/g, ' ').trim().replace(/^((re|fw|fwd)\s*:\s*)+/i, '').trim().slice(0, 300);
  return core ? `Re: ${core}` : null;
}

export type ReplyTarget = { threadId: string; subject: string; inReplyTo: string; references: string; lastFrom: 'customer' | 'us'; found: 'log' | 'search' };
export type ReplyQuery = { repId: string; accountId: string; number: string; addresses: string[] };
export type LookupDeps = {
  logThreads: (q: { repId: string; accountId: string; number: string }) => Promise<string[]>;   // conversation ids from the saved emails, best first
  searchThreads: (token: string, number: string) => Promise<string[]>;                         // conversation ids from a Gmail search
  getThread: (token: string, threadId: string) => Promise<ThreadMessage[] | null>;
};

// What to answer in one conversation: its latest usable email. null if it is not safe or not possible to reply in it.
export function targetFromThread(threadId: string, msgs: ThreadMessage[], customer: Set<string>): Omit<ReplyTarget, 'found'> | null {
  const usable = msgs.filter(m => !m.labelIds.some(l => NOT_USABLE.includes(l)));
  if (!usable.length) return null;
  const involvesCustomer = usable.some(m => ['from', 'to', 'cc', 'reply-to'].some(h => addressesIn(m.headers[h]).some(a => customer.has(a))));
  if (!involvesCustomer) return null;                                    // never reply into somebody else's conversation
  const byTime = [...usable].sort((a, b) => Number(a.internalDate) - Number(b.internalDate));
  const last = [...byTime].reverse().find(m => MSG_ID.test((m.headers['message-id'] ?? '').trim()));
  if (!last) return null;
  const subject = replySubject(byTime.find(m => (m.headers['subject'] ?? '').trim())?.headers['subject'] ?? last.headers['subject']);
  if (!subject) return null;
  const id = last.headers['message-id']!.trim();
  const chain = [...new Set([...((last.headers['references'] ?? '').match(/<[^<>\s]{1,200}>/g) ?? []), id])];
  const refs = chain.length > 12 ? [chain[0]!, ...chain.slice(-11)] : chain;      // the first and the latest ones are what matters
  const lastFrom = addressesIn(last.headers['from']).some(a => customer.has(a)) ? 'customer' : 'us';
  return { threadId, subject, inReplyTo: id, references: refs.join(' '), lastFrom };
}

// Never throws: a conversation that cannot be found or read simply means "start a new email".
export async function findReplyTarget(deps: LookupDeps, token: string, q: ReplyQuery): Promise<ReplyTarget | null> {
  const customer = new Set(q.addresses.map(a => a.toLowerCase()).filter(Boolean));
  if (!customer.size) return null;
  const tried = new Set<string>(); let checks = 0;
  const attempt = async (ids: string[], found: 'log' | 'search'): Promise<ReplyTarget | null> => {
    for (const id of ids) {
      if (tried.has(id) || checks >= MAX_CHECKS) continue;
      tried.add(id); checks++;
      try { const msgs = await deps.getThread(token, id); const t = msgs ? targetFromThread(id, msgs, customer) : null; if (t) return { ...t, found }; }
      catch { /* a conversation that cannot be read is skipped */ }
    }
    return null;
  };
  let fromLog: string[] = [];
  try { fromLog = await deps.logThreads({ repId: q.repId, accountId: q.accountId, number: q.number }); } catch { /* go on to the search */ }
  const a = await attempt(fromLog, 'log'); if (a) return a;
  let found: string[] = [];
  try { found = await deps.searchThreads(token, q.number); } catch { return null; }
  return attempt(found, 'search');
}

export type DraftDeps = {
  createDraft: (token: string, m: DraftInput) => Promise<{ id: string; messageId: string; threadId: string }>;
  findReplyTarget: (token: string, q: ReplyQuery) => Promise<ReplyTarget | null>;
};
// The one reminder draft for one quote: a reply in its conversation when there is one, otherwise a new email.
export async function makeReminderDraft(d: DraftDeps, token: string, a: { to: string | null; subject: string; body: string } & ReplyQuery): Promise<{ id: string; messageId: string; threadId: string; threaded: boolean }> {
  const base: DraftInput = { to: a.to ? [a.to] : [], subject: a.subject, body: a.body, allowEmptyTo: true };
  let reply: ReplyTarget | null = null;
  try { reply = await d.findReplyTarget(token, { repId: a.repId, accountId: a.accountId, number: a.number, addresses: a.addresses }); } catch { reply = null; }
  if (reply) {
    try {
      const made = await d.createDraft(token, { ...base, subject: reply.subject, threadId: reply.threadId, inReplyTo: reply.inReplyTo, references: reply.references });
      return { ...made, threaded: made.threadId === reply.threadId };
    } catch (e) {
      if (!(e instanceof GoogleApiError) || ![400, 404].includes(e.status)) throw e;   // only "Gmail refused that conversation" falls back; a network error is left to the retry
    }
  }
  return { ...(await d.createDraft(token, base)), threaded: false };
}
