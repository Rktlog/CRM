// Tests the product feed's new rules: the Status column, inner and outer carton, and which supplier's cost goes in the sheet. The Miffy ECO product from DEAR (two suppliers,
// one in euros and one in US dollars) is the worked example the sales team confirms. No database, no DEAR, no internet.  Run:  npx tsx scripts/test-product-feed.ts
import { cartonKey, cartonsOf, explainProduct, statusOf, supplierCostOf, whenOf } from '../src/lib/productCartons';

let pass = 0, fail = 0;
const ok = (n: string, c: unknown, x = '') => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (x ? '  ' + x : '')); } };
const sup = (o: Record<string, unknown>) => ({ SupplierName: 'S', Currency: 'AUD', Cost: 0, FixedCost: 0, IncludeInPricing: true, ...o });
const MIFFY = { SKU: '24182601', Name: 'Miffy ECO ...', InnerCartonQuantity: 4, OuterCartonQuantity: 12, Suppliers: [
  { SupplierName: 'IBTT - EURO', Currency: 'EUR', Cost: 7.65, FixedCost: 0, LastSuppliedDate: '2025-11-27T00:00:00', IncludeInPricing: true },
  { SupplierName: 'IBTT - USD', Currency: 'USD', Cost: 5.7, FixedCost: 5.72, LastSuppliedDate: '2026-10-09T00:00:00', IncludeInPricing: true }] };

console.log('--- Status');
const labels = new Map([['eol', 'EOL'], ['discontinued', 'Discontinued'], ['preorder_only', 'Preorder Only'], ['phasing_out', 'Phasing Out'], ['customer_only', 'For Customer Only Then Cease']]);
ok('a normal product is Active', statusOf('Active', null, labels) === 'Active' && statusOf(null, null, labels) === 'Active' && statusOf('Active', '', labels) === 'Active');
ok('DEAR having it as Deprecated, or its stage being Discontinued, is Discontinued', statusOf('Deprecated', null, labels) === 'Discontinued' && statusOf('Active', 'discontinued', labels) === 'Discontinued' && statusOf('Deprecated', 'eol', labels) === 'Discontinued');
ok('a product with a stage shows the stage, in the team\'s words', statusOf('Active', 'eol', labels) === 'EOL' && statusOf('Active', 'preorder_only', labels) === 'Preorder Only' && statusOf('Active', 'customer_only', labels) === 'For Customer Only Then Cease');
ok('a stage the list does not know is made readable, and EOL still reads EOL with no list at all', statusOf('Active', 'new_ss27') === 'New Ss27' && statusOf('Active', 'eol') === 'EOL' && statusOf('Active', 'phasing_out') === 'Phasing Out');
ok('an empty label falls back to the readable key', statusOf('Active', 'phasing_out', new Map([['phasing_out', '  ']])) === 'Phasing Out');

