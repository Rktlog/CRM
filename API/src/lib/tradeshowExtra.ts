// Trade shows, part 2: offers, freight rates, payments and the DEAR queue, the appointment schedule, the checklist, the feedback, old shows,
// and the year-on-year comparison. DEAR is only read. Run tradeshow2.sql first.
import { prisma } from './prisma';
import { cleanText, parseDay, round2, TsError, plusDays, type OrderStage } from './tradeshowCore';
import { cleanFreightCfg, DEFAULT_FREIGHT, type Offer, type OfferItem } from './tsOffers';
import { day, loadFreightCfg, loadOffers, paymentOf } from './tradeshowOrderPlus';
import { addSystemLog, linesOf, linkedOrders, orderTotals, stageOf, type Rep } from './tradeshow';

const isManager = (r: Rep) => r.role === 'manager';
const NOT_SET_UP = 'Trade shows part 2 is not set up in the database yet. Ask whoever looks after Radar to run tradeshow2.sql.';
const missing = (e: any) => (e?.code === '42P01' || e?.meta?.code === '42P01' || e?.code === '42703' || /does not exist/i.test(String(e?.message ?? e))) && /ts_|pct|line_kind|dear_reference|region_type|series|is_history/.test(String(e?.message ?? e));
async function guard<T>(f: () => Promise<T>): Promise<T> { try { return await f(); } catch (e) { if (missing(e)) throw new TsError(NOT_SET_UP, 503); throw e; } }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idOk = (v: unknown, what = 'That'): string => { if (typeof v !== 'string' || !UUID.test(v)) throw new TsError(`${what} was not found.`, 404); return v; };
const mustManage = (rep: Rep, what: string) => { if (!isManager(rep)) throw new TsError(`Only managers can ${what}.`, 403); };
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const NOT_A_SALE = ['DRAFT', 'ESTIMATING', 'ESTIMATED', 'ORDERING', 'VOIDED', 'CREDITED'];

