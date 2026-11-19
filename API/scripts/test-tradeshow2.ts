// Tests the plain rules behind trade show offers, freight, references and payment. No database, no email, no Claude.
// Run:  npx tsx scripts/test-tradeshow2.ts
import { applyOffers, combinePct, DEFAULT_FREIGHT, cleanFreightCfg, dearReference, freightFor, paymentOf, type Offer } from '../src/lib/tsOffers';
import { dearCsv, salesEmail, totals } from '../src/lib/tradeshowCore';

let pass = 0, fail = 0;
const ok = (n: string, c: unknown, x = '') => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (x ? '  ' + x : '')); } };
const throws = (f: () => unknown) => { try { f(); return null; } catch (e: any) { return e?.message ?? 'error'; } };
const L = (sku: string, brand: string | null, qty: number, price: number, extra: object = {}) => ({ sku, name: sku, brand, qty, price, ...extra });
const O = (o: Partial<Offer> & { id: string; kind: Offer['kind']; name: string }): Offer => ({ pct: null, brands: [], skus: [], threshold: null, repeat: false, items: [], bundlePrice: null, payBy: null, active: true, notes: null, ...o });

console.log('--- percent offers');
const eol = O({ id: 'eol', kind: 'pct', name: 'EOL Miffy', pct: 30, brands: ['Miffy Plush'] });
const sku20 = O({ id: 's20', kind: 'pct', name: 'Clearance', pct: 20, skus: ['A1', 'B2'] });
let r = applyOffers([L('M1', 'Miffy Plush', 10, 10), L('A1', 'Other', 2, 50), L('Z9', 'Other', 1, 5)], [eol, sku20]);
ok('a brand offer takes 30% off that brand only', r.lines[0]!.pct === 30 && r.lines[2]!.pct === 0, JSON.stringify(r.lines.map(l => l.pct)));
ok('a SKU list offer takes 20% off those SKUs', r.lines[1]!.pct === 20);
ok('the brand match ignores capitals', applyOffers([L('M1', 'miffy plush', 1, 10)], [eol]).lines[0]!.pct === 30);
ok('when two offers fit, the bigger % wins (they do not stack)', applyOffers([L('A1', 'Miffy Plush', 1, 10)], [eol, sku20]).lines[0]!.pct === 30);
ok('a switched off offer does nothing', applyOffers([L('M1', 'Miffy Plush', 1, 10)], [{ ...eol, active: false }]).lines[0]!.pct === 0);
ok('the order says which offers applied', r.applied.map(a => a.name).sort().join() === 'Clearance,EOL Miffy');
ok('10% then 10% is 19%, and a free line stays 100%', combinePct(10, 10) === 19 && combinePct(100, 10) === 100 && combinePct(0, 12.5) === 12.5);

console.log('--- bundles');
const bundle = O({ id: 'b1', kind: 'bundle', name: 'Miffy Round Stand Bundle', bundlePrice: 90, items: [{ sku: 'S1', qty: 1 }, { sku: 'P1', qty: 4 }] });
r = applyOffers([L('S1', 'Miffy', 2, 40, { kind: 'bundle', offerId: 'b1' }), L('P1', 'Miffy', 8, 15, { kind: 'bundle', offerId: 'b1' })], [bundle]);
// one pack is 40 + 4 x 15 = 100, sold for 90, so every line takes 10% off
ok('every line of the pack gets the same % so a pack costs the pack price', r.lines.every(l => l.pct === 10), JSON.stringify(r.lines.map(l => l.pct)));
const bt = totals({ lines: r.lines, discount: null, freight: 0, cardPayment: false, surchargePct: null, gstRate: 0.1 });
ok('two packs come to 2 x 90', bt.goodsAfter === 180, String(bt.goodsAfter));
ok('the order says how many packs', /2 packs at \$90\.00/.test(r.applied[0]!.text), r.applied[0]?.text);
ok('a bundle line for an offer that is gone is just a normal line', applyOffers([L('S1', 'Miffy', 1, 40, { kind: 'bundle', offerId: 'gone' })], [bundle]).lines[0]!.kind === 'normal');
ok('the same SKU bought alone is not discounted by the bundle', applyOffers([L('S1', 'Miffy', 1, 40), L('S1', 'Miffy', 1, 40, { kind: 'bundle', offerId: 'b1' })], [bundle]).lines[0]!.pct === 0);

