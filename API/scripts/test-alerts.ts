// Tests the plain rules behind the email alerts: which addresses are accepted, and what the new-request email says. No database, no email, no internet.
// Run:  npx tsx scripts/test-alerts.ts
import { HOURLY_LIMIT, isKind, KIND_INFO, KINDS, MAX_ADDRESSES, newRequestMessage, parseAddresses } from '../src/lib/alerts';
import type { RequestItem } from '../src/lib/productRequests';

let pass = 0, fail = 0;
const ok = (n: string, c: unknown, x = '') => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (x ? '  ' + x : '')); } };
const good = (i: unknown) => { const r = parseAddresses(i); return 'addresses' in r ? r.addresses : null; };
const bad = (i: unknown) => { const r = parseAddresses(i); return 'error' in r ? r.error : null; };

console.log('--- addresses');
ok('a list of plain addresses is kept', JSON.stringify(good(['a@x.com', 'b@y.com.au'])) === '["a@x.com","b@y.com.au"]');
ok('text is split on lines, commas, semicolons and spaces', JSON.stringify(good('a@x.com, b@x.com;c@x.com\nd@x.com e@x.com')) === '["a@x.com","b@x.com","c@x.com","d@x.com","e@x.com"]');
ok('they are lower-cased and repeats (in any capitals) are dropped, keeping the first', JSON.stringify(good(['Sean@Example.com', 'sean@example.com', 'SEAN@EXAMPLE.COM', 'b@x.com'])) === '["sean@example.com","b@x.com"]');
ok('blanks are ignored and an empty list is fine (the caller decides if that is allowed)', JSON.stringify(good(['', '  ', 'a@x.com'])) === '["a@x.com"]' && JSON.stringify(good([])) === '[]' && JSON.stringify(good('  ')) === '[]');
ok('things that are not addresses are refused, and the first few are named', /do not look like email addresses: not an address\./.test(bad(['a@x.com', 'not an address']) ?? '') && /do not look like email addresses: nope\./.test(bad(['a@x.com', 'nope']) ?? '') && /: a, b, c and more\./.test(bad(['a', 'b', 'c', 'd']) ?? ''));
ok('names with angle brackets, quotes, brackets or no dot in the domain are refused', ['Sean <s@x.com>', '"s"@x.com', 's@x', '(s)@x.com', 's@@x.com', '@x.com', 's@.com'].every(a => bad([a]) !== null));
ok('a line break inside an address (a way to add an email header) is refused', bad(['a@x.com\r\nBcc: e@x.com']) !== null);
ok('an over-long address is refused', bad(['a'.repeat(250) + '@x.com']) !== null);
ok('20 addresses is fine and 21 is refused', good(Array.from({ length: MAX_ADDRESSES }, (_, i) => `p${i}@x.com`))?.length === 20 && /at most 20/.test(bad(Array.from({ length: 21 }, (_, i) => `p${i}@x.com`)) ?? ''));
ok('repeats do not count towards the 20', good(Array.from({ length: 40 }, (_, i) => `p${i % 5}@x.com`))?.length === 5);
ok('addresses that are not text, or not a list or text, are refused', /must be text/.test(bad([5]) ?? '') && /as a list/.test(bad(null) ?? '') && /as a list/.test(bad({}) ?? ''));

console.log('--- the kinds of alert');
ok('there are four, each with a name and what it is for', KINDS.length === 4 && KINDS.every(k => KIND_INFO[k].label && KIND_INFO[k].about));
ok('isKind accepts those four and nothing else', KINDS.every(isKind) && !isKind('banana') && !isKind(5) && !isKind(null) && !isKind('test'));
ok('no more than 30 alert emails go out in an hour', HOURLY_LIMIT === 30);

console.log('--- the new-request email');
const item = (o: Partial<RequestItem> = {}): RequestItem => ({ id: 'i1', kind: 'existing', sku: 'LSB-219', itemName: 'Bubble Bath 50ml', brand: 'AP Junior', supplier: null, link: null, qty: 60, customer: 'MOOII', neededBy: '2027-01-20', notes: null, status: 'requested', decisionNote: null, requestedBy: { id: 'r1', name: 'Rhonda' }, handledByName: null, createdAt: '2026-11-10T00:00:00Z', seenAt: null, handledAt: null, stock: { available: 12, onOrder: 0 }, supplierAnswer: null, supplierAnswerAt: null, ...o });
const m = newRequestMessage(item());
ok('the subject says what and how many, and starts with [Radar]', m.subject === '[Radar] New product request: Bubble Bath 50ml (60 units)', m.subject);
ok('the body says the product, who asked, how many, for whom, by when and the stock', ['Product: Bubble Bath 50ml (LSB-219, AP Junior)', 'Asked by: Rhonda', 'How many: 60 units', 'For: MOOII', 'Needed by: 2027-01-20', 'Stock now: 12 available, 0 on order'].every(l => m.body.includes(l)));
ok('it tells the reader where to answer it', /Order Forecast & Procurement/.test(m.body) && /Special requests section/.test(m.body));
const n = newRequestMessage(item({ kind: 'new', sku: null, itemName: 'Liewood hat', brand: 'Liewood', qty: null, customer: null, neededBy: null, stock: null, supplier: 'Liewood ApS', link: 'https://x.com/h', notes: 'Asked twice', requestedBy: { id: null, name: null } }));
ok('a new item is marked, and gaps are said plainly', n.body.includes('Product: New item: Liewood hat (Liewood)') && n.body.includes('How many: not given') && n.body.includes('For: no store given') && n.body.includes('Needed by: no date given') && n.body.includes('Asked by: someone who has left') && !n.body.includes('Stock now'));
ok('the supplier, link and notes appear when given, and the subject has no quantity when none was given', n.body.includes('Supplier suggested: Liewood ApS') && n.body.includes('Link: https://x.com/h') && n.body.includes('Notes:\nAsked twice') && n.subject === '[Radar] New product request: Liewood hat');
const evil = newRequestMessage(item({ itemName: 'Hat\r\nBcc: x@y.com\u0007 ' + 'z'.repeat(200) }));
ok('a product name with line breaks, control characters or a huge length cannot break the subject', !/[\r\n\u0007]/.test(evil.subject) && evil.subject.length < 130, JSON.stringify(evil.subject));
console.log(`\npassed: ${pass}   failed: ${fail}`); process.exit(fail ? 1 : 0);
