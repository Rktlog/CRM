// Liewood orders: saving an uploaded sales order and its PDF confirmation, linking the DEAR purchase order, reading what DEAR has on that PO
// (Liewood's invoices = confirmed coming; the stock received against each = the double check), and the alerts. DEAR is only ever READ.
import * as XLSX from 'xlsx';
import { prisma } from './prisma';
import { sendAlert } from './alerts';
import { feedAfterOrder, type FeedResult } from './liewoodRange';
import { LiewoodError, compareConfirmation, etaEnd, orderStage, parsePdfReply, parseSalesOrder, readDearPurchase, tallyPo, type ConfirmationCheck, type DearPo, type OrderStage, type PdfTotals, type PoDoc, type TallyLine } from './liewoodCore';

export { LiewoodError };
export const MAX_SHEET = 10 * 1024 * 1024, MAX_PDF = 15 * 1024 * 1024;
const NOT_SET_UP = 'The Liewood section is not set up in the database yet. Ask whoever looks after Radar to run liewood.sql.';
const missing = (e: any) => e?.code === '42P01' || (/lw_(orders|order_lines|po_docs|po_state)/.test(String(e?.message ?? e)) && /does not exist|relation/i.test(String(e?.message ?? e)));
async function guard<T>(f: () => Promise<T>): Promise<T> { try { return await f(); } catch (e) { if (missing(e)) throw new LiewoodError(NOT_SET_UP, 503); throw e; } }
const uuidOk = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const dec = (v: number | null) => (v === null ? null : String(v));   // numbers go to the database as text, so a list of prices is never taken for whole numbers
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Melbourne' });

// ---------- what this file reaches outside Radar (swapped for stand-ins in the tests) ----------
export type Deps = { dearGet: (path: string, params: Record<string, string | number>) => Promise<any>; readPdf: (pdf: Buffer) => Promise<PdfTotals | null>; alert: typeof sendAlert };
async function realReadPdf(pdf: Buffer): Promise<PdfTotals | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ timeout: 60_000, maxRetries: 1 });
  // Claude fills in a form (a tool with set fields) rather than writing JSON as text, so a Danish number like 16.313,04 can never break the reply.
  const field = (description: string) => ({ type: ['string', 'null'], description });
  const msg = await client.messages.create({ model: process.env.CLAUDE_FAST_MODEL || 'claude-haiku-5-5', max_tokens: 400,
    tools: [{ name: 'record_totals', description: 'Records the order number and totals printed on a Liewood order confirmation.', input_schema: { type: 'object', properties: {
      orderNo: field('The order number, like SO493681.'), totalUnits: field('The total quantity of units, as printed.'), totalAmount: field('The order total, exactly as printed, like 16.313,04.'), currency: field('The 3-letter currency, like EUR.'),
    }, required: ['orderNo', 'totalUnits', 'totalAmount', 'currency'] } }],
    tool_choice: { type: 'tool', name: 'record_totals' },
    messages: [{ role: 'user', content: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') } },
      { type: 'text', text: 'This is a Liewood order confirmation. Record its order number, total units, order total and currency with record_totals. Use null for anything not printed on it.' },
    ] }] } as any);
  const used = msg.content.find((c: any) => c.type === 'tool_use') as any;
  const reply = used ? JSON.stringify(used.input ?? {}) : msg.content.map((c: any) => (c.type === 'text' ? c.text : '')).join('');
  const out = parsePdfReply(reply);
  if (out.orderNo === null && out.totalUnits === null && out.totalAmount === null) console.error('liewood pdf: nothing readable in the reply:', reply.slice(0, 300));
  return out;
}
export const realDeps: Deps = { dearGet: async (p, q) => (await import('../sync/dearClient')).dearGet(p, q), readPdf: realReadPdf, alert: sendAlert };

