// Trade shows: the shows, orders and quotes written at them (with stock that is free to sell), leads taken at the stand, the log on each,
// follow-ups, the email to sales with the DEAR file, and each show's results. DEAR is only read: a trade show order is matched to the
// DEAR order the sales team makes from it by its reference (the TS number in it), or linked by hand.
import { prisma } from './prisma';
import { sendAlert } from './alerts';
import { wholesalePrice } from './pricing';
import * as hand from './tsHandoff';
import { autoFreight, chargeSkus, dearReference, orderPlus, withOffers, writeLines } from './tradeshowOrderPlus';
import {
  TsError, cleanReference, splitColour, cleanText, dearCsv, defaultReference, firstFollowUp, followUpsClosed, gstRateFor, holdsStock, incrementProblem, nameKey, orderStage,
  parseDay, parseDiscount, plusDays, parseNewCustomer, phoneKey, QUOTE_STAGE, round2, salesEmail, STAGE_LABEL, stockView, totals, type DearLink, type Discount, type OrderStage,
} from './tradeshowCore';

export { TsError };
export type Rep = { id: string; role: string };
const isManager = (r: Rep) => r.role === 'manager';
const NOT_SET_UP = 'Trade shows are not set up in the database yet. Ask whoever looks after Radar to run tradeshow.sql.';
const missing = (e: any) => e?.code === '42P01' || e?.meta?.code === '42P01' || (/ts_(shows|orders|order_lines|leads|log|followups)/.test(String(e?.message ?? e)) && /does not exist|relation/i.test(String(e?.message ?? e)));
async function guard<T>(f: () => Promise<T>): Promise<T> { try { return await f(); } catch (e) { if (missing(e)) throw new TsError(NOT_SET_UP, 503); throw e; } }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idOk = (v: unknown, what = 'That'): string => { if (typeof v !== 'string' || !UUID.test(v)) throw new TsError(`${what} was not found.`, 404); return v; };
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Melbourne' });
const day = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const NOT_A_SALE = ['DRAFT', 'ESTIMATING', 'ESTIMATED', 'ORDERING', 'VOIDED', 'CREDITED'];

// Each trade show order with the DEAR order made from it: linked by hand (dear_quote_id), or found by the TS number in the DEAR reference,
// or the whole reference. Used everywhere a stage, a stock hold or a follow-up depends on DEAR.
const linkedCte = (where = '') => `
  with ol as (
    select o.*, dq.id as dear_id, dq.number as dear_number, dq.fulfillment_status as dear_status, dq.invoiced_total as dear_invoiced, dq.amount_due as dear_due
    from (select * from crm.ts_orders o${where}) o
    left join lateral (
      select q.id, q.number, q.fulfillment_status, q.invoiced_total, q.amount_due from crm.quotes q
      where (o.dear_quote_id is not null and q.id = o.dear_quote_id)
         or (o.dear_quote_id is null and o.status = 'sent' and q.reference is not null and q.sent_at >= o.order_date - 3
             and q.source is distinct from 'rhino-history'
             and (q.reference ~* ('\\m' || o.number || '\\M') or upper(btrim(q.reference)) = upper(btrim(o.reference))
             or (o.dear_reference is not null and q.account_id = o.account_id and upper(btrim(q.reference)) = upper(btrim(o.dear_reference)))))
      order by upper(coalesce(q.fulfillment_status, '')) in ('VOIDED', 'CREDITED'), q.sent_at desc limit 1
    ) dq on true
  )`;
const LINKED = linkedCte();
type Linked = { id: string; number: string; show_id: string; account_id: string; kind: 'order' | 'quote'; status: string; dear_id: string | null; dear_number: string | null; dear_status: string | null; dear_invoiced: number | null; dear_due: number | null; [k: string]: any };
const dearOf = (o: Linked): DearLink => (o.dear_id ? { number: o.dear_number!, status: o.dear_status, invoiced: num(o.dear_invoiced), due: num(o.dear_due) } : null);
const stageOf = (o: Linked): OrderStage => orderStage(o.status, dearOf(o));

// ---------- products and stock ----------
export type ProductHit = { sku: string; name: string; brand: string | null; price: number | null; increment: number | null; image: string | null; status: string | null; available: number; pending: number; free: number; incoming: { qty: number; date: string | null; po: string | null } | null; eta: string | null };
/** Units on trade show orders that DEAR has not allocated yet, by SKU (sent orders not yet confirmed in DEAR). */
// What other orders have already taken is the slowest part of every stock figure. For screens that only SHOW stock (search, other colours, the range) the answer
// is kept for 15 seconds, so several reps looking at the same products do not each make the database do it again. Saving an order always asks fresh.
const pendingCache = new Map<string, { at: number; m: Map<string, number> }>();
const PENDING_TTL = 15_000;
export const _forgetPending = () => pendingCache.clear();
async function pendingBySku(skus: string[], exceptOrder: string | null = null, fresh = false): Promise<Map<string, number>> {
  if (!skus.length) return new Map();
  const key = [...new Set(skus.map(s => s.toUpperCase()))].sort().join('|') + '#' + (exceptOrder ?? '');
  if (!fresh) { const hit = pendingCache.get(key); if (hit && Date.now() - hit.at < PENDING_TTL) return hit.m; }
  const m = await pendingFresh(skus, exceptOrder);
  if (!fresh) { if (pendingCache.size > 300) pendingCache.clear(); pendingCache.set(key, { at: Date.now(), m }); }
  return m;
}
async function pendingFresh(skus: string[], exceptOrder: string | null): Promise<Map<string, number>> {
  // only the sent orders that have one of these SKUs are matched to DEAR (matching every order to every DEAR quote is the slow part)
  const only = ` where o.kind = 'order' and o.status = 'sent' and ($2::uuid is null or o.id <> $2::uuid) and exists (select 1 from crm.ts_order_lines x where x.order_id = o.id and upper(x.sku) = any($1::text[]))`;
  const rows = await prisma.$queryRawUnsafe<(Linked & { sku: string; qty: number })[]>(`${linkedCte(only)}
    select ol.*, l.sku, l.qty from ol join crm.ts_order_lines l on l.order_id = ol.id
    where ol.kind = 'order' and ol.status = 'sent' and upper(l.sku) = any($1::text[]) and ($2::uuid is null or ol.id <> $2::uuid)`, skus.map(s => s.toUpperCase()), exceptOrder);
  const m = new Map<string, number>();
  for (const r of rows) if (holdsStock(r.kind, stageOf(r))) m.set(r.sku.toUpperCase(), (m.get(r.sku.toUpperCase()) ?? 0) + Number(r.qty));
  return m;
}
async function stockFacts(skus: string[], exceptOrder: string | null = null, fresh = false) {
  const up = [...new Set(skus.map(s => s.toUpperCase()))];
  // the four lookups are independent, so they run together (one wait instead of four)
  const [prods, dearEtaRows, pos, pending] = up.length ? await Promise.all([
    prisma.$queryRaw<any[]>`select sku, name, brand, status, available, prices, order_increment, image_url, to_char(eta, 'DD Mon YYYY') as eta from crm.products where upper(sku) = any(${up}::text[])`,
    prisma.$queryRaw<{ sku: string; e: string | null }[]>`select upper(sku) as sku, dear_eta as e from crm.products where upper(sku) = any(${up}::text[]) and dear_eta is not null`.catch(() => [] as { sku: string; e: string | null }[]),   // product-eta.sql not run
    prisma.$queryRaw<{ sku: string; qty: number; due: Date | null; po: string | null }[]>`
      select upper(pl.sku) as sku, (pl.quantity_ordered - pl.quantity_received)::float8 as qty, p.required_by as due, p.number as po
      from crm.purchase_lines pl join crm.purchases p on p.id = pl.purchase_id
      where upper(pl.sku) = any(${up}::text[]) and pl.quantity_ordered - pl.quantity_received > 0
        and upper(coalesce(p.status, '')) not in ('VOIDED', 'CREDITED', 'DRAFT') and upper(coalesce(p.status, '')) not like 'COMPLETED%'
      order by p.required_by nulls last`,
    pendingBySku(up, exceptOrder, fresh),
  ]) : [[], [], [], new Map<string, number>()] as const;
  const dearEta = new Map(dearEtaRows.map(r => [r.sku, r.e!]));
  const incoming = new Map<string, { qty: number; date: string | null; po: string | null }>();
  for (const p of pos) if (!incoming.has(p.sku)) incoming.set(p.sku, { qty: Math.round(p.qty), date: p.due ? new Date(p.due).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : null, po: p.po });
  return new Map(prods.map(p => {
    const k = String(p.sku).toUpperCase(), avail = Math.floor(Number(p.available) || 0), pend = pending.get(k) ?? 0;
    const hit: ProductHit = { sku: p.sku, name: p.name, brand: p.brand, price: wholesalePrice(p.prices), increment: p.order_increment ?? null, image: p.image_url ?? null, status: p.status,
      available: avail, pending: pend, free: avail - pend, incoming: incoming.get(k) ?? null, eta: dearEta.get(k) ?? p.eta ?? null };
    return [k, hit] as [string, ProductHit];
  }));
}
export async function searchProducts(q: unknown): Promise<ProductHit[]> {
  const term = String(q ?? '').trim();
  if (term.length < 2) return [];
  const like = `%${term.replace(/[%_\\]/g, m => '\\' + m)}%`;
  const rows = await prisma.$queryRaw<{ sku: string }[]>`
    select sku from crm.products
    where (sku ilike ${like} or name ilike ${like} or barcode = ${term} or brand ilike ${like}) and coalesce(status, '') not in ('Deprecated')
    order by (upper(sku) = upper(${term}) or barcode = ${term}) desc, (sku ilike ${term + '%'}) desc, name limit 25`;
  const facts = await guard(() => stockFacts(rows.map(r => r.sku)));
  return rows.map(r => facts.get(r.sku.toUpperCase())!).filter(Boolean);
}

