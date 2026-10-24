import { prisma } from './prisma';
import { hiddenAccountIds, assignedRegions } from './territory';
import { NOT_A_SALE, isHistoryOrder, salesOf } from './salesRules';
import { isOwing } from './orderSource';

// The rep's "Summary" sheet, as the team's Summary_Rhonda sheet lays it out: a financial year in two halves (July to December, January
// to June) with budget, percentage to budget, invoiced sales this year and last, variance, quotes awaiting payment and new and
// reactivated stockists; the quarter table; and the unpaid quotes. Shown to reps on Sales Data and downloadable by managers from Reports.
//
// The numbers are the ones Sales Data counts, by the same rules (salesRules.ts): invoiced sales on the tax invoice date, goods ex GST,
// the rep's states, accounts a manager hid or marked marketing/warranty left out. The cells are worked out here, with the sheet's own
// formulas, so the page and the Excel file show exactly the same thing.

export type SheetMonth = { key: string; label: string; budget: number; prior: number; current: number; awaiting: number; newReactivated: number };
export type UnpaidRow = { order: string; orderId: string; accountId: string; date: string; stockist: string; total: number; month: string };
export type SheetRaw = { fy: number; regions: string[]; months: SheetMonth[]; unpaid: UnpaidRow[]; budgetSource: 'months' | 'quarters' | 'none' };
export type Cell = { v: string | number | null; f?: string };
export type Block = {
  heading: string[]; budget: number[]; pctToBudget: (number | null)[]; priorLabel: string; prior: number[]; currentLabel: string; current: number[];
  varDollar: number[]; varPct: (number | null)[]; awaiting: number[]; newReactivated: number[];
};
export type SheetModel = {
  fy: number; regions: string[]; title: string; blocks: [Block, Block];
  quarters: { q: string; budget: number; invoiced: number; gap: number; newCount: number }[];
  totalBudget: number; totalInvoiced: number; totalGap: number; totalNew: number; numberToBudget: number;
  note: { quarter: number; text: string } | null;
  unpaid: UnpaidRow[]; unpaidTotal: number; budgetSource: SheetRaw['budgetSource'];
  cells: Record<string, Cell>;
};

const r2 = (n: number) => Math.round(n * 100) / 100;
const pad = (n: number) => String(n).padStart(2, '0');
const MONTHS3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;   // the same grouping Sales Data uses
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const STATE_ORDER = ['NSW', 'ACT', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'NT', 'NZ'];

export const currentFy = (today: string) => (Number(today.slice(5, 7)) >= 7 ? Number(today.slice(0, 4)) : Number(today.slice(0, 4)) - 1);

// The 12 months of a financial year starting July of `fy`, and the same months a year earlier.
export function fyMonths(fy: number) {
  return Array.from({ length: 12 }, (_, i) => {
    const m = (6 + i) % 12;
    const y = fy + (6 + i >= 12 ? 1 : 0);
    return { key: `${y}-${pad(m + 1)}`, priorKey: `${y - 1}-${pad(m + 1)}`, month3: MONTHS3[m], label: MONTHS3[m].toUpperCase() };
  });
}

