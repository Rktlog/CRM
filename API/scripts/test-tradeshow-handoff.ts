// Tests the plain rules behind paying at a trade show: the email wording and the screenshot checks. No database, no email.
// Run:  npx tsx scripts/test-tradeshow-handoff.ts
import { paymentLines, salesEmail, splitColour } from '../src/lib/tradeshowCore';
import { parseProof, PROOF_MAX_BYTES } from '../src/lib/tsHandoff';

let pass = 0, fail = 0;
const ok = (n: string, c: unknown, x = '') => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (x ? '  ' + x : '')); } };
const throws = (f: () => unknown) => { try { f(); return null; } catch (e: any) { return e?.message ?? 'error'; } };

// a tiny but real JPEG, PNG and WebP header each (the checks look at the first bytes)
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]).toString('base64');
const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 0, 0, 0]), Buffer.from('WEBPVP8 ')]).toString('base64');

console.log('--- the payment screenshot');
ok('a JPEG, PNG and WebP are accepted', parseProof({ name: 'a.jpg', mime: 'image/jpeg', data: jpeg })?.mime === 'image/jpeg' && !!parseProof({ name: 'a', mime: 'image/png', data: png }) && !!parseProof({ name: 'a', mime: 'image/webp', data: webp }));
ok('a data: link prefix is tolerated', !!parseProof({ name: 'a', mime: 'image/jpeg', data: `data:image/jpeg;base64,${jpeg}` }));
ok('nothing sent means no screenshot', parseProof(null) === null && parseProof(undefined) === null);
ok('a PDF or script is refused', !!throws(() => parseProof({ name: 'a.pdf', mime: 'application/pdf', data: jpeg })) && !!throws(() => parseProof({ name: 'a.svg', mime: 'image/svg+xml', data: jpeg })));
ok('a file that says JPEG but is not one is refused', !!throws(() => parseProof({ name: 'a.jpg', mime: 'image/jpeg', data: Buffer.from('<script>alert(1)</script>').toString('base64') })));
ok('empty or garbage data is refused', !!throws(() => parseProof({ name: 'a', mime: 'image/jpeg', data: '' })) && !!throws(() => parseProof({ name: 'a', mime: 'image/jpeg', data: '!!!not base64!!!' })));
ok('over 4 MB is refused', !!throws(() => parseProof({ name: 'a', mime: 'image/jpeg', data: Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(PROOF_MAX_BYTES)]).toString('base64') })));
ok('the file name is made safe', parseProof({ name: '../../etc/pass wd?.jpg', mime: 'image/jpeg', data: jpeg })!.name === '.._.._etc_pass wd_.jpg');

console.log('--- the email to sales');
ok('paid by bank: says paid, how much, that the screenshot is attached and what to do', (() => { const t = paymentLines({ kind: 'order', payment: { mode: 'paid', method: 'bank', amount: 1234.5, proofName: 'payment-TS-0007.jpg' } }).join('\n'); return /PAID AT THE SHOW by bank transfer, \$1,234\.50 inc GST/.test(t) && /screenshot is attached \(payment-TS-0007\.jpg\)/.test(t) && /press Done in Radar/.test(t); })(), paymentLines({ kind: 'order', payment: { mode: 'paid', method: 'bank', amount: 1234.5, proofName: 'x' } }).join('|'));
ok('paid by card says card', /by card/.test(paymentLines({ kind: 'order', payment: { mode: 'paid', method: 'card', amount: 10, proofName: null } }).join('\n')));
ok('not paid: an order asks for the payment details, a quote for the quote', /send the customer the invoice and payment details/.test(paymentLines({ kind: 'order', payment: { mode: 'later', method: null, amount: null, proofName: null } }).join('\n')) && /send the customer the quote/.test(paymentLines({ kind: 'quote', payment: { mode: 'later', method: null, amount: null, proofName: null } }).join('\n')));
ok('no payment record (the set-up step not run) adds nothing to the email', paymentLines({ kind: 'order', payment: null }).length === 0 && paymentLines({ kind: 'order' }).length === 0);
const base = { number: 'TS-0007', kind: 'order' as const, reference: 'LIS MEL AUG26 06/08/2026 TS-0007', customerPo: null, orderDate: '2026-08-06', showName: 'LIS Melbourne Aug 2026', repName: 'Sam', customer: { name: 'Test Shop', isNew: false, region: 'VIC', contact: null, email: null, phone: null, address: null, terms: null },
  lines: [{ sku: 'A1', name: 'Bunny', qty: 6, price: 10, lineTotal: 60, stock: 'In stock' }], totals: { goods: 60, linePct: 0, offerDiscount: 0, linePcts: [0], discount: 0, goodsAfter: 60, freight: 0, surcharge: 0, surchargePct: 0, exGst: 60, gst: 6, total: 66, lineTotals: [60] } as any, notes: null, version: 1, chargesInFile: true };
const m = salesEmail({ ...base, payment: { mode: 'paid', method: 'bank', amount: 66, proofName: 'p.jpg' } });
ok('the whole email: subject says PAID and how, body has the payment and the total', /PAID by bank transfer/.test(m.subject) && /PAYMENT: PAID AT THE SHOW/.test(m.body) && /TOTAL inc GST: \$66\.00/.test(m.body), m.subject);
ok('an unpaid email has no PAID in the subject', !/PAID/.test(salesEmail({ ...base, payment: { mode: 'later', method: null, amount: null, proofName: null } }).subject));

console.log('--- the same item in other colours (read from the names)');
const sc = (n: string) => JSON.stringify(splitColour(n));
ok('a colour at the start: Pink Birthday Candle Set', sc('Pink Birthday Candle Set') === '{"base":"birthday candle set","colour":"pink"}', sc('Pink Birthday Candle Set'));
ok('a colour at the end, with or without a dash or brackets', sc('Miffy Bunny Small - Blue') === '{"base":"miffy bunny small","colour":"blue"}' && sc('Miffy Bunny Small Pink') === '{"base":"miffy bunny small","colour":"pink"}' && sc('Miffy Bunny Small (Sage)') === '{"base":"miffy bunny small","colour":"sage"}', sc('Miffy Bunny Small (Sage)'));
ok('two colours of one item share a base', splitColour('Silver Napkins 20 pack').base === splitColour('Navy Napkins 20 pack').base && splitColour('Silver Napkins 20 pack').colour !== splitColour('Navy Napkins 20 pack').colour);
ok('a two-word colour is one colour (rose gold, not rose)', splitColour('Rose Gold Number Candle').colour === 'rose gold' && splitColour('Candle Holder Rose Gold').colour === 'rose gold');
ok('no colour word: no colour', splitColour('Sunshine Cake Topper').colour === null && splitColour('Miffy Plush Large').colour === null);
ok('a colour word inside another word is not a colour (bored game, cream-ery)', splitColour('Bored Game').colour === null && splitColour('Creamery Mug').colour === null);
ok('a name that is only a colour has no base to group on', splitColour('Blue').colour === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