console.log('--- bonus packs');
const bonus = O({ id: 'bp', kind: 'bonus', name: 'Miffy Bonus Pack', threshold: 1000, brands: ['Miffy Plush'], items: [{ sku: 'FREE1', qty: 2, name: 'Free keychain', price: 8 }] });
r = applyOffers([L('M1', 'Miffy Plush', 50, 20)], [bonus]);   // 1000 spent
ok('reaching the spend adds the free products at 100% off', r.lines.length === 2 && r.lines[1]!.kind === 'gift' && r.lines[1]!.pct === 100 && r.lines[1]!.qty === 2 && r.lines[1]!.price === 8, JSON.stringify(r.lines[1]));
const bt2 = totals({ lines: r.lines, discount: null, freight: 0, cardPayment: false, surchargePct: null, gstRate: 0.1 });
ok('the free products cost nothing but show their value as an offer', bt2.goodsAfter === 1000 && bt2.offerDiscount === 16, JSON.stringify([bt2.goodsAfter, bt2.offerDiscount]));
r = applyOffers([L('M1', 'Miffy Plush', 40, 20), L('Q', 'Other', 100, 50)], [bonus]);
ok('spend on other brands does not count', r.lines.length === 2 && !r.lines.some(l => l.kind === 'gift'));
ok('and it says how far off the order is', r.prompts.length === 1 && /Spend \$200\.00 more on Miffy Plush to get Miffy Bonus Pack/.test(r.prompts[0]!.text), r.prompts[0]?.text);
ok('a percent offer comes off before the spend is counted', applyOffers([L('M1', 'Miffy Plush', 50, 20)], [bonus, eol]).lines.some(l => l.kind === 'gift') === false);
const rep2 = O({ ...bonus, id: 'bp2', repeat: true });
ok('a repeating pack comes again for each multiple', applyOffers([L('M1', 'Miffy Plush', 150, 20)], [rep2]).lines[1]!.qty === 6);
ok('a bonus pack with no brand counts the whole order', applyOffers([L('X', 'Any', 10, 100)], [O({ ...bonus, id: 'bp3', brands: [] })]).lines.length === 2);
ok('bonus lines in the input are worked out again, not added twice', applyOffers([...r.lines, ...applyOffers([L('M1', 'Miffy Plush', 50, 20)], [bonus]).lines.slice(1)], [bonus]).lines.filter(l => l.kind === 'gift').length === 0);

console.log('--- pay-by');
ok('the earliest pay-by date of the offers used', applyOffers([L('M1', 'Miffy Plush', 1, 10), L('A1', 'x', 1, 10)], [{ ...eol, payBy: '2026-09-01' }, { ...sku20, payBy: '2026-08-15' }]).payBy === '2026-08-15');
ok('an offer that was not used sets no date', applyOffers([L('Z9', 'x', 1, 10)], [{ ...eol, payBy: '2026-09-01' }]).payBy === null);

console.log('--- totals with offers and a manager discount');
r = applyOffers([L('M1', 'Miffy Plush', 10, 10), L('Z9', 'Other', 10, 10)], [eol]);
let t = totals({ lines: r.lines, discount: { kind: 'pct', value: 10 }, freight: 0, cardPayment: false, surchargePct: null, gstRate: 0.1 });
ok('30% off one line, then 10% off everything: 30% then 10% is 37%', t.linePcts[0] === 37 && t.linePcts[1] === 10, JSON.stringify(t.linePcts));
ok('goods 200, offers 30, goods after 153', t.goods === 200 && t.offerDiscount === 30 && t.goodsAfter === 153, JSON.stringify(t));
t = totals({ lines: r.lines, discount: { kind: 'amount', value: 17 }, freight: 0, cardPayment: false, surchargePct: null, gstRate: 0.1 });
ok('a $ discount is worked out on what is left after the offers (170)', t.linePct === 10, String(t.linePct));
const csv = dearCsv(r.lines.map((l, i) => ({ sku: l.sku, name: l.name, qty: l.qty, price: l.price, pct: t.linePcts[i] })), t.linePct);
ok('the DEAR file gives each line its own %', csv.split('\r\n')[1]!.endsWith(',37') && csv.split('\r\n')[2]!.endsWith(',10'), csv);

