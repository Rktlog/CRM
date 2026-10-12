// Periods for the Conversion section: the last N days, a calendar month, or a fiscal quarter.
// The financial year runs 1 July to 30 June and is named for the year it ends in, so
// 1 Jul 2026 to 30 Jun 2027 is FY27. Quarters: Q1 Jul-Sep, Q2 Oct-Dec, Q3 Jan-Mar, Q4 Apr-Jun.
export type Quarter = 1 | 2 | 3 | 4;
export type Period =
  | { kind: 'days'; days: number }
  | { kind: 'month'; ym: string }               // 2026-09
  | { kind: 'quarter'; fy: number; q: Quarter };

export const DEFAULT_PERIOD: Period = { kind: 'days', days: 90 };
const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const lastDay = (y: number, m: number) => new Date(y, m, 0).getDate();   // m is 1-12
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export const fiscalYearOf = (d: Date) => (d.getMonth() >= 6 ? d.getFullYear() + 1 : d.getFullYear());

// The first and last day of a quarter (a quarter of FY27 starts in July 2026).
export function quarterRange(fy: number, q: Quarter): { from: string; to: string } {
  const startMonth = [7, 10, 1, 4][q - 1];
  const startYear = q <= 2 ? fy - 1 : fy;
  const endMonth = startMonth + 2;
  return { from: ymd(startYear, startMonth, 1), to: ymd(startYear, endMonth, lastDay(startYear, endMonth)) };
}
export function monthRange(ym: string): { from: string; to: string } {
  const [y, m] = ym.split('-').map(Number);
  return { from: ymd(y, m, 1), to: ymd(y, m, lastDay(y, m)) };
}

// The text in the dropdown and the link: days:90, month:2026-09, q:2027-1
export const encodePeriod = (p: Period) => (p.kind === 'days' ? `days:${p.days}` : p.kind === 'month' ? `month:${p.ym}` : `q:${p.fy}-${p.q}`);
export function decodePeriod(s: string | null | undefined): Period {
  const v = s ?? '';
  let m;
  if ((m = v.match(/^days:(\d{1,3})$/))) return { kind: 'days', days: Math.min(365, Math.max(7, Number(m[1]))) };
  if ((m = v.match(/^month:(\d{4})-(0[1-9]|1[0-2])$/))) return { kind: 'month', ym: `${m[1]}-${m[2]}` };
  if ((m = v.match(/^q:(\d{4})-([1-4])$/))) return { kind: 'quarter', fy: Number(m[1]), q: Number(m[2]) as Quarter };
  return DEFAULT_PERIOD;
}

// What the API is asked: ?days=90 or ?from=2026-07-01&to=2026-09-30
export function periodQuery(p: Period): string {
  if (p.kind === 'days') return `days=${p.days}`;
  const r = p.kind === 'month' ? monthRange(p.ym) : quarterRange(p.fy, p.q);
  return `from=${r.from}&to=${r.to}`;
}
// Period and states together, as a query string (for the API and the Excel download).
export const conversionQuery = (p: Period, region: string) => `${periodQuery(p)}${region ? `&region=${encodeURIComponent(region)}` : ''}`;

const monthName = (ym: string) => { const [y, m] = ym.split('-').map(Number); return `${MONTHS[m - 1]} ${y}`; };
const quarterText = (fy: number, q: Quarter) => {
  const r = quarterRange(fy, q); const [fromY, fromM] = r.from.split('-').map(Number); const [, toM] = r.to.split('-').map(Number);
  return `FY${String(fy).slice(2)} Q${q} (${MONTHS[fromM - 1].slice(0, 3)}–${MONTHS[toM - 1].slice(0, 3)} ${fromY})`;
};
export function periodLabel(p: Period, now = new Date()): string {
  if (p.kind === 'days') return p.days === 30 ? 'Last 30 days' : p.days === 90 ? 'Last 90 days' : p.days === 180 ? 'Last 6 months' : p.days === 365 ? 'Last 12 months' : `Last ${p.days} days`;
  const range = p.kind === 'month' ? monthRange(p.ym) : quarterRange(p.fy, p.q);
  const today = ymd(now.getFullYear(), now.getMonth() + 1, now.getDate());
  const soFar = range.to > today && range.from <= today ? ', so far' : '';
  return (p.kind === 'month' ? monthName(p.ym) : quarterText(p.fy, p.q)) + soFar;
}

export type PeriodOption = { value: string; label: string };
// Everything the dropdown offers: recent spans, fiscal quarters (this year and three back), and months.
export function periodOptions(now = new Date()): { recent: PeriodOption[]; quarters: PeriodOption[]; months: PeriodOption[] } {
  const today = ymd(now.getFullYear(), now.getMonth() + 1, now.getDate());
  const recent = [30, 90, 180, 365].map(days => ({ value: encodePeriod({ kind: 'days', days }), label: periodLabel({ kind: 'days', days }) }));
  const quarters: PeriodOption[] = [];
  for (let fy = fiscalYearOf(now); fy >= fiscalYearOf(now) - 3; fy--) {
    for (const q of [4, 3, 2, 1] as Quarter[]) {
      if (quarterRange(fy, q).from > today) continue;   // not started yet
      const p: Period = { kind: 'quarter', fy, q };
      quarters.push({ value: encodePeriod(p), label: periodLabel(p, now) });
    }
  }
  const months: PeriodOption[] = [];
  for (let i = 0; i < 18; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const p: Period = { kind: 'month', ym: `${d.getFullYear()}-${pad(d.getMonth() + 1)}` };
    months.push({ value: encodePeriod(p), label: periodLabel(p, now) });
  }
  return { recent, quarters, months };
}