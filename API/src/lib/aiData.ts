import { prisma } from './prisma';
import { territoryWhere } from './territory';
import { openQuotes, toShip, unpaidInvoices, balances, filterFollowUp, melDay } from './receivables';
import { readTable, parseNumber, kindOf, TableError, Attachment, Table } from './aiFiles';
import { forecastSeries, fillMonths, addMonths } from './aiForecast';
import { parseParams, priceItem, comparePrices, assumptions, PriceError, PriceParams, Supplier, Ours } from './aiPricing';
import { pickPrice, WHOLESALE, RETAIL } from './pricing';
// (the helpers object below also lets a test swap the pieces that talk to other parts of the app)

// Everything saved in the CRM that the assistant may read, as named data sets. Each one reuses the same code (and the
// same territory rule) the matching screen uses, so the assistant never sees more than the person asking could open
// themselves, and its numbers match the screens. Nothing here can change anything.
// The only things never read: DEAR keys, private keys, and Google sign-in details (the saved tokens). Everything else
// the app shows is here, under the same rules the app uses: emails and marketing history on a customer are visible to
// whoever can see that customer, campaigns and contact lists are for managers, and a calendar is only ever your own.
export class DataError extends Error {}
export type Col = { key: string; label: string };
export type DataResult = { columns: Col[]; rows: Record<string, unknown>[]; summary?: Record<string, unknown> };
export type DataCtx = { rep: { id: string; role: string }; today: string; attachments?: Attachment[] };
type Dataset = { key: string; blurb: string; args: string; run: (ctx: DataCtx, a: Record<string, any>) => Promise<DataResult> };

// The helpers from the other parts of the app, in one place so a test can swap them. The credit and conversion ones are
// loaded only when used.
export const helpers = {
  balances, unpaidInvoices, toShip, openQuotes,
  loadHeld: async (...a: any[]) => (await import('../routes/credit')).loadHeld(...(a as [any, any, any])),
  loadCreditNotes: async (...a: any[]) => (await import('../routes/credit')).loadCreditNotes(...(a as [any, any, any])),
  loadReservations: async (...a: any[]) => (await import('../routes/credit')).loadReservations(...(a as [any, any])),
  // The signed-in person's own Google Calendar, read the same way the Planner reads it. The sign-in itself stays inside that code.
  calendar: async (repId: string, fromDay: string, toDay: string): Promise<{ connected: boolean; shown: boolean; events: any[] }> => {
    const g = await import('../lib/googleCalendar');
    const rep = await prisma.rep.findUnique({ where: { id: repId }, select: { calendarShow: true } });
    const conn = g.calendarConfigured() ? await g.connectionOf(repId) : null;
    if (!conn || conn.status !== 'ok') return { connected: false, shown: false, events: [] };
    if (!rep?.calendarShow) return { connected: true, shown: false, events: [] };
    const min = new Date(`${fromDay}T00:00:00+10:00`); min.setDate(min.getDate() - 1);
    const max = new Date(`${toDay}T23:59:59+10:00`); max.setDate(max.getDate() + 1);
    const items = await g.listEvents(repId, min.toISOString(), max.toISOString());
    return { connected: true, shown: true, events: items };
  },
  conversion: async (rep: { id: string; role: string }, a: Record<string, any>) => {
    const m = await import('../routes/conversion');
    let period; try { period = m.parsePeriod({ days: a.days, from: a.from, to: a.to }); } catch (e) { throw new DataError((e as Error).message); }
    return { period, result: await m.computeConversion(rep, { from: period.from, to: period.to, regions: regionsFrom(a.state) }) };
  },
};

const cents = (n: number) => Math.round(n * 100) / 100;
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const lc = (v: unknown) => text(v).toLowerCase();
const clip = (s: string | null | undefined, n = 300) => (s && s.length > n ? `${s.slice(0, n)}…` : s ?? null);
const day = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
const sum = (rows: any[], k: string) => cents(rows.reduce((s, r) => s + (Number(r[k]) || 0), 0));
const count = (rows: any[], k: string) => rows.reduce((m: Record<string, number>, r) => { const key = String(r[k] ?? 'Unknown'); m[key] = (m[key] ?? 0) + 1; return m; }, {});
const cols = (...c: string[]): Col[] => c.map(x => { const [key, label] = x.split(':'); return { key, label: label ?? key }; });
export function regionsFrom(v: unknown): string[] | undefined {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [];
  const out = list.map(x => String(x).trim().toUpperCase()).filter(Boolean);
  return out.length ? out : undefined;
}
const nameHas = (v: unknown, q: unknown) => !text(q) || String(v ?? '').toLowerCase().includes(lc(q));
const like = (v: unknown) => (text(v) ? `%${text(v)}%` : null);
// The customers this person can open: null for a manager (all of them), otherwise their states' accounts.
export async function visibleIds(rep: { id: string; role: string }): Promise<string[] | null> {
  if (rep.role === 'manager') return null;
  return (await prisma.account.findMany({ where: await territoryWhere(rep as any), select: { id: true } })).map((a: { id: string }) => a.id);
}
export const managersOnly = (ctx: { rep: { role: string } }, what: string) => { if (ctx.rep.role !== 'manager') throw new DataError(`${what} are for managers`); };

