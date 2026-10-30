import pg from 'pg';
import { planProblems } from './planGuard.js';

// How a query is run. Every query goes inside a transaction that is READ ONLY, with a time limit, wrapped so that no more than maxRows + 1 rows ever come back
// (the extra one tells us whether there were more). The transaction is always rolled back. The connection itself is the scoped read-only database user
// (radar-readonly-role.sql), which is the real guard; this is the belt to its braces.

export type Queryable = { query(text: string): Promise<{ rows: Record<string, unknown>[]; fields: string[] }> };
export type Db = { withClient<T>(fn: (c: Queryable) => Promise<T>): Promise<T>; close?(): Promise<void> };
/** A question the database's own plan shows would read something it must not. Its message is written for Claude and the manager to read. */
export class QueryRefused extends Error {}
export type QueryResult = { columns: string[]; rows: Record<string, unknown>[]; truncated: boolean; ms: number };

export async function runReadOnly(db: Db, sql: string, opts: { maxRows: number; timeoutMs: number }): Promise<QueryResult> {
  const t0 = Date.now();
  return db.withClient(async c => {
    try {
      // Every message to the database costs a full round trip (about a quarter of a second from Railway to Supabase), so the set-up and the plan check go in ONE message:
      // open the read-only transaction, set the time limits, and ask the database what the question would read (EXPLAIN runs nothing). Then one message to run it, one to roll back.
      const wrapped = `SELECT * FROM (\n${sql}\n) AS q LIMIT ${Math.floor(opts.maxRows) + 1}`;
      const plan = await c.query(`BEGIN READ ONLY; SET LOCAL statement_timeout = ${Math.max(1000, Math.floor(opts.timeoutMs))}; SET LOCAL lock_timeout = 2000; EXPLAIN (FORMAT JSON, VERBOSE, COSTS OFF) ${wrapped}`);
      const why = planProblems(plan.rows[0]?.['QUERY PLAN']);
      if (why) throw new QueryRefused(why);
      const r = await c.query(wrapped);
      const truncated = r.rows.length > opts.maxRows;
      return { columns: r.fields, rows: truncated ? r.rows.slice(0, opts.maxRows) : r.rows, truncated, ms: Date.now() - t0 };
    } finally {
      await c.query('ROLLBACK').catch(() => { /* the connection is already gone */ });
    }
  });
}

/** The real database, through a small pool. Dates and numbers come back exactly as the database writes them (text), never shifted by this server's time zone. */
export function pgDb(connectionString: string, opts: { ssl?: boolean } = {}): Db {
  for (const oid of [pg.types.builtins.TIMESTAMP, pg.types.builtins.TIMESTAMPTZ, pg.types.builtins.DATE, pg.types.builtins.NUMERIC]) pg.types.setTypeParser(oid, (v: string) => v);
  const pool = new pg.Pool({
    connectionString, max: 3, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000,
    ssl: opts.ssl === false ? false : { rejectUnauthorized: false },   // Supabase's pooler certificate is signed by Supabase's own authority
  });
  pool.on('error', e => console.error('database pool error:', e.message));
  return {
    async withClient(fn) {
      const c = await pool.connect();
      // several statements in one message come back as a list of results: the last one is the answer
      try { return await fn({ query: async t => { const res = (await c.query(t)) as unknown; const r = (Array.isArray(res) ? res[res.length - 1] : res) as pg.QueryResult; return { rows: r.rows, fields: (r.fields ?? []).map(f => f.name) }; } }); }
      finally { c.release(); }
    },
    close: () => pool.end(),
  };
}

// ---- turning rows into text for Claude: CSV is compact and easy for it to read ----
const cell = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  const s = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function toCsv(columns: string[], rows: Record<string, unknown>[], maxChars: number): { text: string; shown: number } {
  const lines = [columns.map(cell).join(',')];
  let size = lines[0].length, shown = 0;
  for (const r of rows) {
    const line = columns.map(c => cell(r[c])).join(',');
    if (size + line.length + 1 > maxChars) break;
    lines.push(line); size += line.length + 1; shown++;
  }
  return { text: lines.join('\n'), shown };
}