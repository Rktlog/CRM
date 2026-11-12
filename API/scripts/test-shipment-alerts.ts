// Tests the plain rules behind the shipment alerts: what the booked and landed emails say, how long lists are cut, and which purchase orders count as open.
// No database, no email, no internet.  Run:  npx tsx scripts/test-shipment-alerts.ts
import { buildBooked, buildLanded, dayLabel, isOpen, MAX_ITEMS_PER_BRAND, MAX_ITEMS_TOTAL, MAX_NAMES, type Context, type Facts, type Item, type PoInfo } from '../src/lib/shipmentAlerts';

let pass = 0, fail = 0;
const ok = (n: string, c: unknown, x = '') => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (x ? '  ' + x : '')); } };
const po: PoInfo = { id: 'p1', number: 'PO1234', supplier: 'Liewood ApS', status: 'ORDERED', receivingStatus: 'NOT RECEIVED', orderDate: new Date(), due: '2026-12-20' };
const item = (sku: string, name: string, brand: string | null, units: number, ordered = units, received = 0): Item => ({ sku, name, brand, units, ordered, received });
const facts = (o: Partial<Facts> = {}): Facts => ({ available: 0, onOrder: 0, wholesale: 12, retail: 25, sold12: 0, customers12: 0, ...o });
const ctx = (f: Record<string, Facts> = {}, waiting: Context['waiting'] = [], brands: Record<string, number> = {}): Context => ({ facts: new Map(Object.entries(f).map(([k, v]) => [k.toUpperCase(), v])), brandCustomers: new Map(Object.entries(brands).map(([k, v]) => [k.toLowerCase(), v])), waiting });

console.log('--- which purchase orders are open (the same rule as the Ordering page)');
ok('ordered, authorised, ordering and part received are open', ['ORDERED', 'AUTHORISED', 'ORDERING'].every(s => isOpen({ status: s, receivingStatus: 'NOT RECEIVED' })) && isOpen({ status: 'ORDERED', receivingStatus: 'PARTIALLY RECEIVED' }));
ok('draft, voided and credited are not open', ['DRAFT', 'VOIDED', 'CREDITED', 'draft', 'voided'].every(s => !isOpen({ status: s, receivingStatus: null })));
ok('fully received, completed and received are not open', !isOpen({ status: 'ORDERED', receivingStatus: 'FULLY RECEIVED' }) && !isOpen({ status: 'COMPLETED', receivingStatus: 'FULLY RECEIVED' }) && !isOpen({ status: 'COMPLETED - PART', receivingStatus: null }) && !isOpen({ status: 'RECEIVED', receivingStatus: null }));
ok('missing statuses do not crash', isOpen({ status: null, receivingStatus: null }));

console.log('--- days');
ok('a day is written the Australian way', dayLabel('2026-12-20') === '20 Dec 2026' && dayLabel('2027-01-05') === '5 Jan 2027');
ok('nothing, rubbish and impossible days give nothing', dayLabel(null) === null && dayLabel('soon') === null && dayLabel('2026-13-40') === null && dayLabel('') === null);

console.log('--- the booked email');
const items = [item('LW-1', 'Mini Hat Blue', 'Liewood', 24), item('LW-2', 'Mini Hat Pink', 'Liewood', 12), item('MG-9', 'Bunny', 'Maileg', 6)];
const c = ctx({ 'LW-1': facts({ sold12: 80, customers12: 3, available: 5 }), 'LW-2': facts({ available: 0 }), 'MG-9': facts({ wholesale: null, retail: 30, sold12: 4, customers12: 2 }) },
  [{ account: 'MOOII', sku: 'LW-1', units: 6 }, { account: 'Toys and Tales', sku: 'LW-1', units: 4 }, { account: 'MOOII', sku: 'LW-2', units: 2 }, { account: 'Somebody Else', sku: 'ZZ-9', units: 99 }], { liewood: 38, maileg: 7 });
