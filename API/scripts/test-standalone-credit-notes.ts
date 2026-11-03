// Tests the credit note finder's logic with made-up DEAR sales. No DEAR, no database.   Run:  npx tsx scripts/test-standalone-credit-notes.ts
import { amountOf, candidates, creditNoteReason, dayOf, locate, missingByMonth, statusCounts } from '../src/lib/standaloneCreditNotes';

let pass = 0, fail = 0;
const ok = (n: string, c: unknown, x = '') => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (x ? '  ' + x : '')); } };
const eq = (n: string, got: unknown, want: unknown) => ok(n, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} wanted ${JSON.stringify(want)}`);
const sale = (o: Record<string, any>) => ({ SaleID: 'id' + Math.random(), OrderNumber: 'SQ1', Status: 'COMPLETED', Customer: 'Shop', CustomerID: 'c1', InvoiceAmount: 100, InvoiceDate: '2026-03-05T00:00:00', ...o });

const sales = [
  sale({ OrderNumber: 'SQ100' }),                                                                                  // an ordinary sale
  sale({ OrderNumber: 'SQ101', Status: 'CREDIT NOTE', InvoiceAmount: -250.5, InvoiceDate: '2026-03-10T00:00:00' }),  // a standalone credit note, by its status
  sale({ OrderNumber: 'SQ102', Status: 'COMPLETED', InvoiceAmount: -40, InvoiceDate: '2026-04-02T00:00:00' }),        // negative, status says nothing
  sale({ OrderNumber: 'SQ103', Status: 'CREDITED', InvoiceAmount: 90, InvoiceDate: '2026-04-09T00:00:00' }),          // an order that was credited: shows as a candidate, to be judged
  sale({ OrderNumber: 'SQ104', Status: 'COMPLETED', CombinedPaymentStatus: 'OVERPAID / CREDITED' }),                  // credit only in a PAYMENT status: not a credit note
  sale({ OrderNumber: 'SQ105', Status: 'CREDIT NOTE', InvoiceAmount: -100, InvoiceDate: '2026-04-20T00:00:00', Customer: 'Unknown Co', CustomerID: 'zzz' }),
  sale({ OrderNumber: 'SQ106', Status: 'Credit Note', InvoiceAmount: undefined, Total: -12.34, InvoiceDate: undefined, SaleOrderDate: '2026-05-01T00:00:00' }),
];
eq('an ordinary sale is not a credit note', creditNoteReason(sales[0]!), null);
ok('a status of CREDIT NOTE is found', /Status is "CREDIT NOTE"/.test(creditNoteReason(sales[1]!) ?? ''));
ok('a negative amount is found even when the status says nothing', /negative \(-40\)/.test(creditNoteReason(sales[2]!) ?? ''));
ok('credit only in a payment status is NOT a credit note', creditNoteReason(sales[4]!) === null);
eq('the amount is read from Total when there is no InvoiceAmount', amountOf(sales[6]!), -12.34);
eq('the date is read from the first date field there is', [dayOf(sales[1]!), dayOf(sales[6]!)], ['2026-03-10', '2026-05-01']);
eq('no amount at all gives null, not zero', amountOf({ OrderNumber: 'X' }), null);

const cs = candidates(sales); eq('the candidates are SQ101, SQ102, SQ103, SQ105, SQ106', cs.map(c => c.number), ['SQ101', 'SQ102', 'SQ103', 'SQ105', 'SQ106']);
const sc = statusCounts(sales); eq('the histogram counts every status value, including payment status', [sc.Status!['COMPLETED'], sc.Status!['CREDIT NOTE'], sc.CombinedPaymentStatus!['OVERPAID / CREDITED']], [3, 2, 1]);
const located = locate(cs, new Set(['SQ103']), c => c.customerId === 'c1');
eq('Radar has SQ103 only', located.filter(l => l.inRadar).map(l => l.number), ['SQ103']);
eq('SQ105 is missing and its shop is not in Radar', located.filter(l => !l.inRadar && !l.customerInRadar).map(l => l.number), ['SQ105']);
eq('by month: March 1 for -250.50, April 2 for -140, May 1 for -12.34 (the one Radar has is left out)', missingByMonth(located), [{ month: '2026-03', count: 1, total: -250.5 }, { month: '2026-04', count: 2, total: -140 }, { month: '2026-05', count: 1, total: -12.34 }]);
eq('nothing at all is fine', [candidates([]), missingByMonth([])], [[], []]);
console.log(`\npassed: ${pass}   failed: ${fail}`); process.exit(fail ? 1 : 0);