// ---------- uploading ----------
export function rowsOfSheet(buf: Buffer): unknown[][] {
  let wb: XLSX.WorkBook;
  try { wb = XLSX.read(buf, { type: 'buffer', cellDates: true }); } catch { throw new LiewoodError('That file could not be opened as an Excel file. Use the .xlsx sales order export from Liewood.'); }
  const name = wb.SheetNames.find(n => /sales order|excel export|^SO\d/i.test(n)) ?? wb.SheetNames[0];
  if (!name) throw new LiewoodError('That Excel file is empty.');
  return XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name]!, { header: 1, raw: true, defval: null }).slice(0, 5000);
}
export type Uploaded = { id: string; soNumber: string; replaced: boolean; lines: number; units: number; notInDear: number; problems: string[]; range: FeedResult | null };
/** Saves a Liewood sales order from its Excel export. The same order again is refused unless replace is asked for; replacing keeps the name, ETA, PO and PDF. */
export async function uploadSalesOrder(repId: string, buf: Buffer, fileName: string, replace: boolean): Promise<Uploaded> {
  if (!buf.length) throw new LiewoodError('That file is empty.');
  if (buf.length > MAX_SHEET) throw new LiewoodError('That file is bigger than 10 MB. Use the sales order export from Liewood.', 413);
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') throw new LiewoodError('That is the PDF. Add the Excel sales order first, then the PDF confirmation on the order.');
  const so = parseSalesOrder(rowsOfSheet(buf));
  const saved = await guard(async () => {
    const [have] = await prisma.$queryRaw<{ id: string }[]>`select id from crm.lw_orders where so_number = ${so.orderNo}`;
    if (have && !replace) throw new LiewoodError(`${so.orderNo} has already been uploaded. Choose to replace it if this is a newer version.`, 409);
    const skus = so.lines.map(l => l.sku), codes = so.lines.map(l => l.barcode).filter((b): b is string => !!b);
    const found = await prisma.$queryRaw<{ sku: string; barcode: string | null }[]>`select sku, barcode from crm.products where upper(btrim(sku)) = any(${skus}::text[]) or btrim(barcode) = any(${codes}::text[])`;
    const bySku = new Map(found.map(p => [p.sku.trim().toUpperCase(), p.sku])), byCode = new Map(found.filter(p => p.barcode).map(p => [p.barcode!.trim(), p.sku]));
    const productOf = (l: (typeof so.lines)[number]) => (l.display ? null : (l.barcode && byCode.get(l.barcode)) || bySku.get(l.sku) || null);
    const window = so.deliveryWindows.join(', ') || null, file = fileName.slice(0, 200) || null;
    const id = have
      ? (await prisma.$queryRaw<{ id: string }[]>`update crm.lw_orders set season = ${so.season}, customer_order_no = ${so.customerOrderNo}, currency = ${so.currency}, delivery_window = ${window}, total_units = ${so.totalUnits}, total_amount = ${so.totalAmount}, source_file = ${file}, updated_at = now() where id = ${have.id}::uuid returning id`)[0]!.id
      : (await prisma.$queryRaw<{ id: string }[]>`insert into crm.lw_orders (so_number, season, customer_order_no, currency, delivery_window, total_units, total_amount, source_file, created_by) values (${so.orderNo}, ${so.season}, ${so.customerOrderNo}, ${so.currency}, ${window}, ${so.totalUnits}, ${so.totalAmount}, ${file}, ${repId}::uuid) returning id`)[0]!.id;
    await prisma.$queryRaw`delete from crm.lw_order_lines where order_id = ${id}::uuid`;
    const L = so.lines;
    await prisma.$queryRaw`insert into crm.lw_order_lines (order_id, line_no, display, style_no, style_name, colour_code, colour, size, barcode, sku, product_sku, qty, currency, wsp, discount, price, amount, rrp, delivery_window)
      select ${id}::uuid, * from unnest(${L.map(l => l.lineNo)}::int[], ${L.map(l => l.display)}::boolean[], ${L.map(l => l.styleNo)}::text[], ${L.map(l => l.styleName)}::text[], ${L.map(l => l.colourCode)}::text[], ${L.map(l => l.colour)}::text[], ${L.map(l => l.size)}::text[],
        ${L.map(l => l.barcode)}::text[], ${L.map(l => l.sku)}::text[], ${L.map(productOf)}::text[], ${L.map(l => l.qty)}::int[], ${L.map(l => l.currency)}::text[], ${L.map(l => dec(l.wsp))}::text[]::numeric[], ${L.map(l => dec(l.discount))}::text[]::numeric[], ${L.map(l => dec(l.price))}::text[]::numeric[],
        ${L.map(l => dec(l.amount))}::text[]::numeric[], ${L.map(l => dec(l.rrp))}::text[]::numeric[], ${L.map(l => l.deliveryWindow)}::text[])`;
    // a PDF already on it is checked again against the new figures
    const [c] = await prisma.$queryRaw<{ confirmation_check: ConfirmationCheck | null }[]>`select confirmation_check from crm.lw_orders where id = ${id}::uuid`;
    if (c?.confirmation_check?.pdf) await prisma.$queryRaw`update crm.lw_orders set confirmation_check = ${JSON.stringify(compareConfirmation(so, c.confirmation_check.pdf))}::jsonb where id = ${id}::uuid`;
    return { id, soNumber: so.orderNo, replaced: !!have, lines: L.length, units: so.totalUnits, notInDear: L.filter(l => !l.display && !productOf(l)).length, problems: so.problems };
  });
  // the order's SKUs go into the Liewood range, filled in from the season files (this never stops the upload)
  return { ...saved, range: await feedAfterOrder(so.lines.filter(l => !l.display).map(l => l.sku)) };
}
/** Keeps the PDF confirmation with the order, and checks its order number and totals against the sales order (Claude reads them; nothing else is sent). */
export async function attachConfirmation(id: unknown, buf: Buffer, fileName: string, d: Deps = realDeps): Promise<ConfirmationCheck> {
  if (!uuidOk(id)) throw new LiewoodError('That order was not found.', 404);
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new LiewoodError('That is not a PDF. Add the order confirmation PDF here (the Excel goes in "Upload a sales order").');
  if (buf.length > MAX_PDF) throw new LiewoodError('That PDF is bigger than 15 MB.', 413);
  return guard(async () => {
    const [o] = await prisma.$queryRaw<{ so_number: string; total_units: number; total_amount: string; currency: string | null }[]>`select so_number, total_units, total_amount, currency from crm.lw_orders where id = ${id}::uuid`;
    if (!o) throw new LiewoodError('That order was not found.', 404);
    let pdf: PdfTotals | null = null, why = 'Claude is not set up on the API (ANTHROPIC_API_KEY), so the PDF was kept but not checked.';
    try { pdf = await d.readPdf(buf); } catch (e) { why = 'The PDF could not be read just now, so it was kept but not checked. Add it again to retry.'; console.error('liewood pdf read failed', String((e as Error)?.message ?? e).slice(0, 160)); }
    const check: ConfirmationCheck = pdf ? compareConfirmation({ orderNo: o.so_number, totalUnits: o.total_units, totalAmount: Number(o.total_amount), currency: o.currency }, pdf) : { status: 'not_checked', reasons: [why], pdf: null, checkedAt: new Date().toISOString() };
    await prisma.$queryRaw`update crm.lw_orders set confirmation_pdf = ${buf}, confirmation_name = ${fileName.slice(0, 200) || 'confirmation.pdf'}, confirmation_check = ${JSON.stringify(check)}::jsonb, updated_at = now() where id = ${id}::uuid`;
    return check;
  });
}
export async function getConfirmation(id: unknown): Promise<{ name: string; pdf: Buffer }> {
  if (!uuidOk(id)) throw new LiewoodError('That order was not found.', 404);
  return guard(async () => {
    const [r] = await prisma.$queryRaw<{ confirmation_name: string | null; confirmation_pdf: Buffer | null }[]>`select confirmation_name, confirmation_pdf from crm.lw_orders where id = ${id}::uuid`;
    if (!r?.confirmation_pdf) throw new LiewoodError('There is no PDF on this order yet.', 404);
    return { name: r.confirmation_name ?? 'confirmation.pdf', pdf: Buffer.from(r.confirmation_pdf) };
  });
}
/** PO-89, po00089 and PO-00089 are all PO-00089 (DEAR's numbering). */
export function normalisePo(v: unknown): string | null {
  const s = String(v ?? '').trim().toUpperCase();
  if (!s) return null;
  const m = /^PO[-\s]?(\d{1,8})$/.exec(s);
  if (!m) throw new LiewoodError('Give the DEAR purchase order number, like PO-00089.');
  return `PO-${m[1]!.padStart(5, '0')}`;
}
export async function updateOrder(id: unknown, b: Record<string, unknown>): Promise<void> {
  if (!uuidOk(id)) throw new LiewoodError('That order was not found.', 404);
  const t = (v: unknown, max: number, what: string) => { if (v === undefined) return undefined; const s = typeof v === 'string' ? v.trim() : ''; if (s.length > max) throw new LiewoodError(`Keep the ${what} to ${max} characters.`); return s || null; };
  const name = t(b.name, 120, 'name'), eta = t(b.eta, 40, 'ETA'), notes = t(b.notes, 2000, 'notes'), po = b.poNumber === undefined ? undefined : normalisePo(b.poNumber);
  const closed = b.closed === undefined ? undefined : b.closed === true;
  await guard(async () => {
    const r = await prisma.$queryRaw<{ id: string }[]>`update crm.lw_orders set
        name = case when ${name !== undefined}::boolean then ${name ?? null}::text else name end, eta = case when ${eta !== undefined}::boolean then ${eta ?? null}::text else eta end,
        notes = case when ${notes !== undefined}::boolean then ${notes ?? null}::text else notes end, po_number = case when ${po !== undefined}::boolean then ${po ?? null}::text else po_number end,
        closed = case when ${closed !== undefined}::boolean then ${closed ?? false}::boolean else closed end, updated_at = now()
      where id = ${id}::uuid returning id`;
    if (!r.length) throw new LiewoodError('That order was not found.', 404);
  });
}
export async function deleteOrder(id: unknown): Promise<void> {
  if (!uuidOk(id)) throw new LiewoodError('That order was not found.', 404);
  await guard(async () => { const r = await prisma.$queryRaw<{ id: string }[]>`delete from crm.lw_orders where id = ${id}::uuid returning id`; if (!r.length) throw new LiewoodError('That order was not found.', 404); });
}

