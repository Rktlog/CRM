// Shipment alerts: an email to the "Shipment booked" and "Shipment landed" lists (Settings) when a purchase order is booked and when stock is received on one,
// with the items grouped by brand and the sales information the sales and marketing teams want: prices, stock, what sold, which customers are waiting.
// - "Open" and "waiting for customers" mean exactly what they mean on the Ordering page (same rules), so the numbers agree.
// - Only NEW shipments are ever emailed. The first time this runs it just notes what already exists; a shipment seen while its list is off is never emailed later; a purchase
//   order older than 45 days, or stock received more than 3 days ago, is never treated as new. So switching a list on can never flood anyone.
// - A booked purchase order with no due date yet waits up to 24 hours for one. An email that cannot be sent is tried again on the next run, for up to 3 days.
// - Everything goes through sendAlert (lib/alerts.ts): only to the Settings list, never twice, never more than 30 an hour, and the sandbox only to its test address.
import { prisma } from './prisma';
import { sendAlert } from './alerts';
import { retailPrice, wholesalePrice, type Prices } from './pricing';

export const WAIT_FOR_DATE_HOURS = 24;
export const MAX_PER_RUN = 10;
export const BOOKED_MAX_AGE_DAYS = 45;
export const LANDED_MAX_AGE_DAYS = 3;
export const GIVE_UP_DAYS = 3;
export const MAX_ITEMS_PER_BRAND = 12;
export const MAX_ITEMS_TOTAL = 40;
export const MAX_NAMES = 6;
const tableMissing = (e: any) => e?.code === '42P01' || e?.meta?.code === '42P01' || (/shipment_alerts|\b42P01\b/.test(String(e?.message ?? e)) && /does not exist|relation/i.test(String(e?.message ?? e)));

// The same rules as routes/ordering.ts.
const NOT_VOID = `upper(coalesce(p.status, '')) not in ('VOIDED', 'CREDITED', 'DRAFT')`;
const OPEN_PO = `${NOT_VOID} and not (upper(coalesce(p.receiving_status, '')) like '%FULLY RECEIVED%' or upper(coalesce(p.status, '')) like 'COMPLETED%' or upper(coalesce(p.status, '')) = 'RECEIVED')`;
const SOLD = `q.source <> 'rhino-history' and q.number not like 'Q%' and q.misc_type is null and upper(coalesce(q.fulfillment_status, '')) not in ('DRAFT', 'ESTIMATING', 'ESTIMATED', 'ORDERING', 'VOIDED', 'CREDITED')`;
const WAITING = `q.source <> 'rhino-history' and q.number not like 'Q%' and q.misc_type is null and upper(coalesce(q.fulfillment_status, '')) not in ('COMPLETED', 'VOIDED', 'CREDITED', 'DRAFT', 'ESTIMATING', 'ESTIMATED', 'QUOTE', 'ORDERING') and upper(coalesce(q.shipping_status, '')) <> 'SHIPPED'`;
const RECEIVED_DAY = `((l.last_received_at at time zone 'UTC') at time zone 'Australia/Melbourne')::date`;

export type PoInfo = { id: string; number: string | null; supplier: string | null; status: string | null; receivingStatus: string | null; orderDate: Date | null; due: string | null };
export type Item = { sku: string; name: string; brand: string | null; units: number; ordered: number; received: number };
export type Facts = { available: number; onOrder: number; wholesale: number | null; retail: number | null; sold12: number; customers12: number };
export type Waiting = { account: string; sku: string; units: number };
export type Context = { facts: Map<string, Facts>; brandCustomers: Map<string, number>; waiting: Waiting[] };

export const isOpen = (p: { status: string | null; receivingStatus: string | null }) => {
  const s = String(p.status ?? '').toUpperCase(), r = String(p.receivingStatus ?? '').toUpperCase();
  return !['VOIDED', 'CREDITED', 'DRAFT'].includes(s) && !(r.includes('FULLY RECEIVED') || s.startsWith('COMPLETED') || s === 'RECEIVED');
};