const b = buildBooked(po, items, c);
ok('the subject names the brands, the units, the due day and the order', b.subject === '[Radar] Shipment booked: Liewood and Maileg, 42 units due 20 Dec (PO PO1234)', b.subject);
ok('the top says what, which order, from whom, when, and how much', b.body.startsWith('A new shipment has been booked.\n\nPurchase order: PO1234, from Liewood ApS\nDue: 20 Dec 2026\nItems: 3 products, 42 units\n'));
ok('items are grouped by brand, the biggest first, with units and both prices', /LIEWOOD: 2 products, 36 units\n  LW-1  Mini Hat Blue  24 units  \(wholesale \$12\.00, RRP \$25\.00\)\n/.test(b.body) && b.body.indexOf('LW-1') < b.body.indexOf('LW-2') && /MAILEG: 1 product, 6 units\n  MG-9  Bunny  6 units  \(RRP \$30\.00\)/.test(b.body));
ok('a product that has sold is a restock with its sales, one that has not is new', /Restock: 80 sold in the last 12 months to 3 customers\. In stock now: 5\./.test(b.body) && /New: nothing sold in the last 12 months\. In stock now: 0\./.test(b.body));
ok('what customers are owed is shown per product, or "no customers waiting"', /LW-1[^\n]*\n     [^\n]*10 units owed to customers\./.test(b.body) && /MG-9[^\n]*\n     [^\n]*no customers waiting\./.test(b.body));
ok('"who to tell" names the waiting customers (biggest first, only for these items) and counts the brand\'s buyers', /Customers waiting for these items: 2, 12 units: MOOII 8, Toys and Tales 4\n/.test(b.body) && !/Somebody Else/.test(b.body) && /Customers who bought Liewood in the last 12 months: 38/.test(b.body) && /Customers who bought Maileg in the last 12 months: 7/.test(b.body));
ok('with nobody waiting it says so', /No customers are waiting for these items\./.test(buildBooked(po, items, ctx({}, [], {})).body));
ok('with no due date it says so (and the subject has none)', /Due: no arrival date set yet/.test(buildBooked({ ...po, due: null }, items, c).body) && !/due /.test(buildBooked({ ...po, due: null }, items, c).subject));
ok('one brand: the subject names it; three or more: the first two and a count', buildBooked(po, [items[0]!], c).subject.includes('Shipment booked: Liewood, 24 units') && buildBooked(po, [...items, item('X-1', 'x', 'Zed', 1)], c).subject.includes('Liewood, Maileg and 1 more'));
ok('a product with no brand goes under "Other"', /OTHER: 1 product/.test(buildBooked(po, [item('N-1', 'Thing', null, 3)], c).body));
ok('a single unit and a single product are not written as plurals', /Items: 1 product, 1 units|1 product, 1 unit/.test(buildBooked(po, [item('N-1', 'Thing', 'B', 1)], c).body) && /B: 1 product, 1 units/.test(buildBooked(po, [item('N-1', 'Thing', 'B', 1)], c).body));
const nof = buildBooked(po, [item('Q-1', 'No facts', 'B', 5)], ctx());
ok('a product Radar has no facts for still lists, without stock or sales lines inventing numbers', /Q-1  No facts  5 units/.test(nof.body) && !/Restock|New:/.test(nof.body.split('\n').filter(l => l.includes('Q-1') || l.startsWith('     ')).join('\n')));
ok('the money is written with two places and thousands are separated', buildBooked(po, [item('B-1', 'Big', 'B', 12345)], ctx({ 'B-1': facts({ wholesale: 1234.5, retail: 2500 }) })).body.includes('12,345 units  (wholesale $1234.50, RRP $2500.00)'));