// ---------- reading back: one PO and every order on it, tallied together ----------
type LineRow = { order_id: string; line_no: number; display: boolean; style_no: string; style_name: string | null; colour_code: string | null; colour: string | null; size: string | null; barcode: string | null; sku: string; product_sku: string | null; qty: number; price: string | null; amount: string | null; rrp: string | null; delivery_window: string | null };
type OrderRow = { id: string; so_number: string; name: string | null; season: string | null; customer_order_no: string | null; currency: string | null; delivery_window: string | null; eta: string | null; po_number: string | null; notes: string | null; total_units: number; total_amount: string; source_file: string | null; confirmation_name: string | null; confirmation_check: ConfirmationCheck | null; closed: boolean; created_at: Date; updated_at: Date };
const ORDER_COLS = `id, so_number, name, season, customer_order_no, currency, delivery_window, eta, po_number, notes, total_units, total_amount, source_file, confirmation_name, confirmation_check, closed, created_at, updated_at`;
async function poDocs(pos: string[]): Promise<Map<string, { po: DearPo | null; state: { ok: boolean; error: string | null; fetchedAt: string; status: string | null } | null }>> {
  const out = new Map<string, { po: DearPo | null; state: any }>();
  if (!pos.length) return out;
  const docs = await prisma.$queryRaw<{ po_number: string; kind: 'order' | 'invoice' | 'receipt'; doc_key: string; doc_number: string | null; doc_date: string | null; status: string | null; sku: string; qty: string }[]>`
    select po_number, kind, doc_key, doc_number, to_char(doc_date, 'YYYY-MM-DD') as doc_date, status, sku, qty from crm.lw_po_docs where po_number = any(${pos}::text[]) order by doc_date nulls last, doc_key, sku`;
  const states = await prisma.$queryRaw<{ po_number: string; ok: boolean; error: string | null; fetched_at: Date; status: string | null }[]>`select po_number, ok, error, fetched_at, status from crm.lw_po_state where po_number = any(${pos}::text[])`;
  for (const p of pos) {
    const st = states.find(s => s.po_number === p), mine = docs.filter(d => d.po_number === p);
    const group = (kind: 'invoice' | 'receipt'): PoDoc[] => { const m = new Map<string, PoDoc>(); for (const d of mine.filter(x => x.kind === kind)) { const g = m.get(d.doc_key) ?? { key: d.doc_key, number: d.doc_number, date: d.doc_date, status: d.status, lines: [] }; g.lines.push({ sku: d.sku, qty: Number(d.qty) }); m.set(d.doc_key, g); } return [...m.values()]; };
    out.set(p, { po: st?.ok ? { orderNumber: p, status: st.status, ordered: mine.filter(x => x.kind === 'order').map(x => ({ sku: x.sku, qty: Number(x.qty) })), invoices: group('invoice'), receipts: group('receipt'), fields: [] } : null,
      state: st ? { ok: st.ok, error: st.error, fetchedAt: new Date(st.fetched_at).toISOString(), status: st.status } : null });
  }
  return out;
}
async function tallies(orders: OrderRow[]): Promise<Map<string, { lines: TallyLine[]; po: DearPo | null; state: any; shared: string[]; extraOnPo: { sku: string; qty: number }[]; shortages: { invoice: string; sku: string; invoiced: number; received: number }[] }>> {
  const pos = [...new Set(orders.map(o => o.po_number).filter((p): p is string => !!p))];
  const all = pos.length ? await prisma.$queryRawUnsafe<OrderRow[]>(`select ${ORDER_COLS} from crm.lw_orders where po_number = any($1::text[]) order by created_at, so_number`, pos) : [];
  const ids = [...new Set([...orders, ...all].map(o => o.id))];
  const lines = ids.length ? await prisma.$queryRaw<{ order_id: string; lineNo: number; sku: string; qty: number; display: boolean }[]>`select order_id, line_no as "lineNo", sku, qty, display from crm.lw_order_lines where order_id = any(${ids}::uuid[]) order by order_id, line_no` : [];
  const docs = await poDocs(pos), out = new Map<string, any>();
  for (const p of pos) {
    const onPo = all.filter(o => o.po_number === p), d = docs.get(p)!;
    const t = tallyPo(onPo.map(o => ({ id: o.id, lines: lines.filter(l => l.order_id === o.id && !l.display) })), d.po);
    for (const o of onPo) out.set(o.id, { lines: t.lines.filter(l => l.orderId === o.id), po: d.po, state: d.state, shared: onPo.filter(x => x.id !== o.id).map(x => x.so_number), extraOnPo: t.extraOnPo, shortages: t.shortages });
  }
  for (const o of orders) if (!out.has(o.id)) out.set(o.id, { lines: tallyPo([{ id: o.id, lines: lines.filter(l => l.order_id === o.id && !l.display) }], null).lines, po: null, state: null, shared: [], extraOnPo: [], shortages: [] });
  return out;
}
export type OrderSummary = { id: string; soNumber: string; name: string | null; season: string | null; eta: string | null; poNumber: string | null; units: number; amount: number; currency: string | null; stage: OrderStage; closed: boolean; confirmation: ConfirmationCheck['status'] | 'none'; issues: number; overdue: boolean; createdAt: string };
const issuesOf = (ls: TallyLine[], hasPo: boolean) => (hasPo ? ls.filter(l => l.stage === 'not_on_po' || l.stage === 'short_on_po').length : 0);
const isOverdue = (o: OrderRow, ls: TallyLine[]) => { const e = etaEnd(o.eta); return !!e && e < today() && ls.some(l => l.invoiced < l.qty) && !o.closed; };
export async function listOrders(): Promise<OrderSummary[]> {
  return guard(async () => {
    const orders = await prisma.$queryRawUnsafe<OrderRow[]>(`select ${ORDER_COLS} from crm.lw_orders order by closed, created_at desc limit 500`);
    const t = await tallies(orders);
    return orders.map(o => { const x = t.get(o.id)!; return { id: o.id, soNumber: o.so_number, name: o.name, season: o.season, eta: o.eta, poNumber: o.po_number, units: o.total_units, amount: Number(o.total_amount), currency: o.currency, stage: orderStage(!!o.po_number && !!x.po, x.lines), closed: o.closed,
      confirmation: o.confirmation_check?.status ?? (o.confirmation_name ? 'not_checked' : 'none'), issues: issuesOf(x.lines, !!x.po) + x.shortages.length, overdue: isOverdue(o, x.lines), createdAt: new Date(o.created_at).toISOString() }; });
  });
}
export async function getOrder(id: unknown) {
  if (!uuidOk(id)) throw new LiewoodError('That order was not found.', 404);
  return guard(async () => {
    const [o] = await prisma.$queryRawUnsafe<OrderRow[]>(`select ${ORDER_COLS} from crm.lw_orders where id = $1::uuid`, id);
    if (!o) throw new LiewoodError('That order was not found.', 404);
    const rows = await prisma.$queryRaw<LineRow[]>`select order_id, line_no, display, style_no, style_name, colour_code, colour, size, barcode, sku, product_sku, qty, price::text, amount::text, rrp::text, delivery_window from crm.lw_order_lines where order_id = ${o.id}::uuid order by line_no`;
    const x = (await tallies([o])).get(o.id)!;
    const byLine = new Map(x.lines.map((l: TallyLine) => [l.lineNo, l]));
    const lines = rows.map(r => { const t = byLine.get(r.line_no) as TallyLine | undefined; return { lineNo: r.line_no, display: r.display, styleNo: r.style_no, styleName: r.style_name, colour: r.colour, colourCode: r.colour_code, size: r.size, barcode: r.barcode, sku: r.sku, inDear: !!r.product_sku, qty: r.qty,
      price: r.price === null ? null : Number(r.price), amount: r.amount === null ? null : Number(r.amount), rrp: r.rrp === null ? null : Number(r.rrp), deliveryWindow: r.delivery_window, onPo: t?.onPo ?? 0, invoiced: t?.invoiced ?? 0, received: t?.received ?? 0, stage: r.display ? null : (t?.stage ?? 'not_on_po') }; });
    const skus = new Set(rows.map(r => r.sku));
    const invoices = (x.po?.invoices ?? []).map((d: PoDoc) => { const rec = (x.po?.receipts ?? []).filter((r: PoDoc) => r.key === d.key); const mine = d.lines.filter(l => skus.has(l.sku));
      return { number: d.number, date: d.date, units: mine.reduce((t, l) => t + l.qty, 0), allUnits: d.lines.reduce((t, l) => t + l.qty, 0), received: rec.length ? rec.flatMap((r: PoDoc) => r.lines).reduce((t: number, l: { qty: number }) => t + l.qty, 0) : null, receivedOn: rec[0]?.date ?? null }; });
    return { id: o.id, soNumber: o.so_number, name: o.name, season: o.season, customerOrderNo: o.customer_order_no, currency: o.currency, deliveryWindow: o.delivery_window, eta: o.eta, etaEnd: etaEnd(o.eta), poNumber: o.po_number, notes: o.notes, units: o.total_units, amount: Number(o.total_amount),
      sourceFile: o.source_file, confirmationName: o.confirmation_name, confirmation: o.confirmation_check, closed: o.closed, stage: orderStage(!!o.po_number && !!x.po, x.lines), overdue: isOverdue(o, x.lines), po: x.state, sharedWith: x.shared, invoices,
      shortages: x.shortages.filter((s: { sku: string }) => skus.has(s.sku)), extraOnPo: x.extraOnPo, lines, updatedAt: new Date(o.updated_at).toISOString() };
  });
}