/** One brand's products with pictures, price and stock, for showing a customer the range (and comparing). With no brand it gives just the list of brands. */
const brandCache: { at: number; list: { brand: string; n: number }[] } = { at: 0, list: [] };
export async function productRange(brandIn: unknown, showId?: unknown, qIn?: unknown): Promise<{ brands: { brand: string; n: number }[]; stand: string[]; products: ProductHit[] }> {
  const brand = String(brandIn ?? '').trim().slice(0, 80), q = String(qIn ?? '').trim().slice(0, 60);
  const sid = typeof showId === 'string' && UUID.test(showId) ? showId : '00000000-0000-0000-0000-000000000000';
  const [brands, stand, rows] = await Promise.all([
    Date.now() - brandCache.at < 600_000 && brandCache.list.length ? Promise.resolve(brandCache.list)
      : prisma.$queryRaw<{ brand: string; n: number }[]>`select brand, count(*)::int as n from crm.products where brand is not null and btrim(brand) <> '' and coalesce(status, '') not in ('Deprecated') group by brand order by brand`
        .then(l => { brandCache.at = Date.now(); brandCache.list = l; return l; }),
    hand.getStandBrands(sid),
    brand || q ? prisma.$queryRaw<{ sku: string }[]>`select sku from crm.products where coalesce(status, '') not in ('Deprecated')
      and (${brand} = '' or lower(brand) = lower(${brand})) and (${q} = '' or name ilike ${'%' + q.replace(/[%_\\]/g, m => '\\' + m) + '%'} or sku ilike ${'%' + q.replace(/[%_\\]/g, m => '\\' + m) + '%'})
      order by name limit 60` : Promise.resolve([] as { sku: string }[]),
  ]);
  const facts = rows.length ? await guard(() => stockFacts(rows.map(r => r.sku))) : new Map<string, ProductHit>();
  return { brands, stand, products: rows.map(r => facts.get(r.sku.toUpperCase())!).filter(Boolean) };
}

export type VariantHit = ProductHit & { colour: string; onStand: boolean };
/** The same item in its other colours (read from the names), with stock, so a rep can offer the ones the stand does not have. Newest names first is not needed: the colours are sorted. */
export async function productVariants(sku: unknown, showId?: unknown): Promise<{ colour: string | null; others: VariantHit[] }> {
  const s = String(sku ?? '').trim();
  if (!s) return { colour: null, others: [] };
  const [me] = await prisma.$queryRaw<{ name: string; brand: string | null }[]>`select name, brand from crm.products where upper(sku) = upper(${s}) limit 1`;
  if (!me) return { colour: null, others: [] };
  const { base, colour } = splitColour(me.name);
  if (!colour || base.length < 3) return { colour: null, others: [] };
  // the candidates share the base words and the brand; the names are then split again to be sure the base is the same
  const like = `%${base.replace(/[%_\\]/g, m => '\\' + m)}%`;
  const rows = await prisma.$queryRaw<{ sku: string; name: string }[]>`
    select sku, name from crm.products where brand is not distinct from ${me.brand} and upper(sku) <> upper(${s}) and name ilike ${like} and coalesce(status, '') not in ('Deprecated') order by name limit 60`;
  const same = rows.filter(r => { const x = splitColour(r.name); return x.base === base && x.colour && x.colour !== colour; });
  if (!same.length) return { colour, others: [] };
  const facts = await guard(() => stockFacts(same.map(r => r.sku)));
  const stand = new Set((await hand.getStandBrands(typeof showId === 'string' && UUID.test(showId) ? showId : '00000000-0000-0000-0000-000000000000')).map(b => b.toLowerCase()));
  const others = same.map(r => ({ r, f: facts.get(r.sku.toUpperCase()) })).filter(x => x.f).map(x => ({ ...x.f!, colour: splitColour(x.r.name).colour!, onStand: !!x.f!.brand && stand.has(x.f!.brand.toLowerCase()) }));
  return { colour, others: others.sort((a, b) => a.colour.localeCompare(b.colour)) };
}

// ---------- range on the stand ----------
export async function getStand(showId: unknown) {
  const sid = idOk(showId, 'That show');
  const ready = await hand.standReady();
  const [brands, allBrands] = await Promise.all([hand.getStandBrands(sid), ready ? hand.allBrands() : Promise.resolve([] as string[])]);   // one trip each, side by side
  return { ready, brands, allBrands };
}
export async function saveStand(rep: Rep, showId: unknown, brands: unknown): Promise<void> {
  const sid = idOk(showId, 'That show');
  if (!isManager(rep)) throw new TsError('Only managers can set the range on the stand.', 403);
  if (!(await hand.standReady())) throw new TsError('The range on the stand is not set up in the database yet. Ask whoever looks after Radar to run tradeshow-handoffs.sql.', 503);
  const list = [...new Set((Array.isArray(brands) ? brands : []).map(b => String(b ?? '').trim()).filter(Boolean))].slice(0, 300);
  await showRow(sid);
  await hand.putStandBrands(sid, list);
}

// ---------- customers ----------
export type CustomerHit = { id: string; name: string; region: string; contact: string | null; email: string | null; phone: string | null; address: string | null; terms: string | null; archived: boolean };
const CUSTOMER_COLS = `id, name, region, contact_name as contact, email, phone, address, payment_terms as terms, archived`;
export async function searchCustomers(q: unknown): Promise<CustomerHit[]> {
  const term = String(q ?? '').trim();
  if (term.length < 2) return [];
  const like = `%${term.replace(/[%_\\]/g, m => '\\' + m)}%`, ph = phoneKey(term);
  return prisma.$queryRawUnsafe<CustomerHit[]>(`select ${CUSTOMER_COLS} from crm.accounts
    where not misc and (name ilike $1 or email ilike $1 or contact_name ilike $1 or ($2::text is not null and right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), 8) = $2))
    order by archived, (name ilike $3) desc, name limit 12`, like, ph, `${term}%`);
}
export async function customerById(id: string): Promise<CustomerHit | null> {
  if (!UUID.test(id)) return null;
  const [a] = await prisma.$queryRawUnsafe<CustomerHit[]>(`select ${CUSTOMER_COLS} from crm.accounts where id = $1::uuid and not misc`, id);
  return a ?? null;
}
/** Accounts that look like the same shop (same email, phone, or name), so nobody makes a second one by mistake. */
export async function lookAlikes(b: { name: string; email: string | null; phone: string | null }): Promise<CustomerHit[]> {
  const rows = await prisma.$queryRawUnsafe<(CustomerHit & { k: string; p: string })[]>(`select ${CUSTOMER_COLS}, lower(regexp_replace(name, '[^A-Za-z0-9]', '', 'g')) as k,
      right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), 8) as p from crm.accounts
    where ($1::text is not null and lower(email) = $1) or ($2::text is not null and right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), 8) = $2)
       or lower(name) like $3 limit 20`, b.email?.toLowerCase() ?? null, phoneKey(b.phone), `%${b.name.toLowerCase().slice(0, 6).replace(/[%_\\]/g, '')}%`);
  const k = nameKey(b.name);
  return rows.filter(r => (b.email && r.email?.toLowerCase() === b.email.toLowerCase()) || (phoneKey(b.phone) && r.p === phoneKey(b.phone)) || nameKey(r.name) === k).map(({ k: _k, p: _p, ...r }) => r).slice(0, 5);
}
/** A new account made at the show: a prospect, prepay, owned by whoever wrote it. When the sales team sets the customer up in DEAR with the same name, the sync links them. */
async function createAccount(rep: Rep, b: any): Promise<{ id: string; isNew: true }> {
  const nc = parseNewCustomer(b);
  if (!b?.confirmNew) {
    const same = await lookAlikes(nc);
    if (same.length) { const e = new TsError(`This looks like a customer Radar already has: ${same.map(s => `${s.name} (${s.region})`).join(', ')}. Pick them instead, or confirm it is a new customer.`, 409) as TsError & { matches?: CustomerHit[] }; e.matches = same; throw e; }
  }
  const [a] = await prisma.$queryRaw<{ id: string }[]>`
    insert into crm.accounts (id, name, region, rep_id, credit, type, stage, updated_at, contact_name, email, phone, address, category)
    values (gen_random_uuid(), ${nc.name}, ${nc.region}, ${rep.id}::uuid, 'prepay'::crm."CreditTerm", 'prospect'::crm."AccountType", 'new_lead'::crm."Stage", now(), ${nc.contact}, ${nc.email}, ${nc.phone}, ${nc.address}, ${nc.category})
    returning id`;
  return { id: a!.id, isNew: true };
}
async function accountFor(rep: Rep, b: any): Promise<{ id: string; isNew: boolean }> {
  if (b?.accountId) {
    const id = idOk(b.accountId, 'That customer');
    const [a] = await prisma.$queryRaw<{ id: string }[]>`select id from crm.accounts where id = ${id}::uuid`;
    if (!a) throw new TsError('That customer was not found.', 404);
    return { id, isNew: false };
  }
  if (b?.newCustomer) return createAccount(rep, b.newCustomer);
  throw new TsError('Choose the customer, or add a new one.');
}

// ---------- shows ----------
export type ShowInput = { name: string; refName: string; startsOn: string; endsOn: string; venue: string | null; stand: string | null; staff: string | null; notes: string | null; target: number | null; costs: { stand: number | null; travel: number | null; samples: number | null; other: number | null }; cardSurchargePct: number | null; archived: boolean };
const money = (v: unknown, what: string): number | null => { if (v === null || v === undefined || v === '') return null; const n = Number(v); if (!Number.isFinite(n) || n < 0) throw new TsError(`The ${what} must be a number.`); return round2(n); };
function parseShow(b: any): ShowInput {
  const name = cleanText(b?.name, 120); if (!name) throw new TsError('Give the show a name.');
  const startsOn = parseDay(b?.startsOn, 'first day'), endsOn = parseDay(b?.endsOn || b?.startsOn, 'last day');
  if (endsOn < startsOn) throw new TsError('The last day is before the first day.');
  const pct = money(b?.cardSurchargePct, 'card surcharge'); if (pct !== null && pct > 10) throw new TsError('The card surcharge looks too high (it is a %).');
  return { name, refName: (cleanText(b?.refName, 40) ?? name.slice(0, 40)).toUpperCase(), startsOn, endsOn, venue: cleanText(b?.venue, 160), stand: cleanText(b?.stand, 40), staff: cleanText(b?.staff, 300), notes: cleanText(b?.notes, 2000),
    target: money(b?.target, 'target'), costs: { stand: money(b?.costs?.stand, 'stand cost'), travel: money(b?.costs?.travel, 'travel cost'), samples: money(b?.costs?.samples, 'samples cost'), other: money(b?.costs?.other, 'other cost') },
    cardSurchargePct: pct, archived: b?.archived === true };
}
export async function saveShow(rep: Rep, b: any, id?: unknown): Promise<string> {
  if (!isManager(rep)) throw new TsError('Only managers can set up shows.', 403);
  const s = parseShow(b);
  return guard(async () => {
    if (id !== undefined) {
      const sid = idOk(id, 'That show');
      const r = await prisma.$queryRaw<{ id: string }[]>`update crm.ts_shows set name = ${s.name}, ref_name = ${s.refName}, starts_on = ${s.startsOn}::date, ends_on = ${s.endsOn}::date, venue = ${s.venue}, stand = ${s.stand}, staff = ${s.staff}, notes = ${s.notes},
        target = ${s.target}, cost_stand = ${s.costs.stand}, cost_travel = ${s.costs.travel}, cost_samples = ${s.costs.samples}, cost_other = ${s.costs.other}, card_surcharge_pct = ${s.cardSurchargePct}, archived = ${s.archived}, updated_at = now()
        where id = ${sid}::uuid returning id`;
      if (!r.length) throw new TsError('That show was not found.', 404);
      return sid;
    }
    const [r] = await prisma.$queryRaw<{ id: string }[]>`insert into crm.ts_shows (name, ref_name, starts_on, ends_on, venue, stand, staff, notes, target, cost_stand, cost_travel, cost_samples, cost_other, card_surcharge_pct, created_by)
      values (${s.name}, ${s.refName}, ${s.startsOn}::date, ${s.endsOn}::date, ${s.venue}, ${s.stand}, ${s.staff}, ${s.notes}, ${s.target}, ${s.costs.stand}, ${s.costs.travel}, ${s.costs.samples}, ${s.costs.other}, ${s.cardSurchargePct}, ${rep.id}::uuid) returning id`;
    return r!.id;
  });
}
type ShowRow = { id: string; name: string; ref_name: string; starts_on: Date; ends_on: Date; venue: string | null; stand: string | null; staff: string | null; notes: string | null; target: string | null; cost_stand: string | null; cost_travel: string | null; cost_samples: string | null; cost_other: string | null; card_surcharge_pct: string | null; archived: boolean };
const showOut = (s: ShowRow) => ({ id: s.id, name: s.name, refName: s.ref_name, startsOn: day(s.starts_on)!, endsOn: day(s.ends_on)!, venue: s.venue, stand: s.stand, staff: s.staff, notes: s.notes, target: num(s.target),
  costs: { stand: num(s.cost_stand), travel: num(s.cost_travel), samples: num(s.cost_samples), other: num(s.cost_other) }, cardSurchargePct: num(s.card_surcharge_pct), archived: s.archived });