// What it costs to go through every order of the rep's states once. regions is the rep's states (rep_regions).
export async function loadSheetRaw(opts: { repId: string; regions: string[]; fy: number }): Promise<SheetRaw> {
  const { repId, regions, fy } = opts;
  const fm = fyMonths(fy);
  const current = new Map<string, number>(), awaiting = new Map<string, number>(), newR = new Map<string, number>();
  let unpaid: UnpaidRow[] = [];

  if (regions.length) {
    const hidden = await hiddenAccountIds(repId);
    const accounts = await prisma.account.findMany({
      where: { region: { in: regions }, misc: false, ...(hidden.length ? { id: { notIn: hidden } } : {}) },
      select: { id: true, name: true },
    });
    const nameOf = new Map(accounts.map(a => [a.id, a.name]));
    const quotes = accounts.length
      ? await prisma.quote.findMany({ where: { accountId: { in: accounts.map(a => a.id) }, miscType: null }, orderBy: { sentAt: 'desc' } })
      : [];

    // Invoiced sales, by the tax invoice's month (goods ex GST, credit notes taken off), as on Sales Data.
    for (const s of salesOf(quotes)) current.set(monthKey(s.sentAt), (current.get(monthKey(s.sentAt)) ?? 0) + s.amount);

    // Unpaid quotes (live orders with a balance), by order date. The sheet adds them up by the month's name, whatever the year.
    unpaid = quotes.filter(q => isOwing(q)).map(q => {
      const date = q.sentAt.toISOString().slice(0, 10);
      return { order: q.number, orderId: q.id, accountId: q.accountId, date, stockist: nameOf.get(q.accountId) ?? 'Unknown', total: r2(q.amountDue ?? q.amount), month: MONTHS3[Number(date.slice(5, 7)) - 1] };
    }).sort((a, b) => a.date.localeCompare(b.date) || a.order.localeCompare(b.order));
    for (const u of unpaid) awaiting.set(u.month.toUpperCase(), (awaiting.get(u.month.toUpperCase()) ?? 0) + u.total);

    // New and reactivated stockists, on the order date: an account's first order ever, or its first after more than 12 months without one.
    const real = quotes.filter(q => isHistoryOrder(q) || !NOT_A_SALE.includes((q.fulfillmentStatus ?? '').toUpperCase()));
    const days = new Map<string, Map<string, Date>>();
    for (const q of real) {
      const m = days.get(q.accountId) ?? new Map<string, Date>();
      if (!m.has(dayKey(q.sentAt))) m.set(dayKey(q.sentAt), q.sentAt);
      days.set(q.accountId, m);
    }
    for (const m of days.values()) {
      const sorted = [...m.values()].sort((a, b) => a.getTime() - b.getTime());
      sorted.forEach((d, i) => {
        const yearBefore = new Date(d.getFullYear() - 1, d.getMonth(), d.getDate());
        if (i === 0 || sorted[i - 1] < yearBefore) newR.set(monthKey(d), (newR.get(monthKey(d)) ?? 0) + 1);
      });
    }
  }

  // Budget: a figure for each month if one has been set (crm.budget_months), otherwise the quarterly targets from Settings spread over
  // their three months in proportion to what was invoiced in those months last year.
  let budget: number[] = fm.map(() => 0);
  let source: SheetRaw['budgetSource'] = 'none';
  try {
    const rows = await prisma.$queryRaw<{ month: number; amount: number }[]>`select month, amount::float8 as amount from crm.budget_months where rep_id = ${repId}::uuid and year = ${fy}`;
    if (rows.length) {
      const by = new Map<number, number>(rows.map(r => [Number(r.month), Number(r.amount)] as [number, number]));
      budget = fm.map(m => by.get(MONTHS3.indexOf(m.month3) + 1) ?? 0);
      source = 'months';
    }
  } catch { /* crm.budget_months has not been created yet */ }
  if (source === 'none') {
    const targets = await prisma.budgetTarget.findMany({ where: { repId, year: fy } });
    if (targets.length) {
      const priorOf = (i: number) => current.get(fm[i].priorKey) ?? 0;
      for (let q = 0; q < 4; q++) {
        const amount = targets.filter(t => t.quarter === q + 1).reduce((s, t) => s + t.amount, 0);
        const idx = [q * 3, q * 3 + 1, q * 3 + 2];
        const basis = idx.map(priorOf).reduce((s, x) => s + Math.max(0, x), 0);
        const share = (i: number) => (basis > 0 ? amount * Math.max(0, priorOf(i)) / basis : amount / 3);
        budget[idx[0]] = r2(share(idx[0]));
        budget[idx[1]] = r2(share(idx[1]));
        budget[idx[2]] = r2(amount - budget[idx[0]] - budget[idx[1]]);   // the last month takes the rounding, so the quarter adds back to its target exactly
      }
      source = 'quarters';
    }
  }

  return {
    fy, regions, budgetSource: source, unpaid,
    months: fm.map((m, i) => ({
      key: m.key, label: m.label, budget: r2(budget[i]), prior: r2(current.get(m.priorKey) ?? 0), current: r2(current.get(m.key) ?? 0),
      awaiting: r2(awaiting.get(m.label) ?? 0), newReactivated: newR.get(m.key) ?? 0,
    })),
  };
}

