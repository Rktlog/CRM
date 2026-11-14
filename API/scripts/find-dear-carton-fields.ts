// READ-ONLY CHECK against your real DEAR: shows, for one product, where DEAR keeps the inner carton, outer carton and supplier cost, and what Radar would put in the sheet.
// It only reads. Run it from the API folder with the DEAR keys set as they are for the API:   npx tsx scripts/find-dear-carton-fields.ts 24182601
import { explainProduct } from '../src/lib/productCartons';
import { dearGet } from '../src/sync/dearClient';

const sku = process.argv[2];
if (!sku) { console.log('Give a SKU, for example:  npx tsx scripts/find-dear-carton-fields.ts 24182601'); process.exit(1); }
const data = await dearGet('/product', { Sku: sku, Limit: 1, IncludeSuppliers: 'true' });   // DEAR leaves the suppliers out unless asked
const p = (data.Products ?? []).find((x: any) => String(x.SKU).toLowerCase() === sku.toLowerCase());
if (!p) { console.log(`DEAR has no product with the SKU ${sku}.`); process.exit(1); }
console.log(explainProduct(p).join('\n'));
const near = Object.keys(p).filter(k => /carton|inner|outer|supplier/i.test(k));
console.log('\nEvery field on this product with carton, inner, outer or supplier in its name:\n  ' + (near.length ? near.join('\n  ') : '(none)'));
if (Array.isArray(p.Suppliers) && p.Suppliers[0]) console.log('\nThe fields on a supplier line:\n  ' + Object.keys(p.Suppliers[0]).join('\n  '));
console.log('\nIf the numbers above match what DEAR shows (for the Miffy ECO product: inner 4, outer 12, USD 5.72), the sheet will be right. If a field is missing, send me this output.');
