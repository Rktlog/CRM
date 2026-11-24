// Tests the plain rules behind the Liewood range: reading the Product Range List tab, reading a season's two files (Liewood's Product Data file and the
// Customer Forecast Form), the EUR price rule and the price check. Made-up SKUs and prices only. No database, no internet.
// Run:  npx tsx scripts/test-liewood-range.ts
import { essentialOf, parseRangeList, parseSeasonFile, price, priceCheck, wspEurOf } from '../src/lib/liewoodRangeCore';
import { parseCsv, readSheets } from '../src/lib/liewoodRange';

let pass = 0, fail = 0;
const ok = (n: string, c: unknown, x = '') => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (x ? '  ' + x : '')); } };
const throws = (f: () => unknown) => { try { f(); return null; } catch (e: any) { return e?.message ?? 'error'; } };

console.log('--- prices and the rules');
ok('prices are read with or without $, and errors are nothing', price('$29.95') === 29.95 && price(14.975) === 14.98 && price('#N/A') === null && price('') === null && price('-3') === null);
ok('EUR price: STOCK when there is one', wspEurOf(5.6, 6) === 5.6);
ok('EUR price: PRE only when there is no STOCK price (blank or 0)', wspEurOf(null, 40) === 40 && wspEurOf(0, 40) === 40 && wspEurOf(null, null) === null);
ok('Liewood\'s True/False becomes YES/NO', essentialOf('True') === 'YES' && essentialOf('False') === 'NO' && essentialOf('ESSENTIALS') === 'YES' && essentialOf('N/A') === 'N/A' && essentialOf(null) === null);
ok('price check: same, different, not in DEAR, no proposed RRP',
  priceCheck(29.95, 29.95, true) === 'match' && priceCheck(129.95, 54.95, true) === 'differs' && priceCheck(29.95, null, false) === 'not_in_dear' && priceCheck(null, 44.95, true) === 'no_proposed');

console.log('--- the Product Range List tab');
// laid out like the real tab: settings and a colour key above, the heading row further down, two "Order increment" columns (L and BI)
const head = ['EAN', 'SKU from Liewood File', 'SKU', 'Name', 'Season', 'Essential (Yes/NO)', 'Subbrand', 'Category', 'Sub-category', 'Product Type', 'Color Name', 'Order increment',
  'Drop Delivery TO EUR (From Product Data File)', 'Drop Delivery TO EUR', 'Drop Delivery TO AUS \n(+3 months drop delivery to EUR)', 'SO100001 (Made-up order)', 'Confirmed to range',
  'Order increment', 'W/SPrice Euro', 'Proposed RRP', 'PRICE CHECK'];
