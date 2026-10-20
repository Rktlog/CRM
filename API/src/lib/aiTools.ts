import Anthropic from '@anthropic-ai/sdk';
import { prisma } from './prisma';
import { decodeEntities } from './htmlText';
import { fmtDimensions, fmtWeight } from './productSpecs';
import { freightQuote } from './aiFreight';
import { territoryWhere, canSeeAccount } from './territory';
import { openQuotes } from './receivables';
import { chooseEta, incomingFor } from './eta';
import { wholesalePrice } from './pricing';
import { PRODUCT_STATUSES, isStatusKey, statusLabel } from './productImport';

// DEAR's description of each product, plain text, if the sync has saved one. A separate read so the lookup works before the column exists.
async function productIncrements(skus: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!skus.length) return out;
  try {
    for (const r of await prisma.$queryRaw<{ sku: string; order_increment: number | null }[]>`select sku, order_increment from crm.products where sku = any(${skus}::text[]) and order_increment is not null`) if (r.order_increment) out.set(r.sku, Number(r.order_increment));
  } catch { /* not there yet */ }
  return out;
}
// Weight (kg) and size (cm) from DEAR, if the sync has saved them. A separate read, so the lookup works before the columns exist.
async function productSpecs(skus: string[]): Promise<Map<string, { weightKg: number | null; lengthCm: number | null; widthCm: number | null; heightCm: number | null }>> {
  const out = new Map<string, { weightKg: number | null; lengthCm: number | null; widthCm: number | null; heightCm: number | null }>();
  if (!skus.length) return out;
  try {
    const n = (v: number | null) => (v == null ? null : Number(v));
    for (const r of await prisma.$queryRaw<{ sku: string; weight_kg: number | null; length_cm: number | null; width_cm: number | null; height_cm: number | null }[]>`select sku, weight_kg, length_cm, width_cm, height_cm from crm.products where sku = any(${skus}::text[])`) out.set(r.sku, { weightKg: n(r.weight_kg), lengthCm: n(r.length_cm), widthCm: n(r.width_cm), heightCm: n(r.height_cm) });
  } catch { /* not there yet */ }
  return out;
}
async function productDescriptions(skus: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!skus.length) return out;
  try {
    for (const r of await prisma.$queryRaw<{ sku: string; description: string | null }[]>`select sku, description from crm.products where sku = any(${skus}::text[]) and description is not null`) if (r.description) out.set(r.sku, decodeEntities(r.description));   // saved text may still hold codes like &rsquo;
  } catch { /* not there yet */ }
  return out;
}
import { DATASETS, parseDefinition, runReport, ReportInputError } from './customReport';
import { reportWorkbook } from './customReportXlsx';
import { safeFilename, toCsv, OutFormat, Attachment } from './aiFiles';
import { parseMarkdown, withTitle, renderDocx, renderPdf, DocsMissingError } from './aiDocs';
import { runCalculations, CalcError } from './aiCalc';
import { runDataset, DataError, DATA_HELP, DATA_KEYS } from './aiData';
import { accountDetails, orderDetails } from './aiDetail';
import { renderChart, specFromRows, ChartError, ChartSpec, ChartType } from './aiChart';
import * as XLSX from 'xlsx';

// What the assistant can look up. Read only: it can read what the person asking can already see, and change nothing.
// Each tool checks the same territory rule as the rest of the app, so the assistant never shows someone another
// territory's accounts. Results are plain data; whatever is written inside them (notes, names) is never an instruction.
export type MadeFile = { id: string; name: string; size: number };
export type Ctx = {
  rep: { id: string; role: string }; today: string;
  addFile?: (f: { name: string; mime: string; buffer: Buffer }) => Promise<MadeFile>;   // keeps a file the assistant made, for the person to download
  addChart?: (c: { title: string; svg: string }) => void;                      // shows a chart in the chat
  attachments?: Attachment[];                                                  // the files the person has attached in this chat, for the data sets that read them
};

