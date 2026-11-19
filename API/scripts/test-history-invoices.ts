// Run from the API folder:  npx tsx scripts/test-history-invoices.ts
import assert from 'node:assert/strict';
import { asSales } from '../src/lib/salesRules';

let n = 0;
const ok = (name: string, fn: () => void) => { fn(); n++; console.log('ok  ' + name); };
const months = (rows: any[]) => {
  const m: Record<string, number> = {};
  for (const r of rows) { const k = new Date(r.sentAt).toISOString().slice(0, 7); m[k] = Math.round(((m[k] ?? 0) + r.amount) * 100) / 100; }
  return m;
};
const inv = (number: string, date: string, goods: number, status = 'PAID') => ({ number, date, goods, total: goods * 1.1, status, paid: goods * 1.1, credited: 0 });
const base = { source: 'rhino-history', number: 'Q29878', paid: true, amount: 7439.46, sentAt: new Date('2025-02-19T00:00:00Z'), invoiceDate: new Date('2025-02-19T00:00:00Z'), goodsTotal: 7439.46, taxTotal: null };

ok('old order with no invoice list is still one lump on its order date', () => {
  assert.deepEqual(months(asSales({ ...base, invoices: [], creditNotes: [] })), { '2025-02': 7439.46 });
});
ok('old unpaid order with no invoice list still counts nothing', () => {
  assert.deepEqual(asSales({ ...base, paid: false, invoices: [] }), []);
});
ok('old order with an invoice list counts each invoice in its own month, and the credit note on its date', () => {
  const rows = asSales({
    ...base,
    invoices: [inv('INV31460', '2025-02-19T00:00:00', 5354.8), inv('INV31573', '2025-03-11T00:00:00', 659.56), inv('INV31685', '2025-03-11T00:00:00', 464.64), inv('INV31886', '2025-06-13T00:00:00', 2052.37)],
    creditNotes: [{ number: 'CR100', date: '2025-05-02T00:00:00', goods: 9.98, status: 'AUTHORISED' }],
  });
  assert.deepEqual(months(rows), { '2025-02': 5354.8, '2025-03': 1124.2, '2025-05': -9.98, '2025-06': 2052.37 });
  assert.equal(rows.filter(r => r.isCredit).length, 1);
});
ok('an old order that is not marked paid still counts its invoices (like every other order)', () => {
  const rows = asSales({ ...base, paid: false, invoices: [inv('INV1', '2025-04-02T00:00:00', 100)] });
  assert.deepEqual(months(rows), { '2025-04': 100 });
});
ok('an old order whose invoices are all voided falls back to the lump', () => {
  assert.deepEqual(months(asSales({ ...base, invoices: [inv('INV1', '2025-04-02T00:00:00', 100, 'VOIDED')] })), { '2025-02': 7439.46 });
});
ok('a live order is not affected', () => {
  const live = { source: 'cin7', number: 'SQ1', paid: true, amount: 110, sentAt: new Date('2026-01-01T00:00:00Z'), invoiceDate: null, fulfillmentStatus: 'COMPLETED', goodsTotal: 100, taxTotal: 10,
    invoices: [inv('INVC1', '2026-01-02T00:00:00', 100)], creditNotes: [] };
  assert.deepEqual(months(asSales(live)), { '2026-01': 100 });
});
console.log(`${n} checks passed`);
