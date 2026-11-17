// READ-ONLY CHECK against your real DEAR: shows what Radar reads from one purchase order (its lines, Liewood's invoices and the stock received against each).
// It only reads. Run it from the API folder with the DEAR keys set as they are for the API:   npx tsx scripts/find-dear-purchase-docs.ts PO-00089
import { fetchDearPo, normalisePo } from '../src/lib/liewood';
import { dearGet } from '../src/sync/dearClient';

const po = normalisePo(process.argv[2] ?? '');
if (!po) { console.log('Give a purchase order number, for example:  npx tsx scripts/find-dear-purchase-docs.ts PO-00089'); process.exit(1); }
const deps = { dearGet, readPdf: async () => null, alert: async () => ({ sent: false, reason: 'probe' }) };
const { id, purchase } = await fetchDearPo(po, deps);
const units = (ls: { qty: number }[]) => ls.reduce((t, l) => t + l.qty, 0);
console.log(`${po} (DEAR id ${id}), status ${purchase.status ?? '?'}`);
console.log(`Order lines: ${purchase.ordered.length} SKUs, ${units(purchase.ordered)} units`);
for (const inv of purchase.invoices) {
  const rec = purchase.receipts.filter(r => r.key === inv.key);
  console.log(`Invoice ${inv.number ?? '(no number)'} ${inv.date ?? ''}: ${inv.lines.length} SKUs, ${units(inv.lines)} units. Received against it: ${rec.length ? `${units(rec.flatMap(r => r.lines))} units` : 'nothing yet'}`);
}
const loose = purchase.receipts.filter(r => !purchase.invoices.some(i => i.key === r.key));
if (loose.length) console.log(`Stock received not tied to an invoice: ${loose.map(r => `${units(r.lines)} units on ${r.date ?? '?'}`).join(', ')}`);
console.log(`\nFields DEAR sent: ${purchase.fields.join(', ')}`);
console.log('\nIf the invoices and units above match DEAR (PO-00089: SI0010427759 2206, SI0010425438 1040, SI0010398085 1092), the tally will be right. If not, send me this output.');
