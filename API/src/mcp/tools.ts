import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { checkQuery } from './sqlGuard.js';
import { runReadOnly, toCsv, QueryRefused, type Db } from './db.js';

export type ToolContext = {
  person: string;
  db: Db;
  limits: { defaultRows: number; maxRows: number; timeoutMs: number };
  take: (person: string) => boolean;   // false when this person has asked too many questions this minute
  log: (entry: Record<string, unknown>) => void;
};

// What Claude is told about this server when it connects. Only things that are true of Radar's data go here.
const INSTRUCTIONS = `This is a read-only window onto Radar, the CRM behind ordering (Postgres, schema crm). Start with list_tables and describe_table. You can only see what ordering needs: customer contact details, email and staff chats are not available, supplier costs are not available unless the owner has switched them on, and nothing can be changed.

How Radar's data works (these are the team's own rules, the ones its Ordering reports and forecast use):
- Name the columns you want. crm.quotes and crm.accounts only allow named columns, so SELECT * is refused on them.
- Orders are crm.quotes, and the order status is fulfillment_status. Live orders have source <> 'rhino-history' and number not like 'Q%'.
- Dates are Melbourne calendar days. An order's date is ((sent_at at time zone 'UTC') at time zone 'Australia/Melbourne')::date. Do not use sent_at::date: older history rows are stored as Melbourne midnight expressed in UTC, so it gives the day before.
- An order counts as a sale only if upper(coalesce(fulfillment_status, '')) is not one of DRAFT, ESTIMATING, ESTIMATED, ORDERING, VOIDED, CREDITED, QUOTE. For demand and forecasts also require misc_type is null (misc_type marks warranty, marketing and similar orders that are not customer demand). Orders at ORDERING are unconfirmed quotes, not sales.
- Order lines are crm.quote_lines (sku, product_name, brand, quantity, unit_price, line_total, amounts as stored from DEAR): join to crm.quotes on quote_id.
- Products are crm.products, one row per sku, with on_hand, allocated, available, on_order and eta (the next arrival date, when someone has set it).
- Purchase orders are crm.purchases (supplier, status, receiving_status, order_date, required_by) and crm.purchase_lines (quantity_ordered, quantity_received). Still to arrive means quantity_ordered - quantity_received > 0 on a purchase order whose status is not VOIDED, CREDITED or DRAFT and which is not fully received.
- Do the work in SQL: filter, group and aggregate so the answer is a few hundred rows at most. Results are capped (200 rows unless you ask for more, up to the limit the tool states).
- When you give a number, say which dates and filters it used, so it can be checked. If a result looks surprising, say so rather than explaining it away.`;

const TABLE = /^(?:[a-z_][a-z0-9_]*\.)?[a-z_][a-z0-9_]*$/;

export function buildServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: 'radar-ordering', version: '0.1.0' }, { instructions: INSTRUCTIONS });
  // The library's own types for registerTool are so heavy that the compiler runs out of memory under the older module setting the CRM API uses
  // (moduleResolution "node"). Describing the call plainly keeps every build fast; the library still checks each call against these same zod shapes.
  type Reply = { content: { type: 'text'; text: string }[]; isError?: boolean };
  type ToolConfig = { title?: string; description?: string; inputSchema?: Record<string, z.ZodTypeAny>; annotations?: Record<string, boolean> };
  const tool = (name: string, config: ToolConfig, cb: (args: any) => Promise<Reply>): void => { (server.registerTool as unknown as (n: string, c: ToolConfig, f: (a: any) => Promise<Reply>) => unknown).call(server, name, config, cb); };
  const reply = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) });
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const friendly = (e: unknown): string => {
    if (e instanceof QueryRefused) return `Not run: ${e.message}`;
    const m = String((e as Error)?.message ?? e);
    if (/permission denied/i.test(m)) return `${m}. You can only read the tables and columns that list_tables shows.`;
    if (/statement timeout|canceling statement/i.test(m)) return `The query took longer than ${Math.round(ctx.limits.timeoutMs / 1000)} seconds and was stopped. Narrow it (a date range, a brand) or aggregate in SQL.`;
    return m;
  };
  const run = async (tool: string, sql: string, maxRows: number) => {
    const t0 = Date.now();
    try {
      const r = await runReadOnly(ctx.db, sql, { maxRows, timeoutMs: ctx.limits.timeoutMs });
      ctx.log({ person: ctx.person, tool, ok: true, ms: Date.now() - t0, rows: r.rows.length, truncated: r.truncated, sql: sql.slice(0, 600) });
      return r;
    } catch (e) {
      ctx.log({ person: ctx.person, tool, ok: false, ms: Date.now() - t0, error: String((e as Error)?.message ?? e).slice(0, 200), sql: sql.slice(0, 600) });
      throw e;
    }
  };

  tool('list_tables', {
    title: 'List tables',
    description: 'Lists every table and view you can read in Radar, with each one\'s columns and types. Start here.',
    annotations: readOnly,
  }, async () => {
    if (!ctx.take(ctx.person)) return reply('Too many questions in the last minute. Wait a moment and try again.', true);
    try {
      const r = await run('list_tables', `select table_name, string_agg(column_name || ' ' || data_type, ', ' order by ordinal_position) as columns from information_schema.columns where table_schema = 'crm' group by table_name order by table_name`, 500);
      return reply(r.rows.length ? r.rows.map(x => `crm.${x.table_name}: ${x.columns}`).join('\n') : 'No tables are readable.');
    } catch (e) { return reply(friendly(e), true); }
  });

  tool('describe_table', {
    title: 'Describe a table',
    description: 'Shows the columns, types and whether each can be empty, for one table or view in the crm schema.',
    inputSchema: { table: z.string().max(80).describe('A table name such as products or crm.quote_lines') },
    annotations: readOnly,
  }, async ({ table }) => {
    if (!ctx.take(ctx.person)) return reply('Too many questions in the last minute. Wait a moment and try again.', true);
    const t = table.trim().toLowerCase();
    if (!TABLE.test(t)) return reply('Give a plain table name such as products or crm.quote_lines.', true);
    const [schema, name] = t.includes('.') ? t.split('.') : ['crm', t];
    if (schema !== 'crm') return reply('Only the crm schema is available.', true);
    try {
      const r = await run('describe_table', `select column_name, data_type, is_nullable from information_schema.columns where table_schema = 'crm' and table_name = '${name}' order by ordinal_position`, 500);
      if (!r.rows.length) return reply(`There is no table or view called crm.${name} that you can read. Use list_tables to see what is available.`, true);
      return reply(`crm.${name}\n` + r.rows.map(x => `  ${x.column_name}  ${x.data_type}${x.is_nullable === 'YES' ? '  (can be empty)' : ''}`).join('\n'));
    } catch (e) { return reply(friendly(e), true); }
  });

  tool('query', {
    title: 'Run a read-only query',
    description: `Runs one SELECT (or WITH ... SELECT) against Radar and returns the rows as CSV. Read-only: nothing can be changed. Results are capped at ${ctx.limits.defaultRows} rows unless you pass max_rows (up to ${ctx.limits.maxRows}), and a query is stopped after ${Math.round(ctx.limits.timeoutMs / 1000)} seconds, so filter and aggregate in SQL.`,
    inputSchema: {
      sql: z.string().max(20000).describe('One SELECT statement. Name your columns; do not use SELECT * on crm.quotes or crm.accounts.'),
      max_rows: z.number().int().min(1).max(ctx.limits.maxRows).optional().describe(`How many rows to return at most (default ${ctx.limits.defaultRows}).`),
    },
    annotations: readOnly,
  }, async ({ sql, max_rows }) => {
    if (!ctx.take(ctx.person)) return reply('Too many questions in the last minute. Wait a moment and try again.', true);
    const g = checkQuery(sql);
    if (!g.ok) { ctx.log({ person: ctx.person, tool: 'query', ok: false, refused: g.reason, sql: String(sql).slice(0, 600) }); return reply(`Not run: ${g.reason}`, true); }
    const maxRows = Math.min(max_rows ?? ctx.limits.defaultRows, ctx.limits.maxRows);
    try {
      const r = await run('query', g.sql, maxRows);
      const csv = toCsv(r.columns, r.rows, 120_000);
      const cutBySize = csv.shown < r.rows.length;
      const more = r.truncated || cutBySize;
      const head = `${csv.shown} row${csv.shown === 1 ? '' : 's'} in ${r.ms} ms.` + (more
        ? (cutBySize ? ' The output was cut to stay a readable size: select fewer columns, narrow the query, or aggregate in SQL.'
          : ` There are more rows than this: ask for more with max_rows (up to ${ctx.limits.maxRows}), or filter and aggregate in SQL.`) : '');
      return reply(`${head}\n\n${csv.text}`);
    } catch (e) { return reply(friendly(e), true); }
  });

  return server;
}