async function showRow(id: string): Promise<ShowRow> {
  const [s] = await prisma.$queryRaw<ShowRow[]>`select * from crm.ts_shows where id = ${id}::uuid`;
  if (!s) throw new TsError('That show was not found.', 404);
  return s;
}

// ---------- orders ----------
type LineRow = { line_no: number; sku: string; name: string; brand: string | null; qty: number; price: string; comment: string | null; pct: number; line_kind: string; offer_id: string | null };
const discountOf = (o: any): Discount => (o.discount_kind && Number(o.discount_value) > 0 ? { kind: o.discount_kind, value: Number(o.discount_value) } : null);
function orderTotals(o: any, lines: { qty: number; price: number; pct?: number }[]) {
  return totals({ lines, discount: discountOf(o), freight: Number(o.freight) || 0, cardPayment: !!o.card_payment, surchargePct: num(o.card_surcharge_pct), gstRate: Number(o.gst_rate) });
}
async function linesOf(ids: string[]): Promise<Map<string, LineRow[]>> {
  const rows = ids.length ? await prisma.$queryRaw<(LineRow & { order_id: string })[]>`select order_id, line_no, sku, name, brand, qty, price::text, comment, pct::float8 as pct, line_kind, offer_id from crm.ts_order_lines where order_id = any(${ids}::uuid[]) order by order_id, line_no` : [];
  const m = new Map<string, LineRow[]>(); for (const r of rows) m.set(r.order_id, [...(m.get(r.order_id) ?? []), r]); return m;
}
async function linkedOrders(where: string, ...params: unknown[]): Promise<Linked[]> {
  return prisma.$queryRawUnsafe<Linked[]>(`${LINKED} select ol.*, a.name as customer, a.region, r.name as rep_name from ol join crm.accounts a on a.id = ol.account_id left join crm.reps r on r.id = ol.rep_id where ${where}`, ...params);
}
async function orderRow(id: string): Promise<Linked> {
  const [o] = await linkedOrders('ol.id = $1::uuid', id);
  if (!o) throw new TsError('That order was not found.', 404);
  return o;
}
const canEdit = (rep: Rep, o: Linked) => isManager(rep) || o.rep_id === rep.id;

export async function startOrder(rep: Rep, b: any): Promise<string> {
  return guard(async () => {
    const show = await showRow(idOk(b?.showId, 'That show'));
    if (show.archived) throw new TsError('That show is closed.');
    const kind = b?.kind === 'quote' ? 'quote' : 'order';
    const acct = await accountFor(rep, b);
    const [a] = await prisma.$queryRaw<any[]>`select region, contact_name, email, phone, address from crm.accounts where id = ${acct.id}::uuid`;
    const [o] = await prisma.$queryRaw<{ id: string; number: string; order_date: Date }[]>`
      insert into crm.ts_orders (show_id, account_id, new_customer, kind, rep_id, contact_name, contact_email, contact_phone, delivery_address, gst_rate, card_surcharge_pct)
      values (${show.id}::uuid, ${acct.id}::uuid, ${acct.isNew}, ${kind}, ${rep.id}::uuid, ${a.contact_name}, ${a.email}, ${a.phone}, ${a.address}, ${gstRateFor(a.region)}, ${num(show.card_surcharge_pct)})
      returning id, number, order_date`;
    const dref = dearReference(show.ref_name, day(o!.order_date)!);   // what sales type in DEAR; Radar's own adds the TS number
    await prisma.$queryRaw`update crm.ts_orders set dear_reference = ${dref}, reference = ${`${dref} ${o!.number}`} where id = ${o!.id}::uuid`;
    if (acct.isNew) await addSystemLog(o!.id, null, rep.id, 'New customer added at the show.');
    return o!.id;
  });
}

/** Saves the order as it is being written (a draft). Lines are priced at wholesale ex GST from Radar's products. Only a manager can set a discount. */
export async function saveOrder(rep: Rep, id: unknown, b: any): Promise<void> {
  const oid = idOk(id, 'That order');
  await guard(async () => {
    const o = await orderRow(oid);
    if (!canEdit(rep, o)) throw new TsError('Only the person who wrote it, or a manager, can change it.', 403);
    const field = (k: string, max: number) => (b?.[k] === undefined ? undefined : cleanText(b[k], max));
    if (o.status === 'sent') {   // after it is confirmed, only the reference, the customer's PO and the notes change (then send it again)
      const ref = b?.reference === undefined ? undefined : cleanReference(b.reference);
      await prisma.$queryRaw`update crm.ts_orders set dear_reference = coalesce(${ref ?? null}::text, dear_reference), reference = case when ${ref ?? null}::text is not null then ${ref ?? null}::text || ' ' || number else reference end, customer_po = case when ${b?.customerPo !== undefined}::boolean then ${field('customerPo', 60) ?? null}::text else customer_po end,
        notes = case when ${b?.notes !== undefined}::boolean then ${field('notes', 2000) ?? null}::text else notes end, updated_at = now() where id = ${oid}::uuid`;
      if (ref && ref !== (o.dear_reference ?? o.reference)) await addSystemLog(oid, null, rep.id, `Reference changed from "${o.dear_reference ?? o.reference}" to "${ref}". Send it to sales again so they use the new one.`);
      return;
    }
    if (o.status !== 'draft') throw new TsError('A cancelled order cannot be changed.');
    // the lines
    let lines: { sku: string; qty: number; comment: string | null; kind: 'normal' | 'bundle'; offerId: string | null }[] | undefined;
    if (b?.lines !== undefined) {
      if (!Array.isArray(b.lines) || b.lines.length > 300) throw new TsError('Too many lines.');
      lines = b.lines.map((l: any) => ({ sku: String(l?.sku ?? '').trim(), qty: Number(l?.qty), comment: cleanText(l?.comment, 200), kind: l?.kind === 'bundle' ? 'bundle' as const : 'normal' as const, offerId: typeof l?.offerId === 'string' && UUID.test(l.offerId) ? l.offerId : null }));
      for (const l of lines!) if (!l.sku || !Number.isInteger(l.qty) || l.qty < 1 || l.qty > 100000) throw new TsError(`Check the quantity for ${l.sku || 'a line'} (a whole number of 1 or more).`);
      const facts = await stockFacts(lines!.map(l => l.sku), oid, true);
      const priced = lines!.map(l => { const f = facts.get(l.sku.toUpperCase()); if (!f) throw new TsError(`Radar has no product ${l.sku}.`); if (f.price === null) throw new TsError(`${f.sku} has no wholesale price in DEAR.`); return { ...l, sku: f.sku, name: f.name, brand: f.brand, price: f.price }; });
      await writeLines(oid, await withOffers(o.show_id, priced as any));
    }
    // the discount: managers only
    let dKind: string | null | undefined, dValue: number | null | undefined;
    if (b?.discount !== undefined) {
      const goods = (await linesOf([oid])).get(oid)?.reduce((s, l) => s + l.qty * Number(l.price), 0) ?? 0;
      const d = b.discount === null ? null : parseDiscount(b.discount?.kind, b.discount?.value, goods);
      const same = JSON.stringify(d) === JSON.stringify(discountOf(o));
      if (!same && !isManager(rep)) throw new TsError('Only a manager can give a discount.', 403);
      dKind = d?.kind ?? null; dValue = d?.value ?? null;
    }
    const freight = b?.freight === undefined ? undefined : money(b.freight, 'freight') ?? 0;
    const ref = b?.reference === undefined ? undefined : cleanReference(b.reference);
    const kind = b?.kind === undefined ? undefined : b.kind === 'quote' ? 'quote' : 'order';
    await prisma.$queryRaw`update crm.ts_orders set
        kind = coalesce(${kind ?? null}::text, kind), dear_reference = coalesce(${ref ?? null}::text, dear_reference), reference = case when ${ref ?? null}::text is not null then ${ref ?? null}::text || ' ' || number else reference end, freight = coalesce(${freight ?? null}::numeric, freight),
        discount_kind = case when ${dKind !== undefined}::boolean then ${dKind ?? null}::text else discount_kind end,
        discount_value = case when ${dKind !== undefined}::boolean then ${dValue ?? null}::numeric else discount_value end,
        card_payment = coalesce(${typeof b?.cardPayment === 'boolean' ? b.cardPayment : null}::boolean, card_payment),
        customer_po = case when ${b?.customerPo !== undefined}::boolean then ${field('customerPo', 60) ?? null}::text else customer_po end,
        notes = case when ${b?.notes !== undefined}::boolean then ${field('notes', 2000) ?? null}::text else notes end,
        contact_name = case when ${b?.contactName !== undefined}::boolean then ${field('contactName', 120) ?? null}::text else contact_name end,
        contact_email = case when ${b?.contactEmail !== undefined}::boolean then ${field('contactEmail', 160) ?? null}::text else contact_email end,
        contact_phone = case when ${b?.contactPhone !== undefined}::boolean then ${field('contactPhone', 40) ?? null}::text else contact_phone end,
        delivery_address = case when ${b?.deliveryAddress !== undefined}::boolean then ${field('deliveryAddress', 300) ?? null}::text else delivery_address end,
        updated_at = now()
      where id = ${oid}::uuid`;
    await autoFreight(oid, { id: rep.id, role: rep.role }, b);   // the team's calculator, or Australia Post for New Zealand, unless the freight was typed in
  });
}