console.log('--- inner and outer carton');
ok('the Miffy product: inner 4, outer 12', cartonsOf(MIFFY).inner === 4 && cartonsOf(MIFFY).outer === 12);
ok('other well-known DEAR names are found', cartonsOf({ CartonInnerQuantity: 6, CartonOuterQuantity: 24 }).inner === 6 && cartonsOf({ CartonInnerQuantity: 6, CartonOuterQuantity: 24 }).outer === 24 && cartonsOf({ CartonQuantity: 10 }).outer === 10 && cartonsOf({ CartonQuantity: 10 }).inner === null);
ok('a field with inner (or outer) and carton or quantity in its name is found even if it is spelled another way', cartonsOf({ 'Inner carton quantity': 3, OuterCartonUnits: 9, 'Outer Carton Qty (units)': 8 }).inner === 3 && cartonsOf({ 'Outer Carton Qty (units)': 8 }).outer === 8);
ok('the well-known outer name wins over the plain CartonQuantity', cartonsOf({ CartonQuantity: 5, OuterCartonQuantity: 12 }).outer === 12);
ok('0 means "not set" in DEAR, so it is blank, as are empty, text, negative and missing', cartonsOf({ InnerCartonQuantity: 0, OuterCartonQuantity: '' }).inner === null && cartonsOf({ InnerCartonQuantity: 'lots' }).inner === null && cartonsOf({ InnerCartonQuantity: -4 }).inner === null && cartonsOf({}).inner === null && cartonsOf(null).outer === null);
ok('numbers typed as text are read, and a fraction is rounded', cartonsOf({ InnerCartonQuantity: ' 12 ', OuterCartonQuantity: '24' }).inner === 12 && cartonsOf({ InnerCartonQuantity: 3.6 }).inner === 4);
process.env.DEAR_INNER_CARTON_FIELD = 'AdditionalAttribute4'; process.env.DEAR_OUTER_CARTON_FIELD = 'AdditionalAttribute5';
ok('the fields can be named in the settings, and then only those are used', cartonsOf({ AdditionalAttribute4: 8, AdditionalAttribute5: 32, InnerCartonQuantity: 99 }).inner === 8 && cartonsOf({ AdditionalAttribute4: 8, AdditionalAttribute5: 32 }).outer === 32 && cartonsOf({ InnerCartonQuantity: 99 }).inner === null && cartonKey({ AdditionalAttribute4: 8 }, 'inner') === 'AdditionalAttribute4');
delete process.env.DEAR_INNER_CARTON_FIELD; delete process.env.DEAR_OUTER_CARTON_FIELD;