console.log('--- freight (the team\'s calculator)');
let f = freightFor(DEFAULT_FREIGHT, { state: 'NSW', region: 'Metro', orderIncGst: 850, large: false, pantone: false });
ok('NSW metro, $850: 4.5% = $38.25 (the calculator\'s own example)', f.amount === 38.25, JSON.stringify(f));
ok('the state minimum applies on a small order', freightFor(DEFAULT_FREIGHT, { state: 'VIC', region: 'Metro', orderIncGst: 100, large: false, pantone: false }).amount === 25);
ok('regional is 1.35 times and rural 1.65 times', freightFor(DEFAULT_FREIGHT, { state: 'QLD', region: 'Regional', orderIncGst: 1000, large: false, pantone: false }).amount === 81 && freightFor(DEFAULT_FREIGHT, { state: 'QLD', region: 'Rural', orderIncGst: 1000, large: false, pantone: false }).amount === 99);
ok('large items add 20% and Pantone Living 10%', freightFor(DEFAULT_FREIGHT, { state: 'NSW', region: 'Metro', orderIncGst: 1000, large: true, pantone: true }).amount === 59.4);
ok('ACT is quoted as NSW rural', freightFor(DEFAULT_FREIGHT, { state: 'ACT', region: 'Metro', orderIncGst: 1000, large: false, pantone: false }).amount === 74.25);
ok('VIC/HO and NSW/HO use their state\'s rate', freightFor(DEFAULT_FREIGHT, { state: 'NSW/HO', region: 'Metro', orderIncGst: 1000, large: false, pantone: false }).amount === 45);
ok('New Zealand has no calculator price (Australia Post is asked)', freightFor(DEFAULT_FREIGHT, { state: 'NZ', region: 'Metro', orderIncGst: 1000, large: false, pantone: false }).how === 'overseas');
ok('a state with no rate says so', freightFor(DEFAULT_FREIGHT, { state: 'XX', region: 'Metro', orderIncGst: 1000, large: false, pantone: false }).how === 'unknown');
ok('changed rates are checked', !!throws(() => cleanFreightCfg({ states: { VIC: { rate: 5, min: 25 } } })) && !!throws(() => cleanFreightCfg({ states: {} })) && cleanFreightCfg({ states: { VIC: { rate: 0.03, min: 20 } } }).states.VIC!.rate === 0.03);

console.log('--- the reference, and payment');
ok('the DEAR reference is the show and the day, no slashes', dearReference('LIS', '2026-08-06') === 'LIS 06082026');
ok('not in DEAR yet', paymentOf('sent', 100, null, null).status === 'not_in_dear');
ok('in DEAR but not invoiced', paymentOf('in_dear', 100, 0, 100).status === 'not_invoiced');
ok('invoiced and unpaid', paymentOf('invoiced', 100, 110, 110).status === 'unpaid');
ok('part paid shows what is paid and owing', (() => { const p = paymentOf('invoiced', 100, 110, 40); return p.status === 'part' && p.paid === 70 && p.owing === 40; })());
ok('paid', paymentOf('paid', 100, 110, 0).status === 'paid');
ok('cancelled and voided', paymentOf('cancelled', 100, null, null).status === 'cancelled' && paymentOf('voided_in_dear', 100, 0, 0).status === 'cancelled');

console.log('--- the email with offers');
const tt = totals({ lines: r.lines, discount: null, freight: 38.25, cardPayment: false, surchargePct: null, gstRate: 0.1 });
const m = salesEmail({ number: 'TS-0007', kind: 'order', reference: 'LIS 06082026 TS-0007', dearReference: 'LIS 06082026', customerPo: null, orderDate: '2026-08-06', showName: 'LIS Melbourne', repName: 'Sam',
  customer: { name: 'Shop', isNew: false, region: 'NSW', contact: null, email: null, phone: null, address: null, terms: null },
  lines: r.lines.map((l, i) => ({ sku: l.sku, name: l.name, qty: l.qty, price: l.price, lineTotal: tt.lineTotals[i]!, pct: tt.linePcts[i], note: l.note, stock: 'In stock' })),
  totals: tt, notes: null, version: 1, chargesInFile: true, payBy: '2026-09-01', offersNote: r.applied.map(a => a.text), freightNote: 'NSW 4.5% metro, minimum $30.00' });
ok('sales are told the short DEAR reference and Radar\'s own', m.body.includes('REFERENCE TO USE: LIS 06082026') && m.body.includes('Radar reference: LIS 06082026 TS-0007'));
ok('each line shows its own %, the offers, the freight reason and the pay-by date', m.body.includes('less 30%') && m.body.includes('Offers: -$30.00') && m.body.includes('(NSW 4.5% metro, minimum $30.00)') && m.body.includes('paid by 01/09/2026') && m.body.includes('EOL Miffy: 30% off'), m.body);

console.log(`\npassed: ${pass}   failed: ${fail}`); process.exit(fail ? 1 : 0);
