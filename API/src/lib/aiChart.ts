// Charts for the assistant, drawn as plain SVG: bar, column, stacked column, line and pie. SVG is only drawing
// instructions, shown in the chat as an image, so nothing in it can run. Every piece of text in it is escaped.
export class ChartError extends Error {}
export type ChartType = 'column' | 'bar' | 'stacked_column' | 'line' | 'pie';
export type ChartSpec = {
  type: ChartType; title?: string; labels: string[]; series: { name: string; values: (number | null)[] }[];
  xLabel?: string; yLabel?: string; format?: 'number' | 'money' | 'percent'; decimals?: number;
};

const PALETTE = ['#2a7f7f', '#d9962b', '#b5553a', '#3b5b92', '#5f9e4a', '#8a5a9c', '#7d8790', '#c2688d', '#8f7a2e', '#46a0c9', '#a35d5d', '#4f4f8a'];   // 12, so a pie of ten slices never repeats a colour
const FONT = "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const trunc = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const W = 800, H = 440;

// "Nice" axis steps: 1, 2, 5 times a power of ten.
export function niceTicks(min: number, max: number, target = 6): { ticks: number[]; lo: number; hi: number } {
  if (min === max) { max = min + (min === 0 ? 1 : Math.abs(min) * 0.1); }
  const raw = (max - min) / Math.max(1, target - 1), mag = 10 ** Math.floor(Math.log10(raw)), f = raw / mag;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * mag;
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step, ticks: number[] = [];
  for (let v = lo; v <= hi + step / 1000; v += step) ticks.push(Math.round(v / step * 1e6) / 1e6 * step);
  return { ticks, lo, hi };
}

export function fmtValue(v: number, f: ChartSpec['format'] = 'number', decimals?: number): string {
  const d = decimals ?? (Math.abs(v) >= 100 || Number.isInteger(v) ? 0 : 2);
  const body = Math.abs(v).toLocaleString('en-AU', { minimumFractionDigits: f === 'money' && decimals === undefined ? 0 : 0, maximumFractionDigits: f === 'percent' ? Math.min(1, d || 1) : d });
  return f === 'percent' ? `${v < 0 ? '-' : ''}${body}%` : f === 'money' ? `${v < 0 ? '-' : ''}$${body}` : `${v < 0 ? '-' : ''}${body}`;
}
const fmtAxis = (v: number, f: ChartSpec['format']): string => {
  const a = Math.abs(v), sign = v < 0 ? '-' : '', pre = f === 'money' ? '$' : '', post = f === 'percent' ? '%' : '';
  if (a >= 1e6) return `${sign}${pre}${+(a / 1e6).toFixed(1)}M${post}`;
  if (a >= 1e4) return `${sign}${pre}${+(a / 1e3).toFixed(1)}k${post}`;
  return `${sign}${pre}${a.toLocaleString('en-AU', { maximumFractionDigits: a < 10 && !Number.isInteger(a) ? 2 : 0 })}${post}`;
};

export function checkSpec(s: ChartSpec): ChartSpec {
  if (!['column', 'bar', 'stacked_column', 'line', 'pie'].includes(s.type)) throw new ChartError('type must be column, bar, stacked_column, line or pie');
  if (!Array.isArray(s.labels) || !s.labels.length) throw new ChartError('A chart needs labels, for example the months or brands along the bottom');
  if (!Array.isArray(s.series) || !s.series.length) throw new ChartError('A chart needs at least one series of numbers');
  if (s.labels.length > 60) throw new ChartError('That is more than 60 points. Group it (by month or brand) or show the top few.');
  if (s.series.length > 8 && s.type !== 'pie') throw new ChartError('That is more than 8 series. Show the top few.');
  for (const x of s.series) if (!Array.isArray(x.values) || x.values.length !== s.labels.length) throw new ChartError(`The series "${x.name}" has ${Array.isArray(x.values) ? x.values.length : 0} values but there are ${s.labels.length} labels. They must match.`);
  const clean: ChartSpec = { ...s, labels: s.labels.map(String), series: s.series.map(x => ({ name: String(x.name ?? ''), values: x.values.map(v => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v))) })) };
  if (clean.series.every(x => x.values.every(v => v === null))) throw new ChartError('There are no numbers to draw');
  return clean;
}

const textW = (t: string, size = 12) => t.length * size * 0.56;   // a rough width, enough to leave room for labels

