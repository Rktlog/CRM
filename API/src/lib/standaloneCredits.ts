// Standalone credit notes: credit notes that are a sale of their own in DEAR (Type "Sale Credit Note", their own SQ number) and are on no order.
// DEAR keeps them in a separate list, /saleCreditNoteList. Radar's sales sync only reads /saleList, so it never saw them, and Sales Data ran high by their
// amounts. This reads that list and saves each note in crm.standalone_credit_notes (apart from the orders table, so nothing that reads orders can mistake a
// credit note for an order). Pure logic with the outside world passed in, so it can be tested; runStandaloneCreditNotes() below wires it to DEAR and the database.

export type Get = (path: string, params?: Record<string, string | number>) => Promise<any>;
const arr = (v: any): any[] => (Array.isArray(v) ? v : v ? [v] : []);
const addUp = (xs: any[], f: (x: any) => number) => xs.reduce((s, x) => s + (Number(f(x)) || 0), 0);
const toCents = (n: number) => Math.round(n * 100) / 100;

// ---- What Sales Data counts for a document: ported from the live sales sync (supabase function sync-sales, docGoods / docCharges), so a standalone note is
// worked out exactly like a credit note on an order. Product lines after discount, ex GST, ex freight and ex card surcharge; an order-level discount is a
// NEGATIVE additional charge and comes off the goods; positive charges (freight, surcharge) stay out. GST-inclusive prices have their GST taken out.
const isChargeLine = (l: any) => /surcharge|freight/i.test(`${l?.SKU ?? ''} ${l?.Name ?? ''}`);
const isRrCredit = (c: any) => /^\s*rr credit/i.test(String(c?.Description ?? c?.Name ?? ''));   // a sales credit, not freight: counts as goods
function isTaxInclusive(doc: any): boolean {
  if (typeof doc?.TaxInclusive === 'boolean') return doc.TaxInclusive;
  const lines = addUp(arr(doc?.Lines), l => l.Total);
  const charges = addUp(arr(doc?.AdditionalCharges), c => c.Total);
  return Number(doc?.Tax ?? 0) > 0.01 && Math.abs(Number(doc?.Total ?? 0) - (lines + charges)) < 0.02;
}
const exTax = (row: any, inclusive: boolean) => (Number(row?.Total) || 0) - (inclusive ? Number(row?.Tax) || 0 : 0);
export function docGoods(doc: any): number {
  const inc = isTaxInclusive(doc);
  return toCents(addUp(arr(doc?.Lines).filter((l: any) => !isChargeLine(l)), l => exTax(l, inc)) + addUp(arr(doc?.AdditionalCharges).filter((c: any) => Number(c.Total) < 0 || isRrCredit(c)), c => exTax(c, inc)));
}
export function docCharges(doc: any): number {
  const inc = isTaxInclusive(doc);
  return toCents(addUp(arr(doc?.AdditionalCharges).filter((c: any) => Number(c.Total) >= 0 && !isRrCredit(c)), c => exTax(c, inc)) + addUp(arr(doc?.Lines).filter(isChargeLine), l => exTax(l, inc)));
}

// DEAR sends dates with no time zone ("2026-07-29T00:00:00"): they are Melbourne calendar days. Take the day exactly as written, never through new Date().
export const dayOf = (v: unknown): string | null => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);

// A standalone credit note is a list entry of Type "Sale Credit Note". An ordinary order that merely HAS a credit note is not one: its notes are carried
// on the order by the sales sync.
export const isStandalone = (entry: any): boolean => String(entry?.Type ?? '').trim().toLowerCase() === 'sale credit note';

export type NoteRow = {
  dearSaleId: string; saleNumber: string; creditNoteNumber: string; noteDay: string; status: string | null;
  goods: number; charges: number; tax: number; total: number; memo: string | null;
  customerName: string | null; dearCustomerId: string | null; accountId: string | null; dearUpdated: string | null;
};