/** Confirm: it becomes a sent order or quote, the email goes to sales@ with the DEAR file, and the 1st follow-up is booked a week out for the sales team. */
export async function confirmOrder(rep: Rep, id: unknown, d: { alert: typeof sendAlert } = { alert: sendAlert }): Promise<{ emailed: boolean; reason: string }> {
  const oid = idOk(id, 'That order');
  return guard(async () => {
    const o = await orderRow(oid);
    if (!canEdit(rep, o)) throw new TsError('Only the person who wrote it, or a manager, can confirm it.', 403);
    if (o.status !== 'draft') throw new TsError(o.status === 'sent' ? 'It has already been confirmed. Use Send again to email sales again.' : 'A cancelled order cannot be confirmed.');
    const lines = (await linesOf([oid])).get(oid) ?? [];
    if (!lines.length) throw new TsError('Add at least one product.');
    const hasHandoff = await hand.handoffReady();
    const chosen = hasHandoff ? await hand.getHandoff(oid) : null;
    if (chosen?.mode === 'paid' && (!chosen.hasProof || !chosen.method)) throw new TsError('Add the payment screenshot, or choose "Sales will send the payment details".');
    if (chosen?.mode === 'paid' && o.kind !== 'order') throw new TsError('Only an order can be paid at the show. A quote is sent to the customer by sales.');
    const done = await prisma.$queryRaw<{ id: string }[]>`update crm.ts_orders set status = 'sent', confirmed_at = now(), updated_at = now() where id = ${oid}::uuid and status = 'draft' returning id`;
    if (!done.length) throw new TsError('It has already been confirmed.');   // a second press of Confirm
    await addSystemLog(oid, null, rep.id, `${o.kind === 'quote' ? 'Quote' : 'Order'} confirmed: ${lines.length} lines.`);
    if (hasHandoff) {
      // every confirmed order lands in sales' To action list; a paid one carries the final amount (the total can move between taking the screenshot and confirming)
      await prisma.$queryRaw`insert into crm.ts_handoffs (order_id, mode) values (${oid}::uuid, 'later') on conflict (order_id) do nothing`;
      if (chosen?.mode === 'paid') {
        const t = orderTotals(o, lines.map(l => ({ qty: l.qty, price: Number(l.price), pct: Number(l.pct) || 0 })));
        await hand.setAmount(oid, t.total);
        await addSystemLog(oid, null, rep.id, `Paid at the show by ${chosen.method === 'card' ? 'card' : 'bank transfer'}: $${t.total.toFixed(2)} inc GST, screenshot kept.`);
      }
    }
    await prisma.$queryRaw`insert into crm.ts_followups (order_id, due_on, created_by) values (${oid}::uuid, ${firstFollowUp(day(o.order_date)!)}::date, ${rep.id}::uuid) on conflict do nothing`;
    return emailSales(rep, oid, d);
  });
}
export async function resendOrder(rep: Rep, id: unknown, d: { alert: typeof sendAlert } = { alert: sendAlert }) {
  const oid = idOk(id, 'That order');
  return guard(async () => {
    const o = await orderRow(oid);
    if (o.status !== 'sent') throw new TsError('Only a confirmed order can be sent to sales.');
    if (!canEdit(rep, o)) throw new TsError('Only the person who wrote it, or a manager, can send it again.', 403);
    return emailSales(rep, oid, d);
  });
}
const CHARGES = () => ({ freight: process.env.TS_FREIGHT_SKU?.trim() || null, surcharge: process.env.TS_SURCHARGE_SKU?.trim() || null });
/** Builds the email and the DEAR file and sends them to the "Trade show orders" list in Settings (sales@). */
async function emailSales(rep: Rep, oid: string, d: { alert: typeof sendAlert }): Promise<{ emailed: boolean; reason: string }> {
  const [v] = await prisma.$queryRaw<{ v: number }[]>`update crm.ts_orders set email_version = email_version + 1 where id = ${oid}::uuid returning email_version as v`;
  const o = await orderRow(oid);
  const show = await showRow(o.show_id);
  const [a] = await prisma.$queryRaw<any[]>`select name, region, payment_terms from crm.accounts where id = ${o.account_id}::uuid`;
  const lines = (await linesOf([oid])).get(oid) ?? [];
  const t = orderTotals(o, lines.map(l => ({ qty: l.qty, price: Number(l.price), pct: Number(l.pct) || 0 })));
  const facts = await stockFacts(lines.map(l => l.sku), oid, true);
  const ch = await chargeSkus();
  const plus = await orderPlus(o, lines, t, stageOf(o));
  const charges = [...(ch.freight ? [{ sku: ch.freight, name: 'Freight', amount: t.freight }] : []), ...(ch.surcharge ? [{ sku: ch.surcharge, name: 'Credit card surcharge', amount: t.surcharge }] : [])];
  const pay = await hand.getHandoffWithProof(oid);
  const msg = salesEmail({
    number: o.number, kind: o.kind, reference: o.reference, dearReference: plus.dearReference, customerPo: o.customer_po, orderDate: day(o.order_date)!, showName: show.name, repName: o.rep_name,
    customer: { name: a.name, isNew: o.new_customer, region: a.region, contact: o.contact_name, email: o.contact_email, phone: o.contact_phone, address: o.delivery_address, terms: a.payment_terms },
    lines: lines.map((l, i) => { const f = facts.get(l.sku.toUpperCase()); return { sku: l.sku, name: l.name, qty: l.qty, price: Number(l.price), lineTotal: t.lineTotals[i]!, pct: t.linePcts[i], note: l.line_kind === 'gift' ? 'free bonus' : l.line_kind === 'bundle' ? 'bundle' : null, stock: f ? stockView(l.qty, f.available, f.pending, f.incoming, f.eta).note : 'not in Radar' }; }),
    totals: t, notes: o.notes, version: v!.v, chargesInFile: !!(ch.freight || !t.freight) && !!(ch.surcharge || !t.surcharge), payBy: plus.payBy, offersNote: plus.applied.map(x => x.text), freightNote: o.freight_note,
    payment: pay ? { mode: pay.mode, method: pay.method, amount: pay.amount, proofName: pay.proofName } : null,
  });
  const csv = dearCsv(lines.map((l, i) => ({ sku: l.sku, name: l.name, comment: l.comment, qty: l.qty, price: Number(l.price), pct: t.linePcts[i] })), t.linePct, charges);
  const file = `${o.reference.replace(/[^\w\- ]+/g, '_').trim()}.csv`;
  const r = await d.alert('tradeshow_order' as any, msg, { relatedId: `ts|${oid}|v${v!.v}`, attachments: [{ name: file, mime: 'text/csv', data: Buffer.from(csv, 'utf8') }, ...(pay?.mode === 'paid' && pay.proof ? [{ name: `payment-${o.number}${pay.proofMime === 'image/png' ? '.png' : pay.proofMime === 'image/webp' ? '.webp' : '.jpg'}`, mime: pay.proofMime ?? 'image/jpeg', data: pay.proof }] : [])] } as any);
  const why = r.sent ? null : r.reason === 'off' ? 'The "Trade show orders" email list is off in Settings (Email alerts). Switch it on with sales@ in it, then press Send again.' : r.reason;
  await prisma.$queryRaw`update crm.ts_orders set emailed_at = case when ${r.sent}::boolean then now() else emailed_at end, email_error = ${why} where id = ${oid}::uuid`;
  await addSystemLog(oid, null, rep.id, r.sent ? `Emailed to sales${v!.v > 1 ? ` again (version ${v!.v})` : ''} with ${file}. Reference: ${o.reference}` : `Not emailed to sales: ${why}`);
  return { emailed: r.sent, reason: why ?? 'sent' };
}
export async function cancelOrder(rep: Rep, id: unknown, reason: unknown): Promise<void> {
  const oid = idOk(id, 'That order');
  await guard(async () => {
    const o = await orderRow(oid);
    if (!canEdit(rep, o)) throw new TsError('Only the person who wrote it, or a manager, can cancel it.', 403);
    if (o.status === 'cancelled') return;
    if (o.status === 'draft') { await prisma.$queryRaw`delete from crm.ts_orders where id = ${oid}::uuid and status = 'draft'`; return; }   // a draft is just thrown away
    const why = cleanText(reason, 300); if (!why) throw new TsError('Say why it is cancelled.');
    await prisma.$queryRaw`update crm.ts_orders set status = 'cancelled', cancelled_at = now(), cancel_reason = ${why}, updated_at = now() where id = ${oid}::uuid`;
    await prisma.$queryRaw`update crm.ts_followups set done_on = ${today()}::date, done_by = ${rep.id}::uuid, done_note = 'Closed: order cancelled' where order_id = ${oid}::uuid and done_on is null`;
    await addSystemLog(oid, null, rep.id, `Cancelled: ${why}. Tell the sales team if it is already in DEAR.`);
  });
}
/** Ties it to a DEAR order by its number (when the sales team used a different reference). Blank clears it. */
export async function linkDear(rep: Rep, id: unknown, number: unknown): Promise<void> {
  const oid = idOk(id, 'That order');
  await guard(async () => {
    const o = await orderRow(oid);
    if (!canEdit(rep, o)) throw new TsError('Only the person who wrote it, or a manager, can link it.', 403);
    const n = String(number ?? '').trim().toUpperCase();
    if (!n) { await prisma.$queryRaw`update crm.ts_orders set dear_quote_id = null where id = ${oid}::uuid`; return; }
    const [q] = await prisma.$queryRaw<{ id: string; account_id: string }[]>`select id, account_id from crm.quotes where upper(number) = ${n} and source is distinct from 'rhino-history' limit 1`;
    if (!q) throw new TsError(`Radar has no DEAR order ${n} yet (it arrives with the next sync).`);
    await prisma.$queryRaw`update crm.ts_orders set dear_quote_id = ${q.id}::uuid where id = ${oid}::uuid`;
    await addSystemLog(oid, null, rep.id, `Linked to DEAR order ${n} by hand.${q.account_id !== o.account_id ? ' Note: that DEAR order is on a different account in Radar.' : ''}`);
  });
}
/** Notes "found in DEAR" once in the log when an order is first matched (called when it is read). */
async function noteDearMatch(o: Linked) {
  if (!o.dear_number || o.status !== 'sent') return;
  const text = `Found in DEAR as ${o.dear_number}.`;
  const [had] = await prisma.$queryRaw<{ one: number }[]>`select 1 as one from crm.ts_log where order_id = ${o.id}::uuid and kind = 'system' and note = ${text} limit 1`;
  if (!had) await addSystemLog(o.id, null, null, text);
}