// ---- supplier lists and pricing (used by the price data sets) ----
const PRICE_ARGS = "params (an object: currency and fxRate (AUD per 1 unit), freightPct, dutyPct, otherPct, freightPerUnit, costIncludesGst, gstPct (default 10), wholesaleMarginPct (our margin on the wholesale price, e.g. 45) OR wholesaleMarkupPct (markup on landed cost), retailerMarginPct (the shop's margin on the RRP ex GST, default 50), rrpRounding (.95, .99, .50, 0.05, 1 or none; default .95), rrpDirection (up, nearest, down; default up), wholesaleRounding (default 0.05), wholesaleDirection (default nearest)); the supplier lines either as items [{sku, name, cost, currency, rrp, barcode}] or from an attached file with file, sheet and columns {sku, cost, name, barcode, currency, rrp} (column headings; found automatically when left out)";
async function wrapPricing<T>(f: () => Promise<T>): Promise<T> {
  try { return await f(); }
  catch (e) { if (e instanceof PriceError || e instanceof TableError) throw new DataError(e.message); throw e; }
}
function tableFor(ctx: DataCtx, a: Record<string, any>): Table {
  const all = ctx.attachments ?? [], want = lc(a.file);
  const pool = want ? all.filter(x => x.name.toLowerCase().includes(want)) : all.filter(x => ['sheet', 'text'].includes(kindOf(x) ?? ''));
  if (!pool.length) throw new DataError(want ? `No attached file matches "${text(a.file)}". Attached: ${all.map(x => x.name).join(', ') || 'nothing'}.` : 'No spreadsheet or CSV is attached. Attach one, or give the items yourself.');
  return readTable(pool[0], text(a.sheet) || undefined);
}
function findColumn(headers: string[], want: unknown, role: string): string {
  const w = lc(want), exact = headers.find(h => h.toLowerCase() === w); if (exact) return exact;
  const part = headers.filter(h => h.toLowerCase().includes(w)); if (part.length === 1) return part[0];
  throw new DataError(`Which column is the ${role}? "${text(want)}" doesn't match one. The columns are: ${headers.join(', ')}.`);
}
const GUESS: Record<string, RegExp> = { sku: /^(sku|item\s*(no|code|number)?|product\s*code|code|part\s*(no|number)?|ref(erence)?|article|style)$/i, barcode: /ean|upc|gtin|barcode/i, name: /desc|name|title|product$/i, currency: /^(currency|cur|ccy)$/i, rrp: /rrp|retail|msrp|recommended/i };
const COST_GOOD = /cost|buy|net|trade|wholesale|unit\s*price|price/i, COST_BAD = /rrp|retail|msrp|recommended|total|extended|qty|quantity|gst|tax/i;
// The supplier's lines: from items given directly, or read from the attached list, with the columns found or named.
function supplierRows(ctx: DataCtx, a: Record<string, any>): { rows: Supplier[]; notes: string[] } {
  const notes: string[] = [];
  if (Array.isArray(a.items) && a.items.length) {
    if (a.items.length > 500) throw new DataError('Up to 500 items at a time when they are given directly. For more, attach the list as a spreadsheet.');
    const rows = (a.items as any[]).map((it, i): Supplier => ({ row: i + 1, sku: it?.sku != null ? String(it.sku).trim() || null : null, barcode: it?.barcode != null ? String(it.barcode).trim() || null : null, name: it?.name != null ? String(it.name) : null, cost: parseNumber(it?.cost), currency: it?.currency ? String(it.currency).toUpperCase() : undefined, rrp: it?.rrp != null ? parseNumber(it.rrp) : null }));
    const bad = rows.filter(r => Number.isNaN(r.cost) || r.cost < 0); if (bad.length) throw new DataError(`Item ${bad[0].row} has no usable cost${bad.length > 1 ? ` (and ${bad.length - 1} more)` : ''}.`);
    return { rows, notes };
  }
  const t = tableFor(ctx, a), m = (a.columns && typeof a.columns === 'object' ? a.columns : {}) as Record<string, unknown>, h = t.headers;
  const pick = (role: string, required: boolean): string | null => {
    if (m[role]) return findColumn(h, m[role], role);
    const guess = role === 'cost' ? h.find(x => COST_GOOD.test(x) && !COST_BAD.test(x)) : h.find(x => GUESS[role].test(x.trim()));
    if (!guess && required) throw new DataError(`I can't tell which column is the ${role}. Tell me, using the column heading. The columns are: ${h.join(', ')}.`);
    return guess ?? null;
  };
  const cSku = pick('sku', false), cBar = pick('barcode', false), cCost = pick('cost', true)!, cName = pick('name', false), cCur = pick('currency', false), cRrp = pick('rrp', false);
  if (!cSku && !cBar) throw new DataError(`I can't tell which column is the SKU or barcode. Tell me, using the column heading. The columns are: ${h.join(', ')}.`);
  notes.push(`Read "${t.file}", sheet "${t.sheet}". Columns used: SKU ${cSku ?? '(none)'}, cost ${cCost}${cName ? `, name ${cName}` : ''}${cBar ? `, barcode ${cBar}` : ''}${cCur ? `, currency ${cCur}` : ''}${cRrp ? `, supplier RRP ${cRrp}` : ''}.`);
  let skipped = 0; const rows: Supplier[] = [];
  t.rows.slice(0, 5000).forEach((r, i) => {
    const cost = parseNumber(r[cCost]); if (Number.isNaN(cost) || cost < 0) { skipped++; return; }
    const sv = (c: string | null) => (c && r[c] != null && String(r[c]).trim() !== '' ? String(r[c]).trim() : null);
    const cur = sv(cCur);
    rows.push({ row: t.headerRow + i + 1, sku: sv(cSku), barcode: sv(cBar), name: sv(cName), cost, currency: cur && /^[A-Za-z]{3}$/.test(cur) ? cur.toUpperCase() : undefined, rrp: cRrp ? (Number.isNaN(parseNumber(r[cRrp])) ? null : parseNumber(r[cRrp])) : null });
  });
  if (skipped) notes.push(`${skipped} row${skipped === 1 ? '' : 's'} skipped because ${skipped === 1 ? 'it has' : 'they have'} no usable cost (headings, blanks, notes or negative amounts).`);
  if (t.rows.length > 5000) notes.push('Only the first 5,000 rows were used.');
  if (!rows.length) throw new DataError('No rows with a cost were found. Check the cost column.');
  return { rows, notes };
}
async function ourProducts(): Promise<Ours[]> {
  let rows: any[];
  try { rows = await prisma.$queryRaw<any[]>`select sku, name, brand, barcode, prices from crm.products where status is distinct from 'Deprecated'`; }
  catch (e) { if (!/barcode|status/i.test(String((e as Error).message))) throw e; rows = await prisma.$queryRaw<any[]>`select sku, name, brand, null as barcode, prices from crm.products`; }
  return rows.map(r => ({ sku: String(r.sku), name: r.name ?? null, brand: r.brand ?? null, barcode: r.barcode ? String(r.barcode) : null, wholesale: pickPrice(r.prices, WHOLESALE)?.price ?? null, retail: pickPrice(r.prices, RETAIL)?.price ?? null }));
}

