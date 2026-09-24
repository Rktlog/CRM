import { Router } from 'express';
import { prisma } from '../lib/prisma';

export const reportsRouter = Router();

type Range = '3m' | '6m' | '12m' | 'fy_quarter' | 'fy_year' | 'last_fy_quarter' | 'last_fy_year';

function startOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function addMonths(d: Date, n: number) {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}
function monthLabel(d: Date) {
  return d.toLocaleDateString('en-AU', { month: 'short', year: '2-digit' });
}

// Australian financial year: 1 July - 30 June.
function fyStart(forDate: Date): Date {
  const year = forDate.getMonth() >= 6 ? forDate.getFullYear() : forDate.getFullYear() - 1;
  return new Date(year, 6, 1); // July
}

// Turns a selected calendar year + a "calendar" | "fiscal" toggle
// into a real, bounded window — start AND end, so a past year's
// data can't leak into "this year" the way an unbounded >=
// comparison would. Fiscal treats the selected year as the year the
// FY STARTS in (year=2026 -> FY 2026/27, Jul 2026-Jun 2027) —
// labelled explicitly so which one is shown is never ambiguous.
function getPeriodWindow(year: number, period: 'calendar' | 'fiscal' | 'alltime') {
  if (period === 'alltime') {
    const now = new Date();
    return {
      start: new Date(2000, 0, 1), end: new Date(now.getFullYear() + 1, 0, 1),
      priorStart: new Date(2000, 0, 1), priorEnd: new Date(2000, 0, 1), // no prior period for "all time"
      label: 'All time (to date)', priorLabel: '—',
    };
  }
  if (period === 'calendar') {
    return {
      start: new Date(year, 0, 1), end: new Date(year + 1, 0, 1),
      priorStart: new Date(year - 1, 0, 1), priorEnd: new Date(year, 0, 1),
      label: `${year}`, priorLabel: `${year - 1}`,
    };
  }
  return {
    start: new Date(year, 6, 1), end: new Date(year + 1, 6, 1),
    priorStart: new Date(year - 1, 6, 1), priorEnd: new Date(year, 6, 1),
    label: `FY ${year}/${String(year + 1).slice(2)}`, priorLabel: `FY ${year - 1}/${String(year).slice(2)}`,
  };
}
function fyQuarterStart(forDate: Date): Date {
  const fyStartDate = fyStart(forDate);
  const monthsSinceFyStart = (forDate.getFullYear() - fyStartDate.getFullYear()) * 12 + (forDate.getMonth() - fyStartDate.getMonth());
  const quarterIndex = Math.floor(monthsSinceFyStart / 3);
  return addMonths(fyStartDate, quarterIndex * 3);
}

function resolveRange(range: Range, now: Date) {
  let currentStart: Date, currentEnd: Date, previousStart: Date, previousEnd: Date, bucketMonths: number;

  switch (range) {
    case '3m':
      currentEnd = startOfMonth(addMonths(now, 1));
      currentStart = addMonths(currentEnd, -3);
      previousEnd = currentStart;
      previousStart = addMonths(previousEnd, -3);
      bucketMonths = 1;
      break;
    case '6m':
      currentEnd = startOfMonth(addMonths(now, 1));
      currentStart = addMonths(currentEnd, -6);
      previousEnd = currentStart;
      previousStart = addMonths(previousEnd, -6);
      bucketMonths = 1;
      break;
    case '12m':
      currentEnd = startOfMonth(addMonths(now, 1));
      currentStart = addMonths(currentEnd, -12);
      previousEnd = currentStart;
      previousStart = addMonths(previousEnd, -12);
      bucketMonths = 1;
      break;
    case 'fy_quarter':
      currentStart = fyQuarterStart(now);
      currentEnd = addMonths(currentStart, 3);
      previousStart = addMonths(currentStart, -12);
      previousEnd = addMonths(previousStart, 3);
      bucketMonths = 1;
      break;
    case 'fy_year':
      currentStart = fyStart(now);
      // Whole fiscal year, July through June — not year-to-date. If
      // the current FY isn't finished yet, the remaining months will
      // show as $0 on the chart, which is correct: there's no data
      // there yet, not a comparison error.
      currentEnd = addMonths(currentStart, 12);
      previousStart = addMonths(currentStart, -12);
      previousEnd = currentStart;
      bucketMonths = 1;
      break;
    case 'last_fy_quarter':
      // The most recently COMPLETED quarter, not the in-progress one
      // — useful mid-quarter when "this quarter" is mostly $0 so far.
      currentStart = addMonths(fyQuarterStart(now), -3);
      currentEnd = addMonths(currentStart, 3);
      previousStart = addMonths(currentStart, -12);
      previousEnd = addMonths(previousStart, 3);
      bucketMonths = 1;
      break;
    case 'last_fy_year':
      // The most recently COMPLETED fiscal year, not the current one.
      currentStart = addMonths(fyStart(now), -12);
      currentEnd = fyStart(now);
      previousStart = addMonths(currentStart, -12);
      previousEnd = currentStart;
      bucketMonths = 1;
      break;
  }

  return { currentStart, currentEnd, previousStart, previousEnd, bucketMonths };
}