const list = [
  ['', '', 'EUR/AUD', 1.79], ['', '', 'Freight Factor', '10%'], ['Ranging cancelled'], ['Range only once'], [], head,
  [1234567890123, 'LW90001-1111-ONE SIZE-CU', 'LW90001-1111-ONE SIZE-CU', 'Test Box S', 'N/A', 'YES', '', 'INTERIOR', '', 'STORAGE BOX', 'Sand', 4, 'July 2024', '#REF!', 'Nov/Dec 2025', 40, 'Y', '', 5.8, 29.95, 'TRUE'],
  ['1234567890124', '', 'lw90002-2222-3/4 y-cu', 'Test Hat', 'SS26 (1.26)', 'N/A', '', 'ACCESSORIES', '', 'HAT', 'Navy', '#N/A', 'January 2026', '', '', '', 'N - Pre order only', 8, '$4.20', '$34.95', 'FALSE'],
  ['', '', '#N/A', 'Made-up shop display', '#N/A', '', '', '', '', '', '#N/A', '', '', '', '', '', '', '', '', 0, '#N/A'],
  ['', '', 'LW90003-3333-ONE SIZE-CU', 'Test Bag', 'N/A', 'YES', '', 'ACCESSORIES', '', 'BAG', 'Sand', 'ten', '', '', '', '', 'Y', '', '', '', ''],
  [1234567890123, '', 'LW90001-1111-ONE SIZE-CU', 'Test Box S (again)', 'N/A', 'YES', '', 'INTERIOR', '', 'STORAGE BOX', 'Sand', 4, 'July 2024', '#REF!', 'Nov/Dec 2025', '', 'Y', '', 5.8, 31.95, ''],
];
const r = parseRangeList(list);
const a = r.rows.find(x => x.sku === 'LW90001-1111-ONE SIZE-CU'), b = r.rows.find(x => x.sku === 'LW90002-2222-3/4 Y-CU');
ok('it finds the heading row under the notes and reads each SKU once', r.rows.length === 3, String(r.rows.length));
ok('the SKU column is "SKU" (not "SKU from Liewood File"), tidied to capitals', !!b && b.name === 'Test Hat');
ok('the order increment is column L, not the second one (BI)', a?.orderIncrement === 4 && b?.orderIncrement === null, JSON.stringify([a?.orderIncrement, b?.orderIncrement]));
ok('column M is the drop delivery, column N (#REF!) is not read, column O is the delivery to Australia', a?.dropEur === 'July 2024' && a?.dropAus === 'Nov/Dec 2025' && b?.dropEur === 'January 2026');
ok('ranged, EUR price and proposed RRP are read ($ signs too)', b?.ranged === 'N - Pre order only' && b?.wspEur === 4.2 && b?.proposedRrp === 34.95 && a?.ean === '1234567890123');
ok('a row with no SKU is left out and counted', r.noSku === 1);
ok('a SKU twice: the lower row wins, and it is named', r.duplicates[0] === 'LW90001-1111-ONE SIZE-CU' && a?.proposedRrp === 31.95);
ok('an increment that is not a number is named', r.problems.some(p => p.includes('LW90003') && p.includes('ten')));
ok('a file that is not the Product Range List is refused in words', !!throws(() => parseRangeList([['hello'], ['a', 'b']])));

console.log('--- Liewood\'s Product Data file');
const pdHead = ['Product ', 'Style No.', 'EAN', 'Style Name (EN)', 'Colours', 'Color Name', 'Size', 'Season Code', 'ESSENTIALS', 'Style/Color Development (EN)', 'Drop Delivery Latest', 'Sales Order Multiple',
  'WSP EUR (STOCK)', 'WSP EUR (PRE)', 'RRP EUR (STOCK)', 'Brand', 'Category', 'Sub Category', 'Product Type'];
const pd = parseSeasonFile([
  { name: 'Colour Overview', rows: [['Product', 'EAN', 'Sales Order Multiple'], ['LW90009-9999-ONE SIZE-CU', '1234567890999', 1]] },
  { name: 'Product Data', rows: [pdHead,
    ['LW91001-5060-1/2 Y-CU', 'LW91001', 1234567891001, 'Test balaclava', '5060', 'Sandy', '1/2 Y', '03 OW/FW 2027', 'False', 'Carry over', 'August 2027', 4, 16.8, 16.8, 42, 'LIEWOOD WEAR', 'ACCESSORIES', 'WEAR ACCESSORIES', 'HATS/CAP'],
    ['LW91002-3361-80-CU', 'LW91002', '1234567891002', 'Test jacket', '3361', 'Black', '80', '03 OW/FW 2027', 'False', 'New development', 'August 2027', 2, 0, 40, 100, 'LIEWOOD WEAR', '', '', ''],
  ] },
]);
ok('it is told apart from the Forecast Form, and the Product Data tab is used over Colour Overview', pd.kind === 'product_data' && pd.tabs[0] === 'Product Data' && pd.rows.length === 2);
const p1 = pd.kind === 'product_data' ? pd.rows[0]! : null, p2 = pd.kind === 'product_data' ? pd.rows[1]! : null;
ok('SKU, EAN, drop delivery and multiple are read', p1?.sku === 'LW91001-5060-1/2 Y-CU' && p1?.ean === '1234567891001' && p1?.dropDelivery === 'August 2027' && p1?.salesMultiple === 4);
ok('both EUR prices are kept, so the rule can pick', p2?.wspEurStock === 0 && p2?.wspEurPre === 40 && wspEurOf(p2!.wspEurStock, p2!.wspEurPre) === 40 && wspEurOf(p1!.wspEurStock, p1!.wspEurPre) === 16.8);
const oldLayout = parseSeasonFile([{ name: 'Product Data File', rows: [['Product', 'EAN', 'Sales Order Multiple', 'WSP EUR', 'Drop Delivery Latest'], ['LW91003-1111-ONE SIZE-CU', 1234567891003, 4, 7, 'October 2025']] }]);
ok('the older layout (one "WSP EUR" column) is read too', oldLayout.kind === 'product_data' && oldLayout.rows[0]!.wspEurStock === 7);

