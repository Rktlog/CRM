// Tests the standalone credit notes sync logic with a pretend DEAR and pretend storage. No DEAR, no database.   Run:  npx tsx scripts/test-standalone-credit-sync.ts
import { dayOf, docCharges, docGoods, isStandalone, notesFromSale, syncStandaloneCreditNotes, type Deps, type NoteRow } from '../src/lib/standaloneCredits';

let pass = 0, fail = 0;
const ok = (n: string, c: unknown, x = '') => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (x ? '  ' + x : '')); } };
const eq = (n: string, got: unknown, want: unknown) => ok(n, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} wanted ${JSON.stringify(want)}`);

// the record DEAR really sends for a standalone credit note (CR02604), reduced to what matters
const entry = (n: number, o: Record<string, unknown> = {}) => ({ SaleID: `sale-${n}`, OrderNumber: `SQ${36900 + n}`, Customer: `Shop ${n}`, CustomerID: `cust-${n}`, CreditNoteNumber: `CR026${n.toString().padStart(2, '0')}`, Type: 'Sale Credit Note', OrderDate: '2026-07-29T00:00:00', Updated: `2026-08-04T01:${String(n % 60).padStart(2, '0')}:00.000Z`, ...o });
const detail = (cr: string, o: Record<string, unknown> = {}) => ({ Type: 'Service Sale', CreditNotes: [{ CreditNoteNumber: cr, CreditNoteDate: '2026-07-29T00:00:00', Status: 'AUTHORISED', Total: 25.25, Tax: 2.3, TotalBeforeTax: 22.95, Memo: 'faulty', Lines: [{ SKU: 'X1', Name: 'Item', Quantity: 1, Total: 22.95, Tax: 2.3 }], ...o }] });

function world(over: { entries?: any[]; details?: Record<string, any>; ordinary?: string[]; stored?: [string, { updated: string | null; status: string | null }][]; shops?: Record<string, string>; rateLimitAt?: string } = {}) {
  const calls: string[] = [], saved: NoteRow[] = [];
  const entries = over.entries ?? [];
  const get = async (path: string, params?: Record<string, string | number>) => {
    calls.push(path + ' ' + JSON.stringify(params));
    if (path === '/saleCreditNoteList') { const page = Number(params?.Page ?? 1), limit = Number(params?.Limit ?? 100); return { Total: entries.length, Page: page, SaleList: entries.slice((page - 1) * limit, page * limit) }; }
    if (path === '/sale') { if (params?.ID === over.rateLimitAt) throw new Error('DEAR API /sale rate limited even after waiting.'); const d = over.details?.[String(params?.ID)]; if (!d) throw new Error('DEAR API /sale failed: 404'); return d; }
    throw new Error('unexpected ' + path);
  };
  const deps: Deps = {
    get, ordinarySaleIds: async ids => new Set(ids.filter(i => (over.ordinary ?? []).includes(i))), stored: async () => new Map(over.stored ?? []),
    findAccount: async (id, name) => (id && over.shops?.[id]) || (name && over.shops?.[name]) || null, save: async r => { saved.push(r); },
  };
  return { deps, calls, saved };
}

async function main() {
  console.log('--- the amounts: the same rule as the live sync');
  eq('tax-exclusive note: goods 22.95, no charges, tax 2.30, total 25.25 (CR02604 as DEAR sends it)', [docGoods(detail('CR').CreditNotes[0]), docCharges(detail('CR').CreditNotes[0])], [22.95, 0]);
  const nr = notesFromSale(entry(4), detail('CR02604'), 'acct-1').rows[0]!;
  eq('the row for it', [nr.creditNoteNumber, nr.noteDay, nr.goods, nr.tax, nr.total, nr.status, nr.accountId, nr.saleNumber], ['CR02604', '2026-07-29', 22.95, 2.3, 25.25, 'AUTHORISED', 'acct-1', 'SQ36904']);
  const inc = { Total: 25.25, Tax: 2.3, Lines: [{ SKU: 'X', Name: 'Item', Total: 25.25, Tax: 2.3 }], AdditionalCharges: [] };
  eq('GST-inclusive prices: the GST is taken out', docGoods(inc), 22.95);
  const withFreight = { Total: 38.5, Tax: 3.5, Lines: [{ SKU: 'X', Name: 'Item', Total: 25 }, { SKU: 'FREIGHT', Name: 'Freight', Total: 10 }], AdditionalCharges: [] };
  eq('a freight line is a charge, not goods', [docGoods(withFreight), docCharges(withFreight)], [25, 10]);
  const withDiscount = { Total: 38.5, Tax: 3.5, Lines: [{ SKU: 'X', Name: 'Item', Total: 40 }], AdditionalCharges: [{ Description: 'Discount', Total: -5 }, { Description: 'Courier', Total: 3 }] };
  eq('an order-level discount (a negative charge) comes off the goods; a positive charge stays out', [docGoods(withDiscount), docCharges(withDiscount)], [35, 3]);
  eq('the date is read as written, with no time zone shift', [dayOf('2026-07-29T00:00:00'), dayOf('2026-03-18'), dayOf(null), dayOf('nonsense')], ['2026-07-29', '2026-03-18', null, null]);
  eq('only a "Sale Credit Note" is standalone', [isStandalone({ Type: 'Sale Credit Note' }), isStandalone({ Type: 'sale credit note ' }), isStandalone({ Type: 'Advanced Sale' }), isStandalone({}), isStandalone(null)], [true, true, false, false, false]);
  eq('a draft credit note is not a credit note yet', notesFromSale(entry(1), detail('CR1', { Status: 'DRAFT' }), null).rows.length, 0);
  eq('two notes on one sale give two rows', notesFromSale(entry(1), { CreditNotes: [detail('CRa').CreditNotes[0], detail('CRb').CreditNotes[0]] }, null).rows.map(r => r.creditNoteNumber), ['CRa', 'CRb']);
  const noDate = notesFromSale(entry(1, { OrderDate: null }), detail('CR1', { CreditNoteDate: null }), null); eq('a note with no date is reported, not guessed', [noDate.rows.length, noDate.problems.length], [0, 1]);

  console.log('--- the sync');
  let w = world({ entries: [entry(1), entry(2)], details: { 'sale-1': detail('CR02601'), 'sale-2': detail('CR02602') }, shops: { 'cust-1': 'A1' } });
  let r = await syncStandaloneCreditNotes(w.deps, { since: '2026-01-01' });
  eq('two new standalone notes are listed, read and saved', [r.listed, r.standalone, r.read, r.saved, r.left], [2, 2, 2, 2, 0]);
  eq('the shop is matched by DEAR customer id, and a note whose shop Radar does not have is still saved, and counted', [w.saved.map(x => x.accountId), r.withoutShop], [['A1', null], 1]);
  ok('the list is asked for with the date, 100 at a time', /UpdatedSince/.test(w.calls[0]!) && /"Limit":100/.test(w.calls[0]!) && w.calls[0]!.includes('2026-01-01T00:00:00.000Z'), w.calls[0]);
  eq("DEAR's own total for the search is reported, so a date filter that is being ignored shows up", r.listTotal, 2);
  const many = Array.from({ length: 230 }, (_, i) => entry(i + 1)); w = world({ entries: many, details: {} });
  r = await syncStandaloneCreditNotes(w.deps, { since: '2026-01-01', maxDetails: 0 });
  eq('230 notes take 3 pages (100, 100, 30) and then it stops asking', [r.listed, w.calls.filter(c => c.startsWith('/saleCreditNoteList')).length], [230, 3]);
  w = world({ entries: [entry(1, { Type: 'Advanced Sale' }), entry(2)], details: { 'sale-2': detail('CR02602') } });
  r = await syncStandaloneCreditNotes(w.deps, { since: '2026-01-01' }); eq('an ordinary sale that only has a credit note is left to the sales sync', [r.standalone, r.saved, w.calls.filter(c => c.startsWith('/sale ')).length], [1, 1, 1]);
  w = world({ entries: [entry(1)], details: { 'sale-1': detail('CR02601') }, ordinary: ['sale-1'] }); r = await syncStandaloneCreditNotes(w.deps, { since: '2026-01-01' });
  eq('one that is already an ordinary order in Radar is skipped, never read', [r.ordinaryOrdersSkipped, r.read, r.saved], [1, 0, 0]);
  w = world({ entries: [entry(1)], details: { 'sale-1': detail('CR02601') }, stored: [['sale-1|CR02601', { updated: '2026-08-04T01:01:00.000Z', status: 'AUTHORISED' }]] }); r = await syncStandaloneCreditNotes(w.deps, { since: '2026-01-01' });
  eq('one already saved and unchanged is not read again', [r.alreadySaved, r.read], [1, 0]);
  w = world({ entries: [entry(1)], details: { 'sale-1': detail('CR02601') }, stored: [['sale-1|CR02601', { updated: '2026-08-01T00:00:00.000Z', status: 'AUTHORISED' }]] }); r = await syncStandaloneCreditNotes(w.deps, { since: '2026-01-01' });
  eq('one DEAR has changed since is read again and saved over', [r.alreadySaved, r.read, r.saved], [0, 1, 1]);
  w = world({ entries: [entry(1)], details: { 'sale-1': detail('CR02601', { Status: 'VOIDED' }) }, stored: [['sale-1|CR02601', { updated: '2026-08-01T00:00:00.000Z', status: 'AUTHORISED' }]] }); r = await syncStandaloneCreditNotes(w.deps, { since: '2026-01-01' });
  eq('a saved note that was voided later is updated to VOIDED so it stops counting', [r.voidedUpdated, r.saved, w.saved[0]?.status], [1, 0, 'VOIDED']);
  w = world({ entries: [entry(1)], details: { 'sale-1': detail('CR02601', { Status: 'VOIDED' }) } }); r = await syncStandaloneCreditNotes(w.deps, { since: '2026-01-01' });
  eq('a note that was never saved and is already voided is not kept', [w.saved.length, r.saved], [0, 0]);
  w = world({ entries: [1, 2, 3, 4, 5].map(i => entry(i)), details: Object.fromEntries([1, 2, 3, 4, 5].map(i => [`sale-${i}`, detail(`CR0260${i}`)])) }); r = await syncStandaloneCreditNotes(w.deps, { since: '2026-01-01', maxDetails: 2 });
  eq('a cap of 2 reads 2, saves 2 and says 3 are left for next time', [r.read, r.saved, r.left], [2, 2, 3]);
  w = world({ entries: [entry(1), entry(2), entry(3)], details: { 'sale-1': detail('CR02601'), 'sale-3': detail('CR02603') }, rateLimitAt: 'sale-2' }); r = await syncStandaloneCreditNotes(w.deps, { since: '2026-01-01' });
  eq('DEAR saying slow down stops the run cleanly, keeps what was saved, and says how many are left', [r.stoppedEarly, r.saved, r.left], ['rateLimit', 1, 2]);
  w = world({ entries: [entry(1), entry(2)], details: { 'sale-2': detail('CR02602') } }); r = await syncStandaloneCreditNotes(w.deps, { since: '2026-01-01' });
  eq('one that cannot be read is reported and the next one still goes ahead', [r.saved, r.problems.length, /could not read/.test(r.problems[0] ?? '')], [1, 1, true]);
  let t = 0; w = world({ entries: [1, 2, 3].map(i => entry(i)), details: Object.fromEntries([1, 2, 3].map(i => [`sale-${i}`, detail(`CR0260${i}`)])) }); w.deps.now = () => (t += 30_000);
  r = await syncStandaloneCreditNotes(w.deps, { since: '2026-01-01', budgetMs: 45_000 }); eq('a run that has used up its time stops and says so', [r.stoppedEarly, r.left > 0], ['time', true]);
  w = world({ entries: [entry(1, { Updated: '2026-08-05T00:00:00Z' }), entry(2, { Updated: '2026-08-01T00:00:00Z' })], details: { 'sale-1': detail('CR02601'), 'sale-2': detail('CR02602') } }); r = await syncStandaloneCreditNotes(w.deps, { since: '2026-01-01', maxDetails: 1 });
  eq('the oldest change is read first, so a stopped run carries on where it left off', w.saved.map(x => x.creditNoteNumber), ['CR02602']);
  w = world({ entries: [], details: {} }); r = await syncStandaloneCreditNotes(w.deps, { since: '2026-01-01' }); eq('nothing to do is fine', [r.listed, r.saved, r.left], [0, 0, 0]);
  console.log(`\npassed: ${pass}   failed: ${fail}`); process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
