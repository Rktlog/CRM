// Tests the plain rules behind trade show orders: totals, discount, stock, reference, the DEAR file, the email and follow-ups. No database, no email.
// Run:  npx tsx scripts/test-tradeshow.ts
import { cleanReference, dearCsv, defaultReference, discountPct, firstFollowUp, followUpsClosed, gstRateFor, holdsStock, incrementProblem, nameKey, orderStage, parseDiscount, parseNewCustomer, phoneKey, salesEmail, stockView, totals } from '../src/lib/tradeshowCore';

let pass = 0, fail = 0;
const ok = (n: string, c: unknown, x = '') => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (x ? '  ' + x : '')); } };
const throws = (f: () => unknown) => { try { f(); return null; } catch (e: any) { return e?.message ?? 'error'; } };
const lines = [{ qty: 3, price: 50 }, { qty: 8, price: 10.5 }, { qty: 2, price: 20 }];

console.log('--- totals');
let t = totals({ lines, discount: null, freight: 25, cardPayment: true, surchargePct: 1.5, gstRate: 0.1 });
ok('goods, freight, 1.5% card surcharge on goods and freight, GST, total', t.goods === 274 && t.surcharge === 4.49 && t.exGst === 303.49 && t.gst === 30.35 && t.total === 333.84, JSON.stringify(t));
t = totals({ lines, discount: { kind: 'amount', value: 27.4 }, freight: 0, cardPayment: false, surchargePct: 1.5, gstRate: 0.1 });
ok('$27.40 off 274 is 10% on every line; no surcharge without a card', t.linePct === 10 && t.goodsAfter === 246.6 && t.surcharge === 0 && t.total === 271.26, JSON.stringify(t));
ok('an odd $ discount rounds to a 2-decimal % (what DEAR takes)', discountPct(274, { kind: 'amount', value: 50 }) === 18.25);
ok('NZ and overseas pay no GST', gstRateFor('NZ') === 0 && gstRateFor('INTL') === 0 && gstRateFor('VIC') === 0.1 && totals({ lines, discount: null, freight: 0, cardPayment: false, surchargePct: null, gstRate: 0 }).gst === 0);
ok('a discount over 100% or over the goods is refused', !!throws(() => parseDiscount('pct', 120, 100)) && !!throws(() => parseDiscount('amount', 101, 100)) && parseDiscount('pct', '', 100) === null && parseDiscount('amount', 0, 100) === null);

console.log('--- stock');
let s = stockView(8, 5, 0, { qty: 24, date: '10 Feb 2027', po: 'PO-00123' }, null);
ok('5 of 8 now, 3 on backorder, with the PO and date', s.canShip === 5 && s.backorder === 3 && s.note === '5 now, 3 on backorder. 24 more coming on PO-00123, due 10 Feb 2027', s.note);
s = stockView(2, 5, 8, null, 'Apr-27');
ok('held by other trade show orders: none free, the DEAR ETA shown', s.free === -3 && s.canShip === 0 && /None free now, 2 on backorder\. ETA Apr-27/.test(s.note), s.note);
ok('plenty: in stock', stockView(2, 100, 0, null, null).note === 'In stock');
ok('pack sizes', incrementProblem(3, 2) === 'Sold in packs of 2' && incrementProblem(4, 2) === null && incrementProblem(3, null) === null);

console.log('--- reference and the DEAR file');
ok('reference: show, date, order number', defaultReference('REED MEL FEB26', '2026-02-01', 'TS-0007') === 'REED MEL FEB26 01/02/2026 TS-0007');
ok('a reference cannot be empty or over 100 characters', !!throws(() => cleanReference('  ')) && !!throws(() => cleanReference('x'.repeat(101))) && cleanReference(' a\n b ') === 'a b');
const csv = dearCsv([{ sku: 'A1', name: 'Lamp, large', comment: 'say "hi"', qty: 3, price: 50 }, { sku: 'B2', name: 'Bank', qty: 8, price: 10.5 }], 10, [{ sku: 'FREIGHT', name: 'Freight', amount: 25 }, { sku: 'CC', name: 'Card', amount: 0 }]);
ok('DEAR file: their header, commas and quotes escaped, the % on each line, freight as a line', csv === 'SKU,Name,Comment,Quantity,Price,Discount\r\nA1,"Lamp, large","say ""hi""",3,50,10\r\nB2,Bank,,8,10.5,10\r\nFREIGHT,Freight,,1,25,0\r\n', JSON.stringify(csv));

