// Special product requests: the sales team asks for a product (one Radar already sells, or a new one) and the ordering team sees it when ordering.
// The rules for what a request may contain are plain functions (no database), so they can be tested on their own. The table is SQL/product-requests.sql;
// until that has been run the callers answer "not set up yet" instead of failing.
import { prisma } from './prisma';

export const OPEN_STATUSES = ['requested', 'seen', 'asked_supplier', 'supplier_replied'] as const;
export const MANAGER_STATUSES = ['requested', 'seen', 'asked_supplier', 'supplier_replied', 'ordered', 'declined'] as const;
export type Status = typeof OPEN_STATUSES[number] | 'ordered' | 'declined' | 'cancelled';

export class RequestError extends Error { status: number; constructor(message: string, status = 400) { super(message); this.status = status; } }

export type NewRequest = { kind: 'existing' | 'new'; sku: string | null; itemName: string; brand: string | null; supplier: string | null; link: string | null; qty: number | null; customer: string | null; neededBy: string | null; notes: string | null };

const clean = (v: unknown, max: number, label: string): string | null | { error: string } => {
  if (v == null) return null;
  if (typeof v !== 'string') return { error: `${label} must be text.` };
  const s = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
  if (!s) return null;
  return s.length > max ? { error: `${label} is too long (most ${max} characters).` } : s;
};
const isErr = (v: unknown): v is { error: string } => !!v && typeof v === 'object' && 'error' in (v as object);
// a real calendar day: 2027-13-01 and 2027-02-30 are not (a bad one must be a plain message, never an error)
const isRealDay = (d: string) => { const t = new Date(d + 'T00:00:00Z'); return !isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d; };
const dayNumber = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000;

/** What a request may hold. `today` is the Melbourne date (YYYY-MM-DD). Returns the cleaned request, or the first problem in plain words. */
export function parseNewRequest(body: unknown, today: string): { ok: NewRequest } | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'Send the request as a form.' };
  const b = body as Record<string, unknown>;
  const kind = b.kind;
  if (kind !== 'existing' && kind !== 'new') return { error: 'Say whether this is a product we already sell or a new one.' };
  const sku = clean(b.sku, 80, 'The SKU'); if (isErr(sku)) return sku;
  const itemName = clean(b.itemName, 200, 'The product name'); if (isErr(itemName)) return itemName;
  const brand = clean(b.brand, 100, 'The brand'); if (isErr(brand)) return brand;
  const supplier = clean(b.supplier, 120, 'The supplier'); if (isErr(supplier)) return supplier;
  const link = clean(b.link, 500, 'The link'); if (isErr(link)) return link;
  const customer = clean(b.customer, 160, 'The customer'); if (isErr(customer)) return customer;
  const notes = clean(b.notes, 1000, 'The notes'); if (isErr(notes)) return notes;
  if (kind === 'existing' && !sku) return { error: 'Choose the product (its SKU).' };
  if (kind === 'new' && (!itemName || itemName.length < 2)) return { error: 'Say what the new product is.' };
  if (link) { try { const u = new URL(link); if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('x'); } catch { return { error: 'The link must start with http:// or https://' }; } }
  let qty: number | null = null;
  if (b.qty != null && b.qty !== '') {
    const q = typeof b.qty === 'number' ? b.qty : Number(b.qty);
    if (!Number.isInteger(q) || q < 1 || q > 100000) return { error: 'The quantity must be a whole number from 1 to 100000.' };
    qty = q;
  }
  let neededBy: string | null = null;
  if (b.neededBy != null && b.neededBy !== '') {
    const d = String(b.neededBy);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !isRealDay(d)) return { error: 'The needed-by date is not a real date.' };
    if (d < today) return { error: 'The needed-by date is in the past.' };
    if (dayNumber(d) - dayNumber(today) > 400) return { error: 'The needed-by date is more than a year away.' };
    neededBy = d;
  }
  return { ok: { kind, sku: kind === 'existing' ? sku : null, itemName: itemName ?? '', brand, supplier, link, qty, customer, neededBy, notes } };
}

/** What the ordering team may change on a request: its status and the note back to the requester. */
export function parseUpdate(body: unknown): { ok: { status?: typeof MANAGER_STATUSES[number]; note?: string | null; answer?: string | null } } | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'Nothing to change.' };
  const b = body as Record<string, unknown>;
  const out: { status?: typeof MANAGER_STATUSES[number]; note?: string | null; answer?: string | null } = {};
  if (b.status !== undefined) {
    if (!(MANAGER_STATUSES as readonly unknown[]).includes(b.status)) return { error: 'That is not a status a request can be moved to.' };
    out.status = b.status as typeof MANAGER_STATUSES[number];
  }
  if (b.decisionNote !== undefined) { const n = clean(b.decisionNote, 1000, 'The note'); if (isErr(n)) return n; out.note = n; }
  if (b.supplierAnswer !== undefined) { const a = clean(b.supplierAnswer, 300, 'What the supplier said'); if (isErr(a)) return a; out.answer = a; }
  if (out.status === undefined && out.note === undefined && out.answer === undefined) return { error: 'Nothing to change.' };
  return { ok: out };
}

export type RequestItem = {
  id: string; kind: 'existing' | 'new'; sku: string | null; itemName: string; brand: string | null; supplier: string | null; link: string | null; qty: number | null;
  customer: string | null; neededBy: string | null; notes: string | null; status: Status; decisionNote: string | null;
  requestedBy: { id: string | null; name: string | null }; handledByName: string | null; createdAt: string; seenAt: string | null; handledAt: string | null;
  stock: { available: number; onOrder: number } | null;
  supplierAnswer: string | null; supplierAnswerAt: string | null;   // what the supplier said, as a manager confirmed or typed it: the requester sees this
};
type Row = { id: string; kind: 'existing' | 'new'; sku: string | null; item_name: string; brand: string | null; supplier: string | null; link: string | null; qty_wanted: number | null; customer_name: string | null; needed_by: string | null; notes: string | null; status: Status; decision_note: string | null; requested_by: string | null; requester: string | null; handler: string | null; created_at: Date; seen_at: Date | null; handled_at: Date | null; available: number | null; on_order: number | null; supplier_answer: string | null; supplier_answer_at: Date | null };
const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
const toItem = (r: Row): RequestItem => ({
  id: r.id, kind: r.kind, sku: r.sku, itemName: r.item_name, brand: r.brand, supplier: r.supplier, link: r.link, qty: r.qty_wanted, customer: r.customer_name, neededBy: r.needed_by,
  notes: r.notes, status: r.status, decisionNote: r.decision_note, requestedBy: { id: r.requested_by, name: r.requester }, handledByName: r.handler,
  createdAt: new Date(r.created_at).toISOString(), seenAt: iso(r.seen_at), handledAt: iso(r.handled_at),
  stock: r.kind === 'existing' && r.available != null ? { available: Number(r.available), onOrder: Number(r.on_order ?? 0) } : null,
  supplierAnswer: r.supplier_answer, supplierAnswerAt: iso(r.supplier_answer_at),
});

const tableMissing = (e: any) => e?.code === '42P01' || e?.meta?.code === '42P01' || (/product_requests|\b42P01\b/.test(String(e?.message ?? e)) && /does not exist|relation/i.test(String(e?.message ?? e)));
const NOT_SET_UP = 'Product requests are not set up in the database yet. Ask whoever looks after Radar to run product-requests.sql.';
async function guard<T>(f: () => Promise<T>): Promise<T> { try { return await f(); } catch (e) { if (tableMissing(e)) throw new RequestError(NOT_SET_UP, 503); throw e; } }

const SELECT = `select r.id, r.kind, r.sku, r.item_name, r.brand, r.supplier, r.link, r.qty_wanted, r.customer_name, to_char(r.needed_by, 'YYYY-MM-DD') as needed_by, r.notes, r.status, r.decision_note,
    r.requested_by, q.name as requester, h.name as handler, r.created_at, r.seen_at, r.handled_at, p.available, p.on_order, r.supplier_answer, r.supplier_answer_at
  from crm.product_requests r left join crm.reps q on q.id = r.requested_by left join crm.reps h on h.id = r.handled_by left join crm.products p on upper(p.sku) = upper(r.sku)`;

export async function createRequest(repId: string, input: NewRequest): Promise<{ item: RequestItem; duplicate: boolean }> {
  return guard(async () => {
    let { sku, itemName, brand } = input;
    if (input.kind === 'existing') {
      const found = await prisma.$queryRaw<{ sku: string; name: string; brand: string | null }[]>`select sku, name, brand from crm.products where upper(btrim(sku)) = upper(${sku})`;
      const p = found[0];
      if (!p) throw new RequestError(`Radar does not have a product with the SKU "${sku}". Check it, or choose "A new product".`);
      sku = p.sku; itemName = p.name; brand = p.brand ?? input.brand;
    }
    // pressing the button twice must not make two requests: the same person asking for the same thing in the last two minutes is the same request
    const same = await prisma.$queryRaw<{ id: string }[]>`
      select id from crm.product_requests where requested_by = ${repId}::uuid and status in ('requested', 'seen', 'asked_supplier', 'supplier_replied')
        and created_at > now() - interval '2 minutes' and coalesce(upper(sku), upper(item_name)) = ${(sku ?? itemName).toUpperCase()}
        and qty_wanted is not distinct from ${input.qty}::int and customer_name is not distinct from ${input.customer}::text limit 1`;
    if (same[0]) return { item: await getOne(same[0].id), duplicate: true };
    const made = await prisma.$queryRaw<{ id: string }[]>`
      insert into crm.product_requests (requested_by, kind, sku, item_name, brand, supplier, link, qty_wanted, customer_name, needed_by, notes)
      values (${repId}::uuid, ${input.kind}, ${sku}, ${itemName}, ${brand}, ${input.supplier}, ${input.link}, ${input.qty}::int, ${input.customer}, ${input.neededBy}::date, ${input.notes}) returning id`;
    return { item: await getOne(made[0]!.id), duplicate: false };
  });
}

async function getOne(id: string): Promise<RequestItem> {
  const r = await prisma.$queryRawUnsafe<Row[]>(SELECT + ' where r.id = $1::uuid', id);
  if (!r[0]) throw new RequestError('That request was not found.', 404);
  return toItem(r[0]);
}

export const listMine = (repId: string) => guard(async () => (await prisma.$queryRawUnsafe<Row[]>(SELECT + ' where r.requested_by = $1::uuid order by r.created_at desc limit 200', repId)).map(toItem));
export const listOpen = () => guard(async () => (await prisma.$queryRawUnsafe<Row[]>(SELECT + " where r.status in ('requested', 'seen', 'asked_supplier', 'supplier_replied') order by (r.status = 'requested') desc, r.created_at asc limit 500")).map(toItem));
export const listClosed = (days = 30) => guard(async () => (await prisma.$queryRawUnsafe<Row[]>(SELECT + " where r.status in ('ordered', 'declined', 'cancelled') and coalesce(r.handled_at, r.updated_at) > now() - ($1::int * interval '1 day') order by coalesce(r.handled_at, r.updated_at) desc limit 100", days)).map(toItem));

export async function summary(): Promise<{ ready: boolean; newCount: number; openCount: number }> {
  try {
    const r = await prisma.$queryRaw<{ n: number; o: number }[]>`select count(*) filter (where status = 'requested')::int as n, count(*) filter (where status in ('requested', 'seen', 'asked_supplier', 'supplier_replied'))::int as o from crm.product_requests`;
    return { ready: true, newCount: Number(r[0]?.n ?? 0), openCount: Number(r[0]?.o ?? 0) };
  } catch (e) { if (tableMissing(e)) return { ready: false, newCount: 0, openCount: 0 }; throw e; }
}

export async function updateRequest(id: string, managerId: string, patch: { status?: string; note?: string | null; answer?: string | null }): Promise<RequestItem> {
  return guard(async () => {
    const cur = await prisma.$queryRaw<{ status: Status }[]>`select status from crm.product_requests where id = ${id}::uuid`;
    if (!cur[0]) throw new RequestError('That request was not found.', 404);
    if (cur[0].status === 'cancelled') throw new RequestError('The requester cancelled this request.', 409);
    const status = patch.status ?? cur[0].status;
    const noteGiven = patch.note !== undefined, answerGiven = patch.answer !== undefined;
    await prisma.$queryRaw`
      update crm.product_requests set status = ${status},
        decision_note = case when ${noteGiven}::boolean then ${patch.note ?? null}::text else decision_note end,
        supplier_answer = case when ${answerGiven}::boolean then ${patch.answer ?? null}::text else supplier_answer end,
        supplier_answer_at = case when ${answerGiven}::boolean then (case when ${patch.answer ?? null}::text is null then null else now() end) else supplier_answer_at end,
        seen_at = case when ${status} <> 'requested' then coalesce(seen_at, now()) else seen_at end,
        handled_by = ${managerId}::uuid, handled_at = now(), updated_at = now()
      where id = ${id}::uuid`;
    return getOne(id);
  });
}

export async function cancelOwn(id: string, repId: string): Promise<RequestItem> {
  return guard(async () => {
    const cur = await prisma.$queryRaw<{ status: Status; requested_by: string | null }[]>`select status, requested_by from crm.product_requests where id = ${id}::uuid`;
    if (!cur[0]) throw new RequestError('That request was not found.', 404);
    if (cur[0].requested_by !== repId) throw new RequestError('You can only cancel your own requests.', 403);
    if (cur[0].status !== 'requested' && cur[0].status !== 'seen') throw new RequestError('It is already being worked on, so ask the ordering team instead.', 409);
    await prisma.$queryRaw`update crm.product_requests set status = 'cancelled', updated_at = now() where id = ${id}::uuid`;
    return getOne(id);
  });
}
