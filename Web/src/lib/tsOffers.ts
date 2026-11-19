// Trade show offers and freight: the plain rules, with no database and no imports.
// The same file is on the API (API/src/lib/tsOffers.ts) and on the order page (Web/src/lib/tsOffers.ts), so the page shows what the server will work out.
//   - percent offers: a % off a brand or a list of SKUs (for example end of life stock). The best % wins; they do not stack.
//   - bundles: a set of products sold for one price per pack. Added as lines; each line gets the same % so the pack adds up to the pack price.
//   - bonus packs: spend a set amount (on a brand, some SKUs, or the whole order) and free products are added at 100% off. Can repeat.
//   - pay-by dates: an offer that only holds if the order is paid by a date.
//   - freight: the team's calculator (state rate and minimum, metro or regional or rural, large items, Pantone Living).

export type OfferItem = { sku: string; qty: number; name?: string | null; price?: number | null; brand?: string | null };
export type Offer = {
  id: string; kind: 'pct' | 'bundle' | 'bonus'; name: string; pct: number | null; brands: string[]; skus: string[]; threshold: number | null; repeat: boolean;
  items: OfferItem[]; bundlePrice: number | null; payBy: string | null; active: boolean; notes: string | null;
};
export type LineKind = 'normal' | 'bundle' | 'gift';
export type InLine = { sku: string; name: string; brand: string | null; qty: number; price: number; comment?: string | null; kind?: LineKind; offerId?: string | null };
export type OutLine = InLine & { kind: LineKind; offerId: string | null; pct: number; note: string | null };
export type Applied = { offerId: string; name: string; text: string };
export type Prompt = { offerId: string; text: string };

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const dollars = (n: number) => `$${n.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const same = (a: string | null | undefined, b: string | null | undefined) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
const skuOf = (s: string | null | undefined) => String(s ?? '').trim().toUpperCase();
/** Two discounts on one line (an offer, then the manager's): 10% then 10% is 19%. DEAR takes a % to 2 decimals. */
export const combinePct = (a: number, b: number) => (a >= 100 || b >= 100 ? 100 : Math.round((100 - ((100 - (a || 0)) * (100 - (b || 0))) / 100) * 100) / 100);

const inScope = (o: Offer, l: { sku: string; brand: string | null }) => o.skus.some(s => skuOf(s) === skuOf(l.sku)) || o.brands.some(b => same(b, l.brand));

/**
 * Works out which offers apply to the lines as they stand. Lines come in as the person wrote them (normal lines, and bundle lines that carry
 * their bundle's id); bonus lines are always worked out again here, so they come and go as the order changes.
 */
export function applyOffers(input: InLine[], offers: Offer[]): { lines: OutLine[]; applied: Applied[]; prompts: Prompt[]; payBy: string | null } {
  const live = offers.filter(o => o.active);
  const pctOffers = live.filter(o => o.kind === 'pct' && (o.pct ?? 0) > 0), bundles = new Map(live.filter(o => o.kind === 'bundle').map(o => [o.id, o]));
  const base = input.filter(l => l.kind !== 'gift');
  const applied = new Map<string, Applied>(), used: Offer[] = [];
  const use = (o: Offer, text: string) => { if (!applied.has(o.id)) { applied.set(o.id, { offerId: o.id, name: o.name, text }); used.push(o); } };

  // each bundle: the same % on every one of its lines, so a pack costs the pack price
  const bundlePct = new Map<string, number>();
  for (const [id, b] of bundles) {
    const mine = base.filter(l => l.kind === 'bundle' && l.offerId === id);
    if (!mine.length || !b.bundlePrice || b.bundlePrice <= 0) continue;
    const packValue = b.items.reduce((s, it) => s + it.qty * (mine.find(l => skuOf(l.sku) === skuOf(it.sku))?.price ?? it.price ?? 0), 0);
    bundlePct.set(id, packValue > 0 ? Math.min(100, Math.max(0, round2((1 - b.bundlePrice / packValue) * 100))) : 0);
  }
  const out: OutLine[] = base.map(l => {
    if (l.kind === 'bundle' && l.offerId && bundles.has(l.offerId)) {
      const b = bundles.get(l.offerId)!, packs = !b.items.length ? 0 : Math.min(...b.items.map(it => (it.qty > 0 ? Math.floor(base.filter(x => x.kind === 'bundle' && x.offerId === b.id && skuOf(x.sku) === skuOf(it.sku)).reduce((s, x) => s + x.qty, 0) / it.qty) : 0)));
      use(b, `${b.name}: ${packs > 0 ? `${packs} ${packs === 1 ? 'pack' : 'packs'} at ${dollars(b.bundlePrice ?? 0)}` : 'incomplete pack'}`);
      return { ...l, kind: 'bundle', offerId: b.id, pct: bundlePct.get(b.id) ?? 0, note: b.name };
    }
    let best: Offer | null = null;
    for (const o of pctOffers) if (inScope(o, l) && (!best || (o.pct ?? 0) > (best.pct ?? 0))) best = o;
    if (best) use(best, `${best.name}: ${best.pct}% off`);
    return { ...l, kind: 'normal', offerId: best?.id ?? null, pct: best?.pct ?? 0, note: best ? `${best.name} ${best.pct}% off` : null };
  });

  // bonus packs: free products once enough is spent
  const gifts: OutLine[] = [], prompts: Prompt[] = [];
  for (const o of live.filter(x => x.kind === 'bonus' && (x.threshold ?? 0) > 0 && x.items.length)) {
    const scoped = o.brands.length || o.skus.length;
    const spend = round2(out.filter(l => (scoped ? inScope(o, l) : true)).reduce((s, l) => s + l.qty * l.price * (1 - l.pct / 100), 0));
    const times = o.repeat ? Math.floor(spend / o.threshold!) : spend >= o.threshold! ? 1 : 0;
    const where = scoped ? ` on ${[...o.brands, ...o.skus].join(', ')}` : '';
    if (times > 0) {
      use(o, `${o.name}: ${dollars(o.threshold!)}${where} reached${times > 1 ? `, ${times} times` : ''}`);
      for (const it of o.items) gifts.push({ sku: it.sku, name: it.name || it.sku, brand: it.brand ?? null, qty: it.qty * times, price: it.price ?? 0, kind: 'gift', offerId: o.id, pct: 100, note: `${o.name} (free)` });
    }
    if (spend > 0 && (o.repeat || times === 0)) {
      const into = o.repeat ? spend % o.threshold! : spend;
      prompts.push({ offerId: o.id, text: `Spend ${dollars(round2(o.threshold! - into))} more${where} to get ${o.name}.` });
    }
  }
  const dates = used.map(o => o.payBy).filter((d): d is string => !!d).sort();
  return { lines: [...out, ...gifts], applied: [...applied.values()], prompts, payBy: dates[0] ?? null };
}

// ---------- freight: the team's calculator ----------
export type FreightCfg = { states: Record<string, { rate: number; min: number }>; regions: Record<string, number>; large: number; pantone: number; act: { state: string; region: string } };
export const DEFAULT_FREIGHT: FreightCfg = {
  states: { VIC: { rate: 0.02, min: 25 }, NSW: { rate: 0.045, min: 30 }, SA: { rate: 0.06, min: 30 }, QLD: { rate: 0.06, min: 30 }, WA: { rate: 0.1, min: 30 }, TAS: { rate: 0.06, min: 30 }, NT: { rate: 0.1, min: 30 } },
  regions: { Metro: 1, Regional: 1.35, Rural: 1.65 }, large: 1.2, pantone: 1.1, act: { state: 'NSW', region: 'Rural' },
};
export const REGION_TYPES = ['Metro', 'Regional', 'Rural'];
export type FreightIn = { state: string | null | undefined; region: string | null | undefined; orderIncGst: number; large: boolean; pantone: boolean };
export type FreightOut = { amount: number | null; note: string; how: 'calculator' | 'overseas' | 'unknown' };
/** Freight ex GST: the biggest of the state's minimum and (order total inc GST x state rate x metro/regional/rural x large items x Pantone Living). */
export function freightFor(cfg: FreightCfg, i: FreightIn): FreightOut {
  const st = String(i.state ?? '').trim().toUpperCase();
  if (st === 'NZ' || st === 'INTL') return { amount: null, note: 'Overseas: quoted from Australia Post.', how: 'overseas' };
  let state = st.replace(/\/HO$/, ''), region = REGION_TYPES.includes(i.region ?? '') ? i.region! : 'Metro';
  if (state === 'ACT') { state = cfg.act.state; region = cfg.act.region; }   // the calculator quotes ACT as NSW rural
  const r = cfg.states[state];
  if (!r) return { amount: null, note: `No freight rate for ${i.state || 'that state'}. Type the freight in.`, how: 'unknown' };
  const mult = cfg.regions[region] ?? 1;
  const raw = i.orderIncGst * r.rate * mult * (i.large ? cfg.large : 1) * (i.pantone ? cfg.pantone : 1);
  const amount = round2(Math.max(r.min, raw));
  return { amount, how: 'calculator', note: `${state} ${round2(r.rate * 100)}% ${region.toLowerCase()}${i.large ? ', large items' : ''}${i.pantone ? ', Pantone Living' : ''}, minimum ${dollars(r.min)}${raw < r.min ? ' (the minimum applies)' : ''}` };
}
/** The cleaned freight settings: every number checked, missing states put back to the defaults. */
export function cleanFreightCfg(v: any): FreightCfg {
  const num = (x: unknown, what: string, lo: number, hi: number) => { const n = Number(x); if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${what} must be a number from ${lo} to ${hi}.`); return n; };
  const states: FreightCfg['states'] = {};
  for (const [k, s] of Object.entries(v?.states ?? {})) { const key = k.trim().toUpperCase(); if (key) states[key] = { rate: num((s as any)?.rate, `The ${key} rate`, 0, 1), min: num((s as any)?.min, `The ${key} minimum`, 0, 1000) }; }
  if (!Object.keys(states).length) throw new Error('Add at least one state.');
  const regions: FreightCfg['regions'] = {};
  for (const r of REGION_TYPES) regions[r] = num(v?.regions?.[r] ?? DEFAULT_FREIGHT.regions[r], `The ${r} multiplier`, 0.1, 10);
  const act = { state: String(v?.act?.state ?? DEFAULT_FREIGHT.act.state).toUpperCase(), region: REGION_TYPES.includes(v?.act?.region) ? v.act.region : DEFAULT_FREIGHT.act.region };
  return { states, regions, large: num(v?.large ?? DEFAULT_FREIGHT.large, 'The large items multiplier', 1, 10), pantone: num(v?.pantone ?? DEFAULT_FREIGHT.pantone, 'The Pantone Living multiplier', 1, 10), act };
}

