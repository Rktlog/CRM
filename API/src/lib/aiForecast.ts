// Sales forecasting for the assistant. A language model should not forecast in its head, so this does it with ordinary
// statistical methods and checks itself: each method is tried on the most recent months it has not seen (a backtest), and
// the one that predicts those best is used. The accuracy of that test comes back with every forecast, so it is clear how
// much to trust it.
//
// It forecasts from what customers ORDERED. It cannot know about a promotion, a new range, a lost customer or a stock-out
// that held orders back, so it says so when history is short or patchy.
export type Confidence = 'High' | 'Medium' | 'Low';
export type Forecast = {
  method: string; forecast: number[]; low: number[]; high: number[];
  wape: number | null;            // backtest error: total miss as a share of what was actually ordered (0.2 = 20% off)
  confidence: Confidence; warnings: string[]; months: number;
};

const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);
const mean = (a: number[]) => (a.length ? sum(a) / a.length : 0);
const std = (a: number[]) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(sum(a.map(v => (v - m) ** 2)) / (a.length - 1)); };
const nonNeg = (a: number[]) => a.map(v => Math.max(0, v));

type Model = (y: number[], h: number, lastMonth: number) => number[];   // lastMonth: 1-12, the calendar month of the last value

// ---- the methods ----
const flat = (k: number): Model => (y, h) => Array(h).fill(mean(y.slice(-k)));

// Straight-line trend through the last 18 months (or fewer), carried forward.
export const ols: Model = (y, h) => {
  const w = y.slice(-18), n = w.length;
  if (n < 3) return Array(h).fill(mean(w));
  const xm = (n - 1) / 2, ym = mean(w);
  let sxy = 0, sxx = 0; w.forEach((v, i) => { sxy += (i - xm) * (v - ym); sxx += (i - xm) ** 2; });
  const b = sxy / sxx, a = ym - b * xm;
  return nonNeg(Array.from({ length: h }, (_, k) => a + b * (n - 1 + k + 1)));
};

// Holt's smoothed trend, damped so a recent run of growth does not run away. The two smoothing weights are chosen by
// which pair predicts the next month best across the history.
export function holtFit(y: number[], alpha: number, beta: number, phi = 0.9): { level: number; trend: number; sse: number; errors: number[] } {
  let l = y[0], b = y.length > 1 ? y[1] - y[0] : 0, sse = 0; const errors: number[] = [];
  for (let t = 1; t < y.length; t++) {
    const f = l + phi * b, e = y[t] - f; sse += e * e; errors.push(e);
    const nl = alpha * y[t] + (1 - alpha) * (l + phi * b);
    b = beta * (nl - l) + (1 - beta) * phi * b; l = nl;
  }
  return { level: l, trend: b, sse, errors };
}
export const holt: Model = (y, h) => {
  if (y.length < 4) return Array(h).fill(mean(y));
  let best = { sse: Infinity, a: 0.3, b: 0.1 };
  for (const a of [0.1, 0.2, 0.3, 0.4, 0.5, 0.7]) for (const b of [0.05, 0.1, 0.2, 0.3]) { const f = holtFit(y, a, b); if (f.sse < best.sse) best = { sse: f.sse, a, b }; }
  const { level, trend } = holtFit(y, best.a, best.b);
  let damp = 0; return nonNeg(Array.from({ length: h }, (_, k) => { damp += 0.9 ** (k + 1); return level + damp * trend; }));
};

// Same level as lately, shaped by how each calendar month usually runs. A month seen only once or twice is trusted a
// little less, so one odd month does not set the pattern. Needs a year and a half of history.
export const seasonal: Model = (y, h, lastMonth) => {
  const n = y.length; if (n < 18) return flat(6)(y, h, lastMonth);
  const monthOf = (i: number) => (((lastMonth - 1 - (n - 1 - i)) % 12) + 12) % 12;   // 0-11: the calendar month of position i
  const from = Math.max(0, n - 36), overall = mean(y.slice(from));
  const total = Array(12).fill(0), cnt = Array(12).fill(0);
  for (let i = from; i < n; i++) { total[monthOf(i)] += y[i]; cnt[monthOf(i)]++; }
  const index = total.map((t, m) => (!cnt[m] || overall <= 0 ? 1 : 1 + (t / cnt[m] / overall - 1) * (cnt[m] / (cnt[m] + 0.3))));
  const plain = y.map((v, i) => v / (index[monthOf(i)] || 1));          // the series with the season taken out
  const level = mean(plain.slice(-12)), prev = n >= 24 ? mean(plain.slice(-24, -12)) : 0;
  const growth = prev > 0 ? Math.min(0.5, Math.max(-0.5, level / prev - 1)) : 0;
  return nonNeg(Array.from({ length: h }, (_, k) => level * (1 + growth) ** ((k + 1) / 12) * index[(lastMonth + k) % 12]));
};