// ---------- offers ----------
const list = (v: unknown, max = 60): string[] => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,\n]/) : []).map(x => String(x ?? '').trim()).filter(Boolean).slice(0, max);
export type OfferInput = Omit<Offer, 'id'>;
/** An offer as typed or as Claude read it from a sheet. Every SKU must exist in Radar's products, so a typo cannot reach an order. */
export async function parseOffer(b: any): Promise<OfferInput> {
  const kind = b?.kind === 'bundle' ? 'bundle' : b?.kind === 'bonus' ? 'bonus' : b?.kind === 'pct' ? 'pct' : null;
  if (!kind) throw new TsError('Choose the kind of offer: percent off, bundle or bonus pack.');
  const name = cleanText(b?.name, 120); if (!name) throw new TsError('Give the offer a name.');
  const n = (v: unknown, what: string, lo = 0) => { if (v === null || v === undefined || v === '') return null; const x = Number(v); if (!Number.isFinite(x) || x < lo) throw new TsError(`The ${what} must be a number.`); return round2(x); };
  const items: OfferItem[] = (Array.isArray(b?.items) ? b.items : []).slice(0, 40).map((i: any) => ({ sku: String(i?.sku ?? '').trim(), qty: Number(i?.qty) }));
  for (const i of items) if (!i.sku || !Number.isInteger(i.qty) || i.qty < 1 || i.qty > 10000) throw new TsError(`Check the quantity for ${i.sku || 'a product'} in "${name}" (a whole number of 1 or more).`);
  const o: OfferInput = { kind, name, pct: n(b?.pct, 'percentage'), brands: list(b?.brands), skus: list(b?.skus, 400), threshold: n(b?.threshold, 'spend amount'), repeat: b?.repeat === true,
    items, bundlePrice: n(b?.bundlePrice, 'bundle price'), payBy: b?.payBy ? parseDay(b.payBy, 'pay-by date') : null, active: b?.active !== false, notes: cleanText(b?.notes, 500) };
  if (kind === 'pct') { if (!o.pct || o.pct <= 0 || o.pct > 100) throw new TsError(`"${name}": give the % off (more than 0, up to 100).`); if (!o.brands.length && !o.skus.length) throw new TsError(`"${name}": say which brands or SKUs it is for.`); o.items = []; o.threshold = null; o.bundlePrice = null; }
  if (kind === 'bundle') { if (!o.items.length) throw new TsError(`"${name}": add the products in the bundle.`); if (!o.bundlePrice || o.bundlePrice <= 0) throw new TsError(`"${name}": give the bundle price (ex GST, per pack).`); o.pct = null; o.threshold = null; o.brands = []; o.skus = []; }
  if (kind === 'bonus') { if (!o.threshold || o.threshold <= 0) throw new TsError(`"${name}": give the spend (ex GST) that earns it.`); if (!o.items.length) throw new TsError(`"${name}": add the free products.`); o.pct = null; o.bundlePrice = null; }
  const all = [...new Set([...o.items.map(i => i.sku), ...o.skus].map(s => s.toUpperCase()))];
  if (all.length) {
    const known = new Set((await prisma.$queryRaw<{ k: string }[]>`select upper(sku) as k from crm.products where upper(sku) = any(${all}::text[])`).map(r => r.k));
    const bad = all.filter(s => !known.has(s));
    if (bad.length) throw new TsError(`"${name}": Radar has no product ${bad.slice(0, 6).join(', ')}${bad.length > 6 ? ` and ${bad.length - 6} more` : ''}. Check the SKUs.`);
  }
  return o;
}
export async function listOffers(showId: unknown): Promise<Offer[]> { return guard(() => loadOffers(idOk(showId, 'That show'))); }
export async function saveOffer(rep: Rep, showId: unknown, b: any, id?: unknown): Promise<string> {
  mustManage(rep, 'set up offers');
  const sid = idOk(showId, 'That show'), o = await parseOffer(b);
  return guard(async () => {
    const [s] = await prisma.$queryRaw<{ id: string }[]>`select id from crm.ts_shows where id = ${sid}::uuid`; if (!s) throw new TsError('That show was not found.', 404);
    const items = JSON.stringify(o.items.map(i => ({ sku: i.sku, qty: i.qty })));
    if (id !== undefined) {
      const oid = idOk(id, 'That offer');
      const r = await prisma.$queryRaw<{ id: string }[]>`update crm.ts_offers set kind = ${o.kind}, name = ${o.name}, pct = ${o.pct}::numeric, brands = ${o.brands}::text[], skus = ${o.skus}::text[], threshold = ${o.threshold}::numeric, repeat = ${o.repeat},
        items = ${items}::jsonb, bundle_price = ${o.bundlePrice}::numeric, pay_by = ${o.payBy}::date, active = ${o.active}, notes = ${o.notes}, updated_at = now() where id = ${oid}::uuid and show_id = ${sid}::uuid returning id`;
      if (!r.length) throw new TsError('That offer was not found.', 404);
      return oid;
    }
    const [r] = await prisma.$queryRaw<{ id: string }[]>`insert into crm.ts_offers (show_id, kind, name, pct, brands, skus, threshold, repeat, items, bundle_price, pay_by, active, notes, created_by)
      values (${sid}::uuid, ${o.kind}, ${o.name}, ${o.pct}::numeric, ${o.brands}::text[], ${o.skus}::text[], ${o.threshold}::numeric, ${o.repeat}, ${items}::jsonb, ${o.bundlePrice}::numeric, ${o.payBy}::date, ${o.active}, ${o.notes}, ${rep.id}::uuid) returning id`;
    return r!.id;
  });
}
export async function deleteOffer(rep: Rep, showId: unknown, id: unknown) {
  mustManage(rep, 'delete offers');
  await guard(() => prisma.$queryRaw`delete from crm.ts_offers where id = ${idOk(id, 'That offer')}::uuid and show_id = ${idOk(showId, 'That show')}::uuid`);
}
/** Next year's show starts from this year's offers: copies them (not the history) into another show. */
export async function copyOffers(rep: Rep, toShowId: unknown, fromShowId: unknown): Promise<number> {
  mustManage(rep, 'copy offers');
  const to = idOk(toShowId, 'That show'), from = idOk(fromShowId, 'The show to copy from');
  if (to === from) throw new TsError('Pick a different show to copy from.');
  return guard(async () => (await prisma.$queryRaw<{ id: string }[]>`insert into crm.ts_offers (show_id, kind, name, pct, brands, skus, threshold, repeat, items, bundle_price, pay_by, active, notes, sort, created_by)
    select ${to}::uuid, kind, name, pct, brands, skus, threshold, repeat, items, bundle_price, null, active, notes, sort, ${rep.id}::uuid from crm.ts_offers where show_id = ${from}::uuid returning id`).length);
}

// ---------- freight rates ----------
export async function getFreightCfg() { return guard(loadFreightCfg); }
export async function saveFreightCfg(rep: Rep, v: unknown) {
  mustManage(rep, 'change freight rates');
  let cfg; try { cfg = cleanFreightCfg(v); } catch (e: any) { throw new TsError(e.message); }
  await guard(() => prisma.$queryRaw`insert into crm.ts_freight_cfg (id, config, updated_by) values (1, ${JSON.stringify(cfg)}::jsonb, ${rep.id}::uuid)
    on conflict (id) do update set config = excluded.config, updated_by = excluded.updated_by, updated_at = now()`);
  return loadFreightCfg();
}
export async function resetFreightCfg(rep: Rep) { mustManage(rep, 'change freight rates'); await guard(() => prisma.$queryRaw`delete from crm.ts_freight_cfg where id = 1`); return { cfg: DEFAULT_FREIGHT, custom: false }; }

// ---------- payments and the DEAR queue ----------
const AU_DAY = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Melbourne' });
/**
 * For one show: the confirmed orders and quotes that are not in DEAR yet (the "to enter" queue, with DEAR orders that look like them, to confirm), and
 * where every order stands on payment. A DEAR order that looks right is only a suggestion until someone confirms it.
 */