// ---------- the job: read the linked POs from DEAR, then the alerts ----------
/** One purchase order from DEAR by its number (an advanced purchase with several invoices, or a simple one). Read only. */
export async function fetchDearPo(po: string, d: Deps = realDeps): Promise<{ id: string; purchase: DearPo }> {
  const list = await d.dearGet('/purchaseList', { Search: po, Limit: 100 });
  const hit = (list?.PurchaseList ?? list?.Purchases ?? []).find((p: any) => String(p?.OrderNumber ?? '').toUpperCase() === po);
  if (!hit?.ID) throw new LiewoodError(`DEAR has no purchase order called ${po}.`, 404);
  const advanced = /advanced/i.test(String(hit.Type ?? ''));
  const raw = await d.dearGet(advanced ? '/advanced-purchase' : '/purchase', { ID: String(hit.ID) });
  const purchase = readDearPurchase(raw);
  if (!purchase.status) purchase.status = String(hit.Status ?? '') || null;
  return { id: String(hit.ID), purchase };
}
export type SyncResult = { pos: number; ok: number; failed: { po: string; error: string }[]; alerts: number };
export async function syncLiewoodPos(d: Deps = realDeps, o: { max?: number } = {}): Promise<SyncResult> {
  const out: SyncResult = { pos: 0, ok: 0, failed: [], alerts: 0 };
  try {
    return await guard(async () => {
      const pos = (await prisma.$queryRaw<{ po: string }[]>`select distinct po_number as po from crm.lw_orders where po_number is not null and not closed order by 1`).map(r => r.po).slice(0, o.max ?? 40);
      for (const po of pos) {
        out.pos++;
        try {
          const { id, purchase } = await fetchDearPo(po, d);
          const rows: [string, string, string | null, string | null, string | null, string, number][] = [
            ...purchase.ordered.map(l => ['order', 'order', null, null, null, l.sku, l.qty] as [string, string, null, null, null, string, number]),
            ...purchase.invoices.flatMap(x => x.lines.map(l => ['invoice', x.key, x.number, x.date, x.status, l.sku, l.qty] as [string, string, string | null, string | null, string | null, string, number])),
            ...purchase.receipts.flatMap(x => x.lines.map(l => ['receipt', x.key, x.number, x.date, x.status, l.sku, l.qty] as [string, string, string | null, string | null, string | null, string, number])),
          ];
          { const m = new Map<string, (typeof rows)[number]>(); for (const r of rows) { const k = `${r[0]}|${r[1]}|${r[5]}`, h = m.get(k); if (h) h[6] += r[6]; else m.set(k, [...r]); } rows.splice(0, rows.length, ...m.values()); }   // one row per document and SKU
          await prisma.$queryRaw`delete from crm.lw_po_docs where po_number = ${po}`;
          if (rows.length) await prisma.$queryRaw`insert into crm.lw_po_docs (po_number, kind, doc_key, doc_number, doc_date, status, sku, qty)
            select ${po}, t.kind, t.doc_key, t.doc_number, t.doc_date::date, t.status, t.sku, t.qty from unnest(${rows.map(r => r[0])}::text[], ${rows.map(r => r[1])}::text[], ${rows.map(r => r[2])}::text[], ${rows.map(r => r[3])}::text[], ${rows.map(r => r[4])}::text[], ${rows.map(r => r[5])}::text[], ${rows.map(r => dec(r[6]))}::text[]::numeric[]) as t(kind, doc_key, doc_number, doc_date, status, sku, qty)
`;
          await prisma.$queryRaw`insert into crm.lw_po_state (po_number, dear_id, status, fields, ok, error, fetched_at) values (${po}, ${id}, ${purchase.status}, ${purchase.fields}::text[], true, null, now())
            on conflict (po_number) do update set dear_id = excluded.dear_id, status = excluded.status, fields = excluded.fields, ok = true, error = null, fetched_at = now()`;
          console.log(`Liewood: ${po} read from DEAR: ${purchase.ordered.length} lines, ${purchase.invoices.length} invoices (${purchase.invoices.map(x => x.number ?? x.key).join(', ') || 'none'}), ${purchase.receipts.length} stock receivings.`);
          out.ok++;
        } catch (e) {
          const msg = e instanceof LiewoodError ? e.message : `DEAR would not answer: ${String((e as Error)?.message ?? e).slice(0, 140)}`;
          out.failed.push({ po, error: msg });
          await prisma.$queryRaw`insert into crm.lw_po_state (po_number, ok, error, fetched_at) values (${po}, false, ${msg}, now()) on conflict (po_number) do update set ok = false, error = excluded.error, fetched_at = now()`;
        }
      }
      out.alerts = await sendAlerts(d);
      return out;
    });
  } catch (e) { if (e instanceof LiewoodError && e.status === 503) return { ...out, failed: [{ po: '-', error: e.message }] }; throw e; }
}
const nameOf = (l: { style_name: string | null; colour: string | null }) => [l.style_name, l.colour].filter(Boolean).join(' - ');
/** Each alert goes once: a delivery that came in short against its invoice, and an order past its ETA with lines not invoiced. */
async function sendAlerts(d: Deps): Promise<number> {
  let n = 0;
  const orders = await prisma.$queryRawUnsafe<OrderRow[]>(`select ${ORDER_COLS} from crm.lw_orders where not closed order by created_at`);
  const t = await tallies(orders);
  const names = new Map((await prisma.$queryRaw<{ sku: string; style_name: string | null; colour: string | null }[]>`select distinct on (sku) sku, style_name, colour from crm.lw_order_lines`).map(r => [r.sku, nameOf(r)]));
  const seen = new Set<string>();
  for (const o of orders) {
    const x = t.get(o.id)!;
    // 1. short against an invoice (once per PO and invoice)
    if (o.po_number && x.shortages.length) {
      const byInv = new Map<string, typeof x.shortages>();
      for (const s of x.shortages) byInv.set(s.invoice, [...(byInv.get(s.invoice) ?? []), s]);
      for (const [inv, list] of byInv) {
        const key = `${o.po_number}|${inv}`; if (seen.has(key)) continue; seen.add(key);
        const orders = [o.so_number, ...x.shared].join(', ');
        const r = await d.alert('liewood', { subject: `[Radar] Liewood delivery short: ${o.po_number}, invoice ${inv}`, body: [
          `The stock received in DEAR against Liewood's invoice ${inv} on ${o.po_number} does not match what the invoice billed.`, `Orders on this PO: ${orders}.`, '',
          ...list.map(s => s.invoiced === 0 ? `- ${s.sku} ${names.get(s.sku) ?? ''}: ${s.received} received but not on this invoice` : `- ${s.sku} ${names.get(s.sku) ?? ''}: invoiced ${s.invoiced}, received ${s.received} (${s.invoiced - s.received} short)`),
          '', 'Check the delivery, and ask Liewood for the missing items or a credit note. The order is on the Liewood page in Radar (Products).'].join('\n') }, { relatedId: `short|${key}` });
        if (r.sent) n++;
      }
    }
    // 2. past the ETA (with a week's grace) and not all invoiced: Liewood may not be sending it
    const e = etaEnd(o.eta), late = !!e && new Date(Date.parse(`${e}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10) < today();
    const notInv = x.lines.filter((l: TallyLine) => l.invoiced < l.qty);
    if (late && notInv.length) {
      const r = await d.alert('liewood', { subject: `[Radar] Liewood ${o.so_number} not invoiced by its ETA (${o.eta})`, body: [
        `${o.so_number}${o.name ? ` (${o.name})` : ''} was due ${o.eta}, and Liewood has not invoiced ${notInv.length === x.lines.length ? 'any of it' : `${notInv.length} of its ${x.lines.length} lines`} yet${o.po_number ? ` on ${o.po_number}` : ' (no DEAR purchase order is linked to it)'}.`, '',
        ...notInv.slice(0, 60).map((l: TallyLine) => `- ${l.sku} ${names.get(l.sku) ?? ''}: ordered ${l.qty}, invoiced ${l.invoiced}`), ...(notInv.length > 60 ? [`- and ${notInv.length - 60} more`] : []),
        '', 'Ask Liewood whether these are still coming. The order is on the Liewood page in Radar (Products).'].join('\n') }, { relatedId: `late|${o.so_number}` });
      if (r.sent) n++;
    }
  }
  return n;
}