// ---------- the emails (plain text) ----------
const oneLine = (s: unknown, max = 120) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const n0 = (n: number) => Math.round(n).toLocaleString('en-AU');
const money = (n: number | null) => (n == null ? null : `$${n.toFixed(2)}`);
/** A day written YYYY-MM-DD, as "20 Dec 2026". */
export const dayLabel = (d: string | null): string | null => {
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const t = new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)));
  if (isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== d) return null;   // 2026-13-40 and 2026-02-30 are not real days: never turn them into one
  return t.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
};
const shortDay = (d: string | null) => { const l = dayLabel(d); return l ? l.replace(/ \d{4}$/, '') : null; };
const brandOf = (i: Item) => oneLine(i.brand, 60) || 'Other';
const byBrand = (items: Item[]) => { const m = new Map<string, Item[]>(); for (const i of items) m.set(brandOf(i), [...(m.get(brandOf(i)) ?? []), i]); return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])); };
const brandsLabel = (items: Item[]) => { const b = byBrand(items).map(([n]) => n); return b.length === 1 ? b[0]! : b.length === 2 ? `${b[0]} and ${b[1]}` : `${b[0]}, ${b[1]} and ${b.length - 2} more`; };

function itemLines(group: Item[], ctx: Context, mode: 'booked' | 'landed'): string[] {
  const out: string[] = [];
  for (const i of [...group].sort((a, b) => b.units - a.units || a.sku.localeCompare(b.sku))) {
    const f = ctx.facts.get(i.sku.toUpperCase());
    const w = ctx.waiting.filter(x => x.sku.toUpperCase() === i.sku.toUpperCase()).reduce((t, x) => t + x.units, 0);
    const prices = f && (f.wholesale != null || f.retail != null) ? `  (${[f.wholesale != null ? `wholesale ${money(f.wholesale)}` : null, f.retail != null ? `RRP ${money(f.retail)}` : null].filter(Boolean).join(', ')})` : '';
    out.push(`  ${oneLine(i.sku, 40)}  ${oneLine(i.name, 90)}  ${n0(i.units)} units${mode === 'landed' ? ` received (${n0(i.ordered)} ordered)` : ''}${prices}`);
    const bits: string[] = [];
    if (f) bits.push(f.sold12 > 0 ? `Restock: ${n0(f.sold12)} sold in the last 12 months to ${f.customers12} customer${f.customers12 === 1 ? '' : 's'}` : 'New: nothing sold in the last 12 months');
    if (f) bits.push(mode === 'landed' ? `In stock now: ${n0(f.available)}${f.onOrder > 0 ? ` (${n0(f.onOrder)} still to come)` : ''}` : `In stock now: ${n0(f.available)}`);
    bits.push(w > 0 ? `${n0(w)} units owed to customers` : 'no customers waiting');
    out.push(`     ${bits.join('. ')}.`);
  }
  return out;
}

