// Several products asked for the same store at once: picked from the search, or pasted or uploaded as a list (SKU, quantity, note).
// Each product becomes its own request (so each can be answered on its own), made together, with ONE alert email for the lot.
// A list is checked first and shown back: SKUs Radar does not know, ones that appear twice, and ones this store has already asked for are flagged, and nothing is made until the person says so.
import { prisma } from './prisma';
import { createRequest, parseNewRequest, RequestError, type RequestItem } from './productRequests';

export const MAX_BULK = 100;
export type BulkRow = { line: number; sku: string; qty: number | null; note: string | null };
const OPEN = `('requested', 'seen', 'asked_supplier', 'supplier_replied')`;
function cells(line: string): string[] {
  if (line.includes('\t')) return line.split('\t').map(c => c.trim());   // pasted from a spreadsheet
  const out: string[] = []; let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false; } else cur += ch; }
    else if (ch === '"') quoted = true; else if (ch === ',' || ch === ';') { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  out.push(cur.trim()); return out;
}
/** A pasted or uploaded list: one product a line, as SKU, quantity, note (commas, semicolons or a spreadsheet's tabs). A heading line is skipped. */
export function parseBulkList(text: unknown): { rows: BulkRow[]; problems: string[] } {
  if (typeof text !== 'string' || !text.trim()) return { rows: [], problems: ['Paste or upload a list first.'] };
  if (text.length > 200_000) return { rows: [], problems: ['That list is too long. Send up to 100 products at a time.'] };
  const rows: BulkRow[] = [], problems: string[] = [];
  text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/).forEach((raw, i) => {
    const line = i + 1; if (!raw.trim()) return;
    const [sku = '', qtyText = '', ...rest] = cells(raw);
    if (rows.length === 0 && problems.length === 0 && /^(sku|product|code|item)\b/i.test(sku) && !/\d/.test(qtyText)) return;   // a heading
    if (!sku) { problems.push(`Line ${line}: there is no SKU.`); return; }
    if (sku.length > 80) { problems.push(`Line ${line}: that SKU is too long.`); return; }
    let qty: number | null = null;
    if (qtyText) { const q = Number(qtyText.replace(/[,\s]/g, '')); if (!Number.isInteger(q) || q < 1 || q > 100000) { problems.push(`Line ${line}: the quantity "${qtyText}" must be a whole number from 1 to 100000.`); return; } qty = q; }
    const note = rest.join(', ').trim().slice(0, 300) || null;
    if (rows.length >= MAX_BULK) { if (!problems.some(p => p.startsWith('Only'))) problems.push(`Only the first ${MAX_BULK} products are taken. Send the rest separately.`); return; }
    rows.push({ line, sku, qty, note });
  });
  return { rows, problems: problems.slice(0, 20) };
}
export type Checked = BulkRow & { status: 'ok' | 'unknown' | 'repeat' | 'already'; name: string | null; brand: string | null; available: number | null };
/** What Radar knows about each row: the product, and whether the store has already asked for it. Nothing is made. */
export async function checkBulk(rows: BulkRow[], customer: string | null): Promise<Checked[]> {
  const keys = [...new Set(rows.map(r => r.sku.trim().toUpperCase()))];
  const known = new Map((await prisma.$queryRaw<{ k: string; sku: string; name: string; brand: string | null; available: number | null }[]>`
    select upper(btrim(sku)) as k, sku, name, brand, available::float8 as available from crm.products where upper(btrim(sku)) = any(${keys}::text[])`).map(p => [p.k, p]));
  const already = new Set(customer ? (await prisma.$queryRawUnsafe<{ k: string }[]>(`select distinct upper(btrim(sku)) as k from crm.product_requests where status in ${OPEN} and sku is not null and upper(btrim(coalesce(customer_name, ''))) = upper(btrim($1)) and upper(btrim(sku)) = any($2::text[])`, customer, keys)).map(r => r.k) : []);
  const seen = new Set<string>();
  return rows.map(r => {
    const k = r.sku.trim().toUpperCase(), p = known.get(k);
    const status: Checked['status'] = !p ? 'unknown' : seen.has(k) ? 'repeat' : already.has(k) ? 'already' : 'ok';
    seen.add(k);
    return { ...r, sku: p?.sku ?? r.sku.trim(), status, name: p?.name ?? null, brand: p?.brand ?? null, available: p?.available ?? null };
  });
}
export type BulkResult = { created: RequestItem[]; skipped: { line: number; sku: string; reason: string }[] };
const REASON: Record<Exclude<Checked['status'], 'ok'>, string> = { unknown: 'Radar does not have a product with that SKU', repeat: 'it is in the list twice', already: 'this store has already asked for it and that request is still open' };
/** Makes one request per product, all for the same store, with the same needed-by date and notes (each row's own note is added to it). */
export async function createBulk(repId: string, b: Record<string, unknown>, today: string): Promise<BulkResult> {
  const items = Array.isArray(b.items) ? b.items : null;
  if (!items || !items.length) throw new RequestError('Choose at least one product.');
  if (items.length > MAX_BULK) throw new RequestError(`Up to ${MAX_BULK} products at a time.`);
  const customer = typeof b.customer === 'string' ? b.customer.trim() : '';
  if (!customer) throw new RequestError('Say which store these are for.');
  const rows: BulkRow[] = items.map((it: any, i: number) => ({ line: Number.isInteger(it?.line) ? it.line : i + 1, sku: String(it?.sku ?? '').trim(), qty: it?.qty == null || it.qty === '' ? null : Number(it.qty), note: typeof it?.note === 'string' && it.note.trim() ? it.note.trim().slice(0, 300) : null }));
  // the parts shared by all of them are checked once, before anything is made
  const probe = parseNewRequest({ kind: 'existing', sku: rows[0]!.sku || 'X', customer, neededBy: b.neededBy, notes: b.notes }, today);
  if ('error' in probe && !/SKU|product/i.test(probe.error)) throw new RequestError(probe.error);
  const checked = await checkBulk(rows.filter(r => r.sku), customer);
  const out: BulkResult = { created: [], skipped: rows.filter(r => !r.sku).map(r => ({ line: r.line, sku: '', reason: 'there is no SKU' })) };
  for (const r of checked) {
    if (r.status !== 'ok') { out.skipped.push({ line: r.line, sku: r.sku, reason: REASON[r.status] }); continue; }
    const notes = [typeof b.notes === 'string' ? b.notes.trim() : '', r.note ?? ''].filter(Boolean).join('. ') || null;
    const parsed = parseNewRequest({ kind: 'existing', sku: r.sku, qty: r.qty, customer, neededBy: b.neededBy, notes }, today);
    if ('error' in parsed) { out.skipped.push({ line: r.line, sku: r.sku, reason: parsed.error }); continue; }
    try { const { item, duplicate } = await createRequest(repId, parsed.ok); if (duplicate) out.skipped.push({ line: r.line, sku: r.sku, reason: 'it was asked for a moment ago' }); else out.created.push(item); }
    catch (e) { if (e instanceof RequestError) out.skipped.push({ line: r.line, sku: r.sku, reason: e.message }); else throw e; }
  }
  return out;
}