reportsRouter.get('/sales', async (req, res) => {
  const range = (req.query.range as Range) || '3m';
  if (!['3m', '6m', '12m', 'fy_quarter', 'fy_year', 'last_fy_quarter', 'last_fy_year'].includes(range)) {
    return res.status(400).json({ error: 'Invalid range' });
  }

  const now = new Date();
  const { currentStart, currentEnd, previousStart, previousEnd } = resolveRange(range, now);

  // Same as /ledger — Sales Data is company-wide for every team
  // member, not scoped to "your own accounts." Excludes misc
  // (marketing/warranty) accounts — real transactions, but shouldn't
  // count toward performance.
  const accounts = await prisma.account.findMany({ where: { misc: false }, select: { id: true } });
  const accountIds = accounts.map(a => a.id);

  const quotes = await prisma.quote.findMany({
    where: {
      accountId: { in: accountIds },
      paid: true,
      miscType: null,
      sentAt: { gte: previousStart, lt: currentEnd },
    },
    select: { amount: true, sentAt: true },
  });

  const currentQuotes = quotes.filter(q => q.sentAt >= currentStart && q.sentAt < currentEnd);
  const previousQuotes = quotes.filter(q => q.sentAt >= previousStart && q.sentAt < previousEnd);

  const currentTotal = currentQuotes.reduce((s, q) => s + q.amount, 0);
  const previousTotal = previousQuotes.reduce((s, q) => s + q.amount, 0);
  const changePct = previousTotal > 0 ? Math.round(((currentTotal - previousTotal) / previousTotal) * 100) : null;

  // Month-by-month buckets, current and previous period aligned by
  // relative position (month 1 of this period next to month 1 of the
  // comparison period) so they can be charted side by side.
  const monthCount = Math.round((currentEnd.getFullYear() * 12 + currentEnd.getMonth() - (currentStart.getFullYear() * 12 + currentStart.getMonth())));
  const buckets = [];
  for (let i = 0; i < monthCount; i++) {
    const curMonthStart = addMonths(currentStart, i);
    const curMonthEnd = addMonths(currentStart, i + 1);
    const prevMonthStart = addMonths(previousStart, i);
    const prevMonthEnd = addMonths(previousStart, i + 1);

    const curSum = currentQuotes.filter(q => q.sentAt >= curMonthStart && q.sentAt < curMonthEnd).reduce((s, q) => s + q.amount, 0);
    const prevSum = previousQuotes.filter(q => q.sentAt >= prevMonthStart && q.sentAt < prevMonthEnd).reduce((s, q) => s + q.amount, 0);

    buckets.push({ label: monthLabel(curMonthStart), current: curSum, previous: prevSum });
  }

  // Earliest data actually available, so the frontend can warn if the
  // comparison period reaches back further than real synced history.
  const earliestQuote = await prisma.quote.findFirst({
    where: { accountId: { in: accountIds } },
    orderBy: { sentAt: 'asc' },
    select: { sentAt: true },
  });

  res.json({
    range,
    currentLabel: `${monthLabel(currentStart)} – ${monthLabel(addMonths(currentEnd, -1))}`,
    previousLabel: `${monthLabel(previousStart)} – ${monthLabel(addMonths(previousEnd, -1))}`,
    currentTotal,
    previousTotal,
    changePct,
    buckets,
    earliestDataAt: earliestQuote?.sentAt ?? null,
    comparisonReachesBeforeData: earliestQuote ? previousStart < earliestQuote.sentAt : false,
  });
});

