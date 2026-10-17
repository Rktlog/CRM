// An exact calculator for the assistant. A language model can slip on long arithmetic, so anything beyond a trivial
// sum goes through this instead. It is a small expression evaluator (numbers, + - * / ^, brackets, percent, a list of
// functions). It can't run code: there are no loops, no variables other than ones you name, and no access to anything.
export class CalcError extends Error {}

type Tok = { t: 'num'; v: number } | { t: 'id'; v: string } | { t: 'op'; v: string };
const MAX_LEN = 500, MAX_DEPTH = 60, MAX_ARGS = 200;

function tokenize(src: string): Tok[] {
  const out: Tok[] = []; let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    const num = src.slice(i).match(/^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/);
    if (num) { out.push({ t: 'num', v: Number(num[0]) }); i += num[0].length; continue; }
    const id = src.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (id) { out.push({ t: 'id', v: id[0].toLowerCase() }); i += id[0].length; continue; }
    if ('+-*/^(),%'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue; }
    if (c === '$') { i++; continue; }   // a money sign is just ignored
    throw new CalcError(`I can't read "${c}" in that. Use numbers, + - * / ^, brackets, % and the listed functions.`);
  }
  return out;
}

const finite = (n: number, what: string) => { if (!Number.isFinite(n)) throw new CalcError(`${what} has no sensible answer`); return n; };
// Round half away from zero, the way a till does (1.005 rounds to 1.01), not the way floating point wants to.
export function roundTo(x: number, digits = 0): number {
  const d = Math.trunc(digits);
  if (!Number.isFinite(x) || Math.abs(x) >= 1e15 || d < 0 || d > 12) return d < 0 || d > 12 ? (() => { throw new CalcError('round takes 0 to 12 decimal places'); })() : x;
  const s = Math.sign(x), a = Math.abs(x);
  return s * Number(Math.round(Number(`${a}e${d}`)) + `e-${d}`);
}

const nums = (a: number[], f: string) => { if (!a.length) throw new CalcError(`${f} needs at least one number`); return a; };
const mean = (a: number[]) => nums(a, 'mean').reduce((s, v) => s + v, 0) / a.length;
const variance = (a: number[], sample: boolean) => { const m = mean(a), n = sample ? a.length - 1 : a.length; if (n <= 0) throw new CalcError('standard deviation and variance of one number are not defined for a sample'); return a.reduce((s, v) => s + (v - m) ** 2, 0) / n; };
const median = (a: number[]) => { const s = [...nums(a, 'median')].sort((x, y) => x - y), h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };

// name -> [min args, max args, function]
const FN: Record<string, [number, number, (a: number[]) => number]> = {
  abs: [1, 1, a => Math.abs(a[0])], sqrt: [1, 1, a => { if (a[0] < 0) throw new CalcError('square root of a negative number'); return Math.sqrt(a[0]); }],
  pow: [2, 2, a => a[0] ** a[1]], exp: [1, 1, a => Math.exp(a[0])],
  ln: [1, 1, a => { if (a[0] <= 0) throw new CalcError('ln needs a number above zero'); return Math.log(a[0]); }],
  log: [1, 1, a => { if (a[0] <= 0) throw new CalcError('log needs a number above zero'); return Math.log10(a[0]); }],
  floor: [1, 1, a => Math.floor(a[0])], ceil: [1, 1, a => Math.ceil(a[0])], trunc: [1, 1, a => Math.trunc(a[0])],
  round: [1, 2, a => roundTo(a[0], a[1] ?? 0)], mod: [2, 2, a => { if (a[1] === 0) throw new CalcError('division by zero'); return a[0] - a[1] * Math.floor(a[0] / a[1]); }],
  min: [1, MAX_ARGS, a => Math.min(...a)], max: [1, MAX_ARGS, a => Math.max(...a)], sum: [1, MAX_ARGS, a => a.reduce((s, v) => s + v, 0)], count: [1, MAX_ARGS, a => a.length],
  mean: [1, MAX_ARGS, mean], avg: [1, MAX_ARGS, mean], median: [1, MAX_ARGS, median],
  stdev: [2, MAX_ARGS, a => Math.sqrt(variance(a, true))], stdevp: [1, MAX_ARGS, a => Math.sqrt(variance(a, false))], variance: [2, MAX_ARGS, a => variance(a, true)],
  // sales and finance
  pct: [2, 2, a => { if (a[1] === 0) throw new CalcError('division by zero'); return (a[0] / a[1]) * 100; }],                      // part as a percent of whole
  change: [2, 2, a => { if (a[0] === 0) throw new CalcError('percent change from zero'); return ((a[1] - a[0]) / Math.abs(a[0])) * 100; }],   // percent change, old to new
  cagr: [3, 3, a => { if (a[0] <= 0 || a[2] <= 0) throw new CalcError('cagr needs a start above zero and years above zero'); return (a[1] / a[0]) ** (1 / a[2]) - 1; }],   // yearly growth as a fraction
  pmt: [3, 3, a => (a[0] === 0 ? a[2] / a[1] : (a[2] * a[0]) / (1 - (1 + a[0]) ** -a[1]))],                                           // repayment per period
  exgst: [1, 1, a => a[0] / 1.1], incgst: [1, 1, a => a[0] * 1.1], gst: [1, 1, a => a[0] / 11],                                        // Australian GST at 10%
};
const CONST: Record<string, number> = { pi: Math.PI, e: Math.E };

