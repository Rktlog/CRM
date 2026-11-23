// Tests the plain rules behind taking a trade show order through the assistant: which show, which product (colours), the quantities, and what the
// assistant is told. No database, no Claude.
// Run:  npx tsx scripts/test-ai-show-order.ts
import { norm, orderSummary, pickProduct, pickShow } from '../src/lib/aiShowOrder';

let pass = 0, fail = 0;
const ok = (n: string, c: unknown, x = '') => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (x ? '  ' + x : '')); } };
const P = (sku: string, name: string, over: object = {}): any => ({ sku, name, brand: 'Miffy', price: 20, increment: null, image: null, status: null, available: 50, pending: 0, free: 50, incoming: null, eta: null, ...over });

console.log('--- which show');
const shows = [
  { id: 'a', name: 'LIS Melbourne Aug 2026', startsOn: '2026-08-06', endsOn: '2026-08-08', archived: false },
  { id: 'b', name: 'Reed Gift Fair Feb 2027', startsOn: '2027-02-01', endsOn: '2027-02-04', archived: false },
  { id: 'c', name: 'Old show', startsOn: '2025-02-01', endsOn: '2025-02-04', archived: true },
];
ok('the show running today is used when none is named', pickShow(shows, undefined, '2026-08-07').show?.id === 'a');
ok('the day before and after still count (setting up, packing down)', pickShow(shows, undefined, '2026-08-05').show?.id === 'a' && pickShow(shows, undefined, '2026-08-09').show?.id === 'a');
ok('a part of the name finds it', pickShow(shows, 'reed', '2026-08-07').show?.id === 'b' && pickShow(shows, 'LIS Melbourne', '2026-01-01').show?.id === 'a');
ok('nothing running and two open shows: ask, with the choices', (() => { const r = pickShow(shows, undefined, '2026-12-01'); return !r.show && r.problem?.choices?.length === 2; })());
ok('a closed show is never offered or picked', pickShow(shows, 'old show', '2026-08-07').show === undefined && !pickShow(shows, undefined, '2026-12-01').problem?.choices?.some(c => c.id === 'c'));
ok('only one open show and nothing running: it is used', pickShow([shows[0]!, shows[2]!], undefined, '2026-12-01').show?.id === 'a');

console.log('--- which product');
const bunnies = [P('MF-BUN-S-BLU', 'Miffy Bunny Small - Blue'), P('MF-BUN-S-PNK', 'Miffy Bunny Small - Pink'), P('MF-BUN-L-BLU', 'Miffy Bunny Large - Blue')];
ok('colour and size pick one product', pickProduct(bunnies, { product: 'bunny small', colour: 'blue' }).hit?.sku === 'MF-BUN-S-BLU');
ok('two matches: ask, with choices (never guess)', (() => { const r = pickProduct(bunnies, { product: 'bunny small' }); return !r.hit && r.problem?.choices?.length === 2; })());
ok('a colour that does not exist is said so, with what did match', (() => { const r = pickProduct(bunnies, { product: 'bunny', colour: 'green' }); return !r.hit && /No "green" version/.test(r.problem!.reason) && r.problem!.choices!.length === 3; })());
ok('a settled SKU is taken exactly', pickProduct(bunnies, { sku: 'mf-bun-l-blu' }).hit?.sku === 'MF-BUN-L-BLU' && !!pickProduct(bunnies, { sku: 'NOPE' }).problem);
ok('no hits is a problem', !!pickProduct([], { product: 'zzz' }).problem);
ok('a colour word inside another word does not match (red is not in bored)', pickProduct([P('X1', 'Bored game')], { product: 'game', colour: 'red' }).hit === undefined);
ok('one plain match is used', pickProduct([P('X1', 'Lamp')], { product: 'lamp' }).hit?.sku === 'X1');

console.log('--- names and what the assistant is told');
ok('names match ignoring case, & and punctuation', norm('Petals Network / Interflora') === norm('petals network  interflora') && norm('Brown & Co.') === norm('brown and co'));
const none = orderSummary({ problems: [{ what: 'x', reason: 'y' }] });
ok('with problems only, nothing is shown and nothing saved', (none as any).previewShownToPerson === false && (none as any).savedNothing === true);
const full = orderSummary({ showId: 'a', showName: 'LIS', accountId: 'c', customer: 'Test Shop', region: 'VIC', kind: 'order', goods: 240, problems: [], lines: [{ sku: 'S', name: 'N', brand: null, qty: 12, price: 20, lineTotal: 240, stock: '50 free', warning: null }] });
ok('a ready preview says nothing is saved yet and it only makes a draft', (full as any).savedNothingYet === true && /DRAFT/.test((full as any).note) && /Do not say the order is placed/.test((full as any).note));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