export async function getOrder(id: unknown) {
  const oid = idOk(id, 'That order');
  return guard(async () => {
    const o = await orderRow(oid);
    // Every database call costs a round trip (160 to 245 ms), so the ones that do not depend on each other run together: two waits instead of ten.
    const noted = noteDearMatch(o);   // may add one log line, so the log is read after it
    const [show, lines, [a], log, followUps, handoffReady, handoff] = await Promise.all([
      showRow(o.show_id),
      linesOf([oid]).then(m => m.get(oid) ?? []),
      prisma.$queryRawUnsafe<CustomerHit[]>(`select ${CUSTOMER_COLS} from crm.accounts where id = $1::uuid`, o.account_id),
      noted.then(() => logOf({ orderId: oid })),
      followUpsOf({ orderId: oid }),
      hand.handoffReady(),
      hand.getHandoff(oid),
    ]);
    const t = orderTotals(o, lines.map(l => ({ qty: l.qty, price: Number(l.price), pct: Number(l.pct) || 0 })));
    const stage = stageOf(o);
    const [facts, plus] = await Promise.all([stockFacts(lines.map(l => l.sku), oid), orderPlus(o, lines, t, stage, a?.region ?? null)]);
    return {
      id: o.id, number: o.number, kind: o.kind, status: o.status, stage, stageLabel: STAGE_LABEL[stage], show: showOut(show), customer: a, newCustomer: o.new_customer,
      orderDate: day(o.order_date)!, reference: o.reference, customerPo: o.customer_po, notes: o.notes, repId: o.rep_id, repName: o.rep_name,
      contact: { name: o.contact_name, email: o.contact_email, phone: o.contact_phone, address: o.delivery_address },
      discount: discountOf(o), freight: Number(o.freight), cardPayment: o.card_payment, cardSurchargePct: num(o.card_surcharge_pct), gstRate: Number(o.gst_rate),
      lines: lines.map((l, i) => { const f = facts.get(l.sku.toUpperCase()); return { lineNo: l.line_no, kind: l.line_kind, offerId: l.offer_id, pct: Number(l.pct) || 0, sku: l.sku, name: l.name, brand: l.brand, qty: l.qty, price: Number(l.price), comment: l.comment, lineTotal: t.lineTotals[i],
        increment: f?.increment ?? null, packNote: incrementProblem(l.qty, f?.increment), stock: f ? stockView(l.qty, f.available, f.pending, f.incoming, f.eta) : null, image: f?.image ?? null }; }),
      totals: t, dear: o.dear_number ? { number: o.dear_number, status: o.dear_status, id: o.dear_id, linkedByHand: !!o.dear_quote_id } : null,
      emailedAt: o.emailed_at, emailError: o.email_error, emailVersion: o.email_version, cancelReason: o.cancel_reason, ...plus,
      log, followUps, followUpsClosed: followUpsClosed(o.kind, stage),
      handoffReady, handoff,
    };
  });
}

// ---------- paid at the show, and sales' "To action" list ----------
/** Saves how the customer is paying, for a draft order. The amount is the order's own total, so the rep never types it. */
export async function saveHandoff(rep: Rep, id: unknown, b: any): Promise<void> {
  const oid = idOk(id, 'That order');
  await guard(async () => {
    if (!(await hand.handoffReady())) throw new TsError('The payment step is not set up in the database yet. Ask whoever looks after Radar to run tradeshow-handoffs.sql.', 503);
    const o = await orderRow(oid);
    if (!canEdit(rep, o)) throw new TsError('Only the person who wrote it, or a manager, can change this.', 403);
    if (o.status !== 'draft') throw new TsError('This order is already confirmed.');
    const mode = b?.mode === 'paid' ? 'paid' : 'later';
    if (mode === 'later') return hand.putHandoff(oid, { mode, method: null, amount: null, proof: null, keepProof: false });
    if (o.kind !== 'order') throw new TsError('Only an order can be paid at the show. A quote is sent to the customer by sales.');
    const method = b?.method === 'card' ? 'card' : b?.method === 'bank' ? 'bank' : null;
    if (!method) throw new TsError('Choose bank transfer or card.');
    if (method === 'card' && !o.card_payment) throw new TsError('Tick "Paying by card" first, so the card surcharge is in the total.');
    if (method === 'bank' && o.card_payment) throw new TsError('Untick "Paying by card": a bank transfer has no card surcharge.');
    const lines = (await linesOf([oid])).get(oid) ?? [];
    if (!lines.length) throw new TsError('Add at least one product first.');
    const t = orderTotals(o, lines.map(l => ({ qty: l.qty, price: Number(l.price), pct: Number(l.pct) || 0 })));
    try { await hand.putHandoff(oid, { mode, method, amount: t.total, proof: hand.parseProof(b?.proof), keepProof: !b?.proof }); }
    catch (e) { if (e instanceof hand.HandoffInputError) throw new TsError(e.message); throw e; }
  });
}
/** The payment screenshot. Anyone signed in can see it, as anyone signed in can already see every order at a show. */
export async function paymentProof(id: unknown) {
  const oid = idOk(id, 'That order');
  const p = await guard(() => hand.proofOf(oid));
  if (!p) throw new TsError('There is no payment screenshot on this order.', 404);
  return p;
}
export async function markActioned(rep: Rep, id: unknown, b: any): Promise<void> {
  const oid = idOk(id, 'That order');
  await guard(async () => {
    const o = await orderRow(oid);
    if (o.status !== 'sent') throw new TsError('Only a confirmed order can be marked done.');
    const done = b?.done !== false;
    const note = typeof b?.note === 'string' && b.note.trim() ? b.note.trim().slice(0, 500) : null;
    if (!(await hand.setActioned(oid, rep.id, done, note))) throw new TsError('This order has no payment record to mark.', 404);
    await addSystemLog(oid, null, rep.id, done ? `Sales marked it done${note ? `: ${note}` : '.'}` : 'Sales put it back on the To action list.');
  });
}
/** What sales still has to do at a show (and the last few things done): every confirmed order, with how it was paid and where DEAR has got to. */
export async function listActions(showId: unknown) {
  const sid = idOk(showId, 'That show');
  return guard(async () => {
    if (!(await hand.handoffReady())) return { ready: false, todo: [], done: [] };
    const rows = await prisma.$queryRawUnsafe<any[]>(`${linkedCte(` where o.show_id = $1::uuid and o.status = 'sent'`)}
      select ol.*, a.name as customer, a.region, r.name as rep_name, h.mode, h.method, h.amount, h.proof is not null as has_proof, h.actioned_at, h.action_note, ab.name as actioned_by_name
      from ol join crm.ts_handoffs h on h.order_id = ol.id join crm.accounts a on a.id = ol.account_id
      left join crm.reps r on r.id = ol.rep_id left join crm.reps ab on ab.id = h.actioned_by
      order by (h.actioned_at is not null), ol.confirmed_at`, sid);
    const out = rows.map(o => {
      const stage = stageOf(o);
      return {
        id: o.id, number: o.number, kind: o.kind, customer: o.customer, region: o.region, rep: o.rep_name, confirmedAt: o.confirmed_at,
        mode: o.mode as 'later' | 'paid', method: o.method as 'bank' | 'card' | null, amount: o.amount == null ? null : Number(o.amount), hasProof: o.has_proof,
        dear: o.dear_number ?? null, stage, stageLabel: STAGE_LABEL[stage],
        // DEAR shows the order paid in full: the reconcile has effectively happened, so sales only needs to tick it
        dearPaid: stage === 'paid', actionedAt: o.actioned_at, actionedBy: o.actioned_by_name, actionNote: o.action_note,
      };
    });
    return { ready: true, todo: out.filter(x => !x.actionedAt), done: out.filter(x => x.actionedAt).sort((a, b) => String(b.actionedAt).localeCompare(String(a.actionedAt))).slice(0, 30) };
  });
}

