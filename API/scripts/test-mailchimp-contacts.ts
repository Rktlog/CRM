// Run: tsx scripts/test-mailchimp-contacts.ts   (no database needed: Mailchimp is faked)
// Checks that bringing a contact list over from Mailchimp only READS, leaves out people who have not confirmed, and builds a CSV the importer understands.
import { audiencePart, listAudiences, setMailchimpForTests } from '../src/lib/mailchimp';
import { parseCsv } from '../src/lib/marketing/audience';

process.env.MAILCHIMP_API_KEY = 'abcdef0123456789-us21';
let fail = 0; const ok = (name: string, cond: boolean, extra = '') => { console.log(`${cond ? 'pass' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); if (!cond) fail++; };

const calls: { url: string; method: string }[] = [];
const people = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ email_address: `person${from + i}@example.com`, status: 'subscribed', merge_fields: { FNAME: `First${from + i}`, LNAME: 'Test', COMPANY: 'Shop, "The Best" & Co' }, tags: [{ name: 'stockist' }, { name: 'vic' }] }));
const members = [
  ...people(3),
  { email_address: 'gone@example.com', status: 'unsubscribed', merge_fields: {}, tags: [] },
  { email_address: 'bounced@example.com', status: 'cleaned', merge_fields: {}, tags: [] },
  { email_address: 'waiting@example.com', status: 'pending', merge_fields: {}, tags: [] },
  { email_address: 'receipts@example.com', status: 'transactional', merge_fields: {}, tags: [] },
];
const json = (b: unknown) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => b }) as unknown as Response;
setMailchimpForTests({
  base: 'https://fake.invalid/3.0',
  fetch: async (url: string, init?: any) => {
    calls.push({ url, method: init?.method ?? 'GET' });
    if (url.includes('/lists?')) return json({ lists: [{ id: 'abc123', name: 'Stockists', stats: { member_count: 7 } }] });
    const off = Number(/offset=(\d+)/.exec(url)?.[1] ?? 0);
    if (url.includes('/lists/b16b16/members')) return json({ total_items: 2500, members: people(1000, off) });
    return json({ total_items: members.length, members });
  },
});

(async () => {
  const a = await listAudiences();
  ok('lists the audiences', a.length === 1 && a[0].name === 'Stockists' && a[0].members === 7);

  const part = await audiencePart('abc123');
  const rows = parseCsv(part.csv);
  ok('reads everyone once', part.read === 7 && part.total === 7 && part.nextOffset === null);
  ok('leaves out pending and transactional', part.skipped === 2 && !part.csv.includes('waiting@') && !part.csv.includes('receipts@'));
  ok('keeps unsubscribed and cleaned, with their status', part.csv.includes('gone@example.com,,,,,unsubscribed') && part.csv.includes('bounced@example.com,,,,,cleaned'));
  ok('header row', rows[0].join('|') === 'Email|First Name|Last Name|Store|Tags|Status');
  ok('names, store and tags come through; a comma and quotes in the store survive', rows[1].join('|') === 'person0@example.com|First0|Test|Shop, "The Best" & Co|stockist;vic|subscribed', rows[1].join('|'));
  ok('one row per person brought in', rows.length === 1 + 5);

  const p1 = await audiencePart('b16b16', 0, 2);
  ok('a big audience is read in slices', p1.read === 2000 && p1.nextOffset === 2000 && p1.total === 2500);
  const p2 = await audiencePart('b16b16', 2000, 2);
  ok('the last slice says it is finished', p2.nextOffset === null);

  let bad = false; try { await audiencePart('x/../y'); } catch { bad = true; }
  ok('an audience id with odd characters is refused', bad);

  ok('every call to Mailchimp was a GET', calls.length > 0 && calls.every(c => c.method === 'GET'), JSON.stringify(calls.filter(c => c.method !== 'GET')));
  console.log(fail ? `\n${fail} FAILED` : '\nall passed'); process.exit(fail ? 1 : 0);
})();
