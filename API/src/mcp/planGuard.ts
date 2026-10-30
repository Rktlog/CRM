import { DANGEROUS_FUNCTIONS } from './sqlGuard.js';

// The second lock, and the one that cannot be fooled by how the SQL is written.
//
// sqlGuard.ts reads the TEXT of a question. Text can be written many ways: a quoted name, a name spelled with escape codes (U&"\006e\0065\0074" is net), a comment in the middle,
// a table name that only means something because the database user's search path was changed. So before a question is run, the database is asked for its PLAN: the list of
// tables it will really read, with the schema each one belongs to, and every function call written out in its one standard spelling. This checks that list.
//
//  - Every table must be in crm, or be a system catalogue (names of tables and columns, no business data).
//  - No function from the not-allowed list may appear anywhere in the plan.
//
// Why it is needed: Supabase's own pg_net tables (net._http_response and net.http_request_queue, the log of web requests the database makes) can be read by every database
// user, and Supabase owns them, so that cannot be switched off from your side. This is what keeps the connector away from them.

export const ALLOWED_SCHEMAS = new Set(['crm', 'pg_catalog', 'information_schema']);

export function planProblems(plan: unknown): string | null {
  let root: unknown = plan;
  if (typeof root === 'string') { try { root = JSON.parse(root); } catch { return 'the database gave a plan that could not be read, so the question was not run.'; } }
  const top = (Array.isArray(root) ? (root[0] as { Plan?: unknown } | undefined)?.Plan : (root as { Plan?: unknown } | null)?.Plan);
  if (!top || typeof top !== 'object') return 'the database gave no plan for that question, so it was not run.';

  const outside = new Set<string>();
  const walk = (n: unknown): void => {
    if (!n || typeof n !== 'object') return;
    const node = n as Record<string, unknown>;
    if (typeof node['Relation Name'] === 'string' && !ALLOWED_SCHEMAS.has(String(node['Schema'] ?? ''))) outside.add(`${node['Schema'] ?? '?'}.${node['Relation Name']}`);
    for (const v of Object.values(node)) { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') walk(v); }
  };
  walk(top);
  if (outside.size) return `that question would read ${[...outside].slice(0, 3).join(', ')}, which is outside the crm tables. Only crm tables can be read here.`;

  if (DANGEROUS_FUNCTIONS.test(JSON.stringify(root))) return 'that question uses a database function that is not allowed here.';
  return null;
}