// Manager-only: how much activity each rep has logged recently.
// Not enforced server-side beyond what RLS-equivalent scoping already
// does elsewhere — a non-manager calling this just sees their own row,
// since the underlying activity query is still rep-scoped for them.
reportsRouter.get('/team-activity', async (req, res) => {
  const days = Number(req.query.days) || 7;
  const since = new Date(Date.now() - days * 86400000);
  const isManager = req.rep!.role === 'manager';

  const activities = await prisma.activity.findMany({
    where: {
      occurredAt: { gte: since },
      ...(isManager ? {} : { repId: req.rep!.id }),
    },
    select: { repId: true, type: true, rep: { select: { name: true } } },
  });

  const byRep = new Map<string, { repName: string; calls: number; emails: number; visits: number }>();
  for (const a of activities) {
    const key = a.repId;
    if (!byRep.has(key)) byRep.set(key, { repName: a.rep?.name ?? 'Unknown', calls: 0, emails: 0, visits: 0 });
    const row = byRep.get(key)!;
    if (a.type === 'call') row.calls++;
    else if (a.type === 'email') row.emails++;
    else if (a.type === 'visit') row.visits++;
  }

  const rows = [...byRep.entries()]
    .map(([repId, r]) => ({ repId, ...r, total: r.calls + r.emails + r.visits }))
    .sort((a, b) => b.total - a.total);

  res.json({ days, rows });
});

// Company-wide (or rep-scoped) monthly invoiced trend, real data from
// synced DEAR orders — powers the Sales Data page. Optional ?region=
// filters to accounts in that region (or region group, e.g. multiple
// comma-separated values for "NSW/ACT").
reportsRouter.get('/monthly-trend', async (req, res) => {
  const isManager = req.rep!.role === 'manager';
  const regionParam = req.query.region as string | undefined;
  const regions = regionParam ? regionParam.split(',') : undefined;

  const accountWhere: any = {
    ...(isManager ? {} : { repId: req.rep!.id }),
    ...(regions ? { region: { in: regions } } : {}),
  };
  const accountIds = (await prisma.account.findMany({ where: accountWhere, select: { id: true } })).map(a => a.id);

  const quotes = await prisma.quote.findMany({
    where: { paid: true, accountId: { in: accountIds } },
    select: { sentAt: true, amount: true },
    orderBy: { sentAt: 'asc' },
  });

  const byMonth = new Map<string, number>();
  for (const q of quotes) {
    const key = `${q.sentAt.getFullYear()}-${String(q.sentAt.getMonth() + 1).padStart(2, '0')}`;
    byMonth.set(key, (byMonth.get(key) ?? 0) + q.amount);
  }

  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const trend = [...byMonth.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, total]) => {
      const [year, month] = key.split('-');
      return { label: `${monthNames[Number(month) - 1]} ${year.slice(2)}`, total: Math.round(total * 100) / 100 };
    });

  const totalValue = quotes.reduce((s, q) => s + q.amount, 0);

  res.json({ trend, totalValue: Math.round(totalValue * 100) / 100, totalOrders: quotes.length });
});

// Every rep, for filter dropdowns (settings page, ledger rep filter).
reportsRouter.get('/reps', async (req, res) => {
  const reps = await prisma.rep.findMany({ select: { id: true, name: true, role: true }, orderBy: { name: 'asc' } });
  res.json(reps);
});