const DATASET_HELP = Object.entries(DATASETS).map(([k, d]) =>
  `- ${k}: ${d.blurb}\n  columns: ${d.columns.map(c => c.key).join(', ')}\n  can group by: ${d.columns.filter(c => c.dim).map(c => c.key).join(', ')}\n  filters: ${d.filters.join(', ')}`).join('\n');

export const TOOLS: Anthropic.Tool[] = [
  {
    name: 'find_accounts',
    description: 'Find customer accounts by name. Returns the id, state, status (Active, Inactive, New Lead or Prospect), last order and spend. Use it first to get an account id.',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Part of the customer name, at least 2 letters' } }, required: ['query'] },
  },
  {
    name: 'account_details',
    description: 'EVERYTHING saved about one customer, in one go: contact details, status, balance owing and unpaid invoices, open quotes, recent orders, credit held, the team notes, emails logged on them, marketing emails sent to them, planner tasks and what they buy most. Use it whenever someone asks about a customer. Give the customer name, or an id from find_accounts. If several customers match, it returns the choices.',
    input_schema: { type: 'object', properties: { customer: { type: 'string', description: 'The customer name (part of it is fine) or an id' } }, required: ['customer'] },
  },
  {
    name: 'order_details',
    description: 'EVERYTHING saved about one order: the customer and contact, status, what has been paid and what is owing, the invoices and credit notes, held prepayment, the follow-up schedule, every line, the team log on the order and emails that mention it. Use it whenever someone asks about a particular order or quote. Give the order number, like SQ37604.',
    input_schema: { type: 'object', properties: { orderNo: { type: 'string', description: 'The order number, like SQ37604' } }, required: ['orderNo'] },
  },
  {
    name: 'open_quotes',
    description: 'Quotes and unpaid orders (an order stays until it is both paid and confirmed), oldest first, with age, total, paid so far, what is still to pay and the next follow-up. Optionally only one state or only those older than some days.',
    input_schema: { type: 'object', properties: { state: { type: 'string', description: 'For example VIC' }, minAgeDays: { type: 'number' } } },
  },
  {
    name: 'product_lookup',
    description: 'Look up products by SKU, name or brand: stock available, on order, ETA of the next delivery, status (EOL, Discontinued, Pre-order, New, Confirmed for Ranging, For Customer Only Then Cease, Preorder Only), the DEAR description, the order increment and wholesale price. Can list by status, for example every EOL product still in stock.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'SKU, part of the name, or the brand' },
        status: { type: 'string', enum: PRODUCT_STATUSES.map(s => s.key) },
        inStockOnly: { type: 'boolean' },
      },
    },
  },
  {
    name: 'freight_quote',
    description: "Australia Post freight quote for an order or a list of products, using the weight and size DEAR holds for each product. It packs everything into 60 x 40 x 30 cm cartons (the height cut down to fit; a further carton if it does not fit or goes over 15 kg each) and prices each carton, for an international country (most often New Zealand) or an Australian postcode. Give the order number (the customer's country comes from the order), or the SKUs and quantities with a country. If it says a product has no weight or size, ASK the person for them (kg, and length, width, height in cm, for ONE unit), then call again with the same order or items plus `overrides`. Never guess a weight or size. Show the cartons (size, weight, what is in each), then the services cheapest first with each carton's price and the total, and state the notes (these are Australia Post's published rates, not the contract rates).",
    input_schema: {
      type: 'object',
      properties: {
        order: { type: 'string', description: 'An order number such as SQ37604. Its lines are what gets packed.' },
        items: { type: 'array', description: 'Products to send, when there is no order', items: { type: 'object', properties: { sku: { type: 'string' }, quantity: { type: 'number' } }, required: ['sku', 'quantity'] } },
        country: { type: 'string', description: 'Where to send it, such as New Zealand or NZ. Left out, an order for a New Zealand customer goes to New Zealand.' },
        postcode: { type: 'string', description: 'A 4-digit Australian postcode, for a parcel within Australia' },
        overrides: { type: 'array', description: 'Weight and size the person has given for products DEAR is missing them for (for ONE unit)', items: { type: 'object', properties: { sku: { type: 'string' }, weightKg: { type: 'number' }, lengthCm: { type: 'number' }, widthCm: { type: 'number' }, heightCm: { type: 'number' } }, required: ['sku'] } },
      },
    },
  },
  {
    name: 'run_report',
    description: `Run a report over the CRM's data, for summaries and analysis. It reads only what the person can see. Choose the dataset, the columns, filters, and optionally add up by group.
${DATASET_HELP}
Dates are YYYY-MM-DD. Adding up (groupBy) totals the number and money columns for each group and adds a Rows count. Returns the first rows only, so add up by group for big questions.`,
    input_schema: {
      type: 'object',
      properties: {
        dataset: { type: 'string', enum: Object.keys(DATASETS) },
        columns: { type: 'array', items: { type: 'string' } },
        filters: { type: 'object', description: 'Any of: from, to, brands[], states[], categories[], statuses[], reps[], realOrdersOnly, inStockOnly, includeArchived. Only those the dataset allows.' },
        groupBy: { type: 'array', items: { type: 'string' } },
        sort: { type: 'object', properties: { key: { type: 'string' }, dir: { type: 'string', enum: ['asc', 'desc'] } } },
        limit: { type: 'number', description: 'How many rows to return, up to 100. Default 40.' },
      },
      required: ['dataset', 'columns'],
    },
  },
  {
    name: 'create_file',
    description: 'Make a file for the person to download from the chat. For data: an Excel workbook or a CSV. Either give a report (same fields as run_report) and the whole result is written to the file without you having to read it, or give your own tables as sheets. For a written report or document: a Word (docx) or PDF file, with the whole text written in markdown in the markdown field (# title, ## headings, - bullets, 1. numbers, | tables |, **bold**). Use it when they ask for a report, a spreadsheet, a Word document, a PDF or something to download.',
    input_schema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'A short name without a path, for example eol-stock-by-brand' },
        format: { type: 'string', enum: ['xlsx', 'csv', 'docx', 'pdf'] },
        markdown: { type: 'string', description: 'For docx and pdf: the full text of the document in markdown. The first # heading becomes the title.' },
        report: { type: 'object', description: 'A report definition: dataset, columns, filters, groupBy, sort' },
        data: { type: 'object', description: 'Or write a query_data data set to the file, every row of it: { dataset, args }', properties: { dataset: { type: 'string', enum: DATA_KEYS }, args: { type: 'object' } } },
        sheets: {
          type: 'array',
          items: { type: 'object', properties: { name: { type: 'string' }, header: { type: 'array', items: { type: 'string' } }, rows: { type: 'array', items: { type: 'array', items: {} } } }, required: ['header', 'rows'] },
        },
      },
      required: ['filename'],
    },
  },
  {
    name: 'query_data',
    description: `Read any other part of the CRM's saved data: balances owing, unpaid invoices, orders to ship, quotes, the team log, the planner, credit, stock on order, conversion, the team and targets. It reads only what the person can see. Returns a summary and the first rows.
${DATA_HELP}
Put the options in args, for example {"dataset":"balances_owing","args":{"state":"VIC","minDaysOverdue":30}}. For sales lines, products and customers use run_report.`,
    input_schema: {
      type: 'object',
      properties: {
        dataset: { type: 'string', enum: DATA_KEYS },
        args: { type: 'object', description: 'The options listed for that dataset' },
        limit: { type: 'number', description: 'How many rows to return, up to 100. Default 40. The summary always covers every row.' },
      },
      required: ['dataset'],
    },
  },
  {
    name: 'make_chart',
    description: 'Draw a chart in the chat: column, bar (horizontal, good for long names), stacked_column, line or pie. Either give the labels and numbers yourself (series), or point it at data and it reads every row for you, which is better for anything big: data = { dataset and args (as query_data) or report (as run_report), labelColumn, valueColumns, or seriesColumn plus valueColumn to make one line or bar group per brand, state and so on, sortBy, top }. Column names are the keys shown in the data\'s columns. Use it whenever a picture would help: trends, comparisons, shares of a total.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['column', 'bar', 'stacked_column', 'line', 'pie'] }, title: { type: 'string' },
        labels: { type: 'array', items: { type: 'string' } }, series: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, values: { type: 'array', items: { type: ['number', 'null'] } } }, required: ['name', 'values'] } },
        format: { type: 'string', enum: ['number', 'money', 'percent'] }, xLabel: { type: 'string' }, yLabel: { type: 'string' },
        data: {
          type: 'object',
          properties: {
            dataset: { type: 'string', enum: DATA_KEYS }, args: { type: 'object' }, report: { type: 'object' },
            labelColumn: { type: 'string' }, valueColumns: { type: 'array', items: { type: 'string' } }, seriesColumn: { type: 'string' }, valueColumn: { type: 'string' },
            sortBy: { type: 'string', enum: ['value', 'label', 'none'] }, top: { type: 'number' },
          },
        },
      },
      required: ['type'],
    },
  },
  {
    name: 'calculate',
    description: `Exact arithmetic. Use it for every calculation beyond a trivial one (totals, percentages, averages, growth, margins, GST, repayments, anything with several steps). Never work such numbers out yourself.
Give a list of calculations, in order. Name a result (name) to use it in later ones. Each expression uses numbers, + - * / ^, brackets, a % after a number (12% is 0.12), pi and e, and these functions: abs, sqrt, pow, exp, ln, log (base 10), floor, ceil, trunc, round(x, decimals), mod, min, max, sum, count, mean (or avg), median, stdev (sample), stdevp, variance, pct(part, whole) as a percent, change(old, new) as a percent, cagr(start, end, years) as a fraction, pmt(rate, periods, amount), exgst(x), incgst(x), gst(x) for Australian GST at 10%.
Example: [{ "name": "ex", "expr": "exgst(1230.02)" }, { "label": "Margin %", "expr": "round(pct(ex - 700, ex), 1)" }]. Round money with round(x, 2).`,
    input_schema: {
      type: 'object',
      properties: {
        calculations: {
          type: 'array',
          items: { type: 'object', properties: { name: { type: 'string', description: 'Optional. Lets later calculations use this result.' }, label: { type: 'string' }, expr: { type: 'string' } }, required: ['expr'] },
        },
      },
      required: ['calculations'],
    },
  },
];

