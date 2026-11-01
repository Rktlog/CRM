// Tests that a payment reminder draft goes INTO the quote's existing email conversation, safely. No database and no internet: Gmail is a stand-in.
// Run:  npx tsx scripts/test-followup-threading.ts
import { GoogleApiError, buildRawMessage, createDraft, getThreadMeta, searchThreadIds, setFetchForTests, type ThreadMessage } from '../src/lib/gmail/google';
import { findReplyTarget, makeReminderDraft, replySubject, targetFromThread, type LookupDeps, type ReplyQuery, type ReplyTarget } from '../src/lib/gmail/threadReply';

let pass = 0, fail = 0;
const ok = (name: string, cond: unknown, extra = '') => { if (cond) { pass++; console.log('PASS  ' + name); } else { fail++; console.log('FAIL  ' + name + (extra ? '  ' + extra : '')); } };
const eq = (name: string, got: unknown, want: unknown) => ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} wanted ${JSON.stringify(want)}`);
const throws = async (name: string, f: () => unknown, part: string) => { try { await f(); ok(name, false, 'did not throw'); } catch (e) { ok(name, String((e as Error).message).includes(part), String((e as Error).message)); } };
const decode = (raw: string) => Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
const headersOf = (raw: string): string[] => decode(raw).split('\r\n\r\n')[0]!.replace(/\r\n /g, ' ').split('\r\n');

// ---------- a stand-in for Gmail that remembers every call ----------
type Call = { method: string; url: string; body?: string };
let calls: Call[] = [];
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
function fakeGmail(handler: (c: Call) => Response) { calls = []; setFetchForTests((async (url: any, init: any) => { const c = { method: String(init?.method ?? 'GET'), url: String(url), body: init?.body ? String(init.body) : undefined }; calls.push(c); return handler(c); }) as typeof fetch); }

const CUST = ['pat@shop.com.au'];
const msg = (id: string, o: { from: string; to?: string; t: number; mid?: string | null; refs?: string; subject?: string; labels?: string[]; cc?: string }): ThreadMessage => ({
  id, labelIds: o.labels ?? [], internalDate: String(o.t),
  headers: { from: o.from, to: o.to ?? '', ...(o.cc ? { cc: o.cc } : {}), subject: o.subject ?? 'Sales Quote SQ36721 from Rhino Rhino', ...(o.mid === null ? {} : { 'message-id': o.mid ?? `<${id}@mail.test>` }), ...(o.refs ? { references: o.refs } : {}) },
});
const quote = msg('m1', { from: 'sales@rhinorhino.com.au', to: 'Pat <Pat@Shop.com.au>', t: 1000 });
const lookup = (o: Partial<LookupDeps> & { threads?: Record<string, ThreadMessage[] | null | 'throw'> } = {}): { deps: LookupDeps; log: string[] } => {
  const log: string[] = [];
  return { log, deps: {
    logThreads: o.logThreads ?? (async () => { log.push('log'); return []; }),
    searchThreads: o.searchThreads ?? (async () => { log.push('search'); return []; }),
    getThread: o.getThread ?? (async (_t, id) => { log.push('get:' + id); const v = o.threads?.[id]; if (v === 'throw') throw new Error('boom'); return v ?? null; }),
  } };
};
const Q: ReplyQuery = { repId: 'rep1', accountId: 'acc1', number: 'SQ36721', addresses: CUST };

async function main() {
  // ===== 1. the email itself =====
  console.log('--- 1. the raw email');
  const plain = headersOf(buildRawMessage({ to: ['pat@shop.com.au'], subject: 'Friendly Reminder', body: 'Hi' }));
  ok('a new email has no reply headers', !plain.some(h => /^(In-Reply-To|References):/i.test(h)));
  const rep = headersOf(buildRawMessage({ to: ['pat@shop.com.au'], subject: 'Re: Sales Quote SQ36721', body: 'Hi', inReplyTo: '<m2@mail.test>', references: '<m0@mail.test> <m1@mail.test> <m2@mail.test>', threadId: '18c3fa2b' }));
  ok('a reply carries In-Reply-To', rep.includes('In-Reply-To: <m2@mail.test>'));
  ok('a reply carries every id in References, in order', rep.includes('References: <m0@mail.test> <m1@mail.test> <m2@mail.test>'));
  ok('the subject stays a plain Re: subject', rep.includes('Subject: Re: Sales Quote SQ36721'));
  ok('the reply headers come before MIME-Version', rep.indexOf('In-Reply-To: <m2@mail.test>') < rep.indexOf('MIME-Version: 1.0'));
  await throws('a line break in In-Reply-To is refused', () => buildRawMessage({ to: ['a@b.com'], subject: 's', body: 'x', inReplyTo: '<a@b>\r\nBcc: x@y.com' }), 'reply headers');
  await throws('a header smuggled into References is refused', () => buildRawMessage({ to: ['a@b.com'], subject: 's', body: 'x', inReplyTo: '<a@b>', references: '<a@b>\r\nBcc: x@y.com' }), 'reply headers');
  await throws('a References entry that is not <id> is refused', () => buildRawMessage({ to: ['a@b.com'], subject: 's', body: 'x', inReplyTo: '<a@b>', references: '<a@b> junk' }), 'reply headers');
  await throws('more than 30 References are refused', () => buildRawMessage({ to: ['a@b.com'], subject: 's', body: 'x', inReplyTo: '<a@b>', references: Array.from({ length: 31 }, (_, i) => `<${i}@x>`).join(' ') }), 'reply headers');
  await throws('a conversation id with odd characters is refused', () => buildRawMessage({ to: ['a@b.com'], subject: 's', body: 'x', threadId: '../../me' }), 'conversation id');

  // ===== 2. making the draft =====
  console.log('--- 2. createDraft');
  fakeGmail(() => reply(200, { id: 'd1', message: { id: 'gm1', threadId: '18c3fa2b' } }));
  const made = await createDraft('tok', { to: ['pat@shop.com.au'], subject: 'Re: x', body: 'Hi', threadId: '18c3fa2b', inReplyTo: '<m1@mail.test>', references: '<m1@mail.test>' });
  eq('the draft ids come back', made, { id: 'd1', messageId: 'gm1', threadId: '18c3fa2b' });
  eq('one call, a POST to /drafts', calls.map(c => `${c.method} ${c.url.replace('https://gmail.googleapis.com/gmail/v1/users/me', '')}`), ['POST /drafts']);
  ok('the conversation id is sent with the draft', JSON.parse(calls[0]!.body!).message.threadId === '18c3fa2b');
  fakeGmail(() => reply(200, { id: 'd2', message: { id: 'gm2', threadId: 'zz' } }));
  await createDraft('tok', { to: ['pat@shop.com.au'], subject: 'x', body: 'Hi' });
  ok('a new email sends no conversation id', !('threadId' in JSON.parse(calls[0]!.body!).message));

  // ===== 3. reading a conversation =====
  console.log('--- 3. reading conversations (headers only)');
  fakeGmail(() => reply(200, { id: 't1', messages: [{ id: 'm1', labelIds: ['SENT'], internalDate: '1000', payload: { headers: [{ name: 'Message-ID', value: '<m1@mail.test>' }, { name: 'Subject', value: 'Sales Quote SQ36721' }, { name: 'From', value: 'sales@rhinorhino.com.au' }, { name: 'To', value: 'Pat <pat@shop.com.au>' }] } }, { id: 'm2', internalDate: '2000', payload: { headers: [{ name: 'FROM', value: 'pat@shop.com.au' }] } }] }));
  const th = await getThreadMeta('tok', 't1');
  eq('two emails read', th?.map(m => m.id), ['m1', 'm2']);
  ok('header names are lower-cased', th?.[0]?.headers['message-id'] === '<m1@mail.test>' && th?.[1]?.headers['from'] === 'pat@shop.com.au');
  ok('labels default to none', Array.isArray(th?.[1]?.labelIds) && th![1]!.labelIds.length === 0);
  ok('only headers are asked for (metadata), never the body', /format=metadata/.test(calls[0]!.url) && !/format=(full|raw)/.test(calls[0]!.url) && /metadataHeaders=Message-ID/.test(calls[0]!.url));
  fakeGmail(() => reply(404, { error: { message: 'Not Found' } }));
  eq('a deleted conversation is null', await getThreadMeta('tok', 't9'), null);
  fakeGmail(() => reply(500, { error: { message: 'oops' } }));
  await throws('a Gmail error other than 404 is raised', () => getThreadMeta('tok', 't9'), 'oops');
  fakeGmail(() => reply(200, {})); calls = [];
  eq('an odd conversation id is not even sent to Gmail', [await getThreadMeta('tok', '../x'), calls.length], [null, 0]);
  fakeGmail(() => reply(200, { messages: [{ id: 'a', threadId: 't1' }, { id: 'b', threadId: 't1' }, { id: 'c', threadId: 't2' }] }));
  eq('a search returns each conversation once, in order', await searchThreadIds('tok', '"SQ36721" -label:private', 10), ['t1', 't2']);
  ok('the search asks for ten, leaves out spam and trash', /maxResults=10/.test(calls[0]!.url) && /includeSpamTrash=false/.test(calls[0]!.url) && /SQ36721/.test(decodeURIComponent(calls[0]!.url)));
  fakeGmail(() => reply(200, {}));
  eq('no matches is an empty list', await searchThreadIds('tok', 'x'), []);

  // ===== 4. choosing what to reply to =====
  console.log('--- 4. choosing the conversation');
  const custReply = msg('m2', { from: 'Pat <pat@shop.com.au>', to: 'sales@rhinorhino.com.au', t: 2000, refs: '<m1@mail.test>', subject: 'RE: Sales Quote SQ36721 from Rhino Rhino' });
  let t = targetFromThread('t1', [quote, custReply], new Set(CUST))!;
  eq('replies to the LATEST email', t.inReplyTo, '<m2@mail.test>');
  eq('References: earlier ids plus the latest', t.references, '<m1@mail.test> <m2@mail.test>');
  eq('the subject is the conversation\'s own, with a single Re:', t.subject, 'Re: Sales Quote SQ36721 from Rhino Rhino');
  eq('the customer wrote last', t.lastFrom, 'customer');
  eq('we wrote last when only the quote was sent', targetFromThread('t1', [quote], new Set(CUST))?.lastFrom, 'us');
  eq('a customer address matches whatever its case or display name', targetFromThread('t1', [msg('m1', { from: 'sales@rhinorhino.com.au', to: 'PAT <PAT@SHOP.COM.AU>', t: 1 })], new Set(CUST))?.threadId, 't1');
  eq('a customer on Cc counts', targetFromThread('t1', [msg('m1', { from: 'sales@rhinorhino.com.au', to: 'x@y.com', cc: 'Pat <pat@shop.com.au>', t: 1 })], new Set(CUST))?.threadId, 't1');
  eq('a conversation about somebody else is never used', targetFromThread('t1', [msg('m1', { from: 'sales@rhinorhino.com.au', to: 'other@elsewhere.com', t: 1 })], new Set(CUST)), null);
  eq('an unsent draft is not replied to: the real last email is', targetFromThread('t1', [quote, msg('md', { from: 'sales@rhinorhino.com.au', to: 'pat@shop.com.au', t: 3000, labels: ['DRAFT'] })], new Set(CUST))?.inReplyTo, '<m1@mail.test>');
  eq('a conversation of only drafts is not used', targetFromThread('t1', [msg('md', { from: 'sales@rhinorhino.com.au', to: 'pat@shop.com.au', t: 3000, labels: ['DRAFT'] })], new Set(CUST)), null);
  eq('trash and spam are ignored', targetFromThread('t1', [msg('m1', { from: 'a@b.com', to: 'pat@shop.com.au', t: 1, labels: ['TRASH'] })], new Set(CUST)), null);
  eq('the last email without a Message-ID is skipped, the one before is used', targetFromThread('t1', [quote, msg('m2', { from: 'pat@shop.com.au', t: 2000, mid: null })], new Set(CUST))?.inReplyTo, '<m1@mail.test>');
  eq('no Message-ID anywhere means no reply', targetFromThread('t1', [msg('m1', { from: 'sales@rhinorhino.com.au', to: 'pat@shop.com.au', t: 1, mid: null })], new Set(CUST)), null);
  eq('a Message-ID that is not <id> is not trusted', targetFromThread('t1', [msg('m1', { from: 'sales@rhinorhino.com.au', to: 'pat@shop.com.au', t: 1, mid: 'abc@x' })], new Set(CUST)), null);
  const longRefs = Array.from({ length: 20 }, (_, i) => `<r${i}@x>`).join(' ');
  const longT = targetFromThread('t1', [msg('m9', { from: 'pat@shop.com.au', t: 9, refs: longRefs })], new Set(CUST))!;
  eq('a very long chain keeps the first id and the latest eleven', [longT.references.split(' ').length, longT.references.split(' ')[0], longT.references.split(' ').at(-1)], [12, '<r0@x>', '<m9@mail.test>']);
  eq('Re:, RE: and Fwd: are all stripped before one Re: is added', [replySubject('Re: RE: Fwd: Hello'), replySubject('Hello'), replySubject('  '), replySubject(undefined)], ['Re: Hello', 'Re: Hello', null, null]);
  eq('the subject comes from the FIRST email, not a changed later one', targetFromThread('t1', [msg('m1', { from: 'sales@rhinorhino.com.au', to: 'pat@shop.com.au', t: 1, subject: 'Sales Quote SQ36721' }), msg('m2', { from: 'pat@shop.com.au', t: 2, subject: 'Re: Something else' })], new Set(CUST))?.subject, 'Re: Sales Quote SQ36721');

  // ===== 5. looking for it =====
  console.log('--- 5. finding the conversation');
  let l = lookup({ logThreads: async () => ['t1'], threads: { t1: [quote, custReply] } });
  let f = await findReplyTarget(l.deps, 'tok', Q);
  eq('found in the saved emails first', [f?.threadId, f?.found], ['t1', 'log']);
  ok('the Gmail search is not used when the saved emails answer it', !l.log.includes('search'));
  l = lookup({ searchThreads: async () => ['t7'], threads: { t7: [quote] } });
  f = await findReplyTarget(l.deps, 'tok', Q);
  eq('otherwise found by a Gmail search', [f?.threadId, f?.found], ['t7', 'search']);
  l = lookup({ logThreads: async () => ['t1'], searchThreads: async () => ['t7'], threads: { t1: [msg('m1', { from: 'sales@rhinorhino.com.au', to: 'other@elsewhere.com', t: 1 })], t7: [quote] } });
  f = await findReplyTarget(l.deps, 'tok', Q);
  eq('a saved conversation about someone else is skipped, the search is tried', [f?.threadId, f?.found], ['t7', 'search']);
  l = lookup({ logThreads: async () => ['t1', 't2'], threads: { t1: 'throw', t2: [quote] } });
  eq('a conversation Gmail cannot read is skipped, the next is used', (await findReplyTarget(l.deps, 'tok', Q))?.threadId, 't2');
  l = lookup({ logThreads: async () => ['t1'], searchThreads: async () => ['t2'], threads: { t1: 'throw', t2: 'throw' } });
  eq('everything failing gives null, not an error', await findReplyTarget(l.deps, 'tok', Q), null);
  l = lookup({ logThreads: async () => { throw new Error('db down'); }, searchThreads: async () => ['t7'], threads: { t7: [quote] } });
  eq('if the saved-email lookup fails the search still runs', (await findReplyTarget(l.deps, 'tok', Q))?.threadId, 't7');
  l = lookup({ searchThreads: async () => { throw new Error('quota'); } });
  eq('if the search fails the answer is null', await findReplyTarget(l.deps, 'tok', Q), null);
  l = lookup(); eq('no customer address means no lookup at all', [await findReplyTarget(l.deps, 'tok', { ...Q, addresses: [] }), l.log.length], [null, 0]);
  l = lookup({ logThreads: async () => ['a', 'b', 'c'], searchThreads: async () => ['d', 'e', 'f'], threads: Object.fromEntries('abcdef'.split('').map(k => [k, [msg('m', { from: 'x@y.com', to: 'z@y.com', t: 1 })]])) });
  await findReplyTarget(l.deps, 'tok', Q);
  eq('at most 4 conversations are read for one quote', l.log.filter(x => x.startsWith('get:')).length, 4);
  l = lookup({ logThreads: async () => ['t1', 't1'], searchThreads: async () => ['t1'], threads: { t1: [msg('m', { from: 'x@y.com', to: 'z@y.com', t: 1 })] } });
  await findReplyTarget(l.deps, 'tok', Q);
  eq('the same conversation is never read twice', l.log.filter(x => x === 'get:t1').length, 1);

  // ===== 6. making the reminder draft =====
  console.log('--- 6. the reminder draft');
  const target: ReplyTarget = { threadId: 't1', subject: 'Re: Sales Quote SQ36721', inReplyTo: '<m2@mail.test>', references: '<m1@mail.test> <m2@mail.test>', lastFrom: 'customer', found: 'log' };
  const input = { to: 'pat@shop.com.au', subject: 'Friendly Reminder: Payment Due for Sales Quote SQ36721', body: 'Hi Pat', ...Q };
  const drafts: any[] = [];
  const mk = (over: { find?: () => Promise<ReplyTarget | null>; create?: (m: any) => Promise<any> } = {}) => ({
    findReplyTarget: over.find ?? (async () => target),
    createDraft: async (_t: string, m: any) => { drafts.push(m); return over.create ? over.create(m) : { id: 'd', messageId: 'g', threadId: m.threadId ?? 'newthread' }; },
  });
  drafts.length = 0; let r = await makeReminderDraft(mk(), 'tok', input);
  ok('a found conversation gives a threaded reply', r.threaded && drafts.length === 1 && drafts[0].threadId === 't1' && drafts[0].inReplyTo === '<m2@mail.test>' && drafts[0].subject === 'Re: Sales Quote SQ36721');
  ok('it is still addressed to the customer, and the words are the team\'s template', drafts[0].to[0] === 'pat@shop.com.au' && drafts[0].body === 'Hi Pat' && drafts[0].allowEmptyTo === true);
  drafts.length = 0; r = await makeReminderDraft(mk({ create: async () => ({ id: 'd', messageId: 'g', threadId: 'different' }) }), 'tok', input);
  ok('if Gmail files it elsewhere it is still a draft, but reported as not threaded', !r.threaded && drafts.length === 1);
  drafts.length = 0; r = await makeReminderDraft(mk({ create: async (m) => { if (m.threadId) throw new GoogleApiError('Invalid thread', 400); return { id: 'd', messageId: 'g', threadId: 'n' }; } }), 'tok', input);
  ok('Gmail refusing the conversation (400) falls back to a new email', !r.threaded && drafts.length === 2 && !drafts[1].threadId && !drafts[1].inReplyTo && drafts[1].subject === input.subject);
  drafts.length = 0; r = await makeReminderDraft(mk({ create: async (m) => { if (m.threadId) throw new GoogleApiError('Not found', 404); return { id: 'd', messageId: 'g', threadId: 'n' }; } }), 'tok', input);
  ok('a 404 falls back too', !r.threaded && drafts.length === 2);
  drafts.length = 0; await throws('a server error (500) is NOT retried as a new email', () => makeReminderDraft(mk({ create: async () => { throw new GoogleApiError('boom', 500); } }), 'tok', input), 'boom');
  ok('only one attempt was made', drafts.length === 1);
  drafts.length = 0; await throws('a network error is not retried either', () => makeReminderDraft(mk({ create: async () => { throw new Error('socket hang up'); } }), 'tok', input), 'socket');
  ok('so a duplicate draft cannot be made', drafts.length === 1);
  drafts.length = 0; r = await makeReminderDraft(mk({ find: async () => { throw new Error('lookup broke'); } }), 'tok', input);
  ok('a broken lookup still gives a normal new email', !r.threaded && drafts.length === 1 && !drafts[0].threadId && drafts[0].subject === input.subject);
  drafts.length = 0; r = await makeReminderDraft(mk({ find: async () => null }), 'tok', input);
  ok('no conversation found: a new email, exactly as before', !r.threaded && !drafts[0].threadId && !('inReplyTo' in drafts[0]));
  drafts.length = 0; await makeReminderDraft(mk({ find: async () => null }), 'tok', { ...input, to: null });
  eq('no customer address: an empty To, to be filled in by a person', [drafts[0].to, drafts[0].allowEmptyTo], [[], true]);

  // ===== 7. the safety promise =====
  console.log('--- 7. nothing is ever sent, and no email body is ever read');
  fakeGmail((c) => {
    if (c.method === 'POST' && c.url.endsWith('/drafts')) return reply(200, { id: 'd9', message: { id: 'g9', threadId: 't1' } });
    if (c.url.includes('/threads/t1')) return reply(200, { id: 't1', messages: [{ id: 'm1', labelIds: ['SENT'], internalDate: '1000', payload: { headers: [{ name: 'Message-ID', value: '<m1@mail.test>' }, { name: 'Subject', value: 'Sales Quote SQ36721' }, { name: 'From', value: 'sales@rhinorhino.com.au' }, { name: 'To', value: 'pat@shop.com.au' }] } }] });
    if (c.url.includes('/messages?')) return reply(200, { messages: [{ id: 'm1', threadId: 't1' }] });
    return reply(404, { error: { message: 'unexpected call' } });
  });
  const real: LookupDeps = { logThreads: async () => [], searchThreads: (t, n) => searchThreadIds(t, `"${n}" -label:private`, 10), getThread: getThreadMeta };
  const end = await makeReminderDraft({ createDraft, findReplyTarget: (t, q) => findReplyTarget(real, t, q) }, 'tok', input);
  ok('end to end with the real helpers: a threaded draft', end.threaded && end.threadId === 't1');
  const writes = calls.filter(c => c.method !== 'GET');
  eq('the only write is one POST to /drafts', writes.map(c => `${c.method} ${c.url.split('/v1/users/me')[1]}`), ['POST /drafts']);
  ok('no call goes to anything that sends', !calls.some(c => /send/i.test(c.url)));
  ok('no email body is requested (no format=full or raw)', !calls.some(c => /format=(full|raw)/.test(c.url)));
  ok('the search leaves Private conversations out', calls.some(c => /label%3Aprivate|label:private/i.test(decodeURIComponent(c.url).replace(/\+/g, ' '))));
  setFetchForTests(null);

  console.log(`\npassed: ${pass}   failed: ${fail}`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