export async function getQueue(showId: unknown) {
  const sid = idOk(showId, 'That show');
  return guard(async () => {
    const orders = await linkedOrders(`ol.show_id = $1::uuid and ol.status = 'sent' order by ol.created_at`, sid);
    const lines = await linesOf(orders.map(o => o.id));
    const t = new Map(orders.map(o => [o.id, orderTotals(o, (lines.get(o.id) ?? []).map(l => ({ qty: l.qty, price: Number(l.price), pct: Number(l.pct) || 0 })))]));
    const waiting = orders.filter(o => stageOf(o) === 'sent');
    const linked = orders.map(o => o.dear_id).filter(Boolean) as string[];
    const cands = waiting.length ? await prisma.$queryRaw<any[]>`select q.id, q.number, q.account_id, q.sent_at, q.reference, q.amount::float8 as total, q.fulfillment_status as status from crm.quotes q
      where q.account_id = any(${[...new Set(waiting.map(o => o.account_id))]}::text[]::uuid[]) and q.source is distinct from 'rhino-history' and q.number not like 'Q%'
        and q.sent_at >= ${plusDays(day(waiting.reduce((m, o) => (o.order_date < m ? o.order_date : m), waiting[0]!.order_date))!, -3)}::date and upper(coalesce(q.fulfillment_status, '')) not in ('VOIDED', 'CREDITED')
        and q.id <> all(${linked}::text[]::uuid[])` : [];
    const today = AU_DAY();
    const rows = orders.map(o => {
      const st = stageOf(o) as OrderStage, tot = t.get(o.id)!, pay = paymentOf(st, tot.total, num(o.dear_invoiced), num(o.dear_due));
      const payBy = day(o.pay_by);
      return { id: o.id, number: o.number, kind: o.kind, customer: o.customer, region: o.region, overseas: /^(NZ|INTL)$/i.test(String(o.region ?? '')), orderDate: day(o.order_date)!, total: tot.total, exGst: tot.goodsAfter, rep: o.rep_name,
        dearReference: o.dear_reference ?? o.reference, stage: st, dear: o.dear_number ?? null, payment: pay, payBy, payByOverdue: !!payBy && payBy < today && pay.status !== 'paid' && pay.status !== 'cancelled',
        emailedAt: o.emailed_at ? new Date(o.emailed_at).toISOString() : null, emailError: o.email_error, daysWaiting: Math.max(0, Math.round((Date.parse(today) - Date.parse(day(o.order_date)!)) / 86_400_000)),
        candidates: st !== 'sent' ? [] : cands.filter(c => c.account_id === o.account_id && day(c.sent_at)! >= plusDays(day(o.order_date)!, -3) && !(o.dear_match_rejected ?? []).includes(c.id))
          .map(c => ({ id: c.id as string, number: c.number as string, reference: c.reference as string | null, sentAt: day(c.sent_at)!, total: round2(Number(c.total) || 0), status: c.status as string | null }))
          .sort((a, b) => Math.abs(a.total - tot.total) - Math.abs(b.total - tot.total)).slice(0, 3) };
    });
    const live = rows.filter(r => r.payment.status !== 'cancelled');
    const value = (r: (typeof rows)[number]) => t.get(r.id)!.goodsAfter;
    const sum = (a: typeof rows) => round2(a.reduce((s, r) => s + value(r), 0));
    const paidValue = round2(live.reduce((s, r) => s + (r.payment.status === 'paid' ? value(r) : r.payment.status === 'part' && r.payment.paid != null && r.payment.owing != null ? (value(r) * r.payment.paid) / Math.max(0.01, r.payment.paid + r.payment.owing) : 0), 0));
    return {
      toEnter: rows.filter(r => r.stage === 'sent'),
      payments: rows.filter(r => r.stage !== 'sent').sort((a, b) => Number(b.payByOverdue) - Number(a.payByOverdue) || a.orderDate.localeCompare(b.orderDate)),
      summary: { orders: live.length, value: sum(live), paidValue, paidPct: sum(live) > 0 ? paidValue / sum(live) : null, paid: live.filter(r => r.payment.status === 'paid').length, unpaid: live.filter(r => ['unpaid', 'part', 'not_invoiced'].includes(r.payment.status)).length,
        notInDear: live.filter(r => r.stage === 'sent').length, overdue: live.filter(r => r.payByOverdue).length, owing: round2(live.reduce((s, r) => s + (r.payment.owing ?? 0), 0)) },
    };
  });
}
/** "That DEAR order is not this one": it stops being suggested. */
export async function rejectMatch(rep: Rep, orderId: unknown, dearId: unknown) {
  const oid = idOk(orderId, 'That order'), did = idOk(dearId, 'That DEAR order');
  await guard(async () => {
    const [o] = await prisma.$queryRaw<{ rep_id: string | null }[]>`select rep_id from crm.ts_orders where id = ${oid}::uuid`;
    if (!o) throw new TsError('That order was not found.', 404);
    if (!isManager(rep) && o.rep_id !== rep.id) throw new TsError('Only the person who wrote it, or a manager, can do that.', 403);
    await prisma.$queryRaw`update crm.ts_orders set dear_match_rejected = array_append(dear_match_rejected, ${did}::uuid) where id = ${oid}::uuid and not (${did}::uuid = any(dear_match_rejected))`;
    await addSystemLog(oid, null, rep.id, 'A suggested DEAR order was marked as not this one.');
  });
}