const LIMIT_CHARS = 7000;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const out = (v: unknown, max = LIMIT_CHARS) => { const s = JSON.stringify(v); return s.length > max ? `${s.slice(0, max)}…(cut: ask for something narrower)` : s; };
// A result that is too big is trimmed by whole rows, so what Claude reads is always valid JSON, and it is told how many it got.
function fitRows(build: (rows: unknown[], cut: boolean) => object, all: unknown[], max = 24000): string {
  let n = all.length, payload = build(all.slice(0, n), false);
  while (JSON.stringify(payload).length > max && n > 1) { n = Math.max(1, Math.floor(n * 0.8)); payload = build(all.slice(0, n), true); }
  return JSON.stringify(payload);
}
const day = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function statuses(ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await prisma.$queryRaw<{ account_id: string; status: string }[]>`select account_id, status from crm.account_status where account_id = any(${ids}::uuid[])`;
  return new Map(rows.map(r => [r.account_id, r.status]));
}

export async function runTool(name: string, input: any, ctx: Ctx): Promise<string> {
  try {
    switch (name) {
      case 'find_accounts': {
        const q = String(input?.query ?? '').trim();
        if (q.length < 2) return out({ error: 'Give at least 2 letters of the name' });
        const accounts = await prisma.account.findMany({
          where: { AND: [await territoryWhere(ctx.rep), { name: { contains: q, mode: 'insensitive' } }] },
          select: { id: true, name: true, region: true, archived: true, spend365: true, lastOrderAt: true },
          orderBy: { spend365: 'desc' }, take: 8,
        });
        const st = await statuses(accounts.map(a => a.id));
        return out({ matches: accounts.map(a => ({ id: a.id, name: a.name, state: a.region, status: st.get(a.id) ?? null, hiddenFromLists: a.archived, lastOrder: day(a.lastOrderAt), spend365: a.spend365 })) });
      }
      case 'account_details': {
        try { return await accountDetails(ctx, input?.customer ?? input?.accountId); }
        catch (e) { if (e instanceof DataError) return out({ error: e.message }); throw e; }
      }
      case 'order_details': {
        try { return await orderDetails(ctx, input?.orderNo); }
        catch (e) { if (e instanceof DataError) return out({ error: e.message }); throw e; }
      }
      case 'open_quotes': {
        const state = String(input?.state ?? '').trim().toUpperCase();
        const min = Number(input?.minAgeDays);
        const r = await openQuotes(ctx.rep, state ? [state] : undefined);
        const rows = r.rows.filter(x => !Number.isFinite(min) || x.ageDays >= min).slice(0, 25);
        return out({ count: r.count, showing: rows.length, totalIncGst: r.total, stillToPay: r.remaining,
          quotes: rows.map(x => ({ number: x.number, customer: x.customer, state: x.region, date: day(x.date), ageDays: x.ageDays, totalIncGst: x.amount, paidSoFar: x.paid, remaining: x.remaining, payment: x.payment, stage: x.stage, nextFollowUp: x.followUp.next })) });
      }
      case 'freight_quote': {
        try { return await freightQuote(ctx, input); }
        catch (e) { if (e instanceof DataError) return out({ error: e.message }); throw e; }
      }
      case 'product_lookup': {
        const q = String(input?.query ?? '').trim();
        const status = isStatusKey(input?.status) ? input.status : null;
        if (!q && !status) return out({ error: 'Give a SKU, a name, a brand or a status' });
        const where: any[] = [{ OR: [{ status: null }, { status: { not: 'Deprecated' } }] }];
        if (q) where.push({ OR: [{ sku: { contains: q, mode: 'insensitive' } }, { name: { contains: q, mode: 'insensitive' } }, { brand: { contains: q, mode: 'insensitive' } }] });
        if (status) where.push({ lifecycle: status });
        if (input?.inStockOnly === true) where.push({ available: { gt: 0 } });
        const products = await prisma.product.findMany({ where: { AND: where }, orderBy: [{ brand: 'asc' }, { sku: 'asc' }], take: 15 });
        const incoming = await incomingFor(products.map(p => p.sku));
        const descriptions = await productDescriptions(products.map(p => p.sku));
        const increments = await productIncrements(products.map(p => p.sku));
        const specs = await productSpecs(products.map(p => p.sku));
        return out({ showing: products.length, products: products.map(p => {
          const eta = chooseEta(p.eta, p.onOrder, incoming.get(p.sku) ?? [], ctx.today);
          return { sku: p.sku, name: p.name, brand: p.brand, status: statusLabel(isStatusKey(p.lifecycle) ? p.lifecycle : null) || null, description: (descriptions.get(p.sku) ?? '').slice(0, 400) || null, orderIncrement: increments.get(p.sku) ?? null, size: fmtDimensions(specs.get(p.sku)?.lengthCm, specs.get(p.sku)?.widthCm, specs.get(p.sku)?.heightCm), weight: fmtWeight(specs.get(p.sku)?.weightKg), available: p.available, onOrder: p.onOrder,
            eta: eta ? { date: eta.date, late: eta.late, from: eta.source === 'manual' ? 'set by hand' : eta.ref ? `purchase order ${eta.ref}` : 'incoming purchase order' } : null, wholesaleExGst: wholesalePrice(p.prices as any) };
        }) });
      }
      case 'run_report': {
        try {
          const def = parseDefinition(input);
          const r = await runReport(def, ctx.rep, ctx.today);
          const limit = Math.min(Math.max(Math.floor(Number(input?.limit)) || 40, 1), 100);
          const cols = r.columns.map(c => ({ key: c.key, label: c.label }));
          return fitRows((rows, cut) => ({ total: r.total, showing: rows.length, ...(cut ? { note: 'Cut to fit: ask for fewer columns or group the data' } : {}), columns: cols, rows }), r.rows.slice(0, limit));
        } catch (e) {
          if (e instanceof ReportInputError) return out({ error: e.message });
          throw e;
        }
      }
      case 'create_file': {
        if (!ctx.addFile) return out({ error: 'Files cannot be made here' });
        const format: OutFormat = (['csv', 'docx', 'pdf'] as const).find(f => f === input?.format) ?? 'xlsx';
        const filename = safeFilename(input?.filename, format);
        const mime = { xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv: 'text/csv', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', pdf: 'application/pdf' }[format];
        let buffer: Buffer, rows = 0;
        try {
          if (format === 'docx' || format === 'pdf') {
            const md = String(input?.markdown ?? '').trim();
            if (md.length < 20) return out({ error: 'Write the whole document in the markdown field' });
            if (md.length > 60000) return out({ error: 'That document is too long. Shorten it or make two files.' });
            const { blocks, title } = withTitle(parseMarkdown(md), filename.replace(/\.(docx|pdf)$/, '').replace(/-/g, ' '));
            buffer = format === 'docx' ? await renderDocx(blocks, { title, on: ctx.today }) : await renderPdf(blocks, { title, on: ctx.today });
            rows = blocks.length;
          } else if (input?.data) {
            const r = await runDataset(input.data.dataset, input.data.args, ctx);
            const rows2 = r.rows.slice(0, 20000);
            rows = rows2.length;
            const header = r.columns.map(c => c.label), body = rows2.map(x => r.columns.map(c => x[c.key] ?? ''));
            if (format === 'csv') buffer = Buffer.from(toCsv(header, body), 'utf8');
            else {
              const wb = XLSX.utils.book_new();
              const ws = XLSX.utils.aoa_to_sheet([header, ...body]);
              ws['!cols'] = header.map(h => ({ wch: Math.min(40, Math.max(10, h.length + 2)) }));
              XLSX.utils.book_append_sheet(wb, ws, 'Data');
              XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['About this export'], ['Data set', String(input.data.dataset)], ['Options', JSON.stringify(input.data.args ?? {})], ['Rows', rows2.length], ['Made', ctx.today], ['By', 'CRM assistant']]), 'About this export');
              buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
            }
          } else if (input?.report) {
            const def = parseDefinition(input.report);
            const r = await runReport(def, ctx.rep, ctx.today);
            rows = r.total;
            buffer = format === 'xlsx'
              ? reportWorkbook(r, def, { name: filename.replace(/\.xlsx$/, ''), by: 'CRM assistant', on: ctx.today })
              : Buffer.from(toCsv(r.columns.map(c => c.label), r.rows.map(x => r.columns.map(c => x[c.key]))), 'utf8');
          } else if (Array.isArray(input?.sheets) && input.sheets.length) {
            const sheets = (input.sheets as any[]).slice(0, 10);
            const tidy = sheets.map((sh, i) => ({
              name: String(sh?.name || '').replace(/[\\/?*[\]:]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31) || `Sheet ${i + 1}`,
              header: (Array.isArray(sh?.header) ? sh.header.map(String) : []) as string[],
              rows: (Array.isArray(sh?.rows) ? (sh.rows as unknown[][]).filter(Array.isArray).slice(0, 20000) : []) as unknown[][],
            }));
            if (tidy.some(sh => !sh.header.length)) return out({ error: 'Every sheet needs a header row' });
            rows = tidy.reduce((t, sh) => t + sh.rows.length, 0);
            if (format === 'csv') buffer = Buffer.from(toCsv(tidy[0].header, tidy[0].rows), 'utf8');
            else {
              const wb = XLSX.utils.book_new();
              for (const sh of tidy) {
                const ws = XLSX.utils.aoa_to_sheet([sh.header, ...sh.rows]);
                ws['!cols'] = sh.header.map(h => ({ wch: Math.min(40, Math.max(10, h.length + 2)) }));
                XLSX.utils.book_append_sheet(wb, ws, sh.name);
              }
              buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
            }
          } else return out({ error: 'Give a report, a data set, or sheets to put in the file' });
        } catch (e) {
          if (e instanceof ReportInputError || e instanceof DocsMissingError || e instanceof DataError) return out({ error: e.message });
          throw e;
        }
        const f = await ctx.addFile({ name: filename, mime, buffer });
        return out({ created: f.name, ...(format === 'docx' || format === 'pdf' ? {} : { rows }), note: 'The person can download it from the chat. Do not paste its contents.' });
      }
      case 'query_data': {
        try {
          const r = await runDataset(input?.dataset, input?.args, ctx);
          const limit = Math.min(Math.max(Math.floor(Number(input?.limit)) || 40, 1), 100);
          const keys = r.columns.map(c => c.key);
          return fitRows((rows, cut) => ({ dataset: input.dataset, summary: r.summary ?? {}, total: r.rows.length, showing: rows.length, ...(cut ? { note: 'Cut to fit: ask for a narrower question (one state, one customer)' } : {}), columns: keys, rows }), r.rows.slice(0, limit));
        } catch (e) {
          if (e instanceof DataError) return out({ error: e.message });
          throw e;
        }
      }
      case 'make_chart': {
        if (!ctx.addChart) return out({ error: 'Charts cannot be shown here' });
        try {
          const type = input?.type as ChartType; let spec: ChartSpec;
          if (input?.data && typeof input.data === 'object') {
            const d = input.data as Record<string, any>; let columns: { key: string; label: string }[], rows: Record<string, unknown>[];
            if (d.report) { const def = parseDefinition(d.report), r = await runReport(def, ctx.rep, ctx.today); columns = r.columns.map(c => ({ key: c.key, label: c.label })); rows = r.rows as Record<string, unknown>[]; }
            else if (d.dataset) { const r = await runDataset(d.dataset, d.args, ctx); columns = r.columns; rows = r.rows; }
            else return out({ error: 'data needs a dataset (and args) or a report' });
            const col = (n: unknown) => { const w = String(n ?? '').trim().toLowerCase(); return columns.find(c => c.key.toLowerCase() === w)?.key ?? columns.find(c => c.label.toLowerCase() === w)?.key ?? String(n ?? ''); };
            const labelOf = (key: string) => columns.find(c => c.key === key)?.label ?? key;
            spec = specFromRows({ rows, type, title: input.title, labelColumn: col(d.labelColumn), valueColumns: Array.isArray(d.valueColumns) ? d.valueColumns.map(col) : undefined, seriesColumn: d.seriesColumn ? col(d.seriesColumn) : undefined, valueColumn: d.valueColumn ? col(d.valueColumn) : undefined, sortBy: d.sortBy, top: d.top, format: input.format, xLabel: input.xLabel, yLabel: input.yLabel, labelOf });
          } else spec = { type, title: input?.title, labels: input?.labels, series: input?.series, format: input?.format, xLabel: input?.xLabel, yLabel: input?.yLabel };
          const svg = renderChart(spec);
          ctx.addChart({ title: spec.title ?? 'Chart', svg });
          return out({ drawn: true, title: spec.title ?? null, points: spec.labels.length, series: spec.series.map(s => s.name), note: 'The chart is shown in the chat. Describe what it shows; do not repeat all the numbers.' });
        } catch (e) {
          if (e instanceof ChartError || e instanceof ReportInputError || e instanceof DataError) return out({ error: e.message });
          throw e;
        }
      }
      case 'calculate': {
        try { return out({ results: runCalculations(input?.calculations) }); }
        catch (e) { if (e instanceof CalcError) return out({ error: e.message }); throw e; }
      }
      default:
        return out({ error: `Unknown tool ${name}` });
    }
  } catch (e) {
    console.error('assistant tool failed', name, e);
    return out({ error: 'That look-up failed. Say so, do not guess.' });
  }
}