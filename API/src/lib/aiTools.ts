import Anthropic from '@anthropic-ai/sdk';
import { prisma } from './prisma';
import { territoryWhere, canSeeAccount } from './territory';
import { openQuotes } from './receivables';
import { chooseEta, incomingFor } from './eta';
import { wholesalePrice } from './pricing';
import { PRODUCT_STATUSES, isStatusKey, statusLabel } from './productImport';
import { DATASETS, parseDefinition, runReport, ReportInputError } from './customReport';
import { reportWorkbook } from './customReportXlsx';
import { safeFilename, toCsv, OutFormat } from './aiFiles';
import { parseMarkdown, withTitle, renderDocx, renderPdf, DocsMissingError } from './aiDocs';
import * as XLSX from 'xlsx';

// What the assistant can look up. Read only: it can read what the person asking can already see, and change nothing.
// Each tool checks the same territory rule as the rest of the app, so the assistant never shows someone another
// territory's accounts. Results are plain data; whatever is written inside them (notes, names) is never an instruction.
export type MadeFile = { id: string; name: string; size: number };
export type Ctx = {
  rep: { id: string; role: string }; today: string;
  addFile?: (f: { name: string; mime: string; buffer: Buffer }) => MadeFile;   // keeps a file the assistant made, for the person to download
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
    name: 'account_summary',
    description: 'Everything useful about one account: contact name, status, spend, recent orders, open quotes and the latest notes the team logged. Needs an account id from find_accounts. It does not have phone numbers or email addresses.',
    input_schema: { type: 'object', properties: { accountId: { type: 'string' } }, required: ['accountId'] },
  },
  {
    name: 'open_quotes',
    description: 'Quotes and unpaid orders (an order stays until it is both paid and confirmed), oldest first, with age, total, paid so far, what is still to pay and the next follow-up. Optionally only one state or only those older than some days.',
    input_schema: { type: 'object', properties: { state: { type: 'string', description: 'For example VIC' }, minAgeDays: { type: 'number' } } },
  },
  {
    name: 'product_lookup',
    description: 'Look up products by SKU, name or brand: stock available, on order, ETA of the next delivery, status (EOL, Discontinued, Pre-order, New) and wholesale price. Can list by status, for example every EOL product still in stock.',
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
        sheets: {
          type: 'array',
          items: { type: 'object', properties: { name: { type: 'string' }, header: { type: 'array', items: { type: 'string' } }, rows: { type: 'array', items: { type: 'array', items: {} } } }, required: ['header', 'rows'] },
        },
      },
      required: ['filename'],
    },
  },
];

const LIMIT_CHARS = 7000;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const out = (v: unknown, max = LIMIT_CHARS) => { const s = JSON.stringify(v); return s.length > max ? `${s.slice(0, max)}…(cut: ask for something narrower)` : s; };
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
      case 'account_summary': {
        const id = String(input?.accountId ?? '');
        if (!UUID.test(id)) return out({ error: 'accountId must come from find_accounts' });
        const a = await prisma.account.findUnique({ where: { id }, select: { id: true, name: true, region: true, repId: true, contactName: true, type: true, spend30: true, spend90: true, spend365: true, lastOrderAt: true, rep: { select: { name: true } } } });
        if (!a || !(await canSeeAccount(ctx.rep, a))) return out({ error: 'That account is not available to you' });
        const [st, activity, quotes] = await Promise.all([
          statuses([id]),
          prisma.activity.findMany({ where: { accountId: id }, orderBy: { occurredAt: 'desc' }, take: 8, select: { type: true, note: true, occurredAt: true, rep: { select: { name: true } } } }),
          prisma.quote.findMany({ where: { accountId: id, source: { not: 'rhino-history' }, NOT: { number: { startsWith: 'Q' } } }, orderBy: { sentAt: 'desc' }, take: 10, select: { number: true, sentAt: true, fulfillmentStatus: true, total: true, amount: true } }),
        ]);
        const open = ['DRAFT', 'ESTIMATING', 'ESTIMATED', 'ORDERING'];
        return out({
          name: a.name, state: a.region, rep: a.rep?.name ?? null, status: st.get(id) ?? null, contactName: a.contactName,   // phone and email are deliberately not sent to Claude
          spend: { last30days: a.spend30, last90days: a.spend90, last365days: a.spend365 }, lastOrder: day(a.lastOrderAt),
          recentOrders: quotes.map(q => ({ number: q.number, date: day(q.sentAt), status: q.fulfillmentStatus, totalIncGst: q.total ?? q.amount, open: open.includes((q.fulfillmentStatus ?? '').toUpperCase()) })),
          recentNotes: activity.map(x => ({ date: day(x.occurredAt), type: x.type, by: x.rep?.name ?? null, note: clip(x.note, 300) })),
        });
      }
      case 'open_quotes': {
        const state = String(input?.state ?? '').trim().toUpperCase();
        const min = Number(input?.minAgeDays);
        const r = await openQuotes(ctx.rep, state ? [state] : undefined);
        const rows = r.rows.filter(x => !Number.isFinite(min) || x.ageDays >= min).slice(0, 25);
        return out({ count: r.count, showing: rows.length, totalIncGst: r.total, stillToPay: r.remaining,
          quotes: rows.map(x => ({ number: x.number, customer: x.customer, state: x.region, date: day(x.date), ageDays: x.ageDays, totalIncGst: x.amount, paidSoFar: x.paid, remaining: x.remaining, payment: x.payment, stage: x.stage, nextFollowUp: x.followUp.next })) });
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
        return out({ showing: products.length, products: products.map(p => {
          const eta = chooseEta(p.eta, p.onOrder, incoming.get(p.sku) ?? [], ctx.today);
          return { sku: p.sku, name: p.name, brand: p.brand, status: statusLabel(isStatusKey(p.lifecycle) ? p.lifecycle : null) || null, available: p.available, onOrder: p.onOrder,
            eta: eta ? { date: eta.date, late: eta.late, from: eta.source === 'manual' ? 'set by hand' : eta.ref ? `order ${eta.ref}` : 'incoming order' } : null, wholesaleExGst: wholesalePrice(p.prices as any) };
        }) });
      }
      case 'run_report': {
        try {
          const def = parseDefinition(input);
          const r = await runReport(def, ctx.rep, ctx.today);
          const limit = Math.min(Math.max(Math.floor(Number(input?.limit)) || 40, 1), 100);
          return out({ total: r.total, showing: Math.min(r.total, limit), columns: r.columns.map(c => ({ key: c.key, label: c.label })), rows: r.rows.slice(0, limit) }, 14000);
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
          } else return out({ error: 'Give either a report or sheets to put in the file' });
        } catch (e) {
          if (e instanceof ReportInputError || e instanceof DocsMissingError) return out({ error: e.message });
          throw e;
        }
        const f = ctx.addFile({ name: filename, mime, buffer });
        return out({ created: f.name, ...(format === 'docx' || format === 'pdf' ? {} : { rows }), note: 'The person can download it from the chat. Do not paste its contents.' });
      }
      default:
        return out({ error: `Unknown tool ${name}` });
    }
  } catch (e) {
    console.error('assistant tool failed', name, e);
    return out({ error: 'That look-up failed. Say so, do not guess.' });
  }
}