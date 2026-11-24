// Tests that a payment reminder draft carries the email it answers underneath it, the way Gmail does when you press Reply
// ("On Mon, Nov 16, 2026 at 11:01 AM Name <address> wrote:"), and that this never stops the reminder from being made.
// No database and no internet: Gmail is a stand-in. All names and addresses are made up.
// Run:  npx tsx scripts/test-followup-quote-copy.ts
import { GoogleApiError, MAX_QUOTED_BYTES, buildRawMessage, createDraft, getMessageBody, getThreadMeta, innerHtml, searchThreadIds, setFetchForTests } from '../src/lib/gmail/google';
import { attributionLine, findReplyTarget, makeReminderDraft, type LookupDeps, type ReplyQuery, type ReplyTarget } from '../src/lib/gmail/threadReply';

let pass = 0, fail = 0;
const ok = (name: string, cond: unknown, extra = '') => { if (cond) { pass++; console.log('PASS  ' + name); } else { fail++; console.log('FAIL  ' + name + (extra ? '  ' + extra : '')); } };
const eq = (name: string, got: unknown, want: unknown) => ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} wanted ${JSON.stringify(want)}`);
const throws = async (name: string, f: () => unknown, part: string) => { try { await f(); ok(name, false, 'did not throw'); } catch (e) { ok(name, String((e as Error).message).includes(part), String((e as Error).message)); } };
const decode = (raw: string) => Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
const headersOf = (raw: string): string[] => decode(raw).split('\r\n\r\n')[0]!.replace(/\r\n /g, ' ').split('\r\n');
// The two versions (plain text, HTML) of a multipart email, decoded. Email lines end in \r\n; they are read back as \n.
const partsOf = (raw: string) => raw.split(/\r\n--rr_[0-9a-f]+/).slice(1, 3).map(p => Buffer.from(p.split('\r\n\r\n')[1]!.replace(/\r\n/g, ''), 'base64').toString('utf8').replace(/\r\n/g, '\n'));

type Call = { method: string; url: string; body?: string };
let calls: Call[] = [];
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
function fakeGmail(handler: (c: Call) => Response) { calls = []; setFetchForTests((async (url: any, init: any) => { const c = { method: String(init?.method ?? 'GET'), url: String(url), body: init?.body ? String(init.body) : undefined }; calls.push(c); return handler(c); }) as typeof fetch); }

const SENDER = 'Sales Team <sales@wholesaler.test>';
const CUSTOMER = 'pat@shop.test';
const Q: ReplyQuery = { repId: 'rep1', accountId: 'acc1', number: 'SQ10001', addresses: [CUSTOMER] };
const input = { to: CUSTOMER, subject: 'Friendly Reminder: Payment Due for Sales Quote SQ10001', body: 'Hi Pat', ...Q };
const target: ReplyTarget = { threadId: 't1', subject: 'Re: Sales Quote SQ10001', inReplyTo: '<m2@mail.test>', references: '<m1@mail.test> <m2@mail.test>', lastFrom: 'customer', found: 'log',
  answers: { gmailId: 'm2', date: 'Mon, 16 Nov 2026 03:01:54 +0000', from: `Pat <${CUSTOMER}>` } };

async function main() {
  // ===== 1. the whole job, with the real Gmail helpers =====
  console.log('--- 1. end to end: a reply with the quote email underneath');
  const quoteHtml = '<html><head><style>p{}</style></head><body><div dir="ltr">Hi Pat,<br>Please see attached your sales quote.</div></body></html>';
  fakeGmail((c) => {
    if (c.method === 'POST' && c.url.endsWith('/drafts')) return reply(200, { id: 'd9', message: { id: 'g9', threadId: 't1' } });
    if (c.url.includes('/threads/t1')) return reply(200, { id: 't1', messages: [{ id: 'm1', labelIds: ['SENT'], internalDate: '1000', payload: { headers: [
      { name: 'Message-ID', value: '<m1@mail.test>' }, { name: 'Subject', value: 'Sales Quote SQ10001' }, { name: 'From', value: SENDER }, { name: 'To', value: CUSTOMER }, { name: 'Date', value: 'Mon, 16 Nov 2026 03:01:54 +0000' }] } }] });
    if (c.url.includes('/messages/m1?format=full')) return reply(200, { id: 'm1', payload: { mimeType: 'multipart/mixed', parts: [
      { mimeType: 'multipart/alternative', parts: [
        { mimeType: 'text/plain', body: { data: Buffer.from('Hi Pat,\nPlease see attached your sales quote.').toString('base64url') } },
        { mimeType: 'text/html', body: { data: Buffer.from(quoteHtml).toString('base64url') } }] },
      { mimeType: 'application/pdf', filename: 'SaleQuote-SQ10001.pdf', body: { attachmentId: 'att1' } }] } });
    if (c.url.includes('/messages?')) return reply(200, { messages: [{ id: 'm1', threadId: 't1' }] });
    return reply(404, { error: { message: 'unexpected call' } });
  });
  const real: LookupDeps = { logThreads: async () => [], searchThreads: (t, n) => searchThreadIds(t, `"${n}" -label:private`, 10), getThread: getThreadMeta };
  const end = await makeReminderDraft({ createDraft, findReplyTarget: (t, q) => findReplyTarget(real, t, q), getBody: getMessageBody }, 'tok', input);
  ok('a threaded draft is made', end.threaded && end.threadId === 't1');
  const writes = calls.filter(c => c.method !== 'GET');
  eq('the only write is one POST to /drafts', writes.map(c => `${c.method} ${c.url.split('/v1/users/me')[1]}`), ['POST /drafts']);
  ok('no call goes to anything that sends', !calls.some(c => /send/i.test(c.url)));
  eq('the only email read in full is the one being answered', calls.filter(c => /format=(full|raw)/.test(c.url)).map(c => c.url.split('/v1/users/me')[1]), ['/messages/m1?format=full']);
  ok('no attachment is downloaded', !calls.some(c => /attachments/.test(c.url)));
  const sent = decode(JSON.parse(writes[0]!.body!).message.raw);
  const [txt, html] = partsOf(sent);
  ok('the draft has a plain-text and an HTML version', /Content-Type: multipart\/alternative; boundary="rr_[0-9a-f]+"/.test(sent) && /text\/plain/.test(sent) && /text\/html/.test(sent));
  ok('the reply headers are still there', /In-Reply-To: <m1@mail.test>/.test(sent) && /Subject: Re: Sales Quote SQ10001/.test(sent));
  ok('plain text: the reminder, then the "wrote:" line, then the quote with > in front',
    txt!.startsWith(`Hi Pat\n\nOn Mon, Nov 16, 2026 at 11:01 AM ${SENDER} wrote:\n\n> Hi Pat,\n> Please see attached your sales quote.`), JSON.stringify(txt));
  ok('HTML: the reminder, then Gmail\'s own quote layout holding the original',
    html!.startsWith('<div dir="ltr">Hi Pat</div><br><div class="gmail_quote gmail_quote_container">') && html!.includes('<blockquote class="gmail_quote"') && html!.includes('Please see attached your sales quote.</div></blockquote>'), JSON.stringify(html));
  ok('HTML: the original\'s <html>, <head> and <body> wrappers are taken off', !/<html|<head|<body|<style/i.test(html!));
  ok('HTML: the address in the "wrote:" line is a mail link, like Gmail', html!.includes('&lt;<a href="mailto:sales@wholesaler.test">sales@wholesaler.test</a>&gt; wrote:'));
  setFetchForTests(null);

  // ===== 2. the "wrote:" line =====
  console.log('--- 2. the "wrote:" line');
  eq('Perth time, worded like Gmail', attributionLine('Mon, 16 Nov 2026 03:01:54 +0000', SENDER), `On Mon, Nov 16, 2026 at 11:01 AM ${SENDER} wrote:`);
  eq('an afternoon time says PM', attributionLine('Tue, 17 Nov 2026 07:05:00 +0000', CUSTOMER), `On Tue, Nov 17, 2026 at 3:05 PM ${CUSTOMER} wrote:`);
  eq('quotes around a display name are dropped', attributionLine('Tue, 17 Nov 2026 07:05:00 +0000', `"Pat Lee" <${CUSTOMER}>`), `On Tue, Nov 17, 2026 at 3:05 PM Pat Lee <${CUSTOMER}> wrote:`);
  eq('no usable date: just "Name wrote:"', attributionLine('', `Pat <${CUSTOMER}>`), `Pat <${CUSTOMER}> wrote:`);
  eq('a line break smuggled into From is flattened', attributionLine('', 'Pat\r\nBcc: x@y.test'), 'Pat Bcc: x@y.test wrote:');
  await throws('a line break in the "wrote:" line is refused outright', () => buildRawMessage({ to: ['a@b.test'], subject: 's', body: 'x', quoted: { attribution: 'a\r\nBcc: x@y.test', html: null, text: 't' } }), 'line break');

  // ===== 3. the copy itself =====
  console.log('--- 3. the copy of the earlier email');
  const noHtml = decode(buildRawMessage({ to: ['a@b.test'], subject: 's', body: 'Hi <you> & co', quoted: { attribution: 'On x wrote:', html: null, text: 'line 1\n\nline <3>' } }));
  const [t2, h2] = partsOf(noHtml);
  eq('an email with no HTML is quoted from its plain text, blank lines kept as >', t2, 'Hi <you> & co\n\nOn x wrote:\n\n> line 1\n>\n> line <3>\n');
  ok('...and in HTML that text is escaped, never treated as code', h2!.includes('line 1<br><br>line &lt;3&gt;') && h2!.startsWith('<div dir="ltr">Hi &lt;you&gt; &amp; co</div>'), JSON.stringify(h2));
  eq('scripts are taken out of a copied email', innerHtml('<body><p>ok</p><script>alert(1)</script></body>'), '<p>ok</p>');
  const plainOnly = headersOf(buildRawMessage({ to: ['a@b.test'], subject: 's', body: 'x' }));
  ok('with nothing to copy, the email is plain text exactly as before', plainOnly.includes('Content-Type: text/plain; charset="UTF-8"') && !plainOnly.some(h => /multipart/.test(h)));

  // ===== 4. it never gets in the way =====
  console.log('--- 4. the reminder is always made');
  const drafts: any[] = [];
  const mk = (getBody: any) => ({ findReplyTarget: async () => target, createDraft: async (_t: string, m: any) => { drafts.push(m); return { id: 'd', messageId: 'g', threadId: 't1' }; }, getBody });
  let r = await makeReminderDraft(mk(async () => { throw new Error('read failed'); }), 'tok', input);
  ok('if the earlier email cannot be read, the reply is still made, just without the copy', r.threaded && drafts.length === 1 && !drafts[0].quoted);
  drafts.length = 0; r = await makeReminderDraft(mk(async () => null), 'tok', input);
  ok('a deleted or too-big earlier email: the reply is still made, without the copy', r.threaded && !drafts[0].quoted);
  drafts.length = 0; r = await makeReminderDraft(mk(async (_t: string, id: string) => ({ html: `<p>${id}</p>`, text: id })), 'tok', input);
  ok('it copies the email the reply answers (the latest one), with that email\'s own date and sender', drafts[0].quoted?.html === '<p>m2</p>' && drafts[0].quoted?.attribution === `On Mon, Nov 16, 2026 at 11:01 AM Pat <${CUSTOMER}> wrote:`);
  drafts.length = 0; r = await makeReminderDraft({ ...mk(async () => ({ html: '<p>x</p>', text: 'x' })), createDraft: async (_t: string, m: any) => { drafts.push(m); if (m.threadId) throw new GoogleApiError('Invalid thread', 400); return { id: 'd', messageId: 'g', threadId: 'n' }; } }, 'tok', input);
  ok('when Gmail refuses the conversation, the fallback new email has no copy', drafts.length === 2 && !drafts[1].quoted && !drafts[1].threadId);
  drafts.length = 0; r = await makeReminderDraft({ findReplyTarget: async () => target, createDraft: async (_t: string, m: any) => { drafts.push(m); return { id: 'd', messageId: 'g', threadId: 't1' }; } }, 'tok', input);
  ok('without a body reader (older callers), it behaves exactly as before', r.threaded && !drafts[0].quoted);

  // ===== 5. reading the one email =====
  console.log('--- 5. getMessageBody');
  fakeGmail(() => reply(200, { id: 'big', payload: { mimeType: 'text/html', body: { data: Buffer.from('x'.repeat(MAX_QUOTED_BYTES + 1)).toString('base64url') } } }));
  eq('an email over the size limit is not copied', await getMessageBody('tok', 'big'), null);
  fakeGmail(() => reply(404, { error: { message: 'Not Found' } }));
  eq('a deleted email gives null', await getMessageBody('tok', 'gone'), null);
  fakeGmail(() => reply(500, { error: { message: 'oops' } }));
  await throws('another Gmail error is raised (and the reminder then goes without the copy)', () => getMessageBody('tok', 'm1'), 'oops');
  fakeGmail(() => reply(200, {})); calls = [];
  eq('an odd email id is not even sent to Gmail', [await getMessageBody('tok', '../x'), calls.length], [null, 0]);
  fakeGmail(() => reply(200, { id: 'p', payload: { mimeType: 'text/plain', body: { data: Buffer.from('just text').toString('base64url') } } }));
  eq('a plain-text-only email comes back as text with no HTML', await getMessageBody('tok', 'p'), { html: null, text: 'just text' });
  setFetchForTests(null);

  console.log(`\npassed: ${pass}   failed: ${fail}`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
