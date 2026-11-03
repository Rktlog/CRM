// Tests how marketing and warranty orders are added up for the overall Sales report, using the real sales rules (tax invoices on their date, credit notes
// as negatives). No database, no internet.   Run:  npx tsx scripts/test-misc-sales.ts
import { salesOf } from '../src/lib/salesRules';
import { summariseMisc } from '../src/lib/miscSales';

let pass = 0, fail = 0;
const ok = (n: string, c: unknown, x = '') => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (x ? '  ' + x : '')); } };
const eq = (n: string, got: unknown, want: unknown) => ok(n, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} wanted ${JSON.stringify(want)}`);
const day = (d: string) => new Date(`${d}T00:00:00Z`);
// an order the way the database hands it over
const order = (o: Partial<Record<string, any>> & { number: string; miscType: string }) => ({
  amount: 0, sentAt: day('2026-10-01'), source: 'cin7', paid: false, invoiceDate: null, fulfillmentStatus: 'COMPLETED', goodsTotal: 0, taxTotal: 0, invoices: [], creditNotes: [], ...o });
const inv = (date: string, goods: number) => ({ number: 'INV' + date, date, status: 'AUTHORISED', total: goods * 1.1, goods });
const range = (rows: ReturnType<typeof salesOf>, from: string, to: string) => rows.filter(r => r.sentAt >= day(from) && r.sentAt < day(to));

const rows = salesOf([
  order({ number: 'SQ1', miscType: 'marketing', invoiceDate: day('2026-10-05'), invoices: [inv('2026-10-05', 0)] }),                     // marketing, a $0 invoice
  order({ number: 'SQ2', miscType: 'marketing', invoiceDate: day('2026-10-09'), invoices: [inv('2026-10-09', 0)] }),
  order({ number: 'SQ3', miscType: 'marketing', invoiceDate: null }),                                                                       // not invoiced yet: no sale yet
  order({ number: 'SQ4', miscType: 'warranty', goodsTotal: 120, invoiceDate: day('2026-10-06'), invoices: [inv('2026-10-06', 120)] }),     // warranty with real dollars
  order({ number: 'SQ5', miscType: 'warranty', goodsTotal: 80, invoiceDate: day('2026-10-20'), invoices: [inv('2026-10-20', 50), inv('2026-10-22', 30)] }), // two invoices, one order
  order({ number: 'SQ6', miscType: 'warranty', invoiceDate: day('2026-10-07'), invoices: [inv('2026-10-07', 40)], creditNotes: [{ number: 'CR1', date: '2026-10-15', status: 'AUTHORISED', goods: 15, total: 16.5 }] }),
  order({ number: 'SQ7', miscType: 'warranty', fulfillmentStatus: 'VOIDED', invoiceDate: day('2026-10-08'), invoices: [inv('2026-10-08', 999)] }),   // voided: not a sale
  order({ number: 'SQ8', miscType: 'warranty', fulfillmentStatus: 'DRAFT', goodsTotal: 77, invoiceDate: null }),                          // draft: not a sale
  order({ number: 'SQ9', miscType: 'warranty', invoiceDate: day('2026-09-10'), invoices: [inv('2026-09-10', 25)] }),                      // last month
] as any[]);

const oct = summariseMisc(range(rows, '2026-10-01', '2026-11-01') as any[]);
eq('October marketing: 2 invoiced orders, $0', oct.marketing, { orders: 2, value: 0 });
eq('October warranty: 3 orders (SQ4, SQ5 with two invoices, SQ6), value 120 + 50 + 30 + 40 - 15 = 225', oct.warranty, { orders: 3, value: 225 });
eq('a credit note adds to the value but is not another order', summariseMisc(range(rows, '2026-10-15', '2026-10-16') as any[]).warranty, { orders: 0, value: -15 });
eq('September is its own period: one warranty order, $25', summariseMisc(range(rows, '2026-09-01', '2026-10-01') as any[]).warranty, { orders: 1, value: 25 });
eq('an order with two invoices is one order however the period is cut', summariseMisc(range(rows, '2026-10-20', '2026-10-23') as any[]).warranty, { orders: 1, value: 80 });
ok('a voided order and a draft add nothing', !rows.some(r => ['SQ7', 'SQ8'].includes(r.number)));
ok('a marketing order not invoiced yet is not counted yet', !rows.some(r => r.number === 'SQ3'));
eq('rows that are not marketing or warranty are ignored', summariseMisc([{ miscType: null, number: 'SQX', amount: 500 }, { number: 'SQY', amount: 1 }] as any[]), { marketing: { orders: 0, value: 0 }, warranty: { orders: 0, value: 0 } });
eq('no rows: zeros, never missing', summariseMisc([]), { marketing: { orders: 0, value: 0 }, warranty: { orders: 0, value: 0 } });
eq('cents are rounded', summariseMisc([{ miscType: 'warranty', number: 'A', amount: 0.1 }, { miscType: 'warranty', number: 'B', amount: 0.2 }]).warranty.value, 0.3);
// the headline total: ordinary sales plus these, as the route adds them
const ordinary = 1000, total = ordinary + oct.marketing.value + oct.warranty.value;
eq('the overall total is the ordinary sales plus warranty (marketing adds $0)', total, 1225);
console.log(`\npassed: ${pass}   failed: ${fail}`); process.exit(fail ? 1 : 0);