// ---------- the appointment schedule ----------
const STATUS = ['booked', 'came', 'no_show', 'cancelled'] as const;
export type AppointmentInput = { stockist: string; accountId: string | null; contact: string | null; state: string | null; dayText: string | null; timeText: string | null; who: string | null; comments: string | null; targetRange: string | null; reportRequest: string | null; reportLink: string | null; followUp: string | null; status: (typeof STATUS)[number] };
export function parseAppointment(b: any): AppointmentInput {
  const stockist = cleanText(b?.stockist, 120); if (!stockist) throw new TsError('Give the stockist name.');
  const status = STATUS.includes(b?.status) ? b.status : 'booked';
  const link = cleanText(b?.reportLink, 300);
  return { stockist, accountId: b?.accountId ? idOk(b.accountId, 'That customer') : null, contact: cleanText(b?.contact, 120), state: cleanText(b?.state, 20), dayText: cleanText(b?.dayText, 60), timeText: cleanText(b?.timeText, 60),
    who: cleanText(b?.who, 40), comments: cleanText(b?.comments, 1000), targetRange: cleanText(b?.targetRange, 1000), reportRequest: cleanText(b?.reportRequest, 500), reportLink: link && /^https?:\/\//i.test(link) ? link : null, followUp: cleanText(b?.followUp, 1000), status };
}
export async function listAppointments(showId: unknown) {
  const sid = idOk(showId, 'That show');
  return guard(async () => {
    const rows = await prisma.$queryRaw<any[]>`select p.*, a.name as account_name, r.name as rep_name from crm.ts_appointments p left join crm.accounts a on a.id = p.account_id left join crm.reps r on r.id = p.rep_id
      where p.show_id = ${sid}::uuid order by p.created_at`;
    const ord = await prisma.$queryRaw<{ account_id: string; n: number; v: number }[]>`select o.account_id, count(distinct o.id)::int as n, coalesce(sum(l.qty * l.price * (1 - l.pct / 100)), 0)::float8 as v
      from crm.ts_orders o left join crm.ts_order_lines l on l.order_id = o.id where o.show_id = ${sid}::uuid and o.status = 'sent' and o.kind = 'order' group by o.account_id`;
    const by = new Map(ord.map(o => [o.account_id, o]));
    return rows.map(p => ({ id: p.id, stockist: p.stockist, accountId: p.account_id, accountName: p.account_name, contact: p.contact, state: p.state, dayText: p.day_text, timeText: p.time_text, who: p.who, comments: p.comments,
      targetRange: p.target_range, reportRequest: p.report_request, reportLink: p.report_link, followUp: p.follow_up, status: p.status as string, rep: p.rep_name as string | null,
      orders: p.account_id ? by.get(p.account_id)?.n ?? 0 : 0, ordered: p.account_id ? round2(by.get(p.account_id)?.v ?? 0) : 0 }));
  });
}
export async function saveAppointment(rep: Rep, showId: unknown, b: any, id?: unknown): Promise<string> {
  const sid = idOk(showId, 'That show'), a = parseAppointment(b);
  return guard(async () => {
    let accountId = a.accountId;
    if (!accountId) { const m = await prisma.$queryRaw<{ id: string }[]>`select id from crm.accounts where not misc and lower(btrim(name)) = lower(${a.stockist}) limit 2`; if (m.length === 1) accountId = m[0]!.id; }
    if (id !== undefined) {
      const aid = idOk(id, 'That appointment');
      const r = await prisma.$queryRaw<{ id: string }[]>`update crm.ts_appointments set stockist = ${a.stockist}, account_id = ${accountId}::uuid, contact = ${a.contact}, state = ${a.state}, day_text = ${a.dayText}, time_text = ${a.timeText}, who = ${a.who},
        comments = ${a.comments}, target_range = ${a.targetRange}, report_request = ${a.reportRequest}, report_link = ${a.reportLink}, follow_up = ${a.followUp}, status = ${a.status}, updated_at = now() where id = ${aid}::uuid and show_id = ${sid}::uuid returning id`;
      if (!r.length) throw new TsError('That appointment was not found.', 404);
      return aid;
    }
    const [r] = await prisma.$queryRaw<{ id: string }[]>`insert into crm.ts_appointments (show_id, account_id, stockist, contact, state, day_text, time_text, who, comments, target_range, report_request, report_link, follow_up, status, rep_id)
      values (${sid}::uuid, ${accountId}::uuid, ${a.stockist}, ${a.contact}, ${a.state}, ${a.dayText}, ${a.timeText}, ${a.who}, ${a.comments}, ${a.targetRange}, ${a.reportRequest}, ${a.reportLink}, ${a.followUp}, ${a.status}, ${rep.id}::uuid) returning id`;
    return r!.id;
  });
}
export async function deleteAppointment(rep: Rep, showId: unknown, id: unknown) {
  await guard(() => prisma.$queryRaw`delete from crm.ts_appointments where id = ${idOk(id, 'That appointment')}::uuid and show_id = ${idOk(showId, 'That show')}::uuid`);
}

// ---------- the checklist ----------
export async function getChecklist(showId: unknown) {
  const sid = idOk(showId, 'That show');
  return guard(async () => {
    const rows = await prisma.$queryRaw<any[]>`select c.id, c.section, c.item, c.sort, c.done, c.done_at, c.note, c.owner_id, o.name as owner, d.name as done_by from crm.ts_checklist c
      left join crm.reps o on o.id = c.owner_id left join crm.reps d on d.id = c.done_by where c.show_id = ${sid}::uuid order by c.sort, c.item`;
    return rows.map(r => ({ id: r.id as string, section: r.section as string, item: r.item as string, done: !!r.done, doneAt: r.done_at ? new Date(r.done_at).toISOString() : null, doneBy: r.done_by as string | null, owner: r.owner_id ? { id: r.owner_id as string, name: r.owner as string } : null, note: r.note as string | null }));
  });
}
/** Copies the template into the show (items already there are left alone, so pressing it twice does no harm). */
export async function loadChecklistTemplate(showId: unknown): Promise<number> {
  const sid = idOk(showId, 'That show');
  return guard(async () => (await prisma.$queryRaw<{ id: string }[]>`insert into crm.ts_checklist (show_id, section, item, sort)
    select ${sid}::uuid, t.section, t.item, t.sort from crm.ts_checklist_template t where not exists (select 1 from crm.ts_checklist c where c.show_id = ${sid}::uuid and c.section = t.section and c.item = t.item) returning id`).length);
}
export async function getChecklistTemplate() { return guard(async () => (await prisma.$queryRaw<{ section: string; item: string }[]>`select section, item from crm.ts_checklist_template order by sort, item`)); }
export async function saveChecklistTemplate(rep: Rep, items: unknown) {
  mustManage(rep, 'change the checklist template');
  if (!Array.isArray(items) || items.length > 200) throw new TsError('Send the list of items (up to 200).');
  const clean = items.map((x: any) => ({ section: cleanText(x?.section, 60) ?? 'General', item: cleanText(x?.item, 200) })).filter((x): x is { section: string; item: string } => !!x.item);
  await guard(async () => {
    await prisma.$queryRaw`delete from crm.ts_checklist_template`;
    if (clean.length) await prisma.$queryRaw`insert into crm.ts_checklist_template (section, item, sort) select * from unnest(${clean.map(x => x.section)}::text[], ${clean.map(x => x.item)}::text[], ${clean.map((_, i) => (i + 1) * 10)}::int[])`;
  });
}
export async function addChecklistItems(showId: unknown, items: { section?: unknown; item: unknown }[]) {
  const sid = idOk(showId, 'That show');
  const clean = items.map(x => ({ section: cleanText(x.section, 60) ?? 'General', item: cleanText(x.item, 200) })).filter((x): x is { section: string; item: string } => !!x.item);
  if (!clean.length) throw new TsError('Write the item.');
  await guard(async () => { const [m] = await prisma.$queryRaw<{ n: number }[]>`select coalesce(max(sort), 0)::int as n from crm.ts_checklist where show_id = ${sid}::uuid`;
    await prisma.$queryRaw`insert into crm.ts_checklist (show_id, section, item, sort) select ${sid}::uuid, * from unnest(${clean.map(x => x.section)}::text[], ${clean.map(x => x.item)}::text[], ${clean.map((_, i) => m!.n + (i + 1) * 10)}::int[])`; });
}
export async function updateChecklistItem(rep: Rep, showId: unknown, id: unknown, b: any) {
  const sid = idOk(showId, 'That show'), cid = idOk(id, 'That item');
  await guard(async () => {
    if (typeof b?.done === 'boolean') await prisma.$queryRaw`update crm.ts_checklist set done = ${b.done}, done_by = case when ${b.done}::boolean then ${rep.id}::uuid else null end, done_at = case when ${b.done}::boolean then now() else null end where id = ${cid}::uuid and show_id = ${sid}::uuid`;
    if (b?.ownerId !== undefined) await prisma.$queryRaw`update crm.ts_checklist set owner_id = ${b.ownerId ? idOk(b.ownerId, 'That person') : null}::uuid where id = ${cid}::uuid and show_id = ${sid}::uuid`;
    if (b?.note !== undefined) await prisma.$queryRaw`update crm.ts_checklist set note = ${cleanText(b.note, 300)} where id = ${cid}::uuid and show_id = ${sid}::uuid`;
  });
}
export async function deleteChecklistItem(showId: unknown, id: unknown) { await guard(() => prisma.$queryRaw`delete from crm.ts_checklist where id = ${idOk(id, 'That item')}::uuid and show_id = ${idOk(showId, 'That show')}::uuid`); }

// ---------- the feedback ----------
export async function getFeedback(showId: unknown) {
  const sid = idOk(showId, 'That show');
  return guard(async () => {
    const [f] = await prisma.$queryRaw<any[]>`select general, pros, cons, improvements, updated_at from crm.ts_feedback where show_id = ${sid}::uuid`;
    // the last time we did this show: the same series, the show before this one (or, with no series, the one before it)
    const [prev] = await prisma.$queryRaw<any[]>`select s.id, s.name, s.starts_on, f.general, f.pros, f.cons, f.improvements from crm.ts_shows s join crm.ts_feedback f on f.show_id = s.id,
      (select series, starts_on, name from crm.ts_shows where id = ${sid}::uuid) cur
      where s.id <> ${sid}::uuid and s.starts_on < cur.starts_on and (coalesce(f.general, '') || coalesce(f.pros, '') || coalesce(f.cons, '') || coalesce(f.improvements, '')) <> ''
        and (cur.series is null or s.series = cur.series) order by s.starts_on desc limit 1`;
    return { general: f?.general ?? '', pros: f?.pros ?? '', cons: f?.cons ?? '', improvements: f?.improvements ?? '', updatedAt: f?.updated_at ? new Date(f.updated_at).toISOString() : null,
      previous: prev ? { showId: prev.id as string, showName: prev.name as string, general: prev.general as string | null, pros: prev.pros as string | null, cons: prev.cons as string | null, improvements: prev.improvements as string | null } : null };
  });
}
export async function saveFeedback(rep: Rep, showId: unknown, b: any) {
  const sid = idOk(showId, 'That show'); const t = (k: string) => cleanText(b?.[k], 6000);
  await guard(() => prisma.$queryRaw`insert into crm.ts_feedback (show_id, general, pros, cons, improvements, updated_by) values (${sid}::uuid, ${t('general')}, ${t('pros')}, ${t('cons')}, ${t('improvements')}, ${rep.id}::uuid)
    on conflict (show_id) do update set general = excluded.general, pros = excluded.pros, cons = excluded.cons, improvements = excluded.improvements, updated_by = excluded.updated_by, updated_at = now()`);
}

// ---------- old shows ----------
/** An old show, made only for the comparison. Its figures come from a sheet (the Excel reader fills them in) or are typed. */
export async function createHistoryShow(rep: Rep, b: any): Promise<string> {
  mustManage(rep, 'add old shows');
  const name = cleanText(b?.name, 120); if (!name) throw new TsError('Give the show a name.');
  const startsOn = parseDay(b?.startsOn, 'first day'), endsOn = parseDay(b?.endsOn || b?.startsOn, 'last day'); if (endsOn < startsOn) throw new TsError('The last day is before the first day.');
  return guard(async () => { const [r] = await prisma.$queryRaw<{ id: string }[]>`insert into crm.ts_shows (name, ref_name, starts_on, ends_on, series, is_history, archived, created_by)
    values (${name}, ${(cleanText(b?.refName, 40) ?? name.slice(0, 40)).toUpperCase()}, ${startsOn}::date, ${endsOn}::date, ${cleanText(b?.series, 80)}, true, true, ${rep.id}::uuid) returning id`; return r!.id; });
}
export type HistoryDay = { day: string; sales: number; orders: number; newSales: number | null; newReturningSales: number | null; existingSales: number | null; newStockists: number | null; newOrders: number | null; paidPct: number | null };
export function parseHistory(b: any): { days: HistoryDay[]; bundles: { name: string; qty: number }[] } {
  const n = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
  const days = (Array.isArray(b?.days) ? b.days : []).slice(0, 60).map((d: any) => ({ day: parseDay(d?.day, 'day'), sales: round2(n(d?.sales) ?? 0), orders: Math.round(n(d?.orders) ?? 0), newSales: n(d?.newSales), newReturningSales: n(d?.newReturningSales), existingSales: n(d?.existingSales),
    newStockists: n(d?.newStockists) === null ? null : Math.round(n(d?.newStockists)!), newOrders: n(d?.newOrders) === null ? null : Math.round(n(d?.newOrders)!), paidPct: n(d?.paidPct) }));
  const bundles = (Array.isArray(b?.bundles) ? b.bundles : []).slice(0, 60).map((x: any) => ({ name: cleanText(x?.name, 120) ?? '', qty: Math.round(n(x?.qty) ?? 0) })).filter((x: any) => x.name && x.qty > 0);
  return { days, bundles };
}
/** Replaces an old show's figures (what the Excel reader found, after the person has checked it). */
export async function saveHistory(rep: Rep, showId: unknown, b: any) {
  mustManage(rep, 'change old show figures');
  const sid = idOk(showId, 'That show'), h = parseHistory(b);
  await guard(async () => {
    const [s] = await prisma.$queryRaw<{ is_history: boolean }[]>`select is_history from crm.ts_shows where id = ${sid}::uuid`;
    if (!s) throw new TsError('That show was not found.', 404);
    if (!s.is_history) throw new TsError('This show has its own orders in Radar, so its figures come from them. Old figures can only be added to an old show.');
    await prisma.$queryRaw`delete from crm.ts_history_days where show_id = ${sid}::uuid`; await prisma.$queryRaw`delete from crm.ts_history_bundles where show_id = ${sid}::uuid`;
    for (const d of h.days) await prisma.$queryRaw`insert into crm.ts_history_days (show_id, day, sales, orders, new_sales, new_returning_sales, existing_sales, new_stockists, new_orders, paid_pct)
      values (${sid}::uuid, ${d.day}::date, ${d.sales}::numeric, ${d.orders}, ${d.newSales}::numeric, ${d.newReturningSales}::numeric, ${d.existingSales}::numeric, ${d.newStockists}::int, ${d.newOrders}::int, ${d.paidPct}::numeric)`;
    for (const x of h.bundles) await prisma.$queryRaw`insert into crm.ts_history_bundles (show_id, name, qty) values (${sid}::uuid, ${x.name}, ${x.qty}) on conflict (show_id, name) do update set qty = excluded.qty`;
  });
  return h;
}

// ---------- the Sales Comparison ----------
export type CompareDay = { n: number; day: string; sales: number; orders: number; newSales: number | null; newReturningSales: number | null; existingSales: number | null; newStockists: number | null; newOrders: number | null };
export type CompareShow = {
  id: string; name: string; year: number; startsOn: string; endsOn: string; history: boolean; days: CompareDay[]; bundles: { name: string; qty: number }[]; byState: { state: string; sales: number; orders: number }[];
  totals: { sales: number; orders: number; averageOrder: number | null; newSales: number | null; newReturningSales: number | null; existingSales: number | null; newPct: number | null; paidPct: number | null; newSignedUp: number | null; newOrders: number | null; conversion: number | null; cost: number; returnOnCost: number | null; target: number | null; toTarget: number | null };
  vsPrevious: { sales: number | null; orders: number | null; previousName: string | null };
};
const pctChange = (now: number, before: number | null | undefined) => (before && before > 0 ? (now - before) / before : null);
/** Every show in a series side by side, year on year. Live shows are worked out from their orders; old shows from the figures loaded for them. */
export async function getComparison(series?: unknown) {
  return guard(async () => {
    const all = await prisma.$queryRaw<any[]>`select id, name, series, is_history, starts_on, ends_on, target, cost_stand, cost_travel, cost_samples, cost_other from crm.ts_shows order by starts_on`;
    const key = (s: any) => String(s.series || s.name);
    const names = [...new Set(all.map(key))].sort();
    const want = typeof series === 'string' && names.includes(series) ? series : all.length ? key(all[all.length - 1]) : null;
    const chosen = all.filter(s => key(s) === want);
    const shows: CompareShow[] = [];
    for (const s of chosen) shows.push(s.is_history ? await historyShow(s) : await liveShow(s));
    shows.forEach((s, i) => { const p = shows[i - 1]; s.vsPrevious = { sales: p ? pctChange(s.totals.sales, p.totals.sales) : null, orders: p ? pctChange(s.totals.orders, p.totals.orders) : null, previousName: p?.name ?? null }; });
    return { series: names, selected: want, shows };
  });
}
const costOf = (s: any) => round2([s.cost_stand, s.cost_travel, s.cost_samples, s.cost_other].reduce((a, c) => a + (Number(c) || 0), 0));
const dayList = (a: string, b: string) => { const out: string[] = []; for (let d = a, i = 0; d <= b && i < 40; d = plusDays(d, 1), i++) out.push(d); return out; };
const base = (s: any) => ({ id: s.id as string, name: s.name as string, year: new Date(s.starts_on).getUTCFullYear(), startsOn: day(s.starts_on)!, endsOn: day(s.ends_on)!, history: !!s.is_history });
function totalsOf(s: any, days: CompareDay[], paidPct: number | null, signed: number | null): CompareShow['totals'] {
  const sum = (k: keyof CompareDay) => days.reduce((a, d) => a + (Number(d[k]) || 0), 0), has = (k: keyof CompareDay) => days.some(d => d[k] !== null);
  const sales = round2(sum('sales')), orders = sum('orders'), cost = costOf(s), newSales = has('newSales') ? round2(sum('newSales')) : null;
  const newOrders = has('newOrders') ? sum('newOrders') : null, newSignedUp = signed ?? (has('newStockists') ? sum('newStockists') : null);
  return { sales, orders, averageOrder: orders ? round2(sales / orders) : null, newSales, newReturningSales: has('newReturningSales') ? round2(sum('newReturningSales')) : null, existingSales: has('existingSales') ? round2(sum('existingSales')) : null,
    newPct: newSales !== null && sales > 0 ? newSales / sales : null, paidPct, newSignedUp, newOrders, conversion: newOrders !== null && newSignedUp ? newOrders / newSignedUp : null, cost, returnOnCost: cost > 0 ? sales / cost : null,
    target: num(s.target), toTarget: s.target && Number(s.target) > 0 ? sales / Number(s.target) : null };
}
async function historyShow(s: any): Promise<CompareShow> {
  const [rows, bundles] = await Promise.all([
    prisma.$queryRaw<any[]>`select day, sales::float8, orders, new_sales::float8 as new_sales, new_returning_sales::float8 as nr, existing_sales::float8 as ex, new_stockists, new_orders, paid_pct::float8 as paid from crm.ts_history_days where show_id = ${s.id}::uuid order by day`,
    prisma.$queryRaw<{ name: string; qty: number }[]>`select name, qty from crm.ts_history_bundles where show_id = ${s.id}::uuid order by qty desc, name`]);
  const days: CompareDay[] = rows.map((r, i) => ({ n: i + 1, day: day(r.day)!, sales: Number(r.sales), orders: r.orders, newSales: r.new_sales, newReturningSales: r.nr, existingSales: r.ex, newStockists: r.new_stockists, newOrders: r.new_orders }));
  const paid = rows.filter(r => r.paid !== null);
  const paidPct = paid.length ? paid.reduce((a, r) => a + Number(r.paid) * Number(r.sales), 0) / Math.max(1, paid.reduce((a, r) => a + Number(r.sales), 0)) / 100 : null;
  return { ...base(s), days, bundles, byState: [], totals: totalsOf(s, days, paidPct, null), vsPrevious: { sales: null, orders: null, previousName: null } };
}
async function liveShow(s: any): Promise<CompareShow> {
  const orders = (await linkedOrders(`ol.show_id = $1::uuid and ol.status = 'sent' and ol.kind = 'order' order by ol.created_at`, s.id)) as any[];
  const lines = await linesOf(orders.map(o => o.id));
  const tot = new Map(orders.map(o => [o.id, orderTotals(o, (lines.get(o.id) ?? []).map(l => ({ qty: l.qty, price: Number(l.price), pct: Number(l.pct) || 0 })))]));
  const accIds = [...new Set(orders.map(o => o.account_id))];
  const before = accIds.length ? await prisma.$queryRaw<{ account_id: string }[]>`select distinct account_id from crm.quotes q where q.account_id = any(${accIds}::text[]::uuid[]) and q.sent_at < ${day(s.starts_on)}::date
      and ((q.source = 'rhino-history' or q.number like 'Q%') and q.paid or (q.source is distinct from 'rhino-history' and q.number not like 'Q%' and upper(coalesce(q.fulfillment_status, '')) <> all(${NOT_A_SALE}::text[])))` : [];
  const had = new Set(before.map(b => b.account_id));
  const isNew = (o: any) => o.new_customer || !had.has(o.account_id);
  const leadsNew = await prisma.$queryRaw<{ account_id: string; taken_on: Date }[]>`select account_id, taken_on from crm.ts_leads where show_id = ${s.id}::uuid and new_account`;
  const days = dayList(day(s.starts_on)!, day(s.ends_on)!).map((d, i): CompareDay => {
    const o = orders.filter(x => day(x.order_date) === d), v = (x: any) => tot.get(x.id)!.goodsAfter, sum = (a: any[]) => round2(a.reduce((q, x) => q + v(x), 0));
    const signed = new Set([...o.filter(x => x.new_customer).map(x => x.account_id), ...leadsNew.filter(l => day(l.taken_on) === d).map(l => l.account_id)]);
    return { n: i + 1, day: d, sales: sum(o), orders: o.length, newSales: sum(o.filter(isNew)), newReturningSales: null, existingSales: sum(o.filter(x => !isNew(x))), newStockists: signed.size, newOrders: o.filter(isNew).length };
  });
  const signedAll = new Set([...orders.filter(o => o.new_customer).map(o => o.account_id), ...leadsNew.map(l => l.account_id)]).size;
  // paid share: orders that DEAR shows paid (part paid counts for what is paid)
  let paidV = 0, allV = 0;
  for (const o of orders) { const st = stageOf(o), v = tot.get(o.id)!.goodsAfter, p = paymentOf(st, tot.get(o.id)!.total, num(o.dear_invoiced), num(o.dear_due)); allV += v; paidV += p.status === 'paid' ? v : p.status === 'part' && p.paid != null && p.owing != null ? (v * p.paid) / Math.max(0.01, p.paid + p.owing) : 0; }
  // bundles sold: whole packs, from the bundle lines
  const offers = await loadOffers(s.id), packs = new Map<string, number>();
  for (const o of orders) for (const b of offers.filter(x => x.kind === 'bundle' && x.items.length)) {
    const mine = (lines.get(o.id) ?? []).filter(l => l.line_kind === 'bundle' && l.offer_id === b.id);
    const n = Math.min(...b.items.map(it => Math.floor(mine.filter(l => l.sku.toUpperCase() === it.sku.toUpperCase()).reduce((q, l) => q + l.qty, 0) / it.qty)));
    if (n > 0) packs.set(b.name, (packs.get(b.name) ?? 0) + n);
  }
  const st = new Map<string, { sales: number; orders: number }>();
  for (const o of orders) { const e = st.get(o.region ?? 'Unknown') ?? { sales: 0, orders: 0 }; e.sales = round2(e.sales + tot.get(o.id)!.goodsAfter); e.orders++; st.set(o.region ?? 'Unknown', e); }
  return { ...base(s), days, bundles: [...packs].map(([name, qty]) => ({ name, qty })).sort((a, b) => b.qty - a.qty), byState: [...st].map(([state, v]) => ({ state, ...v })).sort((a, b) => b.sales - a.sales),
    totals: totalsOf(s, days, allV > 0 ? paidV / allV : null, signedAll), vsPrevious: { sales: null, orders: null, previousName: null } };
}
