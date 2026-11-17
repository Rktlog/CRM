// Tests the plain rules behind the Liewood section: reading the sales order, the SKU, the PDF check, reading a DEAR purchase, the tally and the ETA. No database, no DEAR, no internet.
// Run:  npx tsx scripts/test-liewood.ts
import { buildSku, compareConfirmation, etaEnd, num, orderStage, parsePdfReply, parseSalesOrder, readDearPurchase, tallyPo } from '../src/lib/liewoodCore';
import { normalisePo } from '../src/lib/liewood';

let pass = 0, fail = 0;
const ok = (n: string, c: unknown, x = '') => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (x ? '  ' + x : '')); } };
const throws = (f: () => unknown) => { try { f(); return null; } catch (e: any) { return e?.message ?? 'error'; } };

console.log('--- numbers, SKUs and PO numbers');
ok('Danish and English numbers', num('16.313,04') === 16313.04 && num('16,313.04') === 16313.04 && num('24,00') === 24 && num(780) === 780 && num('25%') === 25 && num('x') === null);
ok('the SKU is built as in DEAR', buildSku('LW20534', 2598, 'One size') === 'LW20534-2598-ONE SIZE-CU' && buildSku('LW14532', 42, '3-6m') === 'LW14532-0042-3-6M-CU');
ok('a shop display (no style number) makes no SKU', buildSku('1001', 1, 'One size') === null);
ok('PO numbers are tidied to DEAR\'s PO-00089', normalisePo('po89') === 'PO-00089' && normalisePo('PO-00089') === 'PO-00089' && normalisePo('') === null && !!throws(() => normalisePo('SI0010427759')));

console.log('--- the sales order');
const head = ['Order No.', 'Season', 'Customer Order No.', 'Style No', 'Style Name', 'Color Code', 'Color Description', 'Barcode', 'Size', 'Qty (CU)', 'Currency', 'Wholesale Price', 'Discount %', 'WSP after Disc.', 'Total WSP Amount', 'Recommended Retail Price', 'Delivery window'];
const rows = [['Liewood sales order'], head,
  ['SO493681', '01 2027', 'PO-RR-1', 'LW20534', 'Chase Chair', 2598, 'Beach blue', 5715493531928, 'One size', 20, 'EUR', 18, 0, 18, 360, 60, 'February/February 2027'],
  ['SO493681', '01 2027', 'PO-RR-1', 'LW14532', 'Bib', '42', 'Sandy', '5715493531935', '3-6m', 12, 'EUR', '4,50', 0, '4,50', '54,00', 15, 'January/January 2027'],
  ['SO493681', '01 2027', 'PO-RR-1', '1001', 'Summer Shop display', 1, 'Mix', null, 'One size', 1, 'EUR', 0, 0, 0, 0, 0, 'January/January 2027']];
const so = parseSalesOrder(rows);
ok('it finds the heading row and reads every line', so.orderNo === 'SO493681' && so.lines.length === 3 && so.totalUnits === 33 && so.totalAmount === 414, JSON.stringify([so.orderNo, so.lines.length, so.totalUnits, so.totalAmount]));
ok('a line has its SKU, barcode and prices', so.lines[1]!.sku === 'LW14532-0042-3-6M-CU' && so.lines[1]!.barcode === '5715493531935' && so.lines[1]!.price === 4.5);
ok('the shop display is kept, marked as a display', so.lines[2]!.display && so.lines[2]!.sku.startsWith('DISPLAY'));
ok('both delivery windows are listed', so.deliveryWindows.length === 2);
ok('a file with no order number column is refused in words', !!throws(() => parseSalesOrder([['hello'], ['a', 'b']])));
ok('a file with two orders in it is refused', !!throws(() => parseSalesOrder([head, rows[2]!, ['SO499999', ...rows[3]!.slice(1)]])));

console.log('--- the PDF check');
const pdf = parsePdfReply('Here: {"orderNo":"SO493681","totalUnits":780,"totalAmount":"16.313,04","currency":"EUR"}');
ok('Claude\'s reply is read, even with words around it', pdf.orderNo === 'SO493681' && pdf.totalUnits === 780 && pdf.totalAmount === 16313.04);
const s = { orderNo: 'SO493681', totalUnits: 780, totalAmount: 16313.04, currency: 'EUR' };
ok('same totals: match', compareConfirmation(s, pdf).status === 'match');
ok('different units or order number: mismatch', compareConfirmation({ ...s, totalUnits: 760 }, pdf).status === 'mismatch' && compareConfirmation({ ...s, orderNo: 'SO1' }, pdf).status === 'mismatch');

console.log('--- a DEAR purchase and the tally');
const po = readDearPurchase({ OrderNumber: 'PO-00089', Order: { Lines: [{ SKU: 'A', Quantity: 10 }, { SKU: 'B', Quantity: 5 }, { SKU: 'X', Quantity: 2 }] },
  Invoices: [{ TaskID: 't1', InvoiceNumber: 'SI1', Status: 'AUTHORISED', Lines: [{ SKU: 'A', Quantity: 10 }] }, { TaskID: 't2', InvoiceNumber: 'SI2', Status: 'AUTHORISED', Lines: [{ SKU: 'B', Quantity: 5 }] }, { TaskID: 't3', InvoiceNumber: 'SI3', Status: 'VOIDED', Lines: [{ SKU: 'B', Quantity: 5 }] }],
  StockReceived: [{ TaskID: 't1', Status: 'AUTHORISED', Lines: [{ SKU: 'A', Quantity: 8 }] }] });
ok('order lines, invoices (voided left out) and receipts are read', po.ordered.length === 3 && po.invoices.length === 2 && po.receipts.length === 1);
const t = tallyPo([{ id: 'old', lines: [{ lineNo: 1, sku: 'A', qty: 10 }, { lineNo: 2, sku: 'B', qty: 5 }, { lineNo: 3, sku: 'C', qty: 4 }] }], po);
ok('A: received 8 of 10; B: invoiced, coming; C: not on the PO', t.lines[0]!.stage === 'part_received' && t.lines[0]!.received === 8 && t.lines[1]!.stage === 'invoiced' && t.lines[2]!.stage === 'not_on_po', JSON.stringify(t.lines.map(l => l.stage)));
ok('invoice SI1 came in 2 short; X is on the PO but on no order', t.shortages.length === 1 && t.shortages[0]!.invoice === 'SI1' && t.shortages[0]!.received === 8 && t.extraOnPo.some(x => x.sku === 'X'));
const two = tallyPo([{ id: 'old', lines: [{ lineNo: 1, sku: 'A', qty: 6 }] }, { id: 'new', lines: [{ lineNo: 1, sku: 'A', qty: 6 }] }], po);
ok('two orders on one PO: the older is filled first', two.lines[0]!.onPo === 6 && two.lines[1]!.onPo === 4 && two.lines[0]!.received === 6 && two.lines[1]!.received === 2);
ok('the order\'s stage', orderStage(false, t.lines) === 'confirmed' && orderStage(true, t.lines) === 'part_received');

console.log('--- the ETA');
ok('April 2027, Apr-27, Nov-26, 04/2027 and 2027-04 all give the month end', etaEnd('April 2027') === '2027-04-30' && etaEnd('Apr-27') === '2027-04-30' && etaEnd('Nov-26') === '2026-11-30' && etaEnd('04/2027') === '2027-04-30' && etaEnd('2027-04') === '2027-04-30');
ok('words that are not a month give nothing', etaEnd('TBC') === null && etaEnd('') === null);

console.log(`\npassed: ${pass}   failed: ${fail}`); process.exit(fail ? 1 : 0);
