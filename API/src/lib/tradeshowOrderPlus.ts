// Trade shows, part 2: what an order needs from the database while it is written and sent. Offers (percent off, bundles, bonus packs),
// freight (the team's calculator, or Australia Post for New Zealand), the DEAR reference, the charge items for the DEAR file, and where the
// payment stands. tradeshow.ts calls these; this file does not import tradeshow.ts.
import { createHash } from 'node:crypto';
import { prisma } from './prisma';
import { wholesalePrice } from './pricing';
import { freightQuote } from './aiFreight';
import { totals, TsError, round2 } from './tradeshowCore';
import { applyOffers, DEFAULT_FREIGHT, dearReference, freightFor, paymentOf, REGION_TYPES, type FreightCfg, type InLine, type Offer, type OutLine } from './tsOffers';

const missingTable = (e: any, t: string) => (e?.code === '42P01' || e?.meta?.code === '42P01' || /does not exist|relation/i.test(String(e?.message ?? e))) && new RegExp(t).test(String(e?.message ?? e));
export const day = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : null);

// ---------- offers ----------
/** The show's offers, with each bundle and bonus product's name, brand and wholesale price filled in from Radar's products. Empty when part 2 is not set up yet. */
export async function loadOffers(showId: string): Promise<Offer[]> {
  let rows: any[];
  try {
    rows = await prisma.$queryRaw<any[]>`select id, kind, name, pct::float8 as pct, brands, skus, threshold::float8 as threshold, repeat, items, bundle_price::float8 as bundle_price,
      to_char(pay_by, 'YYYY-MM-DD') as pay_by, active, notes from crm.ts_offers where show_id = ${showId}::uuid order by sort, created_at`;
  } catch (e) { if (missingTable(e, 'ts_offers')) return []; throw e; }
  const skus = [...new Set(rows.flatMap(r => (Array.isArray(r.items) ? r.items : []).map((i: any) => String(i.sku ?? '').toUpperCase())).filter(Boolean))];
  const prods = skus.length ? await prisma.$queryRaw<any[]>`select upper(sku) as k, sku, name, brand, prices from crm.products where upper(sku) = any(${skus}::text[])` : [];
  const byKey = new Map(prods.map(p => [p.k as string, p]));
  return rows.map(r => ({
    id: r.id, kind: r.kind, name: r.name, pct: r.pct, brands: r.brands ?? [], skus: r.skus ?? [], threshold: r.threshold, repeat: r.repeat, bundlePrice: r.bundle_price, payBy: r.pay_by, active: r.active, notes: r.notes,
    items: (Array.isArray(r.items) ? r.items : []).map((i: any) => { const p = byKey.get(String(i.sku ?? '').toUpperCase()); return { sku: p?.sku ?? String(i.sku), qty: Number(i.qty) || 1, name: p?.name ?? null, brand: p?.brand ?? null, price: p ? wholesalePrice(p.prices) : null }; }),
  }));
}
/** The lines as written, with the show's offers worked out (the server's answer is the one that is saved and sent). */
export async function withOffers(showId: string, lines: InLine[]) { return applyOffers(lines, await loadOffers(showId)); }

/** Replaces the order's lines (the normal, bundle and free bonus lines) in one go, and keeps the pay-by date its offers need. */
export async function writeLines(oid: string, r: { lines: OutLine[]; payBy: string | null }): Promise<void> {
  const lines = r.lines;
  await prisma.$queryRaw`update crm.ts_orders set pay_by = ${r.payBy}::date where id = ${oid}::uuid`;
  await prisma.$queryRaw`delete from crm.ts_order_lines where order_id = ${oid}::uuid`;
  if (!lines.length) return;
  await prisma.$queryRaw`insert into crm.ts_order_lines (order_id, line_no, sku, name, brand, qty, price, comment, pct, line_kind, offer_id)
    select ${oid}::uuid, v.n, v.sku, v.name, v.brand, v.qty, v.price::numeric, v.comment, v.pct::numeric, v.kind, v.offer::uuid
    from unnest(${lines.map((_, i) => i + 1)}::int[], ${lines.map(l => l.sku)}::text[], ${lines.map(l => l.name)}::text[], ${lines.map(l => l.brand)}::text[], ${lines.map(l => l.qty)}::int[],
      ${lines.map(l => String(l.price))}::text[], ${lines.map(l => l.comment ?? null)}::text[], ${lines.map(l => String(l.pct))}::text[], ${lines.map(l => l.kind)}::text[], ${lines.map(l => l.offerId)}::text[])
      as v(n, sku, name, brand, qty, price, comment, pct, kind, offer)`;
}

// ---------- freight ----------
export async function loadFreightCfg(): Promise<{ cfg: FreightCfg; custom: boolean }> {
  try {
    const [r] = await prisma.$queryRaw<{ config: FreightCfg }[]>`select config from crm.ts_freight_cfg where id = 1`;
    if (r?.config) return { cfg: { ...DEFAULT_FREIGHT, ...r.config, states: r.config.states ?? DEFAULT_FREIGHT.states }, custom: true };
  } catch (e) { if (!missingTable(e, 'ts_freight_cfg')) throw e; }
  return { cfg: DEFAULT_FREIGHT, custom: false };
}
type Quote = (ctx: { rep: { id: string; role: string }; today: string }, input: any) => Promise<string>;
/**
 * Works out the freight for a draft order and saves it, unless someone typed it in (then Radar leaves it alone until they press "work it out again").
 * Australia: the calculator. New Zealand: the cheapest Australia Post service for the cartons the goods pack into (only when the goods have changed).
 * b: { regionType, largeItems, pantone, freightEdited, freightReset, freightNz } from the page.
 */
export async function autoFreight(oid: string, rep: { id: string; role: string }, b: any, quote: Quote = freightQuote): Promise<void> {
  const [o] = await prisma.$queryRaw<any[]>`select o.*, a.region from crm.ts_orders o join crm.accounts a on a.id = o.account_id where o.id = ${oid}::uuid`;
  if (!o) return;
  const regionType = typeof b?.regionType === 'string' && REGION_TYPES.includes(b.regionType) ? b.regionType : o.region_type;
  const large = typeof b?.largeItems === 'boolean' ? b.largeItems : o.large_items, pantone = typeof b?.pantone === 'boolean' ? b.pantone : o.pantone;
  const edited = b?.freightEdited === true, reset = b?.freightReset === true;
  const manual = reset ? false : edited ? true : o.freight_manual;
  await prisma.$queryRaw`update crm.ts_orders set region_type = ${regionType}, large_items = ${large}, pantone = ${pantone}, freight_manual = ${manual},
    freight_note = case when ${edited}::boolean then 'Typed in by hand.' else freight_note end where id = ${oid}::uuid`;
  if (manual) return;
  const lines = await prisma.$queryRaw<{ sku: string; qty: number; price: string; pct: string }[]>`select sku, qty, price::text, pct::text from crm.ts_order_lines where order_id = ${oid}::uuid order by line_no`;
  const t = totals({ lines: lines.map(l => ({ qty: l.qty, price: Number(l.price), pct: Number(l.pct) || 0 })), discount: o.discount_kind && Number(o.discount_value) > 0 ? { kind: o.discount_kind, value: Number(o.discount_value) } : null,
    freight: 0, cardPayment: false, surchargePct: null, gstRate: Number(o.gst_rate) });
  const { cfg } = await loadFreightCfg();
  const f = freightFor(cfg, { state: o.region, region: regionType, orderIncGst: t.goodsAfter * (1 + Number(o.gst_rate)), large, pantone });
  if (f.how === 'calculator') { await prisma.$queryRaw`update crm.ts_orders set freight = ${f.amount}::numeric, freight_note = ${f.note}, freight_sig = null where id = ${oid}::uuid`; return; }
  if (f.how === 'unknown') { await prisma.$queryRaw`update crm.ts_orders set freight_note = ${f.note} where id = ${oid}::uuid`; return; }
  // New Zealand: Australia Post. Only asked again when the goods change, or when the person presses the button.
  if (String(o.region).toUpperCase() !== 'NZ' || !lines.length) { await prisma.$queryRaw`update crm.ts_orders set freight_note = 'Overseas: type the freight in.' where id = ${oid}::uuid`; return; }
  const sig = createHash('sha1').update(JSON.stringify(lines.map(l => [l.sku, l.qty]))).digest('hex');
  if (sig === o.freight_sig && b?.freightNz !== true) return;
  const items = lines.map(l => ({ sku: l.sku, quantity: l.qty }));
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Melbourne' });
  let ans: any; try { ans = JSON.parse(await quote({ rep, today }, { country: 'NZ', items })); } catch (e: any) { ans = { status: 'error', message: String(e?.message ?? e).slice(0, 160) }; }
  if (ans.status === 'quoted' && ans.cheapest) {
    const note = `Australia Post to New Zealand: ${ans.cheapest.service}, ${ans.cartons?.length ?? 1} ${(ans.cartons?.length ?? 1) === 1 ? 'carton' : 'cartons'} (cheapest). Change it if you quoted something else.`;
    await prisma.$queryRaw`update crm.ts_orders set freight = ${round2(ans.cheapest.totalAud)}::numeric, freight_note = ${note}, freight_sig = ${sig} where id = ${oid}::uuid`;
  } else {
    await prisma.$queryRaw`update crm.ts_orders set freight_note = ${`Australia Post: ${String(ans.message ?? ans.status ?? 'no quote').slice(0, 300)}`}, freight_sig = null where id = ${oid}::uuid`;
  }
}

