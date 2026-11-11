// Tests the plain rules for special product requests: what a request may contain and what the ordering team may change. No database, no internet.
// Run:  npx tsx scripts/test-product-requests.ts
import { parseNewRequest, parseUpdate } from '../src/lib/productRequests';

let pass = 0, fail = 0;
const ok = (n: string, c: unknown, x = '') => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (x ? '  ' + x : '')); } };
const TODAY = '2026-11-10';
const good = (b: object) => { const r = parseNewRequest(b, TODAY); return 'ok' in r ? r.ok : null; };
const err = (b: unknown) => { const r = parseNewRequest(b, TODAY); return 'error' in r ? r.error : null; };

console.log('--- a request');
ok('a new product with only a name is fine', good({ kind: 'new', itemName: 'Bucket hat' })?.itemName === 'Bucket hat');
ok('an existing product needs only its SKU (the name comes from the product)', good({ kind: 'existing', sku: 'LSB-219' })?.sku === 'LSB-219');
ok('a new product ignores a SKU, and an existing one keeps it', good({ kind: 'new', itemName: 'Hat', sku: 'X' })?.sku === null && good({ kind: 'existing', sku: ' lsb-219 ' })?.sku === 'lsb-219');
ok('empty strings become nothing', (() => { const g = good({ kind: 'new', itemName: 'Hat', brand: '  ', link: '', notes: '' }); return !!g && g.brand === null && g.link === null && g.notes === null; })());
ok('text is trimmed and control characters are removed', good({ kind: 'new', itemName: '  Ha\u0007t  ' })?.itemName === 'Hat');
ok('new lines in notes are kept', good({ kind: 'new', itemName: 'Hat', notes: 'one\ntwo' })?.notes === 'one\ntwo');
ok('no kind, a made-up kind, or no body is refused', /already sell or a new one/.test(err({ itemName: 'x' }) ?? '') && /already sell or a new one/.test(err({ kind: 'maybe' }) ?? '') && err(null) !== null && err('hello') !== null);
ok('an existing product with no SKU is refused', /Choose the product/.test(err({ kind: 'existing', sku: '  ' }) ?? ''));
ok('a new product needs a real name (2 or more characters)', /Say what the new product is/.test(err({ kind: 'new', itemName: 'x' }) ?? '') && good({ kind: 'new', itemName: 'xy' }) !== null);
ok('fields that are not text are refused', /must be text/.test(err({ kind: 'new', itemName: 5 }) ?? '') && /must be text/.test(err({ kind: 'new', itemName: 'Hat', brand: {} }) ?? ''));
ok('over-long fields are refused (name 200, brand 100, supplier 120, customer 160, notes 1000, link 500)', [['itemName', 201], ['brand', 101], ['supplier', 121], ['customer', 161], ['notes', 1001], ['link', 501]].every(([f, n]) => /too long/.test(err({ kind: 'new', itemName: 'Hat', [f as string]: (f === 'link' ? 'https://a.co/' : '') + 'x'.repeat(n as number) }) ?? '')) && good({ kind: 'new', itemName: 'x'.repeat(200) }) !== null);

console.log('--- the link');
ok('http and https links are fine', good({ kind: 'new', itemName: 'Hat', link: 'http://a.com/x' }) !== null && good({ kind: 'new', itemName: 'Hat', link: 'https://a.com/x?y=1' }) !== null);
ok('anything else is refused (javascript:, data:, ftp:, no scheme, plain words)', ['javascript:alert(1)', 'data:text/html,hi', 'ftp://a.com', 'a.com/x', 'my link'].every(l => /must start with http/.test(err({ kind: 'new', itemName: 'Hat', link: l }) ?? '')));

console.log('--- the quantity');
ok('1 and 100000 are fine, as numbers or as text', [1, 100000, '60'].every(q => good({ kind: 'new', itemName: 'Hat', qty: q }) !== null) && good({ kind: 'new', itemName: 'Hat', qty: '60' })?.qty === 60);
ok('0, 100001, a fraction, text and negatives are refused', [0, 100001, 1.5, 'lots', -3, NaN].every(q => /whole number from 1 to 100000/.test(err({ kind: 'new', itemName: 'Hat', qty: q }) ?? '')));
ok('no quantity is fine', good({ kind: 'new', itemName: 'Hat' })?.qty === null && good({ kind: 'new', itemName: 'Hat', qty: '' })?.qty === null && good({ kind: 'new', itemName: 'Hat', qty: null })?.qty === null);

console.log('--- the needed-by date (today is 10 Nov 2026 in these tests)');
ok('today and later are fine', good({ kind: 'new', itemName: 'Hat', neededBy: TODAY })?.neededBy === TODAY && good({ kind: 'new', itemName: 'Hat', neededBy: '2027-01-20' }) !== null);
ok('yesterday is refused', /in the past/.test(err({ kind: 'new', itemName: 'Hat', neededBy: '2026-11-09' }) ?? ''));
ok('400 days ahead is fine, 401 is not', good({ kind: 'new', itemName: 'Hat', neededBy: '2027-12-15' }) !== null && /more than a year/.test(err({ kind: 'new', itemName: 'Hat', neededBy: '2027-12-16' }) ?? ''));
ok('dates that do not exist, or are not dates, are refused', ['2027-02-30', '2027-13-01', '2027-00-10', '2027-01-32', '2027-01-00', '10/11/2026', 'soon', '2026-1-5'].every(d => /not a real date/.test(err({ kind: 'new', itemName: 'Hat', neededBy: d }) ?? '')));
ok('a leap day is a real day when it is within the year, and 29 February in a normal year is not', (() => { const r = parseNewRequest({ kind: 'new', itemName: 'Hat', neededBy: '2028-02-29' }, '2027-12-01'); return 'ok' in r; })() && /not a real date/.test(err({ kind: 'new', itemName: 'Hat', neededBy: '2027-02-29' }) ?? ''));

console.log('--- what the ordering team may change');
const up = (b: unknown) => { const r = parseUpdate(b); return 'ok' in r ? r.ok : r.error; };
ok('each status the team can set is accepted', ['requested', 'seen', 'asked_supplier', 'supplier_replied', 'ordered', 'declined'].every(s => (up({ status: s }) as { status: string }).status === s));
ok('"cancelled" and made-up statuses are refused', /not a status/.test(String(up({ status: 'cancelled' }))) && /not a status/.test(String(up({ status: 'banana' }))) && /not a status/.test(String(up({ status: 5 }))));
ok('a note on its own, a note with a status, and clearing a note', JSON.stringify(up({ decisionNote: ' Back Friday ' })) === '{"note":"Back Friday"}' && (up({ status: 'ordered', decisionNote: 'Done' }) as { note: string }).note === 'Done' && JSON.stringify(up({ decisionNote: null })) === '{"note":null}' && JSON.stringify(up({ decisionNote: '   ' })) === '{"note":null}');
ok('nothing to change is refused', up({}) === 'Nothing to change.' && up(null) === 'Nothing to change.' && up([]) === 'Nothing to change.');
ok('a note over 1000 characters is refused', /too long/.test(String(up({ decisionNote: 'x'.repeat(1001) }))));
console.log(`\npassed: ${pass}   failed: ${fail}`); process.exit(fail ? 1 : 0);