// ---- the sheet itself: the same rows, columns and formulas as Summary_Rhonda ----
const COLS = ['B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];   // JUL AUG SEP Q1 OCT NOV DEC Q2 H1 TOTAL
const col9 = (m: number[]) => { const q1 = r2(m[0] + m[1] + m[2]), q2 = r2(m[3] + m[4] + m[5]); return [m[0], m[1], m[2], q1, m[3], m[4], m[5], q2, r2(q1 + q2)]; };

function blockOf(raw: SheetRaw, half: 0 | 1): Block {
  const ms = raw.months.slice(half * 6, half * 6 + 6);
  const budget = col9(ms.map(m => m.budget)), prior = col9(ms.map(m => m.prior)), current = col9(ms.map(m => m.current));
  const varDollar = current.map((c, i) => r2(c - prior[i]));
  return {
    heading: half === 0 ? ['JUL', 'AUG', 'SEP', 'Q1', 'OCT', 'NOV', 'DEC', 'Q2', 'H1 TOTAL'] : ['JAN', 'FEB', 'MAR', 'Q3', 'APR', 'MAY', 'JUN', 'Q4', 'H2 TOTAL'],
    budget, pctToBudget: current.map((c, i) => (budget[i] !== 0 ? c / budget[i] : null)),
    priorLabel: String(raw.fy - 1 + half), prior, currentLabel: String(raw.fy + half), current,
    varDollar, varPct: varDollar.map((v, i) => (prior[i] !== 0 ? v / prior[i] : null)),
    awaiting: col9(ms.map(m => m.awaiting)), newReactivated: col9(ms.map(m => m.newReactivated)),
  };
}

export const sheetTitle = (regions: string[], fy: number) => {
  const sorted = [...regions].sort((a, b) => (STATE_ORDER.indexOf(a) + 100 * +(STATE_ORDER.indexOf(a) < 0)) - (STATE_ORDER.indexOf(b) + 100 * +(STATE_ORDER.indexOf(b) < 0)) || a.localeCompare(b));
  return `"${sorted.join(' / ') || 'No states'} FY ${fy}/${fy + 1}"`;   // the sheet's title has its quote marks
};

export function buildModel(raw: SheetRaw, today: string): SheetModel {
  const blocks: [Block, Block] = [blockOf(raw, 0), blockOf(raw, 1)];
  const quarters = [{ b: 0, i: 3 }, { b: 0, i: 7 }, { b: 1, i: 3 }, { b: 1, i: 7 }].map(({ b, i }, n) => {
    const bl = blocks[b];
    return { q: `Q${n + 1}`, budget: bl.budget[i], invoiced: bl.current[i], gap: r2(bl.budget[i] - bl.current[i]), newCount: bl.newReactivated[i] };
  });
  const totalBudget = r2(blocks[0].budget[8] + blocks[1].budget[8]), totalInvoiced = r2(blocks[0].current[8] + blocks[1].current[8]);
  const totalNew = quarters.reduce((s, q) => s + q.newCount, 0);

  // The note beside the quarter table: how far the latest finished quarter got (the quarter now, until one has finished).
  const nowMonth = today.slice(0, 7);
  const qMonths = (n: number) => raw.months.slice(n * 3, n * 3 + 3).map(m => m.key);
  const finished = [0, 1, 2, 3].filter(n => qMonths(n)[2] < nowMonth && quarters[n].budget > 0);
  const running = [0, 1, 2, 3].filter(n => qMonths(n)[0] <= nowMonth && nowMonth <= qMonths(n)[2] && quarters[n].budget > 0);
  const pick = finished.length ? finished[finished.length - 1] : running[0];
  const note = pick === undefined ? null : (() => {
    const pct = (quarters[pick].invoiced / quarters[pick].budget) * 100;
    return { quarter: pick + 1, text: `Q${pick + 1} is ${pct.toFixed(2)}% to budget PLAN — approximately ${Math.round(pct)}%.` };
  })();

  const unpaidTotal = r2(raw.unpaid.reduce((s, u) => s + u.total, 0));
  const model: SheetModel = {
    fy: raw.fy, regions: raw.regions, title: sheetTitle(raw.regions, raw.fy), blocks, quarters, totalBudget, totalInvoiced, totalGap: r2(totalBudget - totalInvoiced),
    totalNew, numberToBudget: r2(totalBudget - totalInvoiced), note, unpaid: raw.unpaid, unpaidTotal, budgetSource: raw.budgetSource, cells: {},
  };
  model.cells = sheetCells(model);
  return model;
}

// Every cell of the sheet by its address, with the sheet's own formula where it has one (the value is what the formula comes to).
export function sheetCells(m: SheetModel): Record<string, Cell> {
  const c: Record<string, Cell> = {};
  const put = (addr: string, v: Cell['v'], f?: string) => { c[addr] = f ? { v, f } : { v }; };
  put('A1', m.title);
  const rangeLast = Math.max(32, 31 + m.unpaid.length);
  [0, 1].forEach(half => {
    const b = m.blocks[half], r = half === 0 ? 2 : 12;   // the header row of this half
    const rowBudget = r + 1, rowPct = r + 2, rowPrior = r + 3, rowCur = r + 4, rowVar = r + 5, rowVarPct = r + 6, rowAwait = r + 7, rowNew = r + 8;
    put(`A${r}`, 'MONTH'); b.heading.forEach((h, i) => put(`${COLS[i]}${r}`, h));
    put(`A${rowBudget}`, 'Projected Budget forecast'); put(`A${rowPct}`, 'Percentage to Budget forecast Plan');
    put(`A${rowPrior}`, `Invoiced Sales ${b.priorLabel}`); put(`A${rowCur}`, `Invoiced Sales ${b.currentLabel}`);
    put(`A${rowVar}`, 'Variance ($) YOY'); put(`A${rowVarPct}`, 'Variance (%) YOY'); put(`A${rowAwait}`, 'Quotes - Awaiting Payment');
    put(`A${rowNew}`, 'New & Reactivated Stockist\n(based on order date of that month)');
    COLS.forEach((L, i) => {
      const monthCol = i !== 3 && i !== 7 && i !== 8;
      const sums = (row: number) => i === 3 ? `=SUM(B${row}:D${row})` : i === 7 ? `=SUM(F${row}:H${row})` : `=E${row}+I${row}`;
      put(`${L}${rowBudget}`, b.budget[i], monthCol ? undefined : sums(rowBudget));
      put(`${L}${rowPct}`, b.pctToBudget[i], `=${L}${rowCur}/${L}${rowBudget}`);
      put(`${L}${rowPrior}`, b.prior[i], monthCol ? undefined : sums(rowPrior));
      put(`${L}${rowCur}`, b.current[i], monthCol ? undefined : sums(rowCur));
      put(`${L}${rowVar}`, b.varDollar[i], `=${L}${rowCur}-${L}${rowPrior}`);
      put(`${L}${rowVarPct}`, b.varPct[i], `=${L}${rowVar}/${L}${rowPrior}`);
      put(`${L}${rowAwait}`, b.awaiting[i], monthCol ? `=SUMIFS($D$32:$D$5000,$E$32:$E$5000,${L}$${r})` : sums(rowAwait));
      put(`${L}${rowNew}`, b.newReactivated[i], monthCol ? undefined : sums(rowNew));
    });
  });
  put('E11', '** Check orders paid and didnt go out for this Q');
  put('G22', 'Budget '); put('H22', 'Invoiced'); put('I22', 'Gap'); put('J22', 'New'); put('K22', 'Value');
  const src = [['E3', 'E6', 'E10'], ['I3', 'I6', 'I10'], ['E13', 'E16', 'E20'], ['I13', 'I16', 'I20']];
  m.quarters.forEach((q, n) => {
    const row = 23 + n;
    put(`F${row}`, q.q); put(`G${row}`, q.budget, `=${src[n][0]}`); put(`H${row}`, q.invoiced, `=${src[n][1]}`);
    put(`I${row}`, q.gap, `=G${row}-H${row}`); put(`J${row}`, q.newCount, `=${src[n][2]}`);
  });
  if (m.note) put(`L${22 + m.note.quarter}`, m.note.text);
  put('F27', 'Total Budget Forecast Target '); put('G27', m.totalBudget, '=J3+J13'); put('H27', m.totalInvoiced, '=J6+J16');
  put('I27', m.totalGap, '=G27-H27'); put('J27', m.totalNew, '=SUM(J23:J26)');
  put('G29', 'Number to Budget '); put('H29', m.numberToBudget, '=G27-H27');
  put('A30', 'UNPAID QUOTES (formulated)'); put('C30', 'Total'); put('D30', m.unpaidTotal, `=SUM(D32:D${rangeLast})`);
  ['New Order #', 'Order Date', 'Stockist', 'Total', 'Month'].forEach((h, i) => put(`${'ABCDE'[i]}31`, h));
  m.unpaid.forEach((u, i) => {
    const row = 32 + i, [y, mo, d] = u.date.split('-');
    put(`A${row}`, u.order); put(`B${row}`, `${Number(d)} ${MONTHS3[Number(mo) - 1]} ${y}`); put(`C${row}`, u.stockist); put(`D${row}`, u.total); put(`E${row}`, u.month);
  });
  return c;
}

// ---- who it is for ----
export async function summarySheet(opts: { repId: string; fy: number; today: string }): Promise<SheetModel> {
  const regions = await assignedRegions(opts.repId);
  return buildModel(await loadSheetRaw({ repId: opts.repId, regions, fy: opts.fy }), opts.today);
}