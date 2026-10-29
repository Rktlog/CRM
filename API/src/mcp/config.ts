// Everything the server needs comes from environment variables (set in Railway), so nothing secret is ever in the code.
export type Config = {
  port: number;
  publicUrl: string;                 // the https address this service is reached at, e.g. https://radar-ordering.up.railway.app
  databaseUrl: string;               // the scoped read-only user (radar-readonly-role.sql), never the owner
  oauthSecret: string;               // signs every code and token; changing it signs everyone out
  accessCodes: Map<string, string>;  // person -> the code they type once to connect Claude. Removing a person withdraws their access at once.
  allowedRedirects: string[];        // where sign-in may send the person back to: Claude's own addresses (localhost, which Claude Code uses, is always allowed as well)
  queryTimeoutMs: number;
  defaultRows: number;
  maxRows: number;
  accessTtlSec: number;
  refreshTtlSec: number;
  codeTtlSec: number;
  databaseSsl: boolean;
};

const CLAUDE_REDIRECTS = ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback'];

export function parseAccessCodes(raw: string | undefined): Map<string, string> {
  const m = new Map<string, string>();
  for (const part of (raw ?? '').split(',').map(s => s.trim()).filter(Boolean)) {
    const i = part.indexOf(':');
    if (i < 1) throw new Error(`ACCESS_CODES entry "${part.slice(0, 20)}" should look like name:code`);
    const name = part.slice(0, i).trim(), code = part.slice(i + 1).trim();
    if (!/^[A-Za-z0-9 ._-]{1,40}$/.test(name)) throw new Error(`ACCESS_CODES name "${name}" may only use letters, digits, spaces, dots, dashes and underscores`);
    if (code.length < 12) throw new Error(`The access code for ${name} is too short: use at least 12 characters (a long random string)`);
    m.set(name, code);
  }
  return m;
}

/** The settings. `prefix` lets the connector live inside another service whose own settings must not be touched: with prefix 'MCP_' it reads MCP_DATABASE_URL, MCP_OAUTH_SECRET and so on. */
export function loadConfig(env: Record<string, string | undefined> = process.env, prefix = ''): Config {
  const get = (k: string) => env[prefix + k];
  const need = (k: string) => { const v = get(k)?.trim(); if (!v) throw new Error(`${prefix}${k} is not set`); return v; };
  const publicUrl = need('PUBLIC_URL').replace(/\/+$/, '');
  if (!/^https:\/\//.test(publicUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(publicUrl)) throw new Error(`${prefix}PUBLIC_URL must be an https:// address`);
  const oauthSecret = need('OAUTH_SECRET');
  if (oauthSecret.length < 32) throw new Error(`${prefix}OAUTH_SECRET must be at least 32 characters (a long random string)`);
  const accessCodes = parseAccessCodes(need('ACCESS_CODES'));
  if (accessCodes.size === 0) throw new Error(`${prefix}ACCESS_CODES needs at least one name:code`);
  const num = (k: string, d: number) => { const v = Number(get(k)); return Number.isFinite(v) && v > 0 ? v : d; };
  return {
    port: num('PORT', 3000), publicUrl, databaseUrl: need('DATABASE_URL'), oauthSecret, accessCodes,
    allowedRedirects: [...CLAUDE_REDIRECTS, ...(get('ALLOWED_REDIRECTS') ?? '').split(',').map(s => s.trim()).filter(Boolean)],
    queryTimeoutMs: num('QUERY_TIMEOUT_MS', 15_000), defaultRows: num('DEFAULT_ROWS', 200), maxRows: Math.min(num('MAX_ROWS', 5000), 20_000),
    accessTtlSec: num('ACCESS_TTL_SEC', 3600), refreshTtlSec: num('REFRESH_TTL_SEC', 30 * 86400), codeTtlSec: num('CODE_TTL_SEC', 60),
    databaseSsl: get('DATABASE_SSL') !== 'off',
  };
}
