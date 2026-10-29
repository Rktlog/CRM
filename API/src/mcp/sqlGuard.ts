// The first check on a query Claude wants to run. The database user can only read what it was granted, inside a read-only transaction: this check is the
// first, friendlier layer on top, which gives a clear reason in plain words instead of a database error.
//
// It looks only at the SQL itself, with everything inside quotes and comments blanked out first, so a word inside a text value or a comment is never mistaken
// for SQL. Anything it is not sure about it refuses.

export type GuardResult = { ok: true; sql: string } | { ok: false; reason: string };

const MAX_LENGTH = 20_000;

/** Blanks the inside of quotes and comments (keeping their length, so positions still line up). Returns null if a quote or comment is never closed. */
function blankLiterals(sql: string): { code: string; semicolons: number[] } | null {
  const out: string[] = [];
  const semicolons: number[] = [];
  let i = 0;
  const n = sql.length;
  const blank = (from: number, to: number) => { for (let k = from; k < to; k++) out.push(sql[k] === '\n' ? '\n' : ' '); };
  while (i < n) {
    const c = sql[i], d = sql[i + 1];
    if (c === '-' && d === '-') { const s = i; while (i < n && sql[i] !== '\n') i++; blank(s, i); continue; }
    if (c === '/' && d === '*') {   // block comments nest in Postgres
      const s = i; let depth = 1; i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth++; i += 2; }
        else if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i += 2; }
        else i++;
      }
      if (depth > 0) return null;
      blank(s, i); continue;
    }
    if (c === "'") {
      const before = i > 0 ? sql[i - 1] : '';
      const escapes = /[eE]/.test(before) && !(i > 1 && /\w/.test(sql[i - 2]));   // E'...' strings treat a backslash as an escape
      const s = i; i++;
      let closed = false;
      while (i < n) {
        if (escapes && sql[i] === '\\') { i += 2; continue; }
        if (sql[i] === "'") { if (sql[i + 1] === "'") { i += 2; continue; } closed = true; break; }
        i++;
      }
      if (!closed) return null;
      i++;
      out.push("'"); blank(s + 1, i - 1); out.push("'"); continue;
    }
    if (c === '"') {
      const s = i; i++;
      let closed = false;
      while (i < n) { if (sql[i] === '"') { if (sql[i + 1] === '"') { i += 2; continue; } closed = true; break; } i++; }
      if (!closed) return null;
      i++;
      out.push('"'); for (let k = s + 1; k < i - 1; k++) out.push('_'); out.push('"'); continue;
    }
    if (c === '$') {   // $$ ... $$ and $tag$ ... $tag$ strings ($1 is not one)
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 80));
      if (m) {
        const tag = m[0]; const end = sql.indexOf(tag, i + tag.length);
        if (end === -1) return null;
        const s = i; i = end + tag.length;
        out.push(tag); blank(s + tag.length, end); out.push(tag); continue;
      }
    }
    if (c === ';') semicolons.push(i);
    out.push(c); i++;
  }
  return { code: out.join(''), semicolons };
}

const DANGEROUS_FUNCTIONS = /\b(pg_sleep\w*|pg_read_\w+|pg_ls_\w+|pg_file_\w+|pg_logdir_ls|lo_\w+|dblink\w*|pg_terminate_backend|pg_cancel_backend|set_config|pg_reload_conf|pg_rotate_logfile|pg_stat_activity|pg_authid|pg_shadow|pg_hba_file_rules)\b/i;
const WRITES = /\b(insert\s+into|delete\s+from|merge\s+into|update\s+[\w".]+\s+set|truncate|copy|call|do)\b/i;

export function checkQuery(input: string): GuardResult {
  const no = (reason: string): GuardResult => ({ ok: false, reason });
  if (typeof input !== 'string' || !input.trim()) return no('The query is empty.');
  if (input.length > MAX_LENGTH) return no(`The query is too long (the limit is ${MAX_LENGTH.toLocaleString('en-AU')} characters).`);

  const b = blankLiterals(input);
  if (!b) return no('A quote or a comment in the query is never closed.');
  const { code, semicolons } = b;

  // One statement only. A single semicolon at the very end is allowed (and dropped).
  let sql = input;
  if (semicolons.length > 0) {
    const last = semicolons[semicolons.length - 1];
    if (semicolons.length > 1 || code.slice(last + 1).trim() !== '') return no('Only one statement is allowed (no more than one ;, and only at the end).');
    sql = input.slice(0, last) + ' ' + input.slice(last + 1);
  }

  if (!/^\s*(select|with)\b/i.test(code)) return no('Only SELECT queries (including ones that start with WITH) are allowed.');

  let depth = 0;
  for (const ch of code) { if (ch === '(') depth++; else if (ch === ')') { depth--; if (depth < 0) return no('The brackets in the query do not match.'); } }
  if (depth !== 0) return no('The brackets in the query do not match.');

  if (WRITES.test(code)) return no('This query would change data, and this connection is read-only.');
  if (/\binto\b/i.test(code)) return no('SELECT ... INTO is not allowed (it would create a table).');
  if (/\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b/i.test(code)) return no('Row locks (FOR UPDATE and similar) are not allowed.');
  if (DANGEROUS_FUNCTIONS.test(code)) return no('That query uses a database function that is not allowed here.');

  return { ok: true, sql: sql.trim() };
}