console.log('--- supplier cost: the Miffy example the sales team confirms');
const m = supplierCostOf(MIFFY)!;
ok('two suppliers: the one supplied most recently (IBTT - USD, 9 Oct 2026) wins, at its fixed price 5.72, in USD', m.cost === 5.72 && m.currency === 'USD' && m.supplier === 'IBTT - USD', JSON.stringify(m));
ok('it does not matter which supplier is listed first', supplierCostOf({ Suppliers: [...MIFFY.Suppliers].reverse() })!.cost === 5.72);
ok('with a fixed price of 0 the latest price is used (the euro supplier: 7.65 EUR)', supplierCostOf({ Suppliers: [MIFFY.Suppliers[0]] })!.cost === 7.65 && supplierCostOf({ Suppliers: [MIFFY.Suppliers[0]] })!.currency === 'EUR');
ok('a fixed price beats the latest price', supplierCostOf({ Suppliers: [sup({ Cost: 9, FixedCost: 8 })] })!.cost === 8 && supplierCostOf({ Suppliers: [sup({ Cost: 9, FixedCost: 0 })] })!.cost === 9);
ok('the most recent date wins, whichever of several it is', supplierCostOf({ Suppliers: [sup({ SupplierName: 'A', Cost: 1, LastSuppliedDate: '2026-01-01' }), sup({ SupplierName: 'B', Cost: 2, LastSuppliedDate: '2026-06-01' }), sup({ SupplierName: 'C', Cost: 3, LastSuppliedDate: '2026-03-01' })] })!.supplier === 'B');
ok('a supplier with a date beats one with no date; with no dates at all the first one wins', supplierCostOf({ Suppliers: [sup({ SupplierName: 'A', Cost: 1 }), sup({ SupplierName: 'B', Cost: 2, LastSuppliedDate: '2020-01-01' })] })!.supplier === 'B' && supplierCostOf({ Suppliers: [sup({ SupplierName: 'A', Cost: 1 }), sup({ SupplierName: 'B', Cost: 2 })] })!.supplier === 'A');
ok('a supplier not ticked "Include in pricing" is ignored when another is ticked, even if it was supplied more recently', supplierCostOf({ Suppliers: [sup({ SupplierName: 'Old', Cost: 1, LastSuppliedDate: '2020-01-01' }), sup({ SupplierName: 'Unticked', Cost: 2, LastSuppliedDate: '2026-01-01', IncludeInPricing: false })] })!.supplier === 'Old');
ok('if none is ticked, they are all considered', supplierCostOf({ Suppliers: [sup({ SupplierName: 'A', Cost: 1, IncludeInPricing: false, LastSuppliedDate: '2026-01-01' }), sup({ SupplierName: 'B', Cost: 2, IncludeInPricing: false, LastSuppliedDate: '2025-01-01' })] })!.supplier === 'A');
ok('a supplier with no price at all is skipped, even if it was supplied most recently', supplierCostOf({ Suppliers: [sup({ SupplierName: 'NoPrice', LastSuppliedDate: '2026-12-01' }), sup({ SupplierName: 'Priced', Cost: 4, LastSuppliedDate: '2020-01-01' })] })!.supplier === 'Priced');
ok('no suppliers, an empty list, or none with a price is blank', supplierCostOf({}) === null && supplierCostOf({ Suppliers: [] }) === null && supplierCostOf({ Suppliers: [sup({})] }) === null && supplierCostOf(null) === null && supplierCostOf({ Suppliers: 'x' }) === null && supplierCostOf({ Suppliers: [null, 5, 'x'] }) === null);
ok('zero, negative and text prices are not prices', supplierCostOf({ Suppliers: [sup({ Cost: -3, FixedCost: 0 })] }) === null && supplierCostOf({ Suppliers: [sup({ Cost: 'free' })] }) === null);
ok('prices typed as text with a dollar sign or comma are read; the price is kept to four decimals', supplierCostOf({ Suppliers: [sup({ Cost: '$1,234.50' })] })!.cost === 1234.5 && supplierCostOf({ Suppliers: [sup({ Cost: 1.23456789 })] })!.cost === 1.2346);
ok('the currency is shown in capitals, and is blank (never guessed) when DEAR has none', supplierCostOf({ Suppliers: [sup({ Currency: 'usd', Cost: 1 })] })!.currency === 'USD' && supplierCostOf({ Suppliers: [{ SupplierName: 'S', Cost: 3 }] })!.currency === null);
ok('another way of naming the fields works too (Name, CurrencyName, LatestPrice, FixedPrice, LastSupplied, IncludedInPricing)', (() => { const r = supplierCostOf({ Suppliers: [{ Name: 'X', CurrencyName: 'gbp', LatestPrice: 2.5, FixedPrice: 0, LastSupplied: '10/03/2026', IncludedInPricing: 'true' }] }); return r?.cost === 2.5 && r.currency === 'GBP' && r.supplier === 'X'; })());
ok('a supplier with no name still gives its cost', supplierCostOf({ Suppliers: [{ Cost: 7 }] })!.supplier === null && supplierCostOf({ Suppliers: [{ Cost: 7 }] })!.cost === 7);
ok('dates are read both as DEAR sends them and as DEAR shows them (day first)', whenOf('2026-10-09T00:00:00') === Date.UTC(2026, 9, 9) && whenOf('09/10/2026') === Date.UTC(2026, 9, 9) && whenOf('27/11/2025') === Date.UTC(2025, 10, 27) && whenOf('') === 0 && whenOf(null) === 0 && whenOf('soon') === 0);
ok('a tie on the date keeps the first listed', supplierCostOf({ Suppliers: [sup({ SupplierName: 'A', Cost: 1, LastSuppliedDate: '2026-01-01' }), sup({ SupplierName: 'B', Cost: 2, LastSuppliedDate: '2026-01-01' })] })!.supplier === 'A');

console.log('--- the plain-words explanation (for the check script and the sales sheet)');
const ex = explainProduct(MIFFY).join('\n');
ok('it names the SKU, the carton fields it found and what it chose', /SKU 24182601/.test(ex) && /field "InnerCartonQuantity" = 4 -> 4/.test(ex) && /field "OuterCartonQuantity" = 12 -> 12/.test(ex) && /Suppliers in DEAR: 2/.test(ex) && /Supplier cost chosen: 5.72 USD from IBTT - USD/.test(ex));
ok('and says plainly when it found nothing', /no field found/.test(explainProduct({ SKU: 'X' }).join('\n')) && /Supplier cost: blank/.test(explainProduct({ SKU: 'X' }).join('\n')));
console.log(`\npassed: ${pass}   failed: ${fail}`); process.exit(fail ? 1 : 0);
