// Packs an order into cartons for a freight quote. Pure: no database, no AusPost, so it can be tested on its own.
//
// The rules (from the team):
//   - One carton size: 60 x 40 x 30 cm. When the goods do not fill it, only the HEIGHT is cut down to fit (the 60 x 40 base stays).
//   - A carton holds at most 15 kg, counting the carton and packing (tareKg) as well as the goods.
//   - If it does not fit in one carton, the rest goes in more cartons, each cut down the same way.
//   - Goods are assumed to fill 80% of a carton's volume (soft toys squash, rigid pieces waste space), and each item can be turned
//     any way up, so a flat item lies flat.
//   - A product with no weight or no size is never guessed: the caller is told which, to ask for them.
export type FreightLine = { sku: string; name: string; qty: number; weightKg: number | null; lengthCm: number | null; widthCm: number | null; heightCm: number | null };
export type PackOptions = { boxLengthCm: number; boxWidthCm: number; boxHeightCm: number; maxKg: number; tareKg: number; fill: number; minHeightCm: number };
export const DEFAULT_PACK: PackOptions = { boxLengthCm: 60, boxWidthCm: 40, boxHeightCm: 30, maxKg: 15, tareKg: 0.5, fill: 0.8, minHeightCm: 5 };

// The defaults, with the three that can be changed on the server: FREIGHT_MAX_KG, FREIGHT_TARE_KG, FREIGHT_FILL (0 to 1).
export function packOptionsFromEnv(env: Record<string, string | undefined> = process.env): PackOptions {
  const num = (k: string, d: number, min: number) => { const n = Number(env[k]); return env[k] != null && env[k] !== '' && Number.isFinite(n) && n >= min ? n : d; };
  return { ...DEFAULT_PACK, maxKg: num('FREIGHT_MAX_KG', DEFAULT_PACK.maxKg, 0.1), tareKg: num('FREIGHT_TARE_KG', DEFAULT_PACK.tareKg, 0), fill: Math.min(num('FREIGHT_FILL', DEFAULT_PACK.fill, 0.1), 1) };
}

export type Box = { number: number; lengthCm: number; widthCm: number; heightCm: number; weightKg: number; contents: { sku: string; name: string; qty: number }[] };
export type PackResult =
  | { status: 'packed'; boxes: Box[] }
  | { status: 'needs_input'; missing: { sku: string; name: string; qty: number; needs: ('weight' | 'size')[] }[] }
  | { status: 'cannot_pack'; problems: { sku: string; name: string; reason: string }[] };

const EPS = 1e-9;
const pos = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const trim = (n: number) => String(Math.round(n * 100) / 100);

export function packLines(input: FreightLine[], opts: PackOptions = DEFAULT_PACK): PackResult {
  const { boxLengthCm: L, boxWidthCm: W, boxHeightCm: H } = opts;
  // The same product on two lines is one line.
  const bySku = new Map<string, FreightLine>();
  for (const l of input) {
    const qty = Math.ceil(Number(l.qty));
    if (!(qty > 0)) continue;   // nothing ordered, nothing to send
    const have = bySku.get(l.sku);
    if (have) have.qty += qty; else bySku.set(l.sku, { ...l, qty });
  }
  const lines = [...bySku.values()];

  const missing = lines.flatMap(l => {
    const needs: ('weight' | 'size')[] = [];
    if (!pos(l.weightKg)) needs.push('weight');
    if (!pos(l.lengthCm) || !pos(l.widthCm) || !pos(l.heightCm)) needs.push('size');
    return needs.length ? [{ sku: l.sku, name: l.name, qty: l.qty, needs }] : [];
  });
  if (missing.length) return { status: 'needs_input', missing };

  // Each item may be turned any way up: its smallest side goes up, then the middle side across, the longest along.
  const items = lines.map(l => {
    const [a, b, c] = [l.lengthCm!, l.widthCm!, l.heightCm!].sort((x, y) => x - y);
    return { l, a, b, c, v: a * b * c, w: l.weightKg! };
  });
  const problems: { sku: string; name: string; reason: string }[] = [];
  for (const i of items) {
    if (i.a > H + EPS || i.b > W + EPS || i.c > L + EPS) problems.push({ sku: i.l.sku, name: i.l.name, reason: `one is ${trim(i.c)} x ${trim(i.b)} x ${trim(i.a)} cm, which does not fit a ${L} x ${W} x ${H} cm carton` });
    else if (i.w + opts.tareKg > opts.maxKg + EPS) problems.push({ sku: i.l.sku, name: i.l.name, reason: `one weighs ${trim(i.w)} kg, over the ${trim(opts.maxKg)} kg limit once the carton is counted` });
  }
  if (problems.length) return { status: 'cannot_pack', problems };

  // Biggest first, into the first carton with room (volume and weight), else a new one. Whole runs of identical units at a time.
  const capacity = opts.fill * L * W * H;
  type Open = { vol: number; kg: number; minSide: number; contents: Map<string, { name: string; qty: number }> };
  const open: Open[] = [];
  for (const i of [...items].sort((x, y) => y.v - x.v || y.w - x.w || x.l.sku.localeCompare(y.l.sku))) {
    let left = i.l.qty;
    const put = (box: Open, n: number) => {
      box.vol += n * i.v; box.kg += n * i.w; box.minSide = Math.max(box.minSide, i.a);
      const c = box.contents.get(i.l.sku) ?? { name: i.l.name, qty: 0 }; c.qty += n; box.contents.set(i.l.sku, c);
      left -= n;
    };
    for (const box of open) {
      if (left <= 0) break;
      const byVolume = box.vol === 0 ? 1 + Math.max(0, Math.floor((capacity - i.v + EPS) / i.v)) : Math.floor((capacity - box.vol + EPS) / i.v);
      const byWeight = Math.floor((opts.maxKg - box.kg + EPS) / i.w);
      const n = Math.min(left, byVolume, byWeight);
      if (n > 0) put(box, n);
    }
    while (left > 0) {
      const box: Open = { vol: 0, kg: opts.tareKg, minSide: 0, contents: new Map() };
      open.push(box);
      const byVolume = 1 + Math.max(0, Math.floor((capacity - i.v + EPS) / i.v));
      const byWeight = Math.floor((opts.maxKg - box.kg + EPS) / i.w);
      put(box, Math.max(1, Math.min(left, byVolume, byWeight)));   // every unit was checked to fit on its own, so this always moves on
    }
  }

  const boxes: Box[] = open.map((b, idx) => ({
    number: idx + 1,
    lengthCm: L,
    widthCm: W,
    // Cut down: tall enough for the tallest item lying its flattest way and for the volume at the fill allowance, never over H.
    heightCm: Math.min(H, Math.max(opts.minHeightCm, Math.ceil(Math.max(b.minSide, b.vol / opts.fill / (L * W)) - EPS))),
    weightKg: Math.ceil(b.kg * 100 - EPS) / 100,
    contents: [...b.contents.entries()].map(([sku, c]) => ({ sku, name: c.name, qty: c.qty })).sort((x, y) => x.sku.localeCompare(y.sku)),
  }));
  return { status: 'packed', boxes };
}