export function renderChart(input: ChartSpec): string {
  const s = checkSpec(input), title = s.title ?? '';
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}" role="img" aria-label="${esc(title || 'Chart')}">`);
  out.push(`<title>${esc(title || 'Chart')}</title><rect width="${W}" height="${H}" fill="#ffffff"/>`);
  if (title) out.push(`<text x="${W / 2}" y="28" text-anchor="middle" font-size="17" font-weight="700" fill="#1f2937">${esc(trunc(title, 90))}</text>`);
  const top = title ? 52 : 24;

  if (s.type === 'pie') {
    const vals = s.series[0].values.map(v => Math.max(0, v ?? 0));
    let items = s.labels.map((l, i) => ({ label: l, v: vals[i] })).filter(x => x.v > 0).sort((a, b) => b.v - a.v);
    if (!items.length) throw new ChartError('A pie chart needs positive numbers');
    if (items.length > 10) { const rest = items.slice(9).reduce((t, x) => t + x.v, 0); items = [...items.slice(0, 9), { label: 'Other', v: rest }]; }
    const total = items.reduce((t, x) => t + x.v, 0), cx = 250, cy = top + (H - top - 20) / 2, r = Math.min(150, (H - top - 40) / 2);
    let a0 = -Math.PI / 2;
    items.forEach((it, i) => {
      const a1 = a0 + (it.v / total) * Math.PI * 2, large = a1 - a0 > Math.PI ? 1 : 0, col = PALETTE[i % PALETTE.length];
      if (items.length === 1) out.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${col}"/>`);
      else out.push(`<path d="M${cx},${cy} L${(cx + r * Math.cos(a0)).toFixed(2)},${(cy + r * Math.sin(a0)).toFixed(2)} A${r},${r} 0 ${large} 1 ${(cx + r * Math.cos(a1)).toFixed(2)},${(cy + r * Math.sin(a1)).toFixed(2)} Z" fill="${col}" stroke="#fff" stroke-width="2"/>`);
      const ly = top + 6 + i * 26; out.push(`<rect x="470" y="${ly}" width="14" height="14" rx="2" fill="${col}"/><text x="492" y="${ly + 12}" font-size="13" fill="#374151">${esc(trunc(it.label, 26))}  <tspan fill="#6b7280">${fmtValue(it.v, s.format, s.decimals)} (${Math.round((it.v / total) * 1000) / 10}%)</tspan></text>`);
      a0 = a1;
    });
    out.push('</svg>'); return out.join('');
  }

  // axes for column, bar, stacked column and line
  const horizontal = s.type === 'bar', stacked = s.type === 'stacked_column', n = s.labels.length;
  const sums = s.labels.map((_, i) => s.series.reduce((t, x) => t + Math.max(0, x.values[i] ?? 0), 0));
  const negs = s.labels.map((_, i) => s.series.reduce((t, x) => t + Math.min(0, x.values[i] ?? 0), 0));
  const all = s.series.flatMap(x => x.values).filter((v): v is number => v !== null);
  const dMax = stacked ? Math.max(...sums) : Math.max(...all), dMin = stacked ? Math.min(0, ...negs) : Math.min(...all);
  const { ticks, lo, hi } = niceTicks(Math.min(0, dMin), Math.max(0, dMax));
  const legendH = s.series.length > 1 ? 26 : 0, labelBox = horizontal ? Math.min(180, Math.max(...s.labels.map(l => textW(trunc(l, 24)))) + 14) : 0;
  const left0 = (horizontal ? labelBox + 14 : Math.max(...ticks.map(t => textW(fmtAxis(t, s.format), 11))) + 28) + (s.yLabel && !horizontal ? 16 : 0), right = 24;
  const band0 = (W - left0 - right) / n, longest = Math.max(...s.labels.map(l => textW(trunc(l, 14), 11.5)));
  const rot = !horizontal && longest > band0 * 0.9;                                  // only when the labels would run into each other
  const cut = rot ? 16 : 14, left = rot ? Math.max(left0, 118 - band0 / 2) : left0;   // a slanted label reaches back to the left, so leave room
  const bottomPad = (horizontal ? 36 : 12) + (s.xLabel && !horizontal ? 22 : 0), plotTop = top + legendH, plotBottom = H - bottomPad - (horizontal ? 0 : rot ? 70 : 28), px0 = left, px1 = W - right;
  const sx = (v: number) => px0 + ((v - lo) / (hi - lo)) * (px1 - px0), sy = (v: number) => plotBottom - ((v - lo) / (hi - lo)) * (plotBottom - plotTop);

  if (legendH) { let x = px0; s.series.forEach((se, i) => { out.push(`<rect x="${x}" y="${top + 4}" width="12" height="12" rx="2" fill="${PALETTE[i % PALETTE.length]}"/><text x="${x + 17}" y="${top + 14}" font-size="12.5" fill="#374151">${esc(trunc(se.name, 22))}</text>`); x += 17 + textW(trunc(se.name, 22), 12.5) + 20; }); }
  for (const t of ticks) {
    if (horizontal) { const x = sx(t); out.push(`<line x1="${x.toFixed(1)}" y1="${plotTop}" x2="${x.toFixed(1)}" y2="${plotBottom}" stroke="${t === 0 ? '#9ca3af' : '#e5e7eb'}"/><text x="${x.toFixed(1)}" y="${plotBottom + 16}" text-anchor="middle" font-size="11" fill="#6b7280">${esc(fmtAxis(t, s.format))}</text>`); }
    else { const y = sy(t); out.push(`<line x1="${px0}" y1="${y.toFixed(1)}" x2="${px1}" y2="${y.toFixed(1)}" stroke="${t === 0 ? '#9ca3af' : '#e5e7eb'}"/><text x="${px0 - 6}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#6b7280">${esc(fmtAxis(t, s.format))}</text>`); }
  }
  const showValues = s.series.length === 1 && n <= 14 && s.type !== 'line';
  if (horizontal) {
    const band = (plotBottom - plotTop) / n, gap = band * 0.2, bh = (band - gap) / s.series.length;
    s.labels.forEach((l, i) => {
      out.push(`<text x="${px0 - 8}" y="${(plotTop + band * i + band / 2 + 4).toFixed(1)}" text-anchor="end" font-size="12" fill="#374151">${esc(trunc(l, 24))}</text>`);
      s.series.forEach((se, k) => { const v = se.values[i]; if (v === null) return; const x0 = sx(0), x1 = sx(v), y = plotTop + band * i + gap / 2 + bh * k;
        out.push(`<rect x="${Math.min(x0, x1).toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(1, Math.abs(x1 - x0)).toFixed(1)}" height="${bh.toFixed(1)}" rx="2" fill="${PALETTE[k % PALETTE.length]}"/>`);
        if (showValues) out.push(`<text x="${(v >= 0 ? x1 + 5 : x1 - 5).toFixed(1)}" y="${(y + bh / 2 + 4).toFixed(1)}" text-anchor="${v >= 0 ? 'start' : 'end'}" font-size="11.5" fill="#374151">${esc(fmtValue(v, s.format, s.decimals))}</text>`); });
    });
  } else if (s.type === 'line') {
    const xAt = (i: number) => px0 + ((i + 0.5) / n) * (px1 - px0);   // centred in its slot, so the first and last points are not on the edge
    s.series.forEach((se, k) => {
      const col = PALETTE[k % PALETTE.length]; let d = '', pen = false;
      se.values.forEach((v, i) => { if (v === null) { pen = false; return; } d += `${pen ? 'L' : 'M'}${xAt(i).toFixed(1)},${sy(v).toFixed(1)} `; pen = true; });
      out.push(`<path d="${d.trim()}" fill="none" stroke="${col}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`);
      if (n <= 36) se.values.forEach((v, i) => { if (v !== null) out.push(`<circle cx="${xAt(i).toFixed(1)}" cy="${sy(v).toFixed(1)}" r="3.2" fill="${col}"/>`); });
    });
    s.labels.forEach((l, i) => { if (n > 24 && i % Math.ceil(n / 24) !== 0) return; const x = xAt(i), y = plotBottom + 16; out.push(rot ? `<text transform="translate(${x.toFixed(1)},${y}) rotate(-35)" text-anchor="end" font-size="11.5" fill="#374151">${esc(trunc(l, cut))}</text>` : `<text x="${x.toFixed(1)}" y="${y}" text-anchor="middle" font-size="11.5" fill="#374151">${esc(trunc(l, cut))}</text>`); });
  } else {
    const band = (px1 - px0) / n, gap = band * 0.22, bw = stacked ? band - gap : (band - gap) / s.series.length;
    s.labels.forEach((l, i) => {
      let pos = 0, neg = 0;
      s.series.forEach((se, k) => {
        const v = se.values[i]; if (v === null) return; const col = PALETTE[k % PALETTE.length];
        let y0: number, y1: number, x = px0 + band * i + gap / 2 + (stacked ? 0 : bw * k);
        if (stacked) { if (v >= 0) { y0 = sy(pos); y1 = sy(pos + v); pos += v; } else { y0 = sy(neg); y1 = sy(neg + v); neg += v; } } else { y0 = sy(0); y1 = sy(v); }
        out.push(`<rect x="${x.toFixed(1)}" y="${Math.min(y0, y1).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, Math.abs(y1 - y0)).toFixed(1)}" rx="2" fill="${col}"/>`);
        if (showValues) out.push(`<text x="${(x + bw / 2).toFixed(1)}" y="${(v >= 0 ? Math.min(y0, y1) - 5 : Math.max(y0, y1) + 14).toFixed(1)}" text-anchor="middle" font-size="11.5" fill="#374151">${esc(fmtValue(v, s.format, s.decimals))}</text>`);
      });
      const cx = px0 + band * i + band / 2, y = plotBottom + 16;
      out.push(rot ? `<text transform="translate(${cx.toFixed(1)},${y}) rotate(-35)" text-anchor="end" font-size="11.5" fill="#374151">${esc(trunc(l, cut))}</text>` : `<text x="${cx.toFixed(1)}" y="${y}" text-anchor="middle" font-size="11.5" fill="#374151">${esc(trunc(l, cut))}</text>`);
    });
  }
  if (s.yLabel && !horizontal) out.push(`<text transform="translate(14,${((plotTop + plotBottom) / 2).toFixed(1)}) rotate(-90)" text-anchor="middle" font-size="12" fill="#6b7280">${esc(trunc(s.yLabel, 40))}</text>`);
  if (s.xLabel) out.push(`<text x="${((px0 + px1) / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="12" fill="#6b7280">${esc(trunc(s.xLabel, 60))}</text>`);
  out.push('</svg>');
  return out.join('');
}

