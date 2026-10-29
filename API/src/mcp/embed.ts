import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadConfig } from './config.js';
import { pgDb, type Db } from './db.js';
import { assertReadOnlyLogin } from './selfCheck.js';
import { createApp } from './app.js';

// The connector living INSIDE another web service (the CRM API), instead of as a service of its own.
//
//  - It is off unless MCP_ACCESS_CODES is set, so deploying this code changes nothing until then (it says so in the log, once, at start-up).
//  - Every setting is prefixed MCP_ (MCP_DATABASE_URL, MCP_OAUTH_SECRET, MCP_ACCESS_CODES, and optionally MCP_PUBLIC_URL, which otherwise
//    falls back to the service's own PUBLIC_API_URL), so none of the service's own settings are read or changed.
//  - Requests for the connector are handed over at the very top, before the service's own middleware (login checks, CORS, body parsing) ever sees them,
//    and every other request goes to the service exactly as before.
//  - If its settings are wrong it switches itself off and says why in the log. It never stops the service from starting.
export type EmbeddedMcp = { handles: (url: string | undefined) => boolean; handle: (req: IncomingMessage, res: ServerResponse) => void; databaseUser: string };

const EXACT = new Set(['/mcp', '/authorize', '/token', '/register']);
/** The only addresses the connector answers on. (The sign-in details Claude looks for are under /.well-known/oauth-, and the access-code page under /oauth/.) */
export function mcpHandles(url: string | undefined): boolean {
  const path = (url ?? '').split('?')[0].replace(/(.)\/+$/, '$1');
  return EXACT.has(path) || path.startsWith('/oauth/') || path.startsWith('/.well-known/oauth-');
}

export async function startEmbeddedMcp(
  env: Record<string, string | undefined> = process.env,
  opts: { db?: Db; now?: () => number; log?: (entry: Record<string, unknown>) => void } = {},
): Promise<EmbeddedMcp | null> {
  if (!env.MCP_ACCESS_CODES?.trim()) {
    // Say so, once: a silent "off" cannot be told apart from "this code is not deployed", which is exactly the confusion this line removes.
    console.log('Radar ordering connector is OFF: MCP_ACCESS_CODES is not set on this service (add it in Railway Variables, then Deploy, to switch the connector on)');
    return null;
  }
  try {
    const cfg = loadConfig({ ...env, MCP_PUBLIC_URL: env.MCP_PUBLIC_URL?.trim() || env.PUBLIC_API_URL }, 'MCP_');
    const db = opts.db ?? pgDb(cfg.databaseUrl, { ssl: cfg.databaseSsl });
    const databaseUser = await assertReadOnlyLogin(db);
    const app = createApp(cfg, { db, ...(opts.now ? { now: opts.now } : {}), ...(opts.log ? { log: opts.log } : {}) });
    // Anything that goes wrong inside the connector stays inside it: the person gets a plain 500, and the service carries on.
    const handle = (req: IncomingMessage, res: ServerResponse) => {
      try { app(req, res); }
      catch (e) { console.error('Radar ordering connector request failed:', (e as Error).message); if (!res.headersSent) { res.statusCode = 500; res.end(); } }
    };
    return { handles: mcpHandles, handle, databaseUser };
  } catch (e) {
    console.error('Radar ordering connector NOT started (the service carries on without it):', (e as Error).message);
    return null;
  }
}