// ---------- leads ----------
/** A lead is won once the shop places an order: a trade show order in Radar, or any real DEAR order on that account since the lead was taken. */
async function refreshLeads(showId: string | null) {
  await prisma.$queryRawUnsafe(`update crm.ts_leads l set status = 'won', closed_at = now(), updated_at = now()
    where l.status = 'open' and ($1::uuid is null or l.show_id = $1::uuid) and (
      exists (select 1 from crm.ts_orders o where o.account_id = l.account_id and o.kind = 'order' and o.status = 'sent' and o.created_at >= l.created_at - interval '1 hour')
      or exists (select 1 from crm.quotes q where q.account_id = l.account_id and q.source is distinct from 'rhino-history' and q.number not like 'Q%'
                 and q.sent_at >= l.taken_on - 1 and upper(coalesce(q.fulfillment_status, '')) <> all($2::text[])))`, showId, NOT_A_SALE);
  await prisma.$queryRawUnsafe(`update crm.ts_followups f set done_on = (now() at time zone 'Australia/Melbourne')::date, done_note = 'Closed: the lead placed an order'
    from crm.ts_leads l where f.lead_id = l.id and l.status = 'won' and f.done_on is null`);
}
export async function createLead(rep: Rep, b: any): Promise<string> {
  return guard(async () => {
    const show = await showRow(idOk(b?.showId, 'That show'));
    const acct = await accountFor(rep, b);
    const [a] = await prisma.$queryRaw<any[]>`select contact_name, email, phone from crm.accounts where id = ${acct.id}::uuid`;
    const [l] = await prisma.$queryRaw<{ id: string; taken_on: Date }[]>`insert into crm.ts_leads (show_id, account_id, new_account, contact_name, contact_email, contact_phone, brands, notes, rep_id)
      values (${show.id}::uuid, ${acct.id}::uuid, ${acct.isNew}, ${cleanText(b?.contactName, 120) ?? a.contact_name}, ${cleanText(b?.contactEmail, 160) ?? a.email}, ${cleanText(b?.contactPhone, 40) ?? a.phone},
              ${cleanText(b?.brands, 300)}, ${cleanText(b?.notes, 2000)}, ${rep.id}::uuid) returning id, taken_on`;
    await prisma.$queryRaw`insert into crm.ts_followups (lead_id, due_on, created_by) values (${l!.id}::uuid, ${firstFollowUp(day(l!.taken_on)!)}::date, ${rep.id}::uuid) on conflict do nothing`;
    await addSystemLog(null, l!.id, rep.id, `Lead taken at ${show.name}.${acct.isNew ? ' New account added.' : ''}`);
    return l!.id;
  });
}
export async function updateLead(rep: Rep, id: unknown, b: any): Promise<void> {
  const lid = idOk(id, 'That lead');
  await guard(async () => {
    const [l] = await prisma.$queryRaw<any[]>`select * from crm.ts_leads where id = ${lid}::uuid`;
    if (!l) throw new TsError('That lead was not found.', 404);
    if (b?.status === 'lost') {
      const why = cleanText(b?.reason, 200); if (!why) throw new TsError('Say why it is closed (for example "not a fit").');
      await prisma.$queryRaw`update crm.ts_leads set status = 'lost', lost_reason = ${why}, closed_at = now(), updated_at = now() where id = ${lid}::uuid`;
      await prisma.$queryRaw`update crm.ts_followups set done_on = ${today()}::date, done_by = ${rep.id}::uuid, done_note = ${'Closed: ' + why} where lead_id = ${lid}::uuid and done_on is null`;
      await addSystemLog(null, lid, rep.id, `Closed as lost: ${why}`);
    } else if (b?.status === 'open' && l.status !== 'open') {
      await prisma.$queryRaw`update crm.ts_leads set status = 'open', lost_reason = null, closed_at = null, updated_at = now() where id = ${lid}::uuid`;
      await addSystemLog(null, lid, rep.id, 'Opened again.');
    }
    if (b?.brands !== undefined || b?.notes !== undefined) await prisma.$queryRaw`update crm.ts_leads set brands = case when ${b?.brands !== undefined}::boolean then ${cleanText(b?.brands, 300)}::text else brands end,
      notes = case when ${b?.notes !== undefined}::boolean then ${cleanText(b?.notes, 2000)}::text else notes end, updated_at = now() where id = ${lid}::uuid`;
  });
}
export async function getLead(id: unknown) {
  const lid = idOk(id, 'That lead');
  return guard(async () => {
    const [l0] = await prisma.$queryRaw<any[]>`select show_id from crm.ts_leads where id = ${lid}::uuid`;
    if (!l0) throw new TsError('That lead was not found.', 404);
    await refreshLeads(l0.show_id);
    const [l] = await prisma.$queryRaw<any[]>`select l.*, r.name as rep_name from crm.ts_leads l left join crm.reps r on r.id = l.rep_id where l.id = ${lid}::uuid`;
    const [a] = await prisma.$queryRawUnsafe<CustomerHit[]>(`select ${CUSTOMER_COLS} from crm.accounts where id = $1::uuid`, l.account_id);
    const show = await showRow(l.show_id);
    return { id: l.id, show: showOut(show), customer: a, newAccount: l.new_account, contact: { name: l.contact_name, email: l.contact_email, phone: l.contact_phone }, brands: l.brands, notes: l.notes,
      status: l.status, lostReason: l.lost_reason, takenOn: day(l.taken_on)!, repName: l.rep_name, log: await logOf({ leadId: lid }), followUps: await followUpsOf({ leadId: lid }), followUpsClosed: l.status !== 'open' };
  });
}

// ---------- the log ----------
const KINDS = ['call', 'email', 'visit', 'note'] as const;
async function addSystemLog(orderId: string | null, leadId: string | null, repId: string | null, note: string) {
  await prisma.$queryRaw`insert into crm.ts_log (order_id, lead_id, kind, note, rep_id) values (${orderId}::uuid, ${leadId}::uuid, 'system', ${note}, ${repId}::uuid)`;
}
/** A call, email, visit or note. It also goes into the customer's account history, so the rep sees it there. */
export async function addLog(rep: Rep, target: { orderId?: unknown; leadId?: unknown }, kind: unknown, note: unknown): Promise<void> {
  const k = KINDS.includes(kind as any) ? (kind as (typeof KINDS)[number]) : null; if (!k) throw new TsError('Choose call, email, visit or note.');
  const text = typeof note === 'string' ? note.trim().slice(0, 4000) : ''; if (!text) throw new TsError('Write what happened.');
  await guard(async () => {
    const orderId = target.orderId ? idOk(target.orderId, 'That order') : null, leadId = target.leadId ? idOk(target.leadId, 'That lead') : null;
    const [it] = orderId ? await prisma.$queryRaw<{ account_id: string; label: string }[]>`select account_id, 'Trade show ' || kind || ' ' || number as label from crm.ts_orders where id = ${orderId}::uuid`
      : await prisma.$queryRaw<{ account_id: string; label: string }[]>`select l.account_id, 'Trade show lead, ' || s.name as label from crm.ts_leads l join crm.ts_shows s on s.id = l.show_id where l.id = ${leadId}::uuid`;
    if (!it) throw new TsError('That was not found.', 404);
    let activityId: string | null = null;
    try {
      const [act] = await prisma.$queryRaw<{ id: string }[]>`insert into crm.activity (id, account_id, rep_id, type, note, occurred_at, created_at)
        values (gen_random_uuid(), ${it.account_id}::uuid, ${rep.id}::uuid, ${k === 'note' ? 'remark' : k}::crm."ActivityType", ${`[${it.label}] ${text}`}, now(), now()) returning id`;
      activityId = act?.id ?? null;
    } catch (e) { console.error('trade show log: account history copy failed', String((e as Error)?.message ?? e).slice(0, 160)); }
    await prisma.$queryRaw`insert into crm.ts_log (order_id, lead_id, kind, note, rep_id, activity_id) values (${orderId}::uuid, ${leadId}::uuid, ${k}, ${text}, ${rep.id}::uuid, ${activityId}::uuid)`;
  });
}
async function logOf(t: { orderId?: string; leadId?: string }) {
  const rows = await prisma.$queryRaw<any[]>`select g.id, g.kind, g.note, g.at, r.name as rep from crm.ts_log g left join crm.reps r on r.id = g.rep_id
    where (${t.orderId ?? null}::uuid is not null and g.order_id = ${t.orderId ?? null}::uuid) or (${t.leadId ?? null}::uuid is not null and g.lead_id = ${t.leadId ?? null}::uuid) order by g.at desc limit 300`;
  return rows.map(r => ({ id: r.id, kind: r.kind, note: r.note, at: new Date(r.at).toISOString(), by: r.rep }));
}

// ---------- follow-ups ----------
async function followUpsOf(t: { orderId?: string; leadId?: string }) {
  const rows = await prisma.$queryRaw<any[]>`select f.id, f.due_on, f.rep_id, r.name as rep, f.done_on, d.name as done_by, f.done_note from crm.ts_followups f
    left join crm.reps r on r.id = f.rep_id left join crm.reps d on d.id = f.done_by
    where (${t.orderId ?? null}::uuid is not null and f.order_id = ${t.orderId ?? null}::uuid) or (${t.leadId ?? null}::uuid is not null and f.lead_id = ${t.leadId ?? null}::uuid) order by f.due_on desc, f.created_at desc`;
  return rows.map(f => ({ id: f.id, dueOn: day(f.due_on)!, who: f.rep_id ? { id: f.rep_id, name: f.rep } : null, doneOn: day(f.done_on), doneBy: f.done_by, doneNote: f.done_note }));
}
/**
 * Marks a follow-up done: what happened goes in the log (and the account history), and the next one can be set: a date, and who (a rep or
 * Ellen; nobody = the sales team), the same as the 2nd follow-up on unpaid quotes.
 */
