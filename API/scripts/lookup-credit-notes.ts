/**
 * Prints the credit notes on one or more orders, straight from DEAR: each credit note's number, date, status, total, and every line
 * (SKU, name, quantity), plus any field on the note or a line that looks like a "restock" or "return" flag. Used to see whether
 * credit note lines can feed the Inventory Movement Details report (customer returns), and whether DEAR says if the stock went back.
 *
 * Usage:
 *   npx tsx scripts/lookup-credit-notes.ts SQ36619 SQ37620 SQ37625
 *   npx tsx scripts/lookup-credit-notes.ts SQ36619 --raw      also prints each credit note exactly as DEAR sent it
 *
 * Read-only: nothing is written anywhere. It prints no keys or passwords.
 */
import 'dotenv/config';
import { dearGet } from '../src/sync/dearClient';

const args = process.argv.slice(2);
const raw = args.includes('--raw');
const orders = args.filter(a => !a.startsWith('--'));

const FLAGGY = /restock|return|stock|inventory|location/i;
const asArray = (v: any): any[] => (Array.isArray(v) ? v : v ? [v] : []);
const flags = (o: any) => Object.entries(o ?? {}).filter(([k]) => FLAGGY.test(k)).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('  ');

async function main() {
  if (!orders.length) {
    console.error('Usage: npx tsx scripts/lookup-credit-notes.ts <order-number> [<order-number> ...] [--raw]');
    process.exit(1);
  }
  for (const orderNumber of orders) {
    console.log(`\n==================== ${orderNumber}`);
    const found = await dearGet('/saleList', { Limit: 5, search: orderNumber });
    const match = (found.SaleList ?? []).find((s: any) => String(s.OrderNumber) === orderNumber);
    if (!match) { console.log('Not found in DEAR.'); continue; }
    const detail = await dearGet('/sale', { ID: match.SaleID });
    console.log(`Status: ${detail.Status}   Customer: ${detail.Customer}`);
    console.log(`Credit-note keys present on the sale: ${Object.keys(detail).filter(k => /credit/i.test(k)).join(', ') || '(none)'}`);

    const notes = asArray(detail.CreditNotes ?? detail.CreditNote);
    if (!notes.length) { console.log('No credit notes on this order.'); continue; }

    for (const cn of notes) {
      console.log(`\n  Credit note ${cn.CreditNoteNumber ?? cn.Number ?? '(no number)'}  date ${cn.CreditNoteDate ?? cn.Date ?? '?'}  status ${cn.Status ?? '?'}  total ${cn.Total ?? '?'}`);
      console.log(`  Fields on the note: ${Object.keys(cn).join(', ')}`);
      const noteFlags = flags(cn);
      if (noteFlags) console.log(`  Stock-looking fields on the note: ${noteFlags}`);
      const lines = asArray(cn.Lines);
      console.log(`  Lines (${lines.length}):`);
      for (const l of lines) {
        console.log(`    ${String(l.SKU ?? '(no SKU)').padEnd(22)} qty ${String(l.Quantity ?? '?').padEnd(6)} ${String(l.Name ?? '').slice(0, 40)}`);
        const lf = flags(l);
        if (lf) console.log(`      ${lf}`);
      }
      if (lines[0]) console.log(`  Fields on a line: ${Object.keys(lines[0]).join(', ')}`);
      if (raw) console.log(JSON.stringify(cn, null, 2));
    }
  }
  console.log('\nCompare with DEAR\'s Inventory Movement Details: SQ36619 should show in 4, 2 and 2 (APC-031-G, APC-029-G, APC-035-G), SQ37620 in 6 and 6 (MF_CAPNVY-S, MF_CAPWHT-S), SQ37625 in 1 and out 1 (101062021).');
}

main().catch(e => { console.error(e); process.exit(1); });