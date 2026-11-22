// The "Ellen" monthly sales table: the same layout as Ellen's Dashboard by Month sheet. One row per state group, one column per month, with the
// quarters and the two halves of the financial year (July to June), and three years side by side. Pure sums: the caller passes the sales
// (already counted the Sales Data way, see salesRules.ts) and which row each one belongs to.

export const ELLEN_STATES = ['VIC', 'VIC/HO', 'NSW/HO', 'NSW, ACT', 'QLD', 'NZ', 'WA', 'SA', 'TAS', 'NT', 'Others'] as const;
export const MEEQ = 'MeeQ Custom';
export const TOTAL_WITH = 'TOTAL including MeeQ Custom';
export const TOTAL_WITHOUT = 'TOTAL excluding MeeQ Custom';
export const ELLEN_ROWS = [...ELLEN_STATES, MEEQ, TOTAL_WITH, TOTAL_WITHOUT] as const;

/** Which row an account's state goes in. NSW and ACT share one row; anything unknown or overseas (INTL, Unknown, empty) is "Others". */
export function ellenRowFor(region: string | null | undefined): string {
  const r = (region ?? '').trim().toUpperCase();
  if (r === 'NSW' || r === 'ACT') return 'NSW, ACT';
  const hit = ELLEN_STATES.find(s => s !== 'NSW, ACT' && s !== 'Others' && s.toUpperCase() === r);
  return hit ?? 'Others';
}

export type EllenSale = { amount: number; sentAt: Date; row: string };
export type EllenStatus = 'done' | 'partial' | 'future';
export type EllenBlock = {
  key: string;
  label: string;
  kind: 'month' | 'quarter' | 'half';
  years: number[];                         // the calendar year of each of the three columns, oldest first (a half or quarter shows its first month's year)
  status: EllenStatus;                     // of the newest column: done, running (this month) or not started
  values: Record<string, number[]>;        // row name -> three amounts
  variance: Record<string, number | null>; // newest vs the one before, as a share of the one before. Only when the newest column is finished.
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const r2 = (n: number) => Math.round(n * 100) / 100;

/** The change of the newest figure on the one before it, divided by the one before it (so +100% means it doubled). Null if there is nothing to divide by. */
export function changePct(newest: number, before: number): number | null {
  return before > 0 ? (newest - before) / before : null;
}

/** fy = the year the financial year starts in (2026 = July 2026 to June 2027). The columns are fy-2, fy-1 and fy. */
export function buildEllen(sales: EllenSale[], fy: number, now: Date): { fy: number; fyYears: number[]; rows: string[]; blocks: EllenBlock[] } {
  const fyYears = [fy - 2, fy - 1, fy];
  // sums[row]["calendarYear-month"] (month 0 to 11)
  const sums = new Map<string, Map<string, number>>();
  const add = (row: string, key: string, v: number) => {
    const m = sums.get(row) ?? new Map<string, number>();
    m.set(key, (m.get(key) ?? 0) + v);
    sums.set(row, m);
  };
  for (const s of sales) {
    const key = `${s.sentAt.getFullYear()}-${s.sentAt.getMonth()}`;
    add(s.row, key, s.amount);
    add(TOTAL_WITH, key, s.amount);
    if (s.row !== MEEQ) add(TOTAL_WITHOUT, key, s.amount);
  }
  const calYear = (fyStart: number, month: number) => (month >= 6 ? fyStart : fyStart + 1);
  const monthTotal = (row: string, fyStart: number, month: number) => sums.get(row)?.get(`${calYear(fyStart, month)}-${month}`) ?? 0;
  const statusOf = (fyStart: number, months: number[]): EllenStatus => {
    const cur = now.getFullYear() * 12 + now.getMonth();
    const idx = months.map(m => calYear(fyStart, m) * 12 + m);
    if (idx.every(i => i < cur)) return 'done';
    if (idx.every(i => i > cur)) return 'future';
    return 'partial';
  };
  const make = (key: string, label: string, kind: EllenBlock['kind'], months: number[]): EllenBlock => {
    const values: Record<string, number[]> = {};
    for (const row of ELLEN_ROWS) values[row] = fyYears.map(f => r2(months.reduce((t, m) => t + monthTotal(row, f, m), 0)));
    const status = statusOf(fy, months);
    const variance: Record<string, number | null> = {};
    for (const row of ELLEN_ROWS) variance[row] = kind === 'month' || status !== 'done' ? null : changePct(values[row][2], values[row][1]);
    return { key, label, kind, years: fyYears.map(f => calYear(f, months[0])), status, values, variance };
  };
  const blocks: EllenBlock[] = [];
  const half = (name: string, key: string, quarters: number[][]) => {
    quarters.forEach((qm, qi) => {
      qm.forEach(m => blocks.push(make(`${key}-m${m}`, MONTHS[m], 'month', [m])));
      blocks.push(make(`${key}-q${qi + 1}`, `Q${qi + 1 + (key === 'h2' ? 2 : 0)}`, 'quarter', qm));
    });
    blocks.push(make(key, name, 'half', quarters.flat()));
  };
  half('First half (Jul to Dec)', 'h1', [[6, 7, 8], [9, 10, 11]]);
  half('Second half (Jan to Jun)', 'h2', [[0, 1, 2], [3, 4, 5]]);
  return { fy, fyYears, rows: [...ELLEN_ROWS], blocks };
}