// Each credit note on the sale record DEAR gave for a standalone credit note. A draft is not a credit note yet. Voided ones are kept (with that status) so
// a note that was saved and later voided stops counting.
export function notesFromSale(entry: any, detail: any, accountId: string | null): { rows: NoteRow[]; problems: string[] } {
  const rows: NoteRow[] = [], problems: string[] = [];
  for (const cn of arr(detail?.CreditNotes ?? detail?.CreditNote)) {
    const status = String(cn?.Status ?? '').toUpperCase();
    if (status === 'DRAFT') continue;
    const number = String(cn?.CreditNoteNumber ?? cn?.Number ?? entry?.CreditNoteNumber ?? '').trim();
    const day = dayOf(cn?.CreditNoteDate ?? cn?.Date) ?? dayOf(entry?.OrderDate);
    if (!number) { problems.push(`${entry?.OrderNumber}: a credit note with no number`); continue; }
    if (!day) { problems.push(`${number}: no date`); continue; }
    rows.push({
      dearSaleId: String(entry.SaleID), saleNumber: String(entry.OrderNumber ?? ''), creditNoteNumber: number, noteDay: day, status: cn?.Status ?? null,
      goods: docGoods(cn), charges: docCharges(cn), tax: toCents(Number(cn?.Tax ?? 0)), total: toCents(Number(cn?.Total ?? 0)), memo: cn?.Memo ? String(cn.Memo).slice(0, 500) : null,
      customerName: entry?.Customer ? String(entry.Customer) : null, dearCustomerId: entry?.CustomerID ? String(entry.CustomerID) : null, accountId,
      dearUpdated: typeof entry?.Updated === 'string' ? entry.Updated : null,
    });
  }
  return { rows, problems };
}

export type Deps = {
  get: Get;                                                                  // DEAR
  ordinarySaleIds: (ids: string[]) => Promise<Set<string>>;                  // which of these DEAR sale ids are ordinary orders in crm.quotes
  stored: () => Promise<Map<string, { updated: string | null; status: string | null }>>;   // "saleId|CR number" already saved
  findAccount: (customerId: string | null, name: string | null) => Promise<string | null>;
  save: (row: NoteRow) => Promise<void>;
  now?: () => number;
};
export type Options = { since: string; search?: string[]; maxDetails?: number; budgetMs?: number; pageLimit?: number; maxPages?: number };
export type Result = {
  since: string; listed: number; listTotal: number | null; standalone: number; ordinaryOrdersSkipped: number; alreadySaved: number; read: number; saved: number; voidedUpdated: number;
  withoutShop: number; left: number; stoppedEarly: 'time' | 'rateLimit' | null; problems: string[];
};
const keyOf = (saleId: string, cr: string) => `${saleId}|${cr.toUpperCase()}`;
const isRateLimit = (e: unknown) => /rate limit/i.test(String((e as Error)?.message ?? e));
const msg = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 200);

// Reads the list by search term (one call per credit note number) instead of by date. For notes older than the date filter reaches.
async function searchTerms(d: Deps, terms: string[], limit: number, entries: Map<string, any>, res: Result, started: number, budgetMs: number): Promise<void> {
  const now = d.now ?? Date.now;
  for (const t of terms) {
    if (now() - started > budgetMs) { res.problems.push(`${t}: not searched, out of time (run it again)`); continue; }
    try {
      const r = await d.get('/saleCreditNoteList', { Page: 1, Limit: limit, Search: t });
      const batch: any[] = arr(r?.SaleList ?? Object.values(r ?? {}).find(Array.isArray));
      res.listed += batch.length;
      const hits = batch.filter(isStandalone);
      for (const e of hits) entries.set(String(e.SaleID), e);
      if (!hits.length) res.problems.push(`${t}: no standalone credit note found in DEAR`);
    } catch (err) {
      res.problems.push(`${t}: search failed (${msg(err)})`);
      if (isRateLimit(err)) { res.stoppedEarly = 'rateLimit'; break; }
    }
  }
}