function body(po: PoInfo, items: Item[], ctx: Context, mode: 'booked' | 'landed', when: string | null): string[] {
  const units = items.reduce((t, i) => t + i.units, 0);
  const lines: string[] = [mode === 'booked' ? 'A new shipment has been booked.' : 'A delivery has landed and the stock is ready to sell.', ''];
  lines.push(`Purchase order: ${oneLine(po.number ?? po.id, 40)}${po.supplier ? `, from ${oneLine(po.supplier, 80)}` : ''}`);
  if (mode === 'booked') lines.push(`Due: ${dayLabel(po.due) ?? 'no arrival date set yet'}`); else lines.push(`Received: ${when ?? 'recently'}${po.due ? ` (it was due ${dayLabel(po.due)})` : ''}`);
  lines.push(`${mode === 'booked' ? 'Items' : 'Received'}: ${items.length} product${items.length === 1 ? '' : 's'}, ${n0(units)} units`, '');
  let shown = 0;
  for (const [brand, group] of byBrand(items)) {
    const gu = group.reduce((t, i) => t + i.units, 0);
    lines.push(`${brand.toUpperCase()}: ${group.length} product${group.length === 1 ? '' : 's'}, ${n0(gu)} units`);
    const room = Math.max(0, Math.min(MAX_ITEMS_PER_BRAND, MAX_ITEMS_TOTAL - shown));
    const sorted = [...group].sort((a, b) => b.units - a.units || a.sku.localeCompare(b.sku));
    lines.push(...itemLines(sorted.slice(0, room), ctx, mode));
    shown += Math.min(room, group.length);
    if (group.length > room) lines.push(`  ...and ${group.length - room} more product${group.length - room === 1 ? '' : 's'} (${n0(sorted.slice(room).reduce((t, i) => t + i.units, 0))} units)`);
    lines.push('');
  }
  const mine = new Set(items.map(i => i.sku.toUpperCase()));
  const byCustomer = new Map<string, number>();
  for (const w of ctx.waiting) if (mine.has(w.sku.toUpperCase())) byCustomer.set(oneLine(w.account, 60), (byCustomer.get(oneLine(w.account, 60)) ?? 0) + w.units);
  const names = [...byCustomer.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  lines.push('Who to tell');
  if (names.length) lines.push(`  Customers waiting for these items${mode === 'landed' ? ' (ship these first)' : ''}: ${names.length}, ${n0(names.reduce((t, x) => t + x[1], 0))} units: ${names.slice(0, MAX_NAMES).map(([n, u]) => `${n} ${n0(u)}`).join(', ')}${names.length > MAX_NAMES ? ` and ${names.length - MAX_NAMES} more` : ''}`);
  else lines.push('  No customers are waiting for these items.');
  for (const [brand] of byBrand(items)) { const c = ctx.brandCustomers.get(brand.toLowerCase()); if (c != null) lines.push(`  Customers who bought ${brand} in the last 12 months: ${c}`); }
  lines.push('', 'Prices are the current wholesale and recommended retail prices in Radar. Stock is as of the latest sync.');
  return lines;
}
/** The email for a newly booked purchase order. */
export function buildBooked(po: PoInfo, items: Item[], ctx: Context): { subject: string; body: string } {
  const units = items.reduce((t, i) => t + i.units, 0), due = shortDay(po.due);
  return { subject: `[Radar] Shipment booked: ${brandsLabel(items)}, ${n0(units)} units${due ? ` due ${due}` : ''} (PO ${oneLine(po.number ?? po.id, 30)})`, body: body(po, items, ctx, 'booked', null).join('\n') };
}
/** The email for stock that has just been received on a purchase order. `day` is the day it was received, YYYY-MM-DD. */
export function buildLanded(po: PoInfo, items: Item[], ctx: Context, day: string): { subject: string; body: string } {
  const units = items.reduce((t, i) => t + i.units, 0);
  return { subject: `[Radar] Shipment landed: ${brandsLabel(items)}, ${n0(units)} units now in stock (PO ${oneLine(po.number ?? po.id, 30)})`, body: body(po, items, ctx, 'landed', dayLabel(day)).join('\n') };
}

// ---------- reading the data ----------
type PoRow = { id: string; number: string | null; supplier: string | null; status: string | null; receiving_status: string | null; order_date: Date | null; due: string | null };
const toPo = (r: PoRow): PoInfo => ({ id: r.id, number: r.number, supplier: r.supplier, status: r.status, receivingStatus: r.receiving_status, orderDate: r.order_date, due: r.due });
async function loadPo(id: string): Promise<PoInfo | null> {
  const r = await prisma.$queryRawUnsafe<PoRow[]>(`select p.id, p.number, p.supplier, p.status, p.receiving_status, p.order_date, to_char(p.required_by, 'YYYY-MM-DD') as due from crm.purchases p where p.id = $1`, id);
  return r[0] ? toPo(r[0]) : null;
}
type LineRow = { sku: string; name: string; brand: string | null; ordered: number; received: number };
const toItems = (rows: LineRow[], pick: (r: LineRow) => number): Item[] => rows.map(r => ({ sku: r.sku, name: r.name, brand: r.brand, units: pick(r), ordered: Number(r.ordered), received: Number(r.received) })).filter(i => i.units > 0);
const LINE_SELECT = `select l.sku, coalesce(pr.name, l.product_name) as name, pr.brand, l.quantity_ordered::float8 as ordered, l.quantity_received::float8 as received
  from crm.purchase_lines l left join crm.products pr on upper(pr.sku) = upper(l.sku)`;
async function outstandingLines(poId: string): Promise<Item[]> {
  return toItems(await prisma.$queryRawUnsafe<LineRow[]>(`${LINE_SELECT} where l.purchase_id = $1 and l.quantity_ordered - l.quantity_received > 0`, poId), r => Number(r.ordered) - Number(r.received));
}
async function receivedLines(poId: string, day: string): Promise<Item[]> {
  return toItems(await prisma.$queryRawUnsafe<LineRow[]>(`${LINE_SELECT} where l.purchase_id = $1 and l.quantity_received > 0 and ${RECEIVED_DAY} = $2::date`, poId, day), r => Number(r.received));
}
async function context(items: Item[]): Promise<Context> {
  const skus = [...new Set(items.map(i => i.sku))], brands = [...new Set(items.map(i => brandOf(i)).filter(b => b !== 'Other'))];
  const [prods, sold, waiting, brandRows] = await Promise.all([
    prisma.$queryRawUnsafe<{ sku: string; available: number | null; on_order: number | null; prices: Prices | null }[]>(`select sku, available::float8, on_order::float8, prices from crm.products where upper(sku) = any($1::text[])`, skus.map(s => s.toUpperCase())),
    prisma.$queryRawUnsafe<{ sku: string; units: number; customers: number }[]>(`select upper(l.sku) as sku, sum(l.quantity)::float8 as units, count(distinct q.account_id)::int as customers from crm.quote_lines l join crm.quotes q on q.id = l.quote_id
      where upper(l.sku) = any($1::text[]) and ${SOLD} and q.sent_at >= now() - interval '12 months' group by upper(l.sku)`, skus.map(s => s.toUpperCase())),
    prisma.$queryRawUnsafe<Waiting[]>(`with lines as (select q.id, q.account_id, l.sku, max(q.line_fulfilment::text)::jsonb as lf, sum(l.quantity) as qty from crm.quotes q join crm.quote_lines l on l.quote_id = q.id
        where upper(l.sku) = any($1::text[]) and ${WAITING} group by q.id, q.account_id, l.sku)
      select a.name as account, x.sku, x.units from (select account_id, sku, least(coalesce(nullif(lf -> sku ->> 'backordered', '')::float8, 0), greatest(qty - coalesce(nullif(lf -> sku ->> 'shipped', '')::float8, 0), 0))::float8 as units from lines) x
      join crm.accounts a on a.id = x.account_id where x.units > 0`, skus.map(s => s.toUpperCase())),
    brands.length ? prisma.$queryRawUnsafe<{ brand: string; n: number }[]>(`select pr.brand, count(distinct q.account_id)::int as n from crm.quote_lines l join crm.quotes q on q.id = l.quote_id join crm.products pr on upper(pr.sku) = upper(l.sku)
      where pr.brand = any($1::text[]) and ${SOLD} and q.sent_at >= now() - interval '12 months' group by pr.brand`, brands) : Promise.resolve([] as { brand: string; n: number }[]),
  ]);
  const facts = new Map<string, Facts>();
  for (const p of prods) {
    const s = sold.find(x => x.sku === p.sku.toUpperCase());
    facts.set(p.sku.toUpperCase(), { available: Number(p.available ?? 0), onOrder: Number(p.on_order ?? 0), wholesale: wholesalePrice(p.prices), retail: retailPrice(p.prices), sold12: Number(s?.units ?? 0), customers12: Number(s?.customers ?? 0) });
  }
  for (const i of items) if (!facts.has(i.sku.toUpperCase())) facts.set(i.sku.toUpperCase(), { available: 0, onOrder: 0, wholesale: null, retail: null, sold12: 0, customers12: 0 });
  return { facts, brandCustomers: new Map(brandRows.map(b => [b.brand.toLowerCase(), Number(b.n)])), waiting };
}

// ---------- examples for Settings ----------
export type Sample = { subject: string; body: string; about: string };
/** Up to a few emails built from the newest real purchase orders or deliveries, so a manager can see what would be sent. Nothing is sent or recorded. */
export async function sampleMessages(kind: 'shipment_booked' | 'shipment_landed', limit = 3): Promise<Sample[]> {
  const out: Sample[] = [];
  if (kind === 'shipment_booked') {
    const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(`select p.id from crm.purchases p where ${OPEN_PO} and exists (select 1 from crm.purchase_lines l where l.purchase_id = p.id and l.quantity_ordered - l.quantity_received > 0) order by p.order_date desc nulls last limit $1::int`, limit);
    for (const r of rows) { const po = await loadPo(r.id); if (!po) continue; const items = await outstandingLines(po.id); if (!items.length) continue; const m = buildBooked(po, items, await context(items)); out.push({ ...m, about: `Purchase order ${po.number ?? po.id}${po.supplier ? ` from ${po.supplier}` : ''}` }); }
  } else {
    const rows = await prisma.$queryRawUnsafe<{ id: string; day: string }[]>(`select l.purchase_id as id, to_char(${RECEIVED_DAY}, 'YYYY-MM-DD') as day from crm.purchase_lines l join crm.purchases p on p.id = l.purchase_id where ${NOT_VOID} and l.quantity_received > 0 and l.last_received_at is not null group by 1, ${RECEIVED_DAY} order by ${RECEIVED_DAY} desc limit $1::int`, limit);
    for (const r of rows) { const po = await loadPo(r.id); if (!po) continue; const items = await receivedLines(po.id, r.day); if (!items.length) continue; const m = buildLanded(po, items, await context(items), r.day); out.push({ ...m, about: `Purchase order ${po.number ?? po.id}, received ${dayLabel(r.day)}` }); }
  }
  return out;
}

// ---------- the job ----------
export type Counts = { sent: number; waiting: number; skipped: number };
export type RunResult = { stopped: string | null; baseline: number; booked: Counts; landed: Counts };
const zero = (): Counts => ({ sent: 0, waiting: 0, skipped: 0 });
type Outcome = { state: 'sent' | 'waiting' | 'skipped'; note?: string };

async function baseline(): Promise<number> {
  const r = await prisma.$queryRawUnsafe<{ n: number }[]>(`
    with b as (insert into crm.shipment_alerts (purchase_id, kind, state, done_at, note)
        select p.id, 'booked', 'skipped', now(), 'already open when alerts started' from crm.purchases p
        where ${OPEN_PO} and exists (select 1 from crm.purchase_lines l where l.purchase_id = p.id and l.quantity_ordered - l.quantity_received > 0) on conflict do nothing returning 1),
    d as (insert into crm.shipment_alerts (purchase_id, kind, state, done_at, note)
        select x.k, 'landed', 'skipped', now(), 'already received when alerts started' from (
          select l.purchase_id || '|' || to_char(${RECEIVED_DAY}, 'YYYY-MM-DD') as k from crm.purchase_lines l join crm.purchases p on p.id = l.purchase_id
          where ${NOT_VOID} and l.quantity_received > 0 and l.last_received_at is not null group by 1) x on conflict do nothing returning 1)
    select ((select count(*) from b) + (select count(*) from d))::int as n`);
  return Number(r[0]?.n ?? 0);
}
async function discover() {
  await prisma.$queryRawUnsafe(`
    insert into crm.shipment_alerts (purchase_id, kind, state, done_at, note)
    select p.id, 'booked', case when coalesce(p.order_date, now()) < now() - interval '${BOOKED_MAX_AGE_DAYS} days' then 'skipped' else 'waiting' end,
      case when coalesce(p.order_date, now()) < now() - interval '${BOOKED_MAX_AGE_DAYS} days' then now() end,
      case when coalesce(p.order_date, now()) < now() - interval '${BOOKED_MAX_AGE_DAYS} days' then 'ordered more than ${BOOKED_MAX_AGE_DAYS} days ago' end
    from crm.purchases p where ${OPEN_PO} and exists (select 1 from crm.purchase_lines l where l.purchase_id = p.id and l.quantity_ordered - l.quantity_received > 0)
      and not exists (select 1 from crm.shipment_alerts a where a.purchase_id = p.id and a.kind = 'booked') order by p.order_date desc nulls last limit 50 on conflict do nothing`);
  await prisma.$queryRawUnsafe(`
    insert into crm.shipment_alerts (purchase_id, kind, state, done_at, note)
    select x.k, 'landed', case when x.day < (now() at time zone 'Australia/Melbourne')::date - ${LANDED_MAX_AGE_DAYS} then 'skipped' else 'waiting' end,
      case when x.day < (now() at time zone 'Australia/Melbourne')::date - ${LANDED_MAX_AGE_DAYS} then now() end,
      case when x.day < (now() at time zone 'Australia/Melbourne')::date - ${LANDED_MAX_AGE_DAYS} then 'received more than ${LANDED_MAX_AGE_DAYS} days ago' end
    from (select l.purchase_id || '|' || to_char(${RECEIVED_DAY}, 'YYYY-MM-DD') as k, ${RECEIVED_DAY} as day from crm.purchase_lines l join crm.purchases p on p.id = l.purchase_id
          where ${NOT_VOID} and l.quantity_received > 0 and l.last_received_at is not null group by 1, 2) x
    where not exists (select 1 from crm.shipment_alerts a where a.purchase_id = x.k and a.kind = 'landed') order by x.day desc limit 50 on conflict do nothing`);
}
const interpret = (r: { sent: boolean; reason: string }, seenAt: Date): Outcome => {
  if (r.sent) return { state: 'sent' };
  if (r.reason === 'already sent') return { state: 'sent', note: 'already sent' };
  if (r.reason === 'off') return { state: 'skipped', note: 'the list was off' };
  const old = Date.now() - new Date(seenAt).getTime() > GIVE_UP_DAYS * 86400000;
  return old ? { state: 'skipped', note: `could not be sent for ${GIVE_UP_DAYS} days: ${r.reason}`.slice(0, 200) } : { state: 'waiting', note: r.reason.slice(0, 200) };
};
async function handleBooked(id: string, seenAt: Date): Promise<Outcome & { failed?: string }> {
  const po = await loadPo(id);
  if (!po || !isOpen(po)) return { state: 'skipped', note: 'no longer open' };
  const items = await outstandingLines(id);
  if (!items.length) return { state: 'skipped', note: 'nothing left to arrive' };
  if (!po.due && Date.now() - new Date(seenAt).getTime() < WAIT_FOR_DATE_HOURS * 3600000) return { state: 'waiting', note: 'waiting for a due date' };
  const r = await sendAlert('shipment_booked', buildBooked(po, items, await context(items)), { relatedId: `booked:${id}` });
  const o = interpret(r, seenAt); return o.state === 'waiting' ? { ...o, failed: r.reason } : o;
}
async function handleLanded(key: string, seenAt: Date): Promise<Outcome & { failed?: string }> {
  const [id, day] = key.split('|');
  if (!id || !day) return { state: 'skipped', note: 'not understood' };
  const po = await loadPo(id);
  if (!po || ['VOIDED', 'CREDITED', 'DRAFT'].includes(String(po.status ?? '').toUpperCase())) return { state: 'skipped', note: 'purchase order voided' };
  const items = await receivedLines(id, day);
  if (!items.length) return { state: 'skipped', note: 'nothing received that day any more' };
  const r = await sendAlert('shipment_landed', buildLanded(po, items, await context(items), day), { relatedId: `landed:${key}` });
  const o = interpret(r, seenAt); return o.state === 'waiting' ? { ...o, failed: r.reason } : o;
}
async function processKind(kind: 'booked' | 'landed'): Promise<{ counts: Counts; stopped: string | null }> {
  const counts = zero(); let stopped: string | null = null;
  const rows = await prisma.$queryRaw<{ purchase_id: string; seen_at: Date }[]>`select purchase_id, seen_at from crm.shipment_alerts where kind = ${kind} and state = 'waiting' order by seen_at limit ${MAX_PER_RUN}::int`;
  for (const r of rows) {
    const o = kind === 'booked' ? await handleBooked(r.purchase_id, r.seen_at) : await handleLanded(r.purchase_id, r.seen_at);
    await prisma.$queryRaw`update crm.shipment_alerts set state = ${o.state}, done_at = case when ${o.state} = 'waiting' then null else now() end, note = ${o.note ?? null} where purchase_id = ${r.purchase_id} and kind = ${kind}`;
    if (o.state === 'sent') counts.sent++; else if (o.state === 'skipped') counts.skipped++;
    if (o.failed) { stopped = `${kind === 'booked' ? 'Shipment booked' : 'Shipment landed'}: ${o.failed}`.slice(0, 200); break; }   // the same problem would hit every one: stop and try again next run
  }
  const [w] = await prisma.$queryRaw<{ n: number }[]>`select count(*)::int as n from crm.shipment_alerts where kind = ${kind} and state = 'waiting'`;
  counts.waiting = Number(w?.n ?? 0);
  return { counts, stopped };
}

/** The scheduled job (and the "Look for new shipments now" button in Settings). */
export async function runShipmentAlerts(): Promise<RunResult> {
  const res: RunResult = { stopped: null, baseline: 0, booked: zero(), landed: zero() };
  try {
    const [c] = await prisma.$queryRaw<{ n: number }[]>`select count(*)::int as n from crm.shipment_alerts`;
    if (!c || c.n === 0) { res.baseline = await baseline(); return res; }
    await discover();
    const b = await processKind('booked'), l = await processKind('landed');
    return { ...res, booked: b.counts, landed: l.counts, stopped: b.stopped ?? l.stopped };
  } catch (e) {
    if (tableMissing(e)) return { ...res, stopped: 'not set up in the database yet' };
    throw e;
  }
}