const DATASETS: Dataset[] = [
  {
    key: 'balances_owing',
    blurb: 'Balance owing: one row per customer with what they owe, credit they hold, the net balance, and ageing (not yet due, 1 month, 2 months, 3 months, over 3 months overdue).',
    args: 'state, customer (part of the name), minDaysOverdue (oldest invoice), minBalance',
    async run(ctx, a) {
      let rows = (await helpers.balances(ctx.rep, regionsFrom(a.state))).rows;
      rows = rows.filter(r => nameHas(r.customer, a.customer) && (!Number(a.minDaysOverdue) || r.oldestDays >= Number(a.minDaysOverdue)) && (!Number(a.minBalance) || r.balance >= Number(a.minBalance)));
      const out = rows.map(r => ({ customer: r.customer, state: r.region, rep: r.repName, terms: r.terms, invoices: r.invoices, oldestDaysOverdue: r.oldestDays, owing: r.owing, credit: r.credit, balance: r.balance, notDue: r.current, over1Month: r.d30, over2Months: r.d60, over3Months: r.d90, over3MonthsPlus: r.d90plus }));
      return {
        columns: cols('customer:Customer', 'state:State', 'rep:Rep', 'terms:Terms', 'invoices:Invoices', 'oldestDaysOverdue:Oldest days overdue', 'owing:Owing', 'credit:Credit', 'balance:Balance', 'notDue:Not yet due', 'over1Month:Up to 1 month overdue', 'over2Months:1-2 months overdue', 'over3Months:2-3 months overdue', 'over3MonthsPlus:Over 3 months overdue'),
        rows: out,
        summary: { customers: out.length, owing: sum(out, 'owing'), credit: sum(out, 'credit'), netBalance: sum(out, 'balance'), overdueOver60Days: cents(sum(out, 'over3Months') + sum(out, 'over3MonthsPlus')), notDue: sum(out, 'notDue') },
      };
    },
  },
  {
    key: 'unpaid_invoices',
    blurb: 'Unpaid invoices: one row per invoice that still has money owing, with due date and days overdue.',
    args: 'state, customer, overdueOnly (true), minDaysOverdue',
    async run(ctx, a) {
      let rows = (await helpers.unpaidInvoices(ctx.rep, regionsFrom(a.state))).rows;
      rows = rows.filter(r => nameHas(r.customer, a.customer) && (a.overdueOnly !== true || r.daysOverdue > 0) && (!Number(a.minDaysOverdue) || r.daysOverdue >= Number(a.minDaysOverdue)));
      const out = rows.map(r => ({ order: r.number, invoice: r.invoice, customer: r.customer, state: r.region, rep: r.repName, terms: r.terms, invoiceDate: day(r.invoiceDate), dueDate: day(r.dueDate), daysOverdue: r.daysOverdue, total: r.total, paid: r.paid, credited: r.credited, due: r.due }));
      return {
        columns: cols('order:Order', 'invoice:Invoice', 'customer:Customer', 'state:State', 'rep:Rep', 'terms:Terms', 'invoiceDate:Invoice date', 'dueDate:Due date', 'daysOverdue:Days overdue', 'total:Total', 'paid:Paid', 'credited:Credited', 'due:Due'),
        rows: out, summary: { invoices: out.length, due: sum(out, 'due'), overdue: cents(out.filter(r => r.daysOverdue > 0).reduce((s, r) => s + r.due, 0)) },
      };
    },
  },
  {
    key: 'orders_to_ship',
    blurb: 'Confirmed orders not yet shipped: stage (confirmed, picked, backordered, part shipped), age and value.',
    args: 'state, customer, stage (part of it, e.g. backordered), minAgeDays',
    async run(ctx, a) {
      let rows = (await helpers.toShip(ctx.rep, regionsFrom(a.state))).rows;
      rows = rows.filter(r => nameHas(r.customer, a.customer) && nameHas(r.stage, a.stage) && (!Number(a.minAgeDays) || r.ageDays >= Number(a.minAgeDays)));
      const out = rows.map(r => ({ order: r.number, customer: r.customer, state: r.region, rep: r.repName, orderDate: day(r.date), ageDays: r.ageDays, stage: r.stage, backordered: r.backordered ? 'Yes' : 'No', type: r.type, total: r.amount }));
      return { columns: cols('order:Order', 'customer:Customer', 'state:State', 'rep:Rep', 'orderDate:Order date', 'ageDays:Age (days)', 'stage:Stage', 'backordered:Backordered', 'type:Type', 'total:Total inc GST'), rows: out, summary: { orders: out.length, total: sum(out, 'total'), byStage: count(out, 'stage') } };
    },
  },
  {
    key: 'open_quotes',
    blurb: 'Quotes and unpaid orders: stay until paid and confirmed. Paid so far, still to pay, payment (unpaid, part, paid) and the next follow-up (1st, 2nd, your own date, done).',
    args: 'state, customer, minAgeDays, payment (unpaid|part|paid), followUp (fu1|fu2|manual|done), overdueFollowUp (true)',
    async run(ctx, a) {
      let rows: any[] = (await helpers.openQuotes(ctx.rep, regionsFrom(a.state))).rows;
      rows = rows.filter(r => nameHas(r.customer, a.customer) && (!Number(a.minAgeDays) || r.ageDays >= Number(a.minAgeDays)) && (!text(a.payment) || r.payment === text(a.payment)));
      rows = filterFollowUp(rows, text(a.followUp) || undefined, a.overdueFollowUp === true, melDay());
      const label: Record<string, string> = { fu1: '1st follow-up', fu2: '2nd follow-up', manual: 'Set date' };
      const out = rows.map(r => ({ order: r.number, customer: r.customer, state: r.region, rep: r.repName, orderDate: day(r.date), ageDays: r.ageDays, stage: r.stage, total: r.amount, paid: r.paid, remaining: r.remaining, payment: r.payment, nextFollowUp: r.followUp.next ? `${label[r.followUp.next.kind] ?? r.followUp.next.kind} ${r.followUp.next.date}` : 'Done', lastNote: clip(r.lastNote, 200) }));
      return { columns: cols('order:Order', 'customer:Customer', 'state:State', 'rep:Rep', 'orderDate:Order date', 'ageDays:Age (days)', 'stage:Stage', 'total:Total inc GST', 'paid:Paid', 'remaining:Still to pay', 'payment:Payment', 'nextFollowUp:Next follow-up', 'lastNote:Last note'), rows: out, summary: { count: out.length, total: sum(out, 'total'), stillToPay: sum(out, 'remaining'), byPayment: count(out, 'payment') } };
    },
  },
  {
    key: 'team_log',
    blurb: "The team log: calls, emails and visits logged on customers, with the notes. Reps see their own territory; managers see everyone.",
    args: 'days (1-365, default 7), rep (part of the name), type (call|email|visit), customer, text (words in the note)',
    async run(ctx, a) {
      const days = Math.min(365, Math.max(1, Math.floor(Number(a.days)) || 7));
      const type = lc(a.type);
      if (type && !['call', 'email', 'visit'].includes(type)) throw new DataError('type must be call, email or visit');
      const accountFilters: any[] = [await territoryWhere(ctx.rep as any)];
      if (text(a.customer)) accountFilters.push({ name: { contains: text(a.customer), mode: 'insensitive' } });
      const CAP = 3000;
      const found = await prisma.activity.findMany({
        where: {
          occurredAt: { gte: new Date(Date.now() - days * 86400000) },
          ...(type ? { type: type as any } : {}),
          ...(text(a.text) ? { note: { contains: text(a.text), mode: 'insensitive' as const } } : {}),
          ...(text(a.rep) ? { rep: { name: { contains: text(a.rep), mode: 'insensitive' as const } } } : {}),
          account: { AND: accountFilters },
        },
        include: { account: { select: { id: true, name: true, region: true } }, rep: { select: { name: true } }, quote: { select: { number: true } } },
        orderBy: { occurredAt: 'desc' }, take: CAP,
      });
      const out = found.map(x => ({ date: day(x.occurredAt), rep: x.rep?.name ?? null, customer: x.account.name, state: x.account.region, type: String(x.type), order: x.quote?.number ?? null, note: clip(x.note) }));
      return {
        columns: cols('date:Date', 'rep:Rep', 'customer:Customer', 'state:State', 'type:Type', 'order:Order', 'note:Note'), rows: out,
        summary: { entries: out.length, days, ...(found.length === CAP ? { note: `Only the latest ${CAP} entries were counted` } : {}), byRep: count(out, 'rep'), byType: count(out, 'type'), customersTouched: new Set(out.map(r => r.customer)).size },
      };
    },
  },
  {
    key: 'tasks',
    blurb: "The planner: calls and follow-ups scheduled, done or overdue. A rep sees their own; a manager can see everyone's or one rep's.",
    args: 'from, to (YYYY-MM-DD; default today to 7 days ahead), rep (managers: part of a name), status (open|done), overdue (true: open tasks before today)',
    async run(ctx, a) {
      const isManager = ctx.rep.role === 'manager';
      const reps = await prisma.rep.findMany({ select: { id: true, name: true } });
      const names = new Map(reps.map(r => [r.id, r.name]));
      let repFilter: any = { repId: ctx.rep.id };
      if (isManager) {
        if (text(a.rep)) { const ids = reps.filter(r => nameHas(r.name, a.rep)).map(r => r.id); if (!ids.length) throw new DataError(`No team member called "${text(a.rep)}"`); repFilter = { repId: { in: ids } }; }
        else repFilter = {};
      }
      const from = isDay(a.from) ? a.from : ctx.today, to = isDay(a.to) ? a.to : new Date(Date.parse(ctx.today) + 7 * 86400000).toISOString().slice(0, 10);
      const status = lc(a.status);
      const when = a.overdue === true ? { scheduledDate: { lt: new Date(ctx.today) } } : { scheduledDate: { gte: new Date(from), lte: new Date(to) } };
      const found = await prisma.task.findMany({
        where: { ...repFilter, ...when, ...(a.overdue === true || status === 'open' ? { completed: false } : status === 'done' ? { completed: true } : {}) },
        include: { account: { select: { id: true, name: true, region: true } } },
        orderBy: { scheduledDate: 'asc' }, take: 2000,
      });
      const out = found.map(t => ({ date: day(t.scheduledDate), rep: names.get(t.repId) ?? null, customer: t.account.name, state: t.account.region, type: String(t.type), status: t.completed ? 'Done' : day(t.scheduledDate)! < ctx.today ? 'Overdue' : 'Open', reason: clip(t.reason, 200), note: clip(t.note, 300) }));
      return { columns: cols('date:Date', 'rep:Rep', 'customer:Customer', 'state:State', 'type:Type', 'status:Status', 'reason:Reason', 'note:Note'), rows: out, summary: { tasks: out.length, byStatus: count(out, 'status'), byRep: count(out, 'rep') } };
    },
  },
  {
    key: 'credit_held',
    blurb: 'Money held on orders that is not a credit note: prepayments and overpayments, with how much is free to reserve for another order.',
    args: 'state, customer, kind (Prepayment|Overpaid)',
    async run(ctx, a) {
      let rows: any[] = await helpers.loadHeld(ctx.rep, { regions: regionsFrom(a.state), q: text(a.customer) || undefined }, undefined);
      if (text(a.kind)) rows = rows.filter(r => lc(r.kind) === lc(a.kind));
      const out = rows.map(r => ({ order: r.number, customer: r.account, state: r.region, rep: r.rep, status: r.status, orderDate: r.orderDate, kind: r.kind, amount: r.amount, reserved: r.reserved, free: r.free, reservable: r.reservable ? 'Yes' : 'No', released: r.released ? 'Yes' : 'No' }));
      return { columns: cols('order:Order', 'customer:Customer', 'state:State', 'rep:Rep', 'status:Status', 'orderDate:Order date', 'kind:Kind', 'amount:Amount', 'reserved:Reserved', 'free:Free to reserve', 'reservable:Reservable', 'released:Released'), rows: out, summary: { rows: out.length, held: sum(out, 'amount'), freeToReserve: sum(out, 'free'), reserved: sum(out, 'reserved') } };
    },
  },
  {
    key: 'credit_notes',
    blurb: 'Credit notes: total, applied, refunded, still on account, and how much of the rest is reserved or free.',
    args: 'state, customer',
    async run(ctx, a) {
      const rows: any[] = await helpers.loadCreditNotes(ctx.rep, { regions: regionsFrom(a.state), q: text(a.customer) || undefined }, undefined);
      const out = rows.map(r => ({ customer: r.account, state: r.region, rep: r.rep, order: r.orderNo, creditNote: r.creditNo, date: r.date, total: r.total, applied: r.applied, refunded: r.refunded, onAccount: r.onAccount, reserved: r.reservedAmount, reservedFor: r.reservedFor, free: r.free }));
      return { columns: cols('customer:Customer', 'state:State', 'rep:Rep', 'order:Order', 'creditNote:Credit note', 'date:Date', 'total:Total', 'applied:Applied', 'refunded:Refunded', 'onAccount:On account', 'reserved:Reserved', 'reservedFor:Reserved for', 'free:Free'), rows: out, summary: { creditNotes: out.length, onAccount: sum(out, 'onAccount'), reserved: sum(out, 'reserved'), free: sum(out, 'free') } };
    },
  },
  {
    key: 'credit_reservations',
    blurb: "Credit that has been set aside for another order, and whether it is still reserved, used or cancelled.",
    args: 'state, customer, status (reserved|used|cancelled)',
    async run(ctx, a) {
      const rows: any[] = await helpers.loadReservations(ctx.rep, { regions: regionsFrom(a.state), q: text(a.customer) || undefined, status: text(a.status) || undefined });
      const out = rows.map(r => ({ from: r.account, to: r.forAccount, amount: r.amount, source: r.sourceKind === 'prepayment' ? `Prepayment ${r.sourceOrder ?? ''}`.trim() : `Credit note ${r.creditNo ?? ''}`.trim(), forOrder: r.orderRef, status: r.status, createdAt: day(r.createdAt), createdBy: r.createdBy, note: clip(r.note, 200) }));
      return { columns: cols('from:From customer', 'to:For customer', 'amount:Amount', 'source:Source', 'forOrder:For order', 'status:Status', 'createdAt:Reserved on', 'createdBy:By', 'note:Note'), rows: out, summary: { reservations: out.length, amount: sum(out, 'amount'), byStatus: count(out, 'status') } };
    },
  },
  {
    key: 'incoming_stock',
    blurb: 'Stock on order: purchase order lines still to arrive, with the date they are required and whether they are late.',
    args: 'brand, search (SKU, product name or PO number), lateOnly (true)',
    async run(ctx, a) {
      const brand = text(a.brand) ? `%${text(a.brand)}%` : null, q = text(a.search) ? `%${text(a.search)}%` : null;
      const rows = await prisma.$queryRaw<{ po: string | null; status: string | null; receiving: string | null; required_by: Date | null; sku: string; product: string | null; brand: string | null; ordered: number; received: number; outstanding: number }[]>`
        select p.number as po, p.status, p.receiving_status as receiving, p.required_by, l.sku, pr.name as product, pr.brand,
               l.quantity_ordered::float8 as ordered, l.quantity_received::float8 as received,
               greatest(l.quantity_ordered - l.quantity_received, 0)::float8 as outstanding
        from crm.purchase_lines l
        join crm.purchases p on p.id = l.purchase_id
        left join crm.products pr on pr.sku = l.sku
        where upper(coalesce(p.status, '')) not in ('VOIDED', 'CREDITED', 'DRAFT')
          and not (upper(coalesce(p.receiving_status, '')) like '%FULLY RECEIVED%' or upper(coalesce(p.status, '')) like 'COMPLETED%' or upper(coalesce(p.status, '')) = 'RECEIVED')
          and l.quantity_ordered - l.quantity_received > 0
          and (${brand}::text is null or pr.brand ilike ${brand}::text)
          and (${q}::text is null or l.sku ilike ${q}::text or pr.name ilike ${q}::text or p.number ilike ${q}::text)
        order by p.required_by nulls last, p.number, l.sku
        limit 5000`;
      let out = rows.map(r => ({ po: r.po, sku: r.sku, product: r.product, brand: r.brand, ordered: r.ordered, received: r.received, outstanding: r.outstanding, requiredBy: day(r.required_by), late: r.required_by && day(r.required_by)! < ctx.today ? 'Late' : r.required_by ? 'On time' : 'No date', status: r.status }));
      if (a.lateOnly === true) out = out.filter(r => r.late === 'Late');
      return { columns: cols('po:PO', 'sku:SKU', 'product:Product', 'brand:Brand', 'ordered:Ordered', 'received:Received', 'outstanding:Outstanding', 'requiredBy:Required by', 'late:Timing', 'status:PO status'), rows: out, summary: { lines: out.length, unitsOutstanding: out.reduce((s, r) => s + r.outstanding, 0), lateLines: out.filter(r => r.late === 'Late').length, pos: new Set(out.map(r => r.po)).size } };
    },
  },
  {
    key: 'conversion',
    blurb: 'Conversion funnels over a period: prospects set up in DEAR, new leads, inactive stockists (never ordered, or 12+ months), abandoned carts, and how many reached a quote or an order.',
    args: 'days (7-365, default 90) or from and to (YYYY-MM-DD), state',
    async run(ctx, a) {
      const { period, result } = await helpers.conversion(ctx.rep, a);
      const out = result.funnels.map((f: any) => ({ funnel: f.title, what: f.description, started: f.started, quotes: f.quotes, orders: f.orders, orderRatePct: f.started ? Math.round((f.orders / f.started) * 1000) / 10 : null }));
      return { columns: cols('funnel:Funnel', 'what:What it counts', 'started:Started', 'quotes:Reached a quote', 'orders:Reached an order', 'orderRatePct:Order rate %'), rows: out, summary: { from: day(period.from), to: day(period.to), days: period.days } };
    },
  },
  {
    key: 'team',
    blurb: 'The team: who is on it, their role and the states they cover.',
    args: '(none)',
    async run() {
      const [reps, regions] = await Promise.all([prisma.rep.findMany({ select: { id: true, name: true, role: true }, orderBy: { name: 'asc' } }), prisma.repRegion.findMany({ select: { repId: true, region: true } })]);
      const out = reps.map(r => ({ name: r.name, role: String(r.role), states: regions.filter(x => x.repId === r.id).map(x => x.region).sort().join(', ') }));
      return { columns: cols('name:Name', 'role:Role', 'states:States'), rows: out, summary: { people: out.length } };
    },
  },
  {
    key: 'targets',
    blurb: 'Sales targets by rep and quarter. A rep sees their own; a manager sees everyone.',
    args: 'year (default this year), rep (managers: part of a name)',
    async run(ctx, a) {
      const isManager = ctx.rep.role === 'manager';
      const year = Math.floor(Number(a.year)) || Number(ctx.today.slice(0, 4));
      const found = await prisma.budgetTarget.findMany({ where: { year, ...(isManager ? {} : { repId: ctx.rep.id }) }, include: { rep: { select: { name: true } } }, orderBy: [{ repId: 'asc' }, { quarter: 'asc' }] });
      const out = found.filter(t => isManager ? nameHas(t.rep.name, a.rep) : true).map(t => ({ year: t.year, quarter: `Q${t.quarter}`, rep: t.rep.name, target: Number(t.amount) }));
      return { columns: cols('year:Year', 'quarter:Quarter', 'rep:Rep', 'target:Target'), rows: out, summary: { rows: out.length, totalTarget: sum(out, 'target') } };
    },
  },
  {
    key: 'emails',
    blurb: 'Emails logged on customers from the team\'s Gmail: date, direction, who, the customer, subject and the saved preview (never the body or the addresses). Anyone who can open a customer sees all the team\'s emails on it. Not shown for hidden (archived) customers.',
    args: 'days (1-365, default 30), customer, rep (part of the name), direction (in|out), text (words in the subject or preview)',
    async run(ctx, a) {
      const days = Math.min(365, Math.max(1, Math.floor(Number(a.days)) || 30)), ids = await visibleIds(ctx.rep), dir = lc(a.direction);
      if (dir && !['in', 'out'].includes(dir)) throw new DataError('direction must be in or out');
      const rows = await prisma.$queryRaw<any[]>`
        select l.occurred_at, l.direction, l.subject, l.snippet, r.name as rep, a.name as customer, a.region
        from crm.email_log l join crm.accounts a on a.id = l.account_id join crm.reps r on r.id = l.rep_id
        where l.occurred_at >= now() - make_interval(days => ${days}::int)
          and a.archived = false and a.misc = false
          and (${ids}::uuid[] is null or a.id = any(${ids}::uuid[]))
          and (${like(a.customer)}::text is null or a.name ilike ${like(a.customer)}::text)
          and (${like(a.rep)}::text is null or r.name ilike ${like(a.rep)}::text)
          and (${dir ? dir + '%' : null}::text is null or l.direction ilike ${dir ? dir + '%' : null}::text)
          and (${like(a.text)}::text is null or l.subject ilike ${like(a.text)}::text or l.snippet ilike ${like(a.text)}::text)
        order by l.occurred_at desc limit 2000`;
      const out = rows.map(r => ({ date: day(r.occurred_at), direction: /^in/i.test(r.direction) ? 'Received' : 'Sent', rep: r.rep, customer: r.customer, state: r.region, subject: clip(r.subject, 200), preview: clip(r.snippet, 300) }));
      return { columns: cols('date:Date', 'direction:Direction', 'rep:Rep', 'customer:Customer', 'state:State', 'subject:Subject', 'preview:Preview'), rows: out, summary: { emails: out.length, days, received: out.filter(r => r.direction === 'Received').length, sent: out.filter(r => r.direction === 'Sent').length, byRep: count(out, 'rep'), customers: new Set(out.map(r => r.customer)).size } };
    },
  },
  {
    key: 'marketing_emails',
    blurb: 'Marketing emails sent to customers (campaigns and automatic emails): subject, whether it was opened or clicked, and where it came from.',
    args: 'days (1-365, default 90), customer, status (e.g. delivered, bounced), source (part of the campaign name)',
    async run(ctx, a) {
      const days = Math.min(365, Math.max(1, Math.floor(Number(a.days)) || 90)), ids = await visibleIds(ctx.rep);
      const rows = await prisma.$queryRaw<any[]>`
        select m.sent_at, m.subject, m.status, m.opened_at, m.click_count as clicks, coalesce(c.name, ma.key) as source, coalesce(ac.name, k.company) as customer, ac.region
        from crm.marketing_messages m
        left join crm.marketing_contacts k on k.id = m.contact_id
        left join crm.accounts ac on ac.id = k.account_id
        left join crm.marketing_campaigns c on c.id = m.campaign_id
        left join crm.marketing_automations ma on ma.key = m.automation_key
        where m.sent_at is not null and m.sent_at >= now() - make_interval(days => ${days}::int)
          and (${ids}::uuid[] is null or ac.id = any(${ids}::uuid[]))
          and (${like(a.customer)}::text is null or coalesce(ac.name, k.company) ilike ${like(a.customer)}::text)
          and (${text(a.status) || null}::text is null or lower(m.status) = ${lc(a.status) || null}::text)
          and (${like(a.source)}::text is null or coalesce(c.name, ma.key) ilike ${like(a.source)}::text)
        order by m.sent_at desc limit 3000`;
      const out = rows.map(r => ({ sentOn: day(r.sent_at), customer: r.customer, state: r.region, subject: clip(r.subject, 200), status: r.status, opened: r.opened_at ? 'Yes' : 'No', clicks: Number(r.clicks) || 0, source: r.source }));
      return { columns: cols('sentOn:Sent', 'customer:Customer', 'state:State', 'subject:Subject', 'status:Status', 'opened:Opened', 'clicks:Clicks', 'source:Campaign or automation'), rows: out, summary: { sent: out.length, opened: out.filter(r => r.opened === 'Yes').length, clicked: out.filter(r => r.clicks > 0).length, bySource: count(out, 'source') } };
    },
  },
  {
    key: 'marketing_campaigns',
    blurb: 'Marketing campaigns and how they did: status, when sent, how many sent, delivered, open rate and click rate. Managers only, like the Marketing screen.',
    args: '(none)',
    async run(ctx) {
      managersOnly(ctx, 'Marketing campaigns');
      const rows = await prisma.$queryRaw<any[]>`
        select c.name, c.subject, c.status, c.scheduled_at, c.sent_at,
               count(m.id) filter (where m.sent_at is not null)::int as sent, count(m.id) filter (where m.status in ('bounced', 'complained'))::int as bounced,
               count(m.id) filter (where m.opened_at is not null)::int as opened, count(m.id) filter (where m.click_count > 0)::int as clicked
        from crm.marketing_campaigns c left join crm.marketing_messages m on m.campaign_id = c.id group by c.id order by c.updated_at desc limit 200`;
      const out = rows.map(r => { const d = r.sent - r.bounced; return { campaign: r.name, subject: clip(r.subject, 200), status: r.status, scheduled: day(r.scheduled_at), sentOn: day(r.sent_at), sent: r.sent, delivered: d, bounced: r.bounced, openRatePct: d ? Math.round((r.opened / d) * 1000) / 10 : 0, clickRatePct: d ? Math.round((r.clicked / d) * 1000) / 10 : 0 }; });
      return { columns: cols('campaign:Campaign', 'subject:Subject', 'status:Status', 'scheduled:Scheduled', 'sentOn:Sent on', 'sent:Sent', 'delivered:Delivered', 'bounced:Bounced', 'openRatePct:Open rate %', 'clickRatePct:Click rate %'), rows: out, summary: { campaigns: out.length, sent: out.reduce((s, r) => s + r.sent, 0), byStatus: count(out, 'status') } };
    },
  },
  {
    key: 'marketing_contacts',
    blurb: 'The marketing contact list: name, company, email, subscription status, source, state and the customer it belongs to. Managers only, like the Marketing screen.',
    args: 'text (name, company or email), status, region, source',
    async run(ctx, a) {
      managersOnly(ctx, 'Marketing contacts');
      const rows = await prisma.$queryRaw<any[]>`
        select k.email, k.first_name, k.last_name, k.company, k.status, k.source, k.region, k.contact_type, k.created_at, ac.name as customer
        from crm.marketing_contacts k left join crm.accounts ac on ac.id = k.account_id
        where (${like(a.text)}::text is null or k.email ilike ${like(a.text)}::text or k.company ilike ${like(a.text)}::text or (coalesce(k.first_name, '') || ' ' || coalesce(k.last_name, '')) ilike ${like(a.text)}::text)
          and (${lc(a.status) || null}::text is null or lower(k.status) = ${lc(a.status) || null}::text)
          and (${text(a.region).toUpperCase() || null}::text is null or upper(k.region) = ${text(a.region).toUpperCase() || null}::text)
          and (${lc(a.source) || null}::text is null or lower(k.source) = ${lc(a.source) || null}::text)
        order by k.created_at desc limit 5000`;
      const out = rows.map(r => ({ name: `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || null, company: r.company, email: r.email, status: r.status, source: r.source, state: r.region, type: r.contact_type, customer: r.customer, added: day(r.created_at) }));
      return { columns: cols('name:Name', 'company:Company', 'email:Email', 'status:Status', 'source:Source', 'state:State', 'type:Type', 'customer:Customer', 'added:Added'), rows: out, summary: { contacts: out.length, byStatus: count(out, 'status'), bySource: count(out, 'source') } };
    },
  },
  {
    key: 'my_calendar',
    blurb: "The signed-in person's own Google Calendar: titles, times and places. Only their own, exactly as the Planner shows it, and never anyone else's.",
    args: 'from, to (YYYY-MM-DD; default today to 7 days ahead)',
    async run(ctx, a) {
      const from = isDay(a.from) ? a.from : ctx.today, to = isDay(a.to) ? a.to : new Date(Date.parse(ctx.today) + 7 * 86400000).toISOString().slice(0, 10);
      if (from > to) throw new DataError('That period starts after it ends');
      const c = await helpers.calendar(ctx.rep.id, from, to);
      if (!c.connected) throw new DataError('Your Google Calendar is not connected. Connect it in Settings.');
      if (!c.shown) throw new DataError('Showing your calendar is switched off in Settings.');
      const out = c.events
        .filter((e: any) => e.status !== 'cancelled' && e.extendedProperties?.private?.rhinoCrm !== '1' && !(e.attendees ?? []).some((x: any) => x.self && x.responseStatus === 'declined'))
        .map((e: any) => ({ start: String(e.start?.dateTime ?? e.start?.date ?? ''), end: String(e.end?.dateTime ?? e.end?.date ?? ''), allDay: e.start?.date ? 'Yes' : 'No', title: e.summary || (e.visibility === 'private' ? 'Private event' : '(No title)'), location: e.location ?? null }))
        .filter((e: any) => e.start.slice(0, 10) >= from && e.start.slice(0, 10) <= to)
        .sort((x: any, y: any) => x.start.localeCompare(y.start));
      return { columns: cols('start:Start', 'end:End', 'allDay:All day', 'title:Title', 'location:Where'), rows: out, summary: { events: out.length, from, to } };
    },
  },
  {
    key: 'sales_forecast',
    blurb: 'Forecast of units to be ordered in the coming months, worked out by code from past orders (never by guessing). Each forecast comes with how well the method predicted recent months, a confidence rating, a low and high range, stock cover and a suggested reorder. Only from what customers ordered: it cannot know about promotions, new ranges or stock-outs. For a rep it covers their own states.',
    args: 'by (sku|brand|category|total; default sku), brand, category, sku (one or several, comma separated), search (words in the SKU or name), months (how far ahead, 1-12, default 3), history (months of past orders to use, 6-36, default 24), leadTimeMonths (stock needed to cover supplier lead time, default 0), top (most important series first, default 100, max 500)',
    async run(ctx, a) {
      const by = lc(a.by) || 'sku'; if (!['sku', 'brand', 'category', 'total'].includes(by)) throw new DataError('by must be sku, brand, category or total');
      const h = Math.min(12, Math.max(1, Math.floor(Number(a.months)) || 3)), history = Math.min(36, Math.max(6, Math.floor(Number(a.history)) || 24)), lead = Math.min(12, Math.max(0, Number(a.leadTimeMonths) || 0));
      const top = Math.min(500, Math.max(1, Math.floor(Number(a.top)) || 100)), ids = await visibleIds(ctx.rep);
      const thisMonth = ctx.today.slice(0, 7), lastFull = addMonths(thisMonth, -1), startMonth = addMonths(lastFull, -(history - 1));
      const skus = text(a.sku) ? text(a.sku).split(',').map(x => x.trim().toUpperCase()).filter(Boolean) : null;
      const rows = await prisma.$queryRaw<{ sku: string; product: string | null; brand: string | null; category: string | null; month: string; qty: number; revenue: number }[]>`
        select l.sku, max(l.product_name) as product, max(coalesce(pr.brand, l.brand)) as brand, max(pr.category) as category,
               to_char(date_trunc('month', q.sent_at at time zone 'Australia/Melbourne'), 'YYYY-MM') as month,
               sum(l.quantity)::float8 as qty, sum(l.line_total)::float8 as revenue
        from crm.quote_lines l
        join crm.quotes q on q.id = l.quote_id
        join crm.accounts a on a.id = q.account_id
        left join crm.products pr on pr.sku = l.sku
        where q.source <> 'rhino-history' and q.number not like 'Q%' and q.misc_type is null
          and upper(coalesce(q.fulfillment_status, '')) not in ('DRAFT', 'ESTIMATING', 'ESTIMATED', 'ORDERING', 'VOIDED', 'CREDITED')
          and q.sent_at >= ((${startMonth} || '-01')::date::timestamp at time zone 'Australia/Melbourne')
          and q.sent_at < ((${thisMonth} || '-01')::date::timestamp at time zone 'Australia/Melbourne')
          and (${ids}::uuid[] is null or a.id = any(${ids}::uuid[]))
          and (${like(a.brand)}::text is null or coalesce(pr.brand, l.brand) ilike ${like(a.brand)}::text)
          and (${like(a.category)}::text is null or pr.category ilike ${like(a.category)}::text)
          and (${skus}::text[] is null or upper(l.sku) = any(${skus}::text[]))
          and (${like(a.search)}::text is null or l.sku ilike ${like(a.search)}::text or l.product_name ilike ${like(a.search)}::text)
        group by l.sku, to_char(date_trunc('month', q.sent_at at time zone 'Australia/Melbourne'), 'YYYY-MM')
        limit 250000`;
      if (!rows.length) throw new DataError('No orders matched, so there is nothing to forecast from. Check the brand, category or SKU, or widen the history.');

      type Series = { key: string; sku?: string; product?: string | null; brand?: string | null; category?: string | null; points: Map<string, number>; revenue: number };
      const groups = new Map<string, Series>();
      for (const r of rows) {
        const key = by === 'sku' ? r.sku : by === 'brand' ? r.brand ?? '(no brand)' : by === 'category' ? r.category ?? '(no category)' : 'All sales';
        const g = groups.get(key) ?? { key, sku: by === 'sku' ? r.sku : undefined, product: by === 'sku' ? r.product : undefined, brand: by === 'sku' || by === 'brand' ? r.brand : undefined, category: by === 'sku' ? r.category : undefined, points: new Map<string, number>(), revenue: 0 };
        g.points.set(r.month, (g.points.get(r.month) ?? 0) + r.qty); g.revenue += r.revenue; groups.set(key, g);
      }
      const chosen = [...groups.values()].sort((x, y) => y.revenue - x.revenue).slice(0, top);
      const stock = new Map<string, { available: number; onOrder: number }>();
      if (by === 'sku' && chosen.length) for (const r of await prisma.$queryRaw<{ sku: string; available: number | null; on_order: number | null }[]>`select sku, available::float8 as available, on_order::float8 as on_order from crm.products where sku = any(${chosen.map(c => c.key)}::text[])`) stock.set(r.sku, { available: r.available ?? 0, onOrder: r.on_order ?? 0 });

      const future = Array.from({ length: h }, (_, k) => addMonths(lastFull, k + 1)), lastMonthNo = Number(lastFull.slice(5));
      const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], label = (ym: string) => `${MON[Number(ym.slice(5)) - 1]} ${ym.slice(0, 4)}`;
      const out = chosen.map(g => {
        const { y } = fillMonths([...g.points].map(([month, qty]) => ({ month, qty })), lastFull), f = forecastSeries(y, h, lastMonthNo);
        const last12 = y.slice(-12).reduce((t, v) => t + v, 0), avg3 = y.slice(-3).reduce((t, v) => t + v, 0) / Math.max(1, Math.min(3, y.length)), prior3 = y.slice(-6, -3);
        const total = f.forecast.reduce((t, v) => t + v, 0), avgMonthly = total / h, st = stock.get(g.key);
        const row: Record<string, unknown> = { series: g.key, product: g.product ?? null, brand: g.brand ?? null, category: g.category ?? null, monthsOfHistory: y.length, last12Months: Math.round(last12), avgLast3Months: Math.round(avg3 * 10) / 10 };
        future.forEach((m, k) => { row[`m${k + 1}`] = Math.round(f.forecast[k]); });
        Object.assign(row, {
          forecastTotal: Math.round(total), lowTotal: Math.round(f.low.reduce((t, v) => t + v, 0)), highTotal: Math.round(f.high.reduce((t, v) => t + v, 0)),
          trendPct: prior3.length === 3 && prior3.reduce((t, v) => t + v, 0) > 0 ? Math.round((avg3 / (prior3.reduce((t, v) => t + v, 0) / 3) - 1) * 1000) / 10 : null,
          method: f.method, accuracyPct: f.wape === null ? null : Math.round((1 - Math.min(1, f.wape)) * 100), confidence: f.confidence,
          ...(st ? { available: st.available, onOrder: st.onOrder, monthsOfCover: avgMonthly > 0 ? Math.round((st.available / avgMonthly) * 10) / 10 : null, suggestedReorder: Math.max(0, Math.ceil(total + lead * avgMonthly - st.available - st.onOrder)) } : {}),
          notes: f.warnings.join(' ') || null,
        });
        return row;
      });
      const columns = [
        ...cols(by === 'sku' ? 'series:SKU' : by === 'brand' ? 'series:Brand' : by === 'category' ? 'series:Category' : 'series:Series'),
        ...(by === 'sku' ? cols('product:Product', 'brand:Brand', 'category:Category') : []),
        ...cols('monthsOfHistory:Months of history', 'last12Months:Units last 12 months', 'avgLast3Months:Avg units/month (last 3)'),
        ...future.map((m, k) => ({ key: `m${k + 1}`, label: `Forecast ${label(m)}` })),
        ...cols('forecastTotal:Forecast total', 'lowTotal:Low (80% range)', 'highTotal:High (80% range)', 'trendPct:Trend % (last 3 vs the 3 before)', 'method:Method', 'accuracyPct:Backtest accuracy %', 'confidence:Confidence'),
        ...(by === 'sku' ? cols('available:Available now', 'onOrder:On order', 'monthsOfCover:Months of cover', 'suggestedReorder:Suggested reorder') : []),
        ...cols('notes:Notes'),
      ];
      return {
        columns, rows: out,
        summary: {
          basis: `Units ordered per month from ${label(startMonth)} to ${label(lastFull)} (full months only), forecasting ${label(future[0])} to ${label(future[h - 1])}.`,
          series: out.length, ofWhich: groups.size > out.length ? `showing the ${out.length} biggest of ${groups.size}` : 'all of them',
          forecastUnits: out.reduce((t, r) => t + (r.forecastTotal as number), 0), confidence: count(out, 'confidence'), methods: count(out, 'method'),
          ...(by === 'sku' ? { leadTimeMonthsUsed: lead } : {}),
          caveats: ['Based on what customers ordered. It cannot know about promotions, new ranges, lost customers or stock-outs that held orders back.', ctx.rep.role === 'manager' ? 'Covers all sales.' : 'Covers only the states you look after.'],
        },
      };
    },
  },
  {
    key: 'attached_table',
    blurb: 'Reads a spreadsheet or CSV the person attached (a supplier price list, say) as a table, finding the column headings for you. Use it first to see what columns there are.',
    args: 'file (part of the file name; default the first spreadsheet or CSV attached), sheet (name or part of it; default the first with data)',
    async run(ctx, a) {
      return wrapPricing(async () => {
      const t = tableFor(ctx, a);
      return { columns: t.headers.map(h => ({ key: h, label: h })), rows: t.rows, summary: { file: t.file, sheet: t.sheet, otherSheets: t.sheets.filter(s => s !== t.sheet), headerRowInTheSheet: t.headerRow, rows: t.rows.length, ...(t.truncated ? { note: 'Only the first 20,000 rows were read' } : {}) } };
      });
    },
  },
  {
    key: 'price_calculation',
    blurb: 'Works out wholesale and retail prices from supplier costs and the settings given: exchange rate, freight and duty, target margin or markup, the shop\'s margin, GST, rounding. Exact arithmetic, with the assumptions listed. Costs come from the attached list or from items.',
    args: PRICE_ARGS,
    async run(ctx, a) {
      return wrapPricing(async () => {
        const p = parseParams(a.params), { rows, notes } = supplierRows(ctx, a);
        const out = rows.map(r => { const x = priceItem(p, { cost: r.cost, currency: r.currency, rrp: r.rrp ?? null }); return { sku: r.sku, name: r.name, cost: r.cost, currency: (r.currency ?? p.currency).toUpperCase(), landedCost: x.landed, wholesale: x.wholesale, rrpExGst: x.rrpEx, rrpIncGst: x.rrpInc, wholesaleMarginPct: x.wholesaleMarginPct, retailerMarginPct: x.retailerMarginPct, directMarginPct: x.directMarginPct, flag: x.belowMin ? 'Below minimum margin' : '' }; });
        return { columns: cols('sku:SKU', 'name:Name', 'cost:Supplier cost', 'currency:Currency', 'landedCost:Landed cost (AUD)', 'wholesale:Wholesale (ex GST)', 'rrpExGst:RRP ex GST', 'rrpIncGst:RRP inc GST', 'wholesaleMarginPct:Our margin at wholesale %', 'retailerMarginPct:Shop margin at RRP %', 'directMarginPct:Our margin if sold at RRP %', 'flag:Flag'), rows: out, summary: { items: out.length, belowMinimum: out.filter(r => r.flag).length, assumptions: assumptions(p), ...(notes.length ? { notes } : {}) } };
      });
    },
  },
  {
    key: 'price_comparison',
    blurb: 'Checks a supplier price list against our own prices in the CRM: matches each line by SKU (or barcode), works out the landed cost and the wholesale and retail prices the settings call for, and flags what is priced too low, too high, missing, or not in the CRM. Exact arithmetic, with the assumptions listed.',
    args: PRICE_ARGS + '. Also: tolerancePct (how far off before it is flagged, default 3), minWholesaleMarginPct, wholesaleTierIncludesGst (default false) and retailTierIncludesGst (default true) say how DEAR holds its prices',
    async run(ctx, a) {
      return wrapPricing(async () => {
        const p = parseParams(a.params), { rows, notes } = supplierRows(ctx, a), ours = await ourProducts();
        const cmp = comparePrices(p, rows, ours);
        const flags = count(cmp, 'flag'), matched = cmp.filter(c => c.ourSku), margins = matched.map(c => c.ourWholesaleMarginPct).filter((m): m is number => m !== null);
        const out = cmp.map(c => ({ ...c }));
        return {
          columns: cols('row:Row', 'supplierSku:Supplier SKU', 'supplierName:Supplier name', 'supplierCost:Supplier cost', 'currency:Currency', 'landed:Landed cost (AUD)', 'ourSku:Our SKU', 'ourName:Our name', 'matchedBy:Matched by', 'ourWholesale:Our wholesale (ex GST)', 'suggestedWholesale:Wholesale the settings give', 'wholesaleGapPct:Wholesale gap %', 'ourWholesaleMarginPct:Our margin at our wholesale %', 'ourRetailInc:Our RRP (inc GST)', 'suggestedRrpInc:RRP the settings give', 'retailGapPct:RRP gap %', 'retailerMarginAtOurRrpPct:Shop margin at our RRP %', 'flag:Flag', 'note:Note'),
          rows: out,
          summary: {
            lines: out.length, matched: matched.length, byFlag: flags,
            averageOurWholesaleMarginPct: margins.length ? Math.round((margins.reduce((t, m) => t + m, 0) / margins.length) * 10) / 10 : null,
            assumptions: assumptions(p), ...(notes.length ? { notes } : {}),
          },
        };
      });
    },
  },
];

export const DATA_KEYS = DATASETS.map(d => d.key);
export const DATA_HELP = DATASETS.map(d => `- ${d.key}: ${d.blurb}\n  args: ${d.args}`).join('\n');

export async function runDataset(key: unknown, args: unknown, ctx: DataCtx): Promise<DataResult> {
  const d = DATASETS.find(x => x.key === key);
  if (!d) throw new DataError(`Unknown dataset. Choose one of: ${DATA_KEYS.join(', ')}`);
  return d.run(ctx, args && typeof args === 'object' ? (args as Record<string, any>) : {});
}