export async function syncStandaloneCreditNotes(d: Deps, o: Options): Promise<Result> {
  const now = d.now ?? Date.now, started = now();
  const maxDetails = o.maxDetails ?? 40, budgetMs = o.budgetMs ?? 45_000, limit = o.pageLimit ?? 100, maxPages = o.maxPages ?? 60;
  const res: Result = { since: o.since, listed: 0, listTotal: null, standalone: 0, ordinaryOrdersSkipped: 0, alreadySaved: 0, read: 0, saved: 0, voidedUpdated: 0, withoutShop: 0, left: 0, stoppedEarly: null, problems: [] };

  // 1. the credit note list, page by page, since the date
  const entries = new Map<string, any>();
  if (o.search) await searchTerms(d, o.search, limit, entries, res, started, budgetMs);
  else for (let page = 1; page <= maxPages; page++) {
    const r = await d.get('/saleCreditNoteList', { Page: page, Limit: limit, UpdatedSince: new Date(`${o.since}T00:00:00Z`).toISOString() });
    const batch: any[] = arr(r?.SaleList ?? Object.values(r ?? {}).find(Array.isArray));
    for (const e of batch) if (e?.SaleID) entries.set(String(e.SaleID), e);
    res.listed += batch.length;
    if (page === 1 && Number.isFinite(Number(r?.Total))) res.listTotal = Number(r.Total);   // DEAR's own count for this search: if it is huge, the date filter is being ignored
    if (batch.length < limit) break;
  }
  const standalone = [...entries.values()].filter(isStandalone);
  res.standalone = standalone.length;

  // 2. leave out any that are really ordinary orders, and any already saved and unchanged
  const ordinary = standalone.length ? await d.ordinarySaleIds(standalone.map(e => String(e.SaleID))) : new Set<string>();
  const have = await d.stored();
  const todo: any[] = [];
  for (const e of standalone) {
    if (ordinary.has(String(e.SaleID))) { res.ordinaryOrdersSkipped++; continue; }
    const was = have.get(keyOf(String(e.SaleID), String(e.CreditNoteNumber ?? '')));
    if (was && was.updated && e.Updated && new Date(was.updated).getTime() >= new Date(e.Updated).getTime()) { res.alreadySaved++; continue; }
    todo.push(e);
  }
  todo.sort((a, b) => String(a.Updated ?? '').localeCompare(String(b.Updated ?? '')));   // oldest first, so a stopped run resumes where it left off

  // 3. read each one's full record and save its credit notes
  for (const [i, e] of todo.entries()) {
    if (res.read >= maxDetails) { res.left = todo.length - i; break; }
    if (now() - started > budgetMs) { res.stoppedEarly = 'time'; res.left = todo.length - i; break; }
    let detail: any;
    try { detail = await d.get('/sale', { ID: String(e.SaleID) }); res.read++; }
    catch (err) {
      if (isRateLimit(err)) { res.stoppedEarly = 'rateLimit'; res.left = todo.length - i; break; }
      res.problems.push(`${e.OrderNumber}: could not read it (${msg(err)})`); continue;
    }
    const accountId = await d.findAccount(e.CustomerID ? String(e.CustomerID) : null, e.Customer ? String(e.Customer) : null);
    const { rows, problems } = notesFromSale(e, detail, accountId);
    res.problems.push(...problems);
    for (const row of rows) {
      const was = have.get(keyOf(row.dearSaleId, row.creditNoteNumber));
      if (String(row.status ?? '').toUpperCase() === 'VOIDED' && !was) continue;   // never saved and already cancelled: nothing to keep
      try { await d.save(row); } catch (err) { res.problems.push(`${row.creditNoteNumber}: could not save it (${msg(err)})`); continue; }
      if (String(row.status ?? '').toUpperCase() === 'VOIDED') res.voidedUpdated++; else res.saved++;
      if (!accountId) res.withoutShop++;
    }
  }
  return res;
}
