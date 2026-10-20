import { prisma } from './prisma';
import { canSeeAccount } from './territory';
import { DataError } from './aiData';
import { packLines, packOptionsFromEnv, FreightLine, Box } from './freightPacking';
import * as auspost from './auspost';

// The assistant's freight quote: works out what an order (or a list of products) weighs and measures from DEAR's sizes and
// weights, packs it into 60 x 40 x 30 cm cartons (height cut down to fit, 15 kg at most each), and asks Australia Post what each
// service costs for each carton. International (most often New Zealand) or Australian. It never guesses: a product with no weight
// or size is reported so the assistant can ask the person, who then gives them as `overrides`.
type Ctx = { rep: { id: string; role: string }; today: string };
type Dest = { kind: 'international'; code: string; name: string } | { kind: 'domestic'; postcode: string };

const NON_PRODUCT = /freight|shipping|postage|delivery|surcharge|\bfee\b|discount|deposit|credit card|rounding/i;   // lines that are not goods
const AU_STATES = new Set(['NSW', 'ACT', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'NT', 'NSW/HO', 'VIC/HO']);
const MAX_CARTONS = 10;
const money = (n: number) => Math.round(n * 100) / 100;
const sizeOf = (b: { lengthCm: number; widthCm: number; heightCm: number }) => `${b.lengthCm} × ${b.widthCm} × ${b.heightCm} cm`;
const reply = (o: object) => JSON.stringify(o);

type Spec = { name: string | null; weightKg: number | null; lengthCm: number | null; widthCm: number | null; heightCm: number | null };
// DEAR's weight (kg) and size (cm) for each product, saved by the product sync (product-dimensions.sql adds the columns).
async function specsFor(skus: string[]): Promise<{ map: Map<string, Spec>; loaded: boolean }> {
  const map = new Map<string, Spec>();
  if (!skus.length) return { map, loaded: true };
  try {
    const n = (v: unknown) => (v == null ? null : Number(v));
    for (const r of await prisma.$queryRaw<any[]>`select sku, name, weight_kg, length_cm, width_cm, height_cm from crm.products where upper(sku) = any(${skus.map(x => x.toUpperCase())}::text[])`)
      map.set(String(r.sku).toUpperCase(), { name: r.name ?? null, weightKg: n(r.weight_kg), lengthCm: n(r.length_cm), widthCm: n(r.width_cm), heightCm: n(r.height_cm) });
    return { map, loaded: true };
  } catch { return { map, loaded: false }; }
}

function positive(v: unknown, what: string, sku: string): number | undefined {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new DataError(`The ${what} given for ${sku} must be a number above 0`);
  return n;
}

async function destinationOf(input: any, account: { region: string | null; address: string | null } | null): Promise<{ dest?: Dest; ask?: string }> {
  const countryIn = String(input?.country ?? '').trim();
  const postcodeIn = String(input?.postcode ?? '').trim();
  const domestic = (postcode: string | null | undefined): { dest?: Dest; ask?: string } =>
    postcode && /^\d{4}$/.test(postcode) ? { dest: { kind: 'domestic', postcode } } : { ask: 'Ask for the 4-digit Australian postcode to send to.' };
  const fromAddress = () => { const m = /\b(\d{4})\b(?!.*\b\d{4}\b)/s.exec(account?.address ?? ''); return m ? m[1] : null; };
  if (countryIn) {
    const c = await auspost.resolveCountry(countryIn);
    if (!c) return { ask: `"${countryIn}" does not match a country Australia Post sends to. Ask which country, or for its two-letter country code.` };
    return c.code === 'AU' ? domestic(postcodeIn || fromAddress()) : { dest: { kind: 'international', code: c.code, name: c.name } };
  }
  if (postcodeIn) return domestic(postcodeIn);
  if (account) {
    const region = String(account.region ?? '').trim().toUpperCase();
    if (region === 'NZ') return { dest: { kind: 'international', code: 'NZ', name: 'New Zealand' } };
    if (AU_STATES.has(region)) return domestic(fromAddress());
  }
  return { ask: 'Ask which country to send to (most are New Zealand), or the Australian postcode.' };
}

export async function freightQuote(ctx: Ctx, input: any): Promise<string> {
  if (!auspost.configured()) return reply({ status: 'not_set_up', message: 'Australia Post is not set up yet: the AUSPOST_PAC_KEY setting is missing on the server.' });
  const orderRef = String(input?.order ?? '').trim().toUpperCase();
  const itemsIn: any[] = Array.isArray(input?.items) ? input.items : [];
  if (!orderRef && !itemsIn.length) throw new DataError('Give an order number, or the SKUs and quantities to send');

  try {
    // ---- what is being sent
    let raw: { sku: string; name: string; qty: number }[] = [];
    let account: { name: string; region: string | null; address: string | null } | null = null;
    if (orderRef) {
      if (!/^[A-Z]{1,3}-?\d{3,}$/.test(orderRef)) throw new DataError('Give an order number, like SQ37604');
      const [q] = await prisma.$queryRaw<any[]>`
        select q.id, a.id as account_id, a.name as account_name, a.region as account_region, a.rep_id as account_rep_id, a.address as account_address
        from crm.quotes q join crm.accounts a on a.id = q.account_id where upper(q.number) = ${orderRef} order by q.sent_at desc limit 1`;
      if (!q) throw new DataError(`${orderRef} isn't in the CRM`);
      if (!(await canSeeAccount(ctx.rep as any, { id: q.account_id, repId: q.account_rep_id, region: q.account_region } as any))) throw new DataError('That order is outside your states');
      const lines = await prisma.$queryRaw<any[]>`select sku, product_name, quantity::float8 as qty from crm.quote_lines where quote_id = ${q.id}::uuid order by sku limit 300`;
      raw = lines.map(l => ({ sku: String(l.sku).trim(), name: String(l.product_name ?? l.sku), qty: Number(l.qty) }));
      account = { name: q.account_name, region: q.account_region, address: q.account_address };
    } else {
      raw = itemsIn.map((i, n) => {
        const sku = String(i?.sku ?? '').trim(); const qty = Number(i?.quantity ?? i?.qty);
        if (!sku || sku.length > 60) throw new DataError(`Item ${n + 1} needs a SKU`);
        if (!Number.isFinite(qty) || qty <= 0 || qty > 100000) throw new DataError(`Give a quantity above 0 for ${sku}`);
        return { sku, name: sku, qty };
      });
    }
    if (!raw.length) throw new DataError(`${orderRef} has no lines to send`);

    // ---- DEAR's weight and size for each, and anything the person has told us since
    const specs = await specsFor(raw.map(r => r.sku));
    const overrides = new Map<string, { weightKg?: number; lengthCm?: number; widthCm?: number; heightCm?: number }>();
    for (const o of Array.isArray(input?.overrides) ? input.overrides : []) {
      const sku = String(o?.sku ?? '').trim();
      if (!sku) throw new DataError('Each override needs a SKU');
      overrides.set(sku.toUpperCase(), { weightKg: positive(o.weightKg, 'weight', sku), lengthCm: positive(o.lengthCm, 'length', sku), widthCm: positive(o.widthCm, 'width', sku), heightCm: positive(o.heightCm, 'height', sku) });
    }
    const ignored: string[] = [], used: string[] = [];
    const lines: FreightLine[] = [];
    for (const r of raw) {
      const key = r.sku.toUpperCase(); const s = specs.map.get(key); const o = overrides.get(key);
      if (orderRef && !s && !o && NON_PRODUCT.test(r.name)) { ignored.push(r.name); continue; }   // a freight or discount line is not goods
      if (o && Object.values(o).some(v => v != null)) used.push(r.sku);
      lines.push({
        sku: r.sku, name: s?.name ?? r.name, qty: r.qty,
        weightKg: o?.weightKg ?? s?.weightKg ?? null, lengthCm: o?.lengthCm ?? s?.lengthCm ?? null, widthCm: o?.widthCm ?? s?.widthCm ?? null, heightCm: o?.heightCm ?? s?.heightCm ?? null,
      });
    }
    if (!lines.length) throw new DataError(`${orderRef} has no products to send (only fees or freight lines)`);
    const items = lines.map(l => ({ sku: l.sku, name: l.name, qty: l.qty }));

    // ---- where to
    const where = await destinationOf(input, account);
    const opts = packOptionsFromEnv();
    const packed = packLines(lines, opts);

    if (packed.status === 'needs_input' || !where.dest) {
      const asks: string[] = [];
      if (packed.status === 'needs_input') asks.push('These products have no weight and/or size in DEAR. Ask the person for them (the weight in kg and the length, width and height in cm, for ONE unit), then call freight_quote again with the same order or items plus `overrides` for these SKUs. Do not guess.');
      if (!where.dest) asks.push(where.ask ?? 'Ask where to send it.');
      return reply({
        status: 'needs_input', message: asks.join(' '), items,
        ...(packed.status === 'needs_input' ? { missing: packed.missing } : {}),
        ...(!specs.loaded ? { note: 'DEAR weights and sizes have not been loaded into the CRM yet (product-dimensions.sql and the product sync), so every product shows as missing.' } : {}),
      });
    }
    if (packed.status === 'cannot_pack') return reply({ status: 'cannot_pack', message: `These cannot go in a ${opts.boxLengthCm} x ${opts.boxWidthCm} x ${opts.boxHeightCm} cm carton under ${opts.maxKg} kg, so they need a manual quote with Australia Post.`, problems: packed.problems, items });

    const boxes: Box[] = packed.boxes;
    const cartons = boxes.map(b => ({ number: b.number, size: sizeOf(b), weightKg: b.weightKg, contents: b.contents }));
    if (boxes.length > MAX_CARTONS) return reply({ status: 'cannot_quote', message: `It needs ${boxes.length} cartons, too many to quote here (the limit is ${MAX_CARTONS}). Split the order, or ask for a manual quote.`, cartons });

    // ---- what Australia Post charges for each carton, kept to the services that can take every carton
    const dest = where.dest;
    const results: auspost.Service[][] = [];
    for (const b of boxes) results.push(dest.kind === 'international'
      ? await auspost.internationalServices(dest.code, b.weightKg)
      : await auspost.domesticServices({ toPostcode: dest.postcode, lengthCm: b.lengthCm, widthCm: b.widthCm, heightCm: b.heightCm, weightKg: b.weightKg }));
    const quotes = results[0]
      .filter(s => results.every(r => r.some(x => x.code === s.code)))
      .map(s => { const per = results.map(r => r.find(x => x.code === s.code)!.price); return { service: s.name, code: s.code, totalAud: money(per.reduce((a, b) => a + b, 0)), perCartonAud: per.map(money) }; })
      .sort((a, b) => a.totalAud - b.totalAud || a.service.localeCompare(b.service));
    const destText = dest.kind === 'international' ? dest.name : `postcode ${dest.postcode}`;
    if (!quotes.length) return reply({ status: 'cannot_quote', message: `Australia Post offers no service for ${boxes.length === 1 ? `a ${boxes[0].weightKg} kg parcel` : 'these parcels'} to ${destText}. It may be over that country's weight limit.`, cartons });

    const notes = [
      "Prices are Australia Post's published rates from its online calculator, not the Rocket Logistics contract rates, and carry no packing or handling charge.",
      `Packed in ${opts.boxLengthCm} × ${opts.boxWidthCm} × ${opts.boxHeightCm} cm cartons, the height cut down to fit the goods. A carton holds at most ${opts.maxKg} kg including ${opts.tareKg} kg for the carton and packing, and goods are assumed to fill ${Math.round(opts.fill * 100)}% of its volume.`,
      "Weights and sizes are DEAR's, for one unit.",
      dest.kind === 'international' ? "Australia Post's calculator prices international parcels by country and weight only, and gives no delivery times." : '',
      used.length ? `Used the weight and size the person gave for: ${used.join(', ')}.` : '',
      ignored.length ? `Left out lines that are not goods: ${ignored.join(', ')}.` : '',
    ].filter(Boolean);
    return reply({
      status: 'quoted', currency: 'AUD',
      destination: dest.kind === 'international' ? { country: dest.name, code: dest.code } : { australianPostcode: dest.postcode },
      sentFromPostcode: auspost.fromPostcode(), order: orderRef || null, customer: account?.name ?? null,
      cartons, quotes, cheapest: quotes[0], notes,
    });
  } catch (e) {
    if (e instanceof auspost.AusPostError) return reply({ status: 'cannot_quote', message: e.message });
    throw e;
  }
}