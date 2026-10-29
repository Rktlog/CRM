import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { createOAuth } from './oauth.js';
import { buildServer } from './tools.js';

export type AppDeps = { db: Db; now?: () => number; log?: (entry: Record<string, unknown>) => void };

export function createApp(cfg: Config, deps: AppDeps): express.Express {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((e: Record<string, unknown>) => console.log(JSON.stringify({ t: new Date(now()).toISOString(), ...e })));
  const app = express();
  app.set('trust proxy', 1);   // behind Railway's proxy: the real address and https come from its headers
  app.disable('x-powered-by');

  const { provider, login } = createOAuth(cfg, now);
  const issuerUrl = new URL(cfg.publicUrl);
  const mcpUrl = new URL('/mcp', cfg.publicUrl);

  app.get('/', (_req, res) => { res.type('text/plain').send('Radar ordering data (read-only MCP server). Add this address, ending /mcp, as a custom connector in Claude.'); });
  app.get('/health', (_req, res) => { res.json({ ok: true }); });

  app.use(mcpAuthRouter({
    provider, issuerUrl, baseUrl: issuerUrl, resourceServerUrl: mcpUrl, scopesSupported: ['read'], resourceName: 'Radar ordering data (read-only)',
  }));
  app.use('/oauth', login);

  // Each person's questions are limited to 60 a minute.
  const asked = new Map<string, number[]>();
  const take = (person: string) => {
    const t = now(); const recent = (asked.get(person) ?? []).filter(x => t - x < 60_000);
    if (recent.length >= 60) { asked.set(person, recent); return false; }
    recent.push(t); asked.set(person, recent); return true;
  };

  const bearer = requireBearerAuth({ verifier: provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl) });
  app.post('/mcp', bearer, express.json({ limit: '1mb' }), async (req, res) => {
    const person = String((req.auth?.extra as { person?: string } | undefined)?.person ?? 'unknown');
    // Stateless: a fresh server and transport for every request, so nothing is held between them and a redeploy loses nothing.
    const server = buildServer({ person, db: deps.db, limits: { defaultRows: cfg.defaultRows, maxRows: cfg.maxRows, timeoutMs: cfg.queryTimeoutMs }, take, log });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error('mcp request failed:', (e as Error).message);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  });
  const notAllowed = (_req: express.Request, res: express.Response) => { res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: this server is stateless, use POST.' }, id: null }); };
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);

  return app;
}