// A table of rows (from a data set or a report) turned into a chart spec: one column for the labels and one or more for
// the numbers, or "long" data pivoted so each value of seriesColumn becomes its own series.
export function specFromRows(o: {
  rows: Record<string, unknown>[]; type: ChartType; title?: string; labelColumn: string; valueColumns?: string[]; seriesColumn?: string; valueColumn?: string;
  sortBy?: 'value' | 'label' | 'none'; top?: number; format?: ChartSpec['format']; xLabel?: string; yLabel?: string; labelOf?: (c: string) => string;
}): ChartSpec {
  const { rows } = o; if (!rows.length) throw new ChartError('There is no data to chart');
  const num = (v: unknown) => { const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[$,%\s]/g, '')); return Number.isFinite(n) ? n : null; };
  const label = (r: Record<string, unknown>) => String(r[o.labelColumn] ?? '');
  if (!(o.labelColumn in rows[0])) throw new ChartError(`There is no column "${o.labelColumn}". The columns are: ${Object.keys(rows[0]).join(', ')}`);
  let labels: string[], series: ChartSpec['series'];
  if (o.seriesColumn) {
    const vc = o.valueColumn ?? o.valueColumns?.[0]; if (!vc) throw new ChartError('Say which column holds the numbers (valueColumn)');
    if (!(vc in rows[0])) throw new ChartError(`There is no column "${vc}". The columns are: ${Object.keys(rows[0]).join(', ')}`);
    const ls = [...new Set(rows.map(label))], ss = [...new Set(rows.map(r => String(r[o.seriesColumn!] ?? '')))];
    const cell = new Map<string, number>(); for (const r of rows) { const k = `${label(r)}\u0000${String(r[o.seriesColumn!] ?? '')}`; cell.set(k, (cell.get(k) ?? 0) + (num(r[vc]) ?? 0)); }
    labels = ls; series = ss.map(sn => ({ name: sn, values: ls.map(l => cell.get(`${l}\u0000${sn}`) ?? 0) }));
  } else {
    const cs = o.valueColumns && o.valueColumns.length ? o.valueColumns : o.valueColumn ? [o.valueColumn] : []; if (!cs.length) throw new ChartError('Say which column or columns hold the numbers (valueColumns)');
    for (const c of cs) if (!(c in rows[0])) throw new ChartError(`There is no column "${c}". The columns are: ${Object.keys(rows[0]).join(', ')}`);
    labels = rows.map(label); series = cs.map(c => ({ name: o.labelOf ? o.labelOf(c) : c, values: rows.map(r => num(r[c])) }));
  }
  const order = labels.map((_, i) => i);
  if (o.sortBy === 'value' || (o.sortBy === undefined && o.type !== 'line' && o.type !== 'stacked_column')) order.sort((a, b) => series.reduce((t, x) => t + (x.values[b] ?? 0), 0) - series.reduce((t, x) => t + (x.values[a] ?? 0), 0));
  else if (o.sortBy === 'label') order.sort((a, b) => labels[a].localeCompare(labels[b], undefined, { numeric: true }));
  let keep = order; const top = Math.floor(Number(o.top)) || (o.type === 'pie' ? 10 : 40);
  if (keep.length > top) keep = keep.slice(0, top);
  if (series.length > 8 && o.type !== 'pie') { const tot = series.map(x => x.values.reduce((t: number, v) => t + (v ?? 0), 0)), idx = tot.map((_, i) => i).sort((a, b) => tot[b] - tot[a]); const keepS = idx.slice(0, 7), rest = idx.slice(7); series = [...keepS.map(i => series[i]), { name: 'Other', values: labels.map((_, li) => rest.reduce((t, i) => t + (series[i].values[li] ?? 0), 0)) }]; }
  return { type: o.type, title: o.title, labels: keep.map(i => labels[i]), series: series.map(x => ({ name: x.name, values: keep.map(i => x.values[i]) })), format: o.format, xLabel: o.xLabel, yLabel: o.yLabel };
}