/** The service items DEAR needs on the sale for freight and the card surcharge (the file adds them as lines). Settings override; otherwise the kept service items. */
let chargeCache: { at: number; v: { freight: string | null; surcharge: string | null } } | null = null;
export async function chargeSkus(): Promise<{ freight: string | null; surcharge: string | null }> {
  const env = { freight: process.env.TS_FREIGHT_SKU?.trim() || null, surcharge: process.env.TS_SURCHARGE_SKU?.trim() || null };
  if (env.freight && env.surcharge) return env;
  if (chargeCache && Date.now() - chargeCache.at < 600_000) return { freight: env.freight ?? chargeCache.v.freight, surcharge: env.surcharge ?? chargeCache.v.surcharge };
  const find = async (like: string) => (await prisma.$queryRaw<{ sku: string }[]>`select sku from crm.products where name ilike ${like} order by length(name) limit 1`.catch(() => []))[0]?.sku ?? null;
  chargeCache = { at: Date.now(), v: { freight: await find('RR Freight - Standard%'), surcharge: await find('%surcharge%') } };
  return { freight: env.freight ?? chargeCache.v.freight, surcharge: env.surcharge ?? chargeCache.v.surcharge };
}

/** What the order page needs beside the lines: the show's offers (to add bundles), what applied, what is close, the pay-by date, the freight set-up, the DEAR reference and payment. */
export async function orderPlus(o: any, lines: { sku: string; name: string; brand: string | null; qty: number; price: string | number; comment?: string | null; line_kind?: string; offer_id?: string | null }[], t: { total: number }, stage: string) {
  const offers = await loadOffers(o.show_id);
  const r = applyOffers(lines.filter(l => l.line_kind !== 'gift').map(l => ({ sku: l.sku, name: l.name, brand: l.brand, qty: l.qty, price: Number(l.price), kind: (l.line_kind === 'bundle' ? 'bundle' : 'normal') as 'bundle' | 'normal', offerId: l.offer_id ?? null })), offers);
  const { cfg, custom } = await loadFreightCfg();
  const [a] = await prisma.$queryRaw<{ region: string | null }[]>`select region from crm.accounts where id = ${o.account_id}::uuid`;
  const pay = paymentOf(stage, t.total, o.dear_invoiced == null ? null : Number(o.dear_invoiced), o.dear_due == null ? null : Number(o.dear_due));
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Melbourne' });
  const payBy = day(o.pay_by) ?? r.payBy;
  return {
    dearReference: o.dear_reference ?? o.reference,
    offers: offers.filter(x => x.active), applied: r.applied, prompts: r.prompts, payBy,
    payByOverdue: !!payBy && payBy < today && pay.status !== 'paid' && pay.status !== 'cancelled',
    freightInfo: { regionType: o.region_type ?? 'Metro', largeItems: !!o.large_items, pantone: !!o.pantone, manual: !!o.freight_manual, note: o.freight_note ?? null, state: a?.region ?? null, cfg, customRates: custom },
    payment: pay,
  };
}
export { TsError, dearReference, paymentOf };