export function evaluate(src: string, scope: Record<string, number> = {}): number {
  if (typeof src !== 'string' || !src.trim()) throw new CalcError('There is nothing to calculate');
  if (src.length > MAX_LEN) throw new CalcError(`That is longer than ${MAX_LEN} characters. Split it into steps.`);
  const toks = tokenize(src); let p = 0, depth = 0;
  const peek = () => toks[p], isOp = (v: string) => peek()?.t === 'op' && (peek() as { v: string }).v === v;
  const eat = (v: string) => { if (!isOp(v)) throw new CalcError(`Expected "${v}"`); p++; };
  const enter = () => { if (++depth > MAX_DEPTH) throw new CalcError('That is nested too deeply'); }, leave = () => { depth--; };

  const expr = (): number => { enter(); let v = term(); while (isOp('+') || isOp('-')) { const o = (toks[p++] as { v: string }).v; const r = term(); v = o === '+' ? v + r : v - r; } leave(); return v; };
  const term = (): number => { let v = unary(); while (isOp('*') || isOp('/')) { const o = (toks[p++] as { v: string }).v; const r = unary(); if (o === '/' && r === 0) throw new CalcError('division by zero'); v = o === '*' ? v * r : v / r; } return v; };
  const unary = (): number => { enter(); let v: number; if (isOp('-')) { p++; v = -unary(); } else if (isOp('+')) { p++; v = unary(); } else v = power(); leave(); return v; };
  const power = (): number => { const b = postfix(); if (isOp('^')) { p++; return finite(b ** unary(), 'That power'); } return b; };
  const postfix = (): number => { let v = primary(); while (isOp('%')) { p++; v /= 100; } return v; };
  const primary = (): number => {
    const t = toks[p++];
    if (!t) throw new CalcError('That ends too soon');
    if (t.t === 'num') return t.v;
    if (t.t === 'op') { if (t.v === '(') { const v = expr(); eat(')'); return v; } throw new CalcError(`Unexpected "${t.v}"`); }
    if (isOp('(')) {
      const f = FN[t.v]; if (!f) throw new CalcError(`I don't have a function called ${t.v}`);
      p++; const args: number[] = [];
      if (!isOp(')')) { do { args.push(expr()); if (args.length > MAX_ARGS) throw new CalcError('Too many numbers in one function'); } while (isOp(',') && p++ >= 0); }
      eat(')');
      if (args.length < f[0] || args.length > f[1]) throw new CalcError(`${t.v} takes ${f[0] === f[1] ? f[0] : `${f[0]} to ${f[1] === MAX_ARGS ? 'many' : f[1]}`} number${f[1] === 1 ? '' : 's'}`);
      return finite(f[2](args), t.v);
    }
    if (t.v in scope) return scope[t.v];
    if (t.v in CONST) return CONST[t.v];
    throw new CalcError(`I don't know "${t.v}". Name a result earlier in the list to reuse it.`);
  };

  const v = expr();
  if (p < toks.length) throw new CalcError(`Unexpected "${(toks[p] as { v: string | number }).v}"`);
  return Number(finite(v, 'That').toPrecision(12));   // 12 significant digits: no 0.30000000000000004 or 99.99999999999999
}

export type CalcItem = { name?: string; label?: string; expr: string };
export type CalcResult = { label?: string; name?: string; expr: string; result?: number; error?: string };

// A list of calculations, in order. One that names its result lets the next ones use it. A mistake in one does not stop the rest.
export function runCalculations(items: unknown): CalcResult[] {
  if (!Array.isArray(items) || !items.length) throw new CalcError('Give a list of calculations');
  if (items.length > 25) throw new CalcError('Up to 25 calculations at a time');
  const scope: Record<string, number> = {}, out: CalcResult[] = [];
  for (const it of items as CalcItem[]) {
    const expr = String(it?.expr ?? ''), base: CalcResult = { ...(it?.label ? { label: String(it.label).slice(0, 80) } : {}), ...(it?.name ? { name: String(it.name) } : {}), expr };
    try {
      const name = it?.name ? String(it.name).toLowerCase() : null;
      if (name && (!/^[a-z_][a-z0-9_]{0,30}$/.test(name) || name in CONST || name in FN)) throw new CalcError(`"${it.name}" can't be used as a name`);
      const r = Number(evaluate(expr, scope).toPrecision(12));   // 12 significant digits: no 0.30000000000000004
      if (name) scope[name] = r;
      out.push({ ...base, result: r });
    } catch (e) {
      if (!(e instanceof CalcError)) throw e;
      out.push({ ...base, error: e.message });
    }
  }
  return out;
}