console.log('--- long lists are cut');
const many = Array.from({ length: 30 }, (_, i) => item(`A-${String(i).padStart(2, '0')}`, `Alpha ${i}`, 'Alpha', 30 - i)).concat(Array.from({ length: 30 }, (_, i) => item(`B-${String(i).padStart(2, '0')}`, `Beta ${i}`, 'Beta', 30 - i)));
const big = buildBooked(po, many, ctx());
ok(`at most ${MAX_ITEMS_PER_BRAND} products are listed per brand`, (big.body.match(/^  A-\d\d /gm) ?? []).length === MAX_ITEMS_PER_BRAND && (big.body.match(/^  B-\d\d /gm) ?? []).length === MAX_ITEMS_PER_BRAND);
ok('the rest are counted, with their units', /\.\.\.and 18 more products \(\d+ units\)/.test(big.body));
ok('the totals still count everything', /Items: 60 products, \d+ units/.test(big.body) && /ALPHA: 30 products/.test(big.body));
const five = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'].flatMap((br, bi) => Array.from({ length: 15 }, (_, i) => item(`${br.slice(0, 1)}${bi}-${String(i).padStart(2, '0')}`, `${br} ${i}`, br, 15 - i)));
const fiveBody = buildBooked(po, five, ctx()).body;
ok(`with many brands no more than ${MAX_ITEMS_TOTAL} products are listed in total, and the brands left over still say how many there are`, (fiveBody.match(/^  [A-Z]\d-\d\d /gm) ?? []).length === MAX_ITEMS_TOTAL && /EPSILON: 15 products/.test(fiveBody) && /\.\.\.and 15 more products/.test(fiveBody) && /Items: 75 products/.test(fiveBody));
const w = Array.from({ length: 9 }, (_, i) => ({ account: `Shop ${i}`, sku: 'LW-1', units: 9 - i }));
ok(`only the first ${MAX_NAMES} waiting customers are named, with a count of the rest`, new RegExp(`Customers waiting for these items: 9, 45 units: (Shop \\d \\d, ){${MAX_NAMES - 1}}Shop \\d \\d and 3 more`).test(buildBooked(po, [items[0]!], ctx({}, w)).body));

console.log('--- the landed email');
const landed = [item('LW-1', 'Mini Hat Blue', 'Liewood', 20, 24, 20)];
const l = buildLanded(po, landed, ctx({ 'LW-1': facts({ available: 21, onOrder: 4, sold12: 80, customers12: 3 }) }, [{ account: 'MOOII', sku: 'LW-1', units: 6 }], { liewood: 38 }), '2026-11-20');
ok('the subject says it has landed and is now in stock', l.subject === '[Radar] Shipment landed: Liewood, 20 units now in stock (PO PO1234)', l.subject);
ok('the top says what, which order, and the day it was received (and when it was due)', l.body.startsWith('A delivery has landed and the stock is ready to sell.\n\nPurchase order: PO1234, from Liewood ApS\nReceived: 20 Nov 2026 (it was due 20 Dec 2026)\nReceived: 1 product, 20 units\n'));
ok('each product shows what arrived out of what was ordered, and stock now with what is still to come', /LW-1  Mini Hat Blue  20 units received \(24 ordered\)/.test(l.body) && /In stock now: 21 \(4 still to come\)/.test(l.body));
ok('waiting customers are marked as the ones to ship first', /Customers waiting for these items \(ship these first\): 1, 6 units: MOOII 6/.test(l.body));

console.log('--- nothing in a name can break an email');
const evil = buildBooked({ ...po, number: 'PO\r\nBcc: x@y.com', supplier: 'Sup\r\nBcc: z@y.com' }, [item('E\r\n-1', 'Hat\r\nBcc: q@y.com', 'Br\r\nand', 3)], ctx({}, [{ account: 'Shop\r\nBcc: w@y.com', sku: 'E\r\n-1', units: 2 }]));
ok('line breaks and control characters in a number, supplier, brand, product or customer name are flattened', !/[\r\u0007]/.test(evil.subject + evil.body) && !/\nBcc:/.test(evil.subject) && !/[\r\n]/.test(evil.subject));
ok('a very long product name is cut', !buildBooked(po, [item('L-1', 'x'.repeat(500), 'B', 1)], ctx()).body.includes('x'.repeat(100)));
console.log(`\npassed: ${pass}   failed: ${fail}`); process.exit(fail ? 1 : 0);