export async function doneFollowUp(rep: Rep, id: unknown, b: any): Promise<void> {
  const fid = idOk(id, 'That follow-up');
  await guard(async () => {
    const [f] = await prisma.$queryRaw<{ order_id: string | null; lead_id: string | null; done_on: Date | null }[]>`select order_id, lead_id, done_on from crm.ts_followups where id = ${fid}::uuid`;
    if (!f) throw new TsError('That follow-up was not found.', 404);
    if (f.done_on) throw new TsError('That follow-up is already done.');
    const next = b?.next ? { on: parseDay(b.next.date, 'next follow-up date'), repId: b.next.repId ? idOk(b.next.repId, 'That person') : null } : null;
    if (next && next.on <= today()) throw new TsError('Set the next follow-up for a day after today.');
    if (next?.repId) { const [r] = await prisma.$queryRaw<{ id: string }[]>`select id from crm.reps where id = ${next.repId}::uuid`; if (!r) throw new TsError('That person was not found.'); }
    const note = typeof b?.note === 'string' ? b.note.trim() : '';
    if (!note) throw new TsError('Write what happened on the follow-up.');
    await addLog(rep, { orderId: f.order_id ?? undefined, leadId: f.lead_id ?? undefined }, KINDS.includes(b?.kind) ? b.kind : 'call', note);
    const done = await prisma.$queryRaw<{ id: string }[]>`update crm.ts_followups set done_on = ${today()}::date, done_by = ${rep.id}::uuid, done_note = ${note.slice(0, 500)} where id = ${fid}::uuid and done_on is null returning id`;
    if (!done.length) return;
    if (next) {
      await prisma.$queryRaw`insert into crm.ts_followups (order_id, lead_id, due_on, rep_id, created_by) values (${f.order_id}::uuid, ${f.lead_id}::uuid, ${next.on}::date, ${next.repId}::uuid, ${rep.id}::uuid)`;
      const [who] = next.repId ? await prisma.$queryRaw<{ name: string }[]>`select name from crm.reps where id = ${next.repId}::uuid` : [{ name: 'the sales team' }];
      await addSystemLog(f.order_id, f.lead_id, rep.id, `Next follow-up set for ${next.on}, for ${who!.name}.`);
    }
  });
}
/** Books a follow-up when none is open (for example one that was closed by mistake, or a quote that needs chasing again). */
export async function addFollowUp(rep: Rep, b: any): Promise<void> {
  await guard(async () => {
    const orderId = b?.orderId ? idOk(b.orderId, 'That order') : null, leadId = b?.leadId ? idOk(b.leadId, 'That lead') : null;
    if (!orderId === !leadId) throw new TsError('Choose an order or a lead.');
    const on = parseDay(b?.date, 'follow-up date'), repId = b?.repId ? idOk(b.repId, 'That person') : null;
    try { await prisma.$queryRaw`insert into crm.ts_followups (order_id, lead_id, due_on, rep_id, created_by) values (${orderId}::uuid, ${leadId}::uuid, ${on}::date, ${repId}::uuid, ${rep.id}::uuid)`; }
    catch (e: any) { if (/ts_followups_one_open/.test(String(e?.message ?? e)) || e?.code === '23505') throw new TsError('There is already a follow-up booked. Mark it done and set the next one.'); throw e; }
  });
}
export type FollowUpItem = { id: string; dueOn: string; overdue: boolean; who: { id: string; name: string } | null; kind: 'order' | 'quote' | 'lead'; targetId: string; label: string; customer: string; region: string | null; show: { id: string; name: string }; amount: number | null; stage: string };
/** Open follow-ups (not for orders that no longer need them). who: 'mine' = given to me, or to the sales team when I am a manager; 'team' = the sales team's; 'all'. */
export async function listFollowUps(rep: Rep, o: { who?: unknown; showId?: unknown } = {}): Promise<FollowUpItem[]> {
  return guard(async () => {
    const showId = o.showId ? idOk(o.showId, 'That show') : null;
    await refreshLeads(showId);
    const fs = await prisma.$queryRaw<any[]>`select f.id, f.due_on, f.rep_id, r.name as rep, f.order_id, f.lead_id from crm.ts_followups f left join crm.reps r on r.id = f.rep_id where f.done_on is null order by f.due_on`;
    const orderIds = fs.filter(f => f.order_id).map(f => f.order_id as string), leadIds = fs.filter(f => f.lead_id).map(f => f.lead_id as string);
    const orders = orderIds.length ? await linkedOrders('ol.id = any($1::uuid[])', orderIds) : [];
    const lines = await linesOf(orderIds);
    const leads = leadIds.length ? await prisma.$queryRaw<any[]>`select l.id, l.status, l.show_id, a.name as customer, a.region from crm.ts_leads l join crm.accounts a on a.id = l.account_id where l.id = any(${leadIds}::uuid[])` : [];
    const shows = new Map((await prisma.$queryRaw<{ id: string; name: string }[]>`select id, name from crm.ts_shows`).map(s => [s.id, s.name]));
    const oById = new Map(orders.map(x => [x.id, x])), lById = new Map(leads.map(x => [x.id, x]));
    const now = today(), who = o.who === 'team' ? 'team' : o.who === 'all' ? 'all' : 'mine';
    const out: FollowUpItem[] = [];
    for (const f of fs) {
      const base = { id: f.id, dueOn: day(f.due_on)!, overdue: day(f.due_on)! < now, who: f.rep_id ? { id: f.rep_id, name: f.rep } : null };
      if (who === 'team' && base.who) continue;
      if (who === 'mine' && !(base.who?.id === rep.id || (!base.who && isManager(rep)))) continue;
      if (f.order_id) {
        const x = oById.get(f.order_id); if (!x) continue;
        const stage = stageOf(x); if (followUpsClosed(x.kind, stage)) continue;
        if (showId && x.show_id !== showId) continue;
        const t = orderTotals(x, (lines.get(x.id) ?? []).map(l => ({ qty: l.qty, price: Number(l.price), pct: Number(l.pct) || 0 })));
        out.push({ ...base, kind: x.kind, targetId: x.id, label: x.number, customer: x.customer, region: x.region, show: { id: x.show_id, name: shows.get(x.show_id) ?? '' }, amount: t.total, stage: STAGE_LABEL[stage] });
      } else {
        const x = lById.get(f.lead_id); if (!x || x.status !== 'open') continue;
        if (showId && x.show_id !== showId) continue;
        out.push({ ...base, kind: 'lead', targetId: x.id, label: 'Lead', customer: x.customer, region: x.region, show: { id: x.show_id, name: shows.get(x.show_id) ?? '' }, amount: null, stage: 'Open lead' });
      }
    }
    return out;
  });
}