console.log('--- where it is and follow-ups');
ok('stages', orderStage('draft', null) === 'draft' && orderStage('sent', null) === 'sent' && orderStage('sent', { number: 'SQ1', status: 'ESTIMATING', invoiced: 0, due: null }) === 'in_dear_quote'
  && orderStage('sent', { number: 'SQ1', status: 'ORDERED', invoiced: 0, due: 100 }) === 'in_dear' && orderStage('sent', { number: 'SQ1', status: 'ORDERED', invoiced: 100, due: 50 }) === 'invoiced'
  && orderStage('sent', { number: 'SQ1', status: 'COMPLETED', invoiced: 100, due: 0 }) === 'paid' && orderStage('sent', { number: 'SQ1', status: 'VOIDED', invoiced: 0, due: 0 }) === 'voided_in_dear' && orderStage('cancelled', null) === 'cancelled');
ok('stock is held until DEAR confirms the order; quotes hold none', holdsStock('order', 'sent') && holdsStock('order', 'in_dear_quote') && !holdsStock('order', 'in_dear') && !holdsStock('quote', 'sent'));
ok('follow-ups stop: a quote once it is a DEAR order, an order once paid', followUpsClosed('quote', 'in_dear') && !followUpsClosed('quote', 'in_dear_quote') && !followUpsClosed('order', 'invoiced') && followUpsClosed('order', 'paid') && followUpsClosed('order', 'cancelled'));
ok('the 1st follow-up is a week later', firstFollowUp('2026-02-01') === '2026-02-08' && firstFollowUp('2026-12-28') === '2027-01-04');

console.log('--- customers');
ok('a new customer needs a name and a state; email checked', !!throws(() => parseNewCustomer({ name: 'A', region: 'VIC' })) && !!throws(() => parseNewCustomer({ name: 'Shop', region: 'Victoria' })) && !!throws(() => parseNewCustomer({ name: 'Shop', region: 'VIC', email: 'nope' })) && parseNewCustomer({ name: ' Shop ', region: 'vic', email: 'A@B.com' }).email === 'a@b.com');
ok('same shop spotted by phone or name', phoneKey('+61 412 345 678') === phoneKey('0412345678') && nameKey('The Little Shop Pty Ltd') === nameKey('little shop'));

console.log('--- the email');
const m = salesEmail({ number: 'TS-0001', kind: 'order', reference: 'REED 01/02/2026 TS-0001', customerPo: '4471', orderDate: '2026-02-01', showName: 'Reed', repName: 'Sam',
  customer: { name: 'Shop', isNew: true, region: 'NSW', contact: 'Amy', email: 'a@b.com', phone: null, address: '1 King St', terms: null },
  lines: [{ sku: 'A1', name: 'Lamp', qty: 3, price: 50, lineTotal: 135, stock: 'In stock' }], totals: totals({ lines: [{ qty: 3, price: 50 }], discount: { kind: 'pct', value: 10 }, freight: 10, cardPayment: false, surchargePct: null, gstRate: 0.1 }), notes: null, version: 2, chargesInFile: false });
ok('subject and body have what sales need', /UPDATED Trade show order TS-0001: Shop/.test(m.subject) && m.body.includes('REFERENCE TO USE: REED 01/02/2026 TS-0001') && m.body.includes("Customer's PO: 4471") && /NEW: not in DEAR yet/.test(m.body) && m.body.includes('A1  Lamp  x3 @ $50.00 less 10% = $135.00') && /Add the freight and surcharge in DEAR/.test(m.body), m.body);

console.log(`\npassed: ${pass}   failed: ${fail}`); process.exit(fail ? 1 : 0);