// The single comprehensive payload behind the Sales Ledger page —
// covers everything the three source sheets did (Summary_Rhonda's
// quarterly budget tracker + unpaid quotes, Sales Overview's top
// accounts + mix, Marie's invoice-level trend + recent invoices),
// built from real synced DEAR data plus human-entered budget targets.
reportsRouter.get('/ledger', async (req, res) => {
  const isManager = req.rep!.role === 'manager';
  const regionParam = req.query.region as string | undefined;
  const regions = regionParam ? regionParam.split(',') : undefined;
  const requestedRepId = req.query.repId as string | undefined;
  const year = Number(req.query.year) || new Date().getFullYear();
  const period = (['calendar', 'alltime'].includes(req.query.period as string) ? req.query.period : 'fiscal') as 'calendar' | 'fiscal' | 'alltime';
  const window = getPeriodWindow(year, period);

  // Sales Data is intentionally company-wide and the same for every
  // team member, rep or manager — not scoped to "your own accounts"
  // the way the rest of the app is. Anyone can filter to a specific
  // rep's slice via repId; nobody is restricted to only their own.
  const effectiveRepId = requestedRepId || undefined;

  const accountWhere: any = {
    ...(effectiveRepId ? { repId: effectiveRepId } : {}),
    ...(regions ? { region: { in: regions } } : {}),
    misc: false, // marketing/warranty accounts don't count toward performance
  };
  const accounts = await prisma.account.findMany({
    where: accountWhere,
    select: { id: true, name: true, region: true, type: true, spend365: true, stage: true, category: true },
  });
  const accountIds = accounts.map(a => a.id);
  const accountById = new Map(accounts.map(a => [a.id, a]));

  const allQuotes = await prisma.quote.findMany({
    where: { accountId: { in: accountIds }, miscType: null }, // marketing/warranty orders never count toward performance
    orderBy: { sentAt: 'desc' },
  });
  const paidQuotes = allQuotes.filter(q => q.paid);

  // ---- Monthly trend — bounded to the selected year/period window,
  // not all-time, so the chart actually changes when you change year. ----
  const byMonth = new Map<string, number>();
  for (const q of paidQuotes.filter(q => q.sentAt >= window.start && q.sentAt < window.end)) {
    const key = `${q.sentAt.getFullYear()}-${String(q.sentAt.getMonth() + 1).padStart(2, '0')}`;
    byMonth.set(key, (byMonth.get(key) ?? 0) + q.amount);
  }
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const monthlyTrend = [...byMonth.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, total]) => {
      const [y, m] = key.split('-');
      return { label: `${monthNames[Number(m) - 1]} ${y.slice(2)}`, total: Math.round(total * 100) / 100 };
    });

  // ---- Quarterly budget vs actual (calendar quarters, this year vs last) ----
  const targets = effectiveRepId
    ? await prisma.budgetTarget.findMany({ where: { repId: effectiveRepId, year: { in: [year, year - 1] } } })
    : await prisma.budgetTarget.findMany({ where: { year: { in: [year, year - 1] } } });
  const budgetByQuarter = (y: number, q: number) =>
    targets.filter(t => t.year === y && t.quarter === q).reduce((s, t) => s + t.amount, 0);

  // First-ever paid order date per account — for "new business" detection.
  const firstOrderByAccount = new Map<string, Date>();
  for (const q of [...paidQuotes].sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime())) {
    if (!firstOrderByAccount.has(q.accountId)) firstOrderByAccount.set(q.accountId, q.sentAt);
  }

  const quarterMonths = [['Jan','Feb','Mar'],['Apr','May','Jun'],['Jul','Aug','Sep'],['Oct','Nov','Dec']];
  const quarters = [1, 2, 3, 4].map(qn => {
    const qStart = new Date(year, (qn - 1) * 3, 1);
    const qEnd = new Date(year, qn * 3, 1);
    const priorStart = new Date(year - 1, (qn - 1) * 3, 1);
    const priorEnd = new Date(year - 1, qn * 3, 1);

    const inQuarter = paidQuotes.filter(q => q.sentAt >= qStart && q.sentAt < qEnd);
    const inPriorQuarter = paidQuotes.filter(q => q.sentAt >= priorStart && q.sentAt < priorEnd);
    const invoicedCurrent = inQuarter.reduce((s, q) => s + q.amount, 0);
    const invoicedPrior = inPriorQuarter.reduce((s, q) => s + q.amount, 0);
    const budget = budgetByQuarter(year, qn);

    const newAccountIds = new Set(
      [...firstOrderByAccount.entries()].filter(([, d]) => d >= qStart && d < qEnd).map(([id]) => id)
    );
    const newBusinessValue = inQuarter.filter(q => newAccountIds.has(q.accountId)).reduce((s, q) => s + q.amount, 0);

    return {
      quarter: `Q${qn}`,
      months: quarterMonths[qn - 1],
      budget: Math.round(budget * 100) / 100,
      pctToBudget: budget > 0 ? invoicedCurrent / budget : null,
      invoicedCurrent: Math.round(invoicedCurrent * 100) / 100,
      invoicedPrior: Math.round(invoicedPrior * 100) / 100,
      varianceDollar: Math.round((invoicedCurrent - invoicedPrior) * 100) / 100,
      variancePct: invoicedPrior > 0 ? (invoicedCurrent - invoicedPrior) / invoicedPrior : null,
      newBusinessCount: newAccountIds.size,
      newBusinessValue: Math.round(newBusinessValue * 100) / 100,
    };
  });

  // ---- Unpaid quotes to chase ----
  const unpaidQuotes = allQuotes
    .filter(q => !q.paid)
    .map(q => ({
      order: q.number,
      date: q.sentAt.toISOString().slice(0, 10),
      stockist: accountById.get(q.accountId)?.name ?? 'Unknown',
      amount: q.amount,
      status: q.fulfillmentStatus ?? 'Awaiting payment',
    }));

  // ---- Top accounts, selected period vs prior period ----
  const topAccounts = accounts
    .map(a => {
      const acctQuotes = paidQuotes.filter(q => q.accountId === a.id);
      const fyCurrent = acctQuotes.filter(q => q.sentAt >= window.start && q.sentAt < window.end).reduce((s, q) => s + q.amount, 0);
      const fyPrior = acctQuotes.filter(q => q.sentAt >= window.priorStart && q.sentAt < window.priorEnd).reduce((s, q) => s + q.amount, 0);
      return { customer: a.name, region: a.region, type: a.type, fyPrior: Math.round(fyPrior*100)/100, fyCurrent: Math.round(fyCurrent*100)/100 };
    })
    .filter(a => a.fyCurrent > 0 || a.fyPrior > 0)
    .sort((a, b) => b.fyCurrent - a.fyCurrent)
    .slice(0, 50);

  // ---- Mix: new vs existing in the selected period, and region mix
  // (stands in for the spreadsheet's business-category mix in one
  // remaining place; category itself is now tracked properly below) ----
  let newCount = 0, newValue = 0, existingCount = 0, existingValue = 0;
  for (const a of accounts) {
    const acctQuotesThisPeriod = paidQuotes.filter(q => q.accountId === a.id && q.sentAt >= window.start && q.sentAt < window.end);
    if (acctQuotesThisPeriod.length === 0) continue;
    const value = acctQuotesThisPeriod.reduce((s, q) => s + q.amount, 0);
    const firstOrder = firstOrderByAccount.get(a.id);
    if (firstOrder && firstOrder >= window.start) { newCount++; newValue += value; }
    else { existingCount++; existingValue += value; }
  }
  const typeBreakdown = [
    { type: `New in ${window.label}`, count: newCount, total: Math.round(newValue*100)/100 },
    { type: 'Existing', count: existingCount, total: Math.round(existingValue*100)/100 },
  ];

  const regionTotals = new Map<string, number>();
  for (const q of paidQuotes.filter(q => q.sentAt >= window.start && q.sentAt < window.end)) {
    const region = accountById.get(q.accountId)?.region ?? 'Unknown';
    regionTotals.set(region, (regionTotals.get(region) ?? 0) + q.amount);
  }
  const regionBreakdown = [...regionTotals.entries()]
    .map(([region, total]) => ({ region, total: Math.round(total*100)/100 }))
    .sort((a, b) => b.total - a.total);

  // ---- Category breakdown — real data from DEAR's AdditionalAttribute1
  // field (e.g. "Gift and concept stores", "Toy", "Pharmacy"). Accounts
  // synced before this field was found show as "Uncategorized" until
  // backfill-region-and-category.ts has run for them. ----
  const categoryTotals = new Map<string, number>();
  for (const q of paidQuotes.filter(q => q.sentAt >= window.start && q.sentAt < window.end)) {
    const category = (accountById.get(q.accountId) as any)?.category || 'Uncategorized';
    categoryTotals.set(category, (categoryTotals.get(category) ?? 0) + q.amount);
  }
  const categoryBreakdown = [...categoryTotals.entries()]
    .map(([category, total]) => ({ category, total: Math.round(total*100)/100 }))
    .sort((a, b) => b.total - a.total);

  // ---- SKU and brand breakdown — this FY, real line-item data ----
  const thisFyQuoteIds = paidQuotes.filter(q => q.sentAt >= window.start && q.sentAt < window.end).map(q => q.id);
  const lines = thisFyQuoteIds.length
    ? await prisma.quoteLine.findMany({ where: { quoteId: { in: thisFyQuoteIds } } })
    : [];

  const skuTotals = new Map<string, { productName: string; quantity: number; total: number }>();
  const brandTotals = new Map<string, number>();
  for (const l of lines) {
    const existing = skuTotals.get(l.sku) ?? { productName: l.productName, quantity: 0, total: 0 };
    existing.quantity += l.quantity;
    existing.total += l.lineTotal;
    skuTotals.set(l.sku, existing);
    const brand = l.brand || 'Unbranded';
    brandTotals.set(brand, (brandTotals.get(brand) ?? 0) + l.lineTotal);
  }
  const skuBreakdown = [...skuTotals.entries()]
    .map(([sku, v]) => ({ sku, productName: v.productName, quantity: v.quantity, total: Math.round(v.total*100)/100 }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 50);
  const brandBreakdown = [...brandTotals.entries()]
    .map(([brand, total]) => ({ brand, total: Math.round(total*100)/100 }))
    .sort((a, b) => b.total - a.total);

  // ---- Recent invoices (most recent 100, paid or not) ----
  const recentInvoices = allQuotes.slice(0, 100).map(q => ({
    invoice: q.number,
    date: q.sentAt.toISOString().slice(0, 10),
    customer: accountById.get(q.accountId)?.name ?? 'Unknown',
    region: accountById.get(q.accountId)?.region ?? 'Unknown',
    amount: q.amount,
    paid: q.paid,
  }));

  // Stat cards now respect the same selected window as everything
  // else on the page — a real "Total invoiced" for whatever
  // region/rep/period is picked, not an unconditional all-time sum
  // regardless of filters. Pick period=alltime to genuinely see
  // everything to date.
  const windowedQuotes = paidQuotes.filter(q => q.sentAt >= window.start && q.sentAt < window.end);
  const accountsWithActivity = new Set(windowedQuotes.map(q => q.accountId)).size;

  res.json({
    totalValue: Math.round(windowedQuotes.reduce((s, q) => s + q.amount, 0) * 100) / 100,
    totalOrders: windowedQuotes.length,
    accountsWithActivity,
    period,
    periodLabel: window.label,
    priorPeriodLabel: window.priorLabel,
    monthlyTrend,
    quarters,
    unpaidQuotes,
    topAccounts,
    typeBreakdown,
    regionBreakdown,
    categoryBreakdown,
    skuBreakdown,
    brandBreakdown,
    recentInvoices,
    accountsTracked: accounts.length,
  });
});