// For items that sell on only some months: the usual size of an order divided by the usual gap between them
// (Croston's method, with the correction that stops it running high).
export const croston: Model = (y, h) => {
  const a = 0.1; let z = 0, p = 1, q = 1, started = false;
  for (const v of y) { if (v > 0) { if (!started) { z = v; p = q; started = true; } else { z = a * v + (1 - a) * z; p = a * q + (1 - a) * p; } q = 1; } else q++; }
  return Array(h).fill(started ? (z / p) * (1 - a / 2) : 0);
};

export const METHODS: { name: string; model: Model; minMonths: number }[] = [
  { name: 'Average of the last 3 months', model: flat(3), minMonths: 3 },
  { name: 'Average of the last 6 months', model: flat(6), minMonths: 6 },
  { name: 'Straight-line trend', model: ols, minMonths: 6 },
  { name: 'Smoothed trend (Holt)', model: holt, minMonths: 8 },
  { name: 'Seasonal pattern', model: seasonal, minMonths: 18 },
  { name: 'Intermittent demand (Croston)', model: croston, minMonths: 6 },
];

export function wape(actual: number[], f: number[]): number | null {
  const t = sum(actual); if (t <= 0) return null;
  return sum(actual.map((a, i) => Math.abs(a - f[i]))) / t;
}

// y: monthly units, oldest first, no gaps. lastMonth: calendar month (1-12) of the final value.
export function forecastSeries(y: number[], h: number, lastMonth: number): Forecast {
  const n = y.length, warnings: string[] = [];
  if (n === 0 || sum(y) <= 0) return { method: 'No sales to go on', forecast: Array(h).fill(0), low: Array(h).fill(0), high: Array(h).fill(0), wape: null, confidence: 'Low', warnings: ['No sales in the period, so the forecast is zero.'], months: n };
  const zeroShare = y.filter(v => v === 0).length / n;
  if (n < 6) warnings.push(`Only ${n} month${n === 1 ? '' : 's'} of history: treat this as a rough guide.`);
  if (zeroShare >= 0.4) warnings.push('Sells in only some months, so any single month is hard to call.');

  const hold = n >= 9 ? Math.min(6, Math.max(3, Math.floor(n / 4))) : 0;
  const candidates: typeof METHODS = METHODS.filter(m => n >= m.minMonths && (m.name.startsWith('Intermittent') ? zeroShare >= 0.3 : true));
  if (!candidates.length) candidates.push({ name: 'Average so far', model: (v, k) => Array(k).fill(mean(v)), minMonths: 1 });   // one or two months of history
  let chosen = candidates[0], bestWape: number | null = null;
  if (hold) {
    const train = y.slice(0, n - hold), test = y.slice(n - hold);
    const lastTrainMonth = ((lastMonth - 1 - hold) % 12 + 12) % 12 + 1;
    let bestScore = Infinity;
    for (const m of candidates) {
      if (train.length < m.minMonths) continue;
      const w = wape(test, m.model(train, hold, lastTrainMonth)); if (w === null) continue;
      if (w < bestScore - 1e-9) { bestScore = w; chosen = m; bestWape = w; }
    }
  } else warnings.push('Too little history to test the forecast against recent months.');
  const point = chosen.model(y, h, lastMonth).map(v => (Number.isFinite(v) ? Math.max(0, v) : 0));

  // The spread: how far one month usually misses its own prediction, widening the further out it goes.
  const resid = n >= 6 ? (() => { const k = Math.min(12, n - 3); const e: number[] = []; for (let t = n - k; t < n; t++) { const f = chosen.model(y.slice(0, t), 1, ((lastMonth - 1 - (n - t)) % 12 + 12) % 12 + 1)[0]; e.push(y[t] - f); } return std(e); })() : std(y);
  const low = point.map((v, k) => Math.max(0, v - 1.28 * resid * Math.sqrt(k + 1))), high = point.map((v, k) => v + 1.28 * resid * Math.sqrt(k + 1));
  const confidence: Confidence = bestWape === null || n < 6 ? 'Low' : bestWape < 0.25 && zeroShare < 0.3 ? 'High' : bestWape < 0.5 ? 'Medium' : 'Low';
  if (bestWape !== null && bestWape >= 0.5) warnings.push('Recent months were hard to predict, so this forecast is uncertain.');
  return { method: chosen.name, forecast: point, low, high, wape: bestWape, confidence, warnings, months: n };
}

// Fills the months a series did not sell, from its first sale to the last full month, so a quiet month counts as zero.
export function fillMonths(points: { month: string; qty: number }[], lastMonth: string): { months: string[]; y: number[] } {
  if (!points.length) return { months: [], y: [] };
  const by = new Map(points.map(p => [p.month, p.qty]));
  const months: string[] = []; let [yy, mm] = points.map(p => p.month).sort()[0].split('-').map(Number);
  const [ly, lm] = lastMonth.split('-').map(Number);
  while (yy < ly || (yy === ly && mm <= lm)) { months.push(`${yy}-${String(mm).padStart(2, '0')}`); mm++; if (mm > 12) { mm = 1; yy++; } }
  return { months, y: months.map(m => by.get(m) ?? 0) };
}
export const addMonths = (ym: string, k: number): string => { const [y, m] = ym.split('-').map(Number); const t = y * 12 + (m - 1) + k; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`; };