// ---------- the shows list and one show ----------
export async function listShows() {
  return guard(async () => {
    const shows = await prisma.$queryRaw<ShowRow[]>`select * from crm.ts_shows where not is_history order by archived, starts_on desc`;
    const counts = await prisma.$queryRaw<{ show_id: string; orders: number; quotes: number; leads: number }[]>`
      select s.id as show_id, (select count(*)::int from crm.ts_orders o where o.show_id = s.id and o.status = 'sent' and o.kind = 'order') as orders,
        (select count(*)::int from crm.ts_orders o where o.show_id = s.id and o.status = 'sent' and o.kind = 'quote') as quotes,
        (select count(*)::int from crm.ts_leads l where l.show_id = s.id) as leads from crm.ts_shows s`;
    const c = new Map(counts.map(x => [x.show_id, x]));
    return shows.map(s => ({ ...showOut(s), orders: c.get(s.id)?.orders ?? 0, quotes: c.get(s.id)?.quotes ?? 0, leads: c.get(s.id)?.leads ?? 0 }));
  });
}
export async function getShow(id: unknown) {
  const sid = idOk(id, 'That show');
  return guard(async () => {
    const show = await showRow(sid);
    await refreshLeads(sid);
    const orders = await linkedOrders('ol.show_id = $1::uuid order by ol.created_at desc', sid);
    const noted = Promise.all(orders.map(o => noteDearMatch(o)));   // all at once, not one trip per order
    const linesP = noted.then(() => linesOf(orders.map(o => o.id)));
    const fuP = prisma.$queryRaw<{ order_id: string | null; lead_id: string | null; due_on: Date; rep: string | null }[]>`select f.order_id, f.lead_id, f.due_on, r.name as rep from crm.ts_followups f left join crm.reps r on r.id = f.rep_id where f.done_on is null`;
    const nextFu = (k: 'order_id' | 'lead_id', id: string) => { const f = fu.find(x => x[k] === id); return f ? { dueOn: day(f.due_on)!, who: f.rep ?? 'Sales team' } : null; };
    const leadsP = prisma.$queryRaw<any[]>`select l.*, a.name as customer, a.region, r.name as rep_name from crm.ts_leads l join crm.accounts a on a.id = l.account_id left join crm.reps r on r.id = l.rep_id where l.show_id = ${sid}::uuid order by l.created_at desc`;
    const [lines, fu, leads] = await Promise.all([linesP, fuP, leadsP]);
    return {
      show: showOut(show),
      orders: orders.map(o => { const st = stageOf(o), t = orderTotals(o, (lines.get(o.id) ?? []).map(l => ({ qty: l.qty, price: Number(l.price), pct: Number(l.pct) || 0 })));
        return { id: o.id, number: o.number, kind: o.kind, status: o.status, stage: st, stageLabel: STAGE_LABEL[st], customer: o.customer, region: o.region, newCustomer: o.new_customer, orderDate: day(o.order_date)!, rep: o.rep_name,
          reference: o.reference, exGst: t.goodsAfter, total: t.total, lines: (lines.get(o.id) ?? []).length, dear: o.dear_number, emailError: o.email_error, nextFollowUp: followUpsClosed(o.kind, st) ? null : nextFu('order_id', o.id) }; }),
      leads: leads.map(l => ({ id: l.id, customer: l.customer, region: l.region, contact: l.contact_name, brands: l.brands, status: l.status, lostReason: l.lost_reason, takenOn: day(l.taken_on)!, rep: l.rep_name, newAccount: l.new_account,
        nextFollowUp: l.status === 'open' ? nextFu('lead_id', l.id) : null })),
      results: await showResults(sid, show, orders, lines),
    };
  });
}
/** What the show brought in. Values are goods ex GST after discount (no freight, surcharge or GST), the same basis as Sales Data. */
async function showResults(sid: string, show: ShowRow, orders: Linked[], lines: Map<string, LineRow[]>) {
  const live = orders.filter(o => o.status === 'sent');
  const val = (o: Linked) => orderTotals(o, (lines.get(o.id) ?? []).map(l => ({ qty: l.qty, price: Number(l.price), pct: Number(l.pct) || 0 })));
  const ord = live.filter(o => o.kind === 'order'), quo = live.filter(o => o.kind === 'quote');
  const sum = (a: Linked[]) => round2(a.reduce((s, o) => s + val(o).goodsAfter, 0));
  // new customers: made at the show, or with no real order before the show
  const accIds = [...new Set(ord.map(o => o.account_id))];
  const beforeP = accIds.length ? prisma.$queryRaw<{ account_id: string }[]>`select distinct account_id from crm.quotes q where q.account_id = any(${accIds}::uuid[]) and q.sent_at < ${day(show.starts_on)}::date
      and ((q.source = 'rhino-history' or q.number like 'Q%') and q.paid or (q.source is distinct from 'rhino-history' and q.number not like 'Q%' and upper(coalesce(q.fulfillment_status, '')) <> all(${NOT_A_SALE}::text[])))` : Promise.resolve([] as { account_id: string }[]);
  const isNew = (o: Linked) => o.new_customer || !had.has(o.account_id);
  const by = (k: (o: Linked) => string) => { const m = new Map<string, { orders: number; value: number }>(); for (const o of ord) { const e = m.get(k(o)) ?? { orders: 0, value: 0 }; e.orders++; e.value = round2(e.value + val(o).goodsAfter); m.set(k(o), e); } return [...m].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.value - a.value); };
  const brands = new Map<string, number>(), skus = new Map<string, { name: string; units: number; value: number }>();
  for (const o of ord) { const t = val(o); (lines.get(o.id) ?? []).forEach((l, i) => { brands.set(l.brand || 'Unbranded', round2((brands.get(l.brand || 'Unbranded') ?? 0) + t.lineTotals[i]!)); const e = skus.get(l.sku) ?? { name: l.name, units: 0, value: 0 }; e.units += l.qty; e.value = round2(e.value + t.lineTotals[i]!); skus.set(l.sku, e); }); }
  const top = [...skus].sort((a, b) => b[1].units - a[1].units).slice(0, 25);
  const factsP = stockFacts(top.map(([s]) => s));
  const cost = round2([show.cost_stand, show.cost_travel, show.cost_samples, show.cost_other].reduce((s, c) => s + (Number(c) || 0), 0));
  const value = sum(ord);
  // leads
  const leadsP = prisma.$queryRaw<{ id: string; account_id: string; status: string; taken_on: Date }[]>`select id, account_id, status, taken_on from crm.ts_leads where show_id = ${sid}::uuid`;
  const [before, facts, leads] = await Promise.all([beforeP, factsP, leadsP]);   // three independent lookups, side by side
  const had = new Set(before.map(b => b.account_id));
  const won = leads.filter(l => l.status === 'won');
  let wonSales = 0;
  if (won.length) {
    const tsWon = ord.filter(o => won.some(w => w.account_id === o.account_id));
    const linkedDear = new Set(orders.map(o => o.dear_id).filter(Boolean));
    const dear = await prisma.$queryRaw<{ id: string; v: number; account_id: string; sent_at: Date }[]>`select q.id, q.account_id, q.sent_at, coalesce(q.goods_total, q.amount - coalesce(q.tax_total, 0))::float8 as v from crm.quotes q
      where q.account_id = any(${won.map(w => w.account_id)}::uuid[]) and q.source is distinct from 'rhino-history' and q.number not like 'Q%' and upper(coalesce(q.fulfillment_status, '')) <> all(${NOT_A_SALE}::text[])`;
    wonSales = round2(tsWon.reduce((s, o) => s + val(o).goodsAfter, 0) + dear.filter(q => !linkedDear.has(q.id) && won.some(w => w.account_id === q.account_id && day(q.sent_at)! >= plusDays(day(w.taken_on)!, -1))).reduce((s, q) => s + q.v, 0));
  }
  return {
    orders: ord.length, orderValue: value, quotes: quo.length, quoteValue: sum(quo), averageOrder: ord.length ? round2(value / ord.length) : 0,
    target: num(show.target), toTarget: show.target && Number(show.target) > 0 ? value / Number(show.target) : null,
    newCustomers: { count: new Set(ord.filter(isNew).map(o => o.account_id)).size, value: sum(ord.filter(isNew)) }, existingCustomers: { count: new Set(ord.filter(o => !isNew(o)).map(o => o.account_id)).size, value: sum(ord.filter(o => !isNew(o))) },
    cost, costPerOrder: ord.length && cost ? round2(cost / ord.length) : null, returnOnCost: cost ? value / cost : null,
    byRep: by(o => o.rep_name ?? 'Unknown'), byBrand: [...brands].map(([name, v]) => ({ name, value: v })).sort((a, b) => b.value - a.value),
    products: top.map(([sku, v]) => { const f = facts.get(sku.toUpperCase()); return { sku, name: v.name, units: v.units, value: v.value, available: f?.available ?? null, free: f?.free ?? null, incoming: f?.incoming ?? null }; }),
    leads: { taken: leads.length, won: won.length, lost: leads.filter(l => l.status === 'lost').length, winRate: leads.length ? won.length / leads.length : null, wonSales },
    stillWithSales: live.filter(o => stageOf(o) === 'sent').length,
  };
}
export async function deleteShow(rep: Rep, id: unknown) {
  if (!isManager(rep)) throw new TsError('Only managers can delete shows.', 403);
  const sid = idOk(id, 'That show');
  await guard(async () => {
    const [n] = await prisma.$queryRaw<{ n: number }[]>`select ((select count(*) from crm.ts_orders where show_id = ${sid}::uuid) + (select count(*) from crm.ts_leads where show_id = ${sid}::uuid))::int as n`;
    if (n!.n > 0) throw new TsError('This show has orders or leads, so it cannot be deleted. Mark it closed instead.');
    await prisma.$queryRaw`delete from crm.ts_shows where id = ${sid}::uuid`;
  });
}
// ---------- export ----------
/** Everything about one show as sheets of rows (the route turns them into an Excel file): summary, orders and quotes, their lines, products, leads, log, follow-ups. */
export async function exportShow(id: unknown) {
  const sid = idOk(id, 'That show');
  const page = await getShow(sid);
  return guard(async () => {
    const orders = await linkedOrders('ol.show_id = $1::uuid order by ol.created_at', sid);
    const lines = await linesOf(orders.map(o => o.id));
    const leadRows = await prisma.$queryRaw<any[]>`select l.*, a.name as customer, a.region from crm.ts_leads l join crm.accounts a on a.id = l.account_id where l.show_id = ${sid}::uuid order by l.created_at`;
    const logs = await prisma.$queryRaw<any[]>`select g.at, g.kind, g.note, r.name as rep, g.order_id, g.lead_id from crm.ts_log g left join crm.reps r on r.id = g.rep_id
      where g.order_id in (select id from crm.ts_orders where show_id = ${sid}::uuid) or g.lead_id in (select id from crm.ts_leads where show_id = ${sid}::uuid) order by g.at`;
    const fus = await prisma.$queryRaw<any[]>`select f.due_on, f.done_on, f.done_note, f.order_id, f.lead_id, r.name as rep, d.name as done_by from crm.ts_followups f left join crm.reps r on r.id = f.rep_id left join crm.reps d on d.id = f.done_by
      where f.order_id in (select id from crm.ts_orders where show_id = ${sid}::uuid) or f.lead_id in (select id from crm.ts_leads where show_id = ${sid}::uuid) order by f.due_on`;
    const sh = page.show as any, r = page.results;
    const oLabel = new Map(orders.map(o => [o.id, `${o.number} ${o.customer}`])), lLabel = new Map(leadRows.map(l => [l.id, `Lead: ${l.customer}`]));
    const what = (x: { order_id: string | null; lead_id: string | null }) => (x.order_id ? oLabel.get(x.order_id) : lLabel.get(x.lead_id ?? '')) ?? '';
    const stamp = (d: Date | string | null) => (d ? new Date(d).toLocaleString('en-AU', { timeZone: 'Australia/Melbourne', day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
    const pctOf = (n: number | null) => (n === null ? '' : `${Math.round(n * 1000) / 10}%`);
    const summary: [string, string | number][] = [
      ['Show', sh.name], ['Reference name', sh.refName], ['Dates', `${sh.startsOn} to ${sh.endsOn}`], ['Venue', sh.venue ?? ''], ['Stand', sh.stand ?? ''], ['Staff', sh.staff ?? ''],
      ['Orders', r.orders], ['Order value (goods ex GST, after discount)', r.orderValue], ['Quotes', r.quotes], ['Quote value', r.quoteValue], ['Average order', r.averageOrder],
      ['Target', r.target ?? ''], ['Reached', pctOf(r.toTarget)], ['New customers (orders)', r.newCustomers.count], ['New customer value', r.newCustomers.value],
      ['Existing customers (orders)', r.existingCustomers.count], ['Existing customer value', r.existingCustomers.value],
      ['Costs', r.cost], ['Cost per order', r.costPerOrder ?? ''], ['Return on cost', r.returnOnCost === null ? '' : `${Math.round(r.returnOnCost * 10) / 10}x`],
      ['Leads taken', r.leads.taken], ['Leads won', r.leads.won], ['Leads lost', r.leads.lost], ['Lead win rate', pctOf(r.leads.winRate)], ['Sales from won leads', r.leads.wonSales],
      ...r.byRep.map((x): [string, string] => [`Rep: ${x.name}`, `${x.orders} orders, $${x.value.toFixed(2)}`]), ...r.byBrand.map((x): [string, number] => [`Brand: ${x.name}`, x.value]),
    ];
    const ordersSheet = orders.map(o => { const ls = lines.get(o.id) ?? [], t = orderTotals(o, ls.map(l => ({ qty: l.qty, price: Number(l.price), pct: Number(l.pct) || 0 })));
      return { Number: o.number, Type: o.kind === 'quote' ? 'Quote' : 'Order', Status: o.status === 'cancelled' ? 'Cancelled' : o.status === 'draft' ? 'Draft' : STAGE_LABEL[stageOf(o)], 'DEAR number': o.dear_number ?? '', Reference: o.reference, "Customer PO": o.customer_po ?? '',
        Customer: o.customer, State: o.region, 'New customer': o.new_customer ? 'Yes' : '', Contact: o.contact_name ?? '', Email: o.contact_email ?? '', Phone: o.contact_phone ?? '', 'Delivery address': o.delivery_address ?? '', Date: day(o.order_date), Rep: o.rep_name ?? '',
        'Goods ex GST': t.goods, 'Discount %': t.linePct, Discount: t.discount, Freight: t.freight, 'Card surcharge': t.surcharge, 'Total ex GST': t.exGst, GST: t.gst, 'Total inc GST': t.total, Notes: o.notes ?? '', 'Emailed to sales': stamp(o.emailed_at) }; });
    const linesSheet = orders.flatMap(o => { const ls = lines.get(o.id) ?? [], t = orderTotals(o, ls.map(l => ({ qty: l.qty, price: Number(l.price), pct: Number(l.pct) || 0 })));
      return ls.map((l, i) => ({ Number: o.number, Type: o.kind === 'quote' ? 'Quote' : 'Order', Customer: o.customer, SKU: l.sku, Product: l.name, Brand: l.brand ?? '', Qty: l.qty, 'Price ex GST': Number(l.price), 'Discount %': t.linePct, 'Line ex GST': t.lineTotals[i], Comment: l.comment ?? '' })); });
    const productsSheet = r.products.map(p => ({ SKU: p.sku, Product: p.name, Units: p.units, 'Value ex GST': p.value, 'Free to sell now': p.free ?? '', 'Next incoming': p.incoming ? `${p.incoming.qty}${p.incoming.date ? ` due ${p.incoming.date}` : ''}${p.incoming.po ? ` (${p.incoming.po})` : ''}` : '' }));
    const leadsSheet = leadRows.map(l => ({ Customer: l.customer, State: l.region, 'New account': l.new_account ? 'Yes' : '', Contact: l.contact_name ?? '', Email: l.contact_email ?? '', Phone: l.contact_phone ?? '', Brands: l.brands ?? '', Notes: l.notes ?? '',
      Status: l.status === 'won' ? 'Won' : l.status === 'lost' ? 'Lost' : 'Open', 'Lost reason': l.lost_reason ?? '', Taken: day(l.taken_on) }));
    const logSheet = logs.map(g => ({ When: stamp(g.at), For: what(g), Type: g.kind, Note: g.note, By: g.rep ?? '' }));
    const fuSheet = fus.map(f => ({ For: what(f), Due: day(f.due_on), 'Who': f.rep ?? 'Sales team', Done: day(f.done_on) ?? '', 'Done by': f.done_by ?? '', 'What happened': f.done_note ?? '' }));
    const safe = String(sh.name).replace(/[^A-Za-z0-9 _-]+/g, '').trim().replace(/\s+/g, '-').slice(0, 50) || 'show';
    return { filename: `trade-show-${safe}.xlsx`, sheets: [
      { name: 'Summary', rows: summary.map(([k, v]) => ({ '': k, Value: v })) }, { name: 'Orders and quotes', rows: ordersSheet }, { name: 'Order lines', rows: linesSheet }, { name: 'Products', rows: productsSheet },
      { name: 'Leads', rows: leadsSheet }, { name: 'Log', rows: logSheet }, { name: 'Follow-ups', rows: fuSheet } ] as { name: string; rows: Record<string, any>[] }[] };
  });
}
export async function repsList() { return prisma.$queryRaw<{ id: string; name: string }[]>`select id, name from crm.reps order by name`; }
export { QUOTE_STAGE, linkedOrders, linesOf, orderTotals, stageOf, addSystemLog };
