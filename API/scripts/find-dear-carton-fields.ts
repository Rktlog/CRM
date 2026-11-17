// READ-ONLY CHECK against your real DEAR: shows, for one product, where DEAR keeps the inner carton, outer carton, supplier cost and ETA, and what Radar would put in the sheet.
// It only reads. Run it from the API folder with the DEAR keys set as they are for the API:   npx tsx scripts/find-dear-carton-fields.ts LW20396-3230-ONE\ SIZE-CU
import { etaFieldFor, etaOf, explainProduct, fetchEtaFields } from '../src/lib/productCartons';
import { dearGet } from '../src/sync/dearClient';

const sku = process.argv.slice(2).join(' ').trim();
if (!sku) { console.log('Give a SKU, for example:  npx tsx scripts/find-dear-carton-fields.ts 24182601'); process.exit(1); }
const data = await dearGet('/product', { Sku: sku, Limit: 1, IncludeSuppliers: 'true' });   // DEAR leaves the suppliers out unless asked
const p = (data.Products ?? []).find((x: any) => String(x.SKU).toLowerCase() === sku.toLowerCase());
if (!p) { console.log(`DEAR has no product with the SKU ${sku}.`); process.exit(1); }
console.log(explainProduct(p).join('\n'));
const fields = await fetchEtaFields(), etaField = etaFieldFor(p, fields);
console.log(`\nAttribute set of this product: ${p.AttributeSet ?? '(none)'}`);
console.log(`ETA: ${etaField ? `field "${etaField}" = ${JSON.stringify(p[etaField])} -> ${etaOf(p, etaField) ?? 'blank'}` : 'no attribute called ETA was found in DEAR\'s attribute set settings'}`);
console.log('The extra fields on this product (DEAR\'s Additional Attributes):');
for (let i = 1; i <= 10; i++) console.log(`  AdditionalAttribute${i}: ${JSON.stringify(p[`AdditionalAttribute${i}`] ?? null)}`);
const near = Object.keys(p).filter(k => /carton|inner|outer|supplier/i.test(k));
console.log('\nEvery field on this product with carton, inner, outer or supplier in its name:\n  ' + (near.length ? near.join('\n  ') : '(none)'));
console.log('\nIf ETA shows what DEAR shows for this product (for LW20396-3230-ONE SIZE-CU: Nov-26), the sheet will be right. If not, send me this output.');