// ---------- the DEAR reference, and payment ----------
/** "LIS 06082026": the reference the sales team types in DEAR (show name and the order day, no slashes). */
export const dearReference = (refName: string, orderDay: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(orderDay); return `${refName.trim()} ${m ? `${m[3]}${m[2]}${m[1]}` : orderDay}`.replace(/\s+/g, ' ').trim(); };

// ---------- payment ----------
export type Payment = { status: 'cancelled' | 'not_in_dear' | 'not_invoiced' | 'unpaid' | 'part' | 'paid'; label: string; paid: number | null; owing: number | null };
/** Where the payment stands, from the DEAR order Radar found for it: invoiced and what is still due. */
export function paymentOf(stage: string, total: number, invoiced: number | null, due: number | null): Payment {
  if (stage === 'cancelled' || stage === 'voided_in_dear') return { status: 'cancelled', label: 'Cancelled', paid: null, owing: null };
  if (stage === 'draft') return { status: 'not_in_dear', label: 'Not confirmed', paid: null, owing: null };
  if (stage === 'sent') return { status: 'not_in_dear', label: 'Not in DEAR yet', paid: null, owing: null };
  const inv = invoiced ?? 0;
  if (inv <= 0.005) return { status: 'not_invoiced', label: 'Not invoiced yet', paid: 0, owing: total };
  const owing = Math.max(0, due ?? 0), paid = round2(Math.max(0, inv - owing));
  if (owing <= 0.01) return { status: 'paid', label: 'Paid', paid: round2(inv), owing: 0 };
  if (paid <= 0.01) return { status: 'unpaid', label: 'Unpaid', paid: 0, owing: round2(owing) };
  return { status: 'part', label: 'Part paid', paid, owing: round2(owing) };
}