console.log('--- the Customer Forecast Form');
const fcHead = ['Packshot', 'EAN', 'SKU', 'Category', 'Sub Category', 'Product Type', 'Style Name', 'Colour', 'Size', 'ETA', 'RRP inc GST', 'WS ex GST', 'Order Increment', 'Forecast Qty', 'Sub Total'];
const fc = parseSeasonFile([
  { name: 'Summary', rows: [['MADE-UP FORECAST'], ['Category', '# SKUs'], ['Outerwear', 2]] },
  { name: 'Outerwear', rows: [['MADE-UP | Outerwear'], ['Enter quantities in the yellow column'], fcHead,
    ['', '1234567891002', 'LW91002-3361-80-CU', 'Outerwear', 'Heavy Outerwear', 'Jacket', 'Test jacket', 'Black', '80', 'December 2027', '$189.95', '$94.98', 2, '', '$0.00']] },
  { name: 'Footwear', rows: [['MADE-UP | Footwear'], [], fcHead,
    ['', '1234567891004', 'LW91004-3050-22-CU', 'Footwear', 'Boots', 'Regular Boots', 'Test boot', 'Caramel', '22', 'December 2027', 179.95, 89.98, 2, '', 0]] },
]);
ok('every category tab is read, the Summary tab is skipped', fc.kind === 'forecast' && fc.rows.length === 2 && fc.tabs.join() === 'Outerwear,Footwear', JSON.stringify(fc.tabs));
const f1 = fc.kind === 'forecast' ? fc.rows[0]! : null;
ok('RRP inc GST, wholesale ex GST, increment and category are read', f1?.rrpAud === 189.95 && f1?.wsAud === 94.98 && f1?.increment === 2 && f1?.category === 'Outerwear' && f1?.eta === 'December 2027');
ok('a file that is neither season file is refused in words', !!throws(() => parseSeasonFile([{ name: 'Sheet1', rows: [['a', 'b'], [1, 2]] }])));

console.log('--- a CSV of the tab (as Google Sheets downloads it)');
const csv = '﻿EUR/AUD,1.79\r\nEAN,SKU,Name,"Drop Delivery TO AUS \n(+3 months)",Confirmed to range,Order increment\r\n'
  + '123,LW90001-1111-ONE SIZE-CU,"Box, small","Nov/Dec 2025\nJuly 2026",Y,4\r\n' + `124,LW90004-4444-ONE SIZE-CU,"Say ""hi""",,N,${',x'.repeat(80)}\r\n`;
const rowsCsv = parseCsv(csv);
ok('quoted commas, quotes and line breaks stay inside their cell', rowsCsv.length === 4 && rowsCsv[2]![2] === 'Box, small' && rowsCsv[2]![3] === 'Nov/Dec 2025\nJuly 2026' && rowsCsv[3]![2] === 'Say "hi"', JSON.stringify(rowsCsv.map(r => r.length)));
ok('a long row stays one row', rowsCsv[3]!.length === 86);
const fromCsv = parseRangeList(readSheets(Buffer.from(csv, 'utf8'))[0]!.rows);
ok('the range is read from the CSV', fromCsv.rows.length === 2 && fromCsv.rows[0]!.dropAus === 'Nov/Dec 2025 July 2026' && fromCsv.rows[0]!.orderIncrement === 4);

console.log(`\npassed: ${pass}   failed: ${fail}`);
process.exit(fail ? 1 : 0);
