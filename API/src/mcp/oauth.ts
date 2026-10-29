import express from 'express';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidClientMetadataError, InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { Config } from './config.js';
import { sign, verify } from './tokens.js';

// Signing in. Claude (claude.ai or Claude Code) discovers this server, registers itself, and sends the person to the page below, where they type the access code
// they were given. The server checks it, and gives Claude a short-lived token (renewed in the background) that carries the person's name. There is no
// password database: a code is a name:code pair in the ACCESS_CODES setting, and deleting a pair withdraws that person's access straight away.
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const sha = (s: string) => createHash('sha256').update(s).digest();

function isLoopback(u: URL) { return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname); }
/** A redirect address is allowed if it is one of the listed ones, or a loopback address (localhost) on any port: that is how Claude Code on a person's own computer signs in. */
export function redirectAllowed(uri: string, allowed: string[]): boolean {
  let u: URL; try { u = new URL(uri); } catch { return false; }
  if (u.hash) return false;
  return allowed.includes(uri) || isLoopback(u);
}
const sameRedirect = (given: string, registered: string[]) => registered.some(r => {
  if (r === given) return true;
  try { const a = new URL(given), b = new URL(r); return isLoopback(a) && isLoopback(b) && a.pathname === b.pathname && a.hostname === b.hostname; } catch { return false; }
});

export function createOAuth(cfg: Config, now: () => number = Date.now) {
  const secs = () => Math.floor(now() / 1000);
  const personFor = (given: string): string | null => {
    let found: string | null = null;
    for (const [person, code] of cfg.accessCodes) if (timingSafeEqual(sha(given), sha(code))) found = person;   // compares every code, so timing does not show which
    return found;
  };
  const clientSecretFor = (id: string) => createHmac('sha256', cfg.oauthSecret).update('client_secret:' + id).digest('hex');

  const getClient = (id: string): OAuthClientInformationFull | undefined => {
    const c = verify(id, cfg.oauthSecret, 'client', secs());
    if (!c) return undefined;
    const method = (c.am as string) || 'none';
    return {
      client_id: id, redirect_uris: c.ru as string[], client_name: c.name as string | undefined, token_endpoint_auth_method: method,
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], ...(method === 'none' ? {} : { client_secret: clientSecretFor(id) }),
    } as OAuthClientInformationFull;
  };

  const clientsStore: OAuthRegisteredClientsStore = {
    getClient,
    registerClient(info) {
      const uris = (info.redirect_uris ?? []).map(String);
      if (uris.length === 0 || uris.some(u => !redirectAllowed(u, cfg.allowedRedirects))) throw new InvalidClientMetadataError('redirect_uris must be Claude\'s own addresses (or a localhost address)');
      const method = info.token_endpoint_auth_method ?? 'none';
      const id = sign({ k: 'client', ru: uris, name: info.client_name, am: method, iat: secs() }, cfg.oauthSecret);
      return { ...info, client_id: id, client_id_issued_at: secs(), ...(method === 'none' ? { client_secret: undefined } : { client_secret: clientSecretFor(id) }) } as OAuthClientInformationFull;
    },
  };

  const issueTokens = (clientId: string, person: string, resource?: string): OAuthTokens => {
    const t = secs();
    return {
      access_token: sign({ k: 'access', cid: clientId, p: person, res: resource, exp: t + cfg.accessTtlSec }, cfg.oauthSecret),
      token_type: 'Bearer', expires_in: cfg.accessTtlSec, scope: 'read',
      refresh_token: sign({ k: 'refresh', cid: clientId, p: person, res: resource, exp: t + cfg.refreshTtlSec }, cfg.oauthSecret),
    };
  };

  const page = (fields: Record<string, string>, error?: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Connect Claude to Radar</title>
<style>body{font-family:system-ui,sans-serif;background:#F3F5F1;color:#1B2430;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}
main{background:#fff;border:1px solid #D7DCD4;border-radius:8px;padding:28px;max-width:380px;width:100%}h1{font-size:20px;margin:0 0 8px}p{margin:0 0 14px;color:#445064;line-height:1.45}
input[type=password]{width:100%;padding:10px;font-size:16px;border:1px solid #D7DCD4;border-radius:5px;box-sizing:border-box}button{margin-top:14px;width:100%;padding:11px;font-size:16px;background:#1B2430;color:#fff;border:0;border-radius:5px;cursor:pointer}
.err{color:#A8432A;margin-bottom:12px}</style></head><body><main>
<h1>Connect Claude to Radar</h1><p>This lets Claude <b>read</b> Radar's ordering data: products, stock, purchase orders and sales. It cannot change anything. Enter the access code you were given.</p>
${error ? `<div class="err">${esc(error)}</div>` : ''}
<form method="post" action="/oauth/login" autocomplete="off">${Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('')}
<input type="password" name="access_code" placeholder="Access code" autofocus required><button type="submit">Connect</button></form></main></body></html>`;
  const sendPage = (res: express.Response, status: number, html: string) => {
    res.status(status).set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" }).send(html);
  };

  const provider: OAuthServerProvider = {
    get clientsStore() { return clientsStore; },

    async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: express.Response) {
      sendPage(res, 200, page({ client_id: client.client_id, redirect_uri: params.redirectUri, state: params.state ?? '', code_challenge: params.codeChallenge, resource: params.resource?.href ?? '' }));
    },

    async challengeForAuthorizationCode(client, authorizationCode) {
      const c = verify(authorizationCode, cfg.oauthSecret, 'code', secs());
      if (!c || c.cid !== client.client_id) throw new InvalidGrantError('Invalid or expired authorization code');
      return c.cc as string;
    },

    async exchangeAuthorizationCode(client, authorizationCode, _verifier, redirectUri, resource) {
      const c = verify(authorizationCode, cfg.oauthSecret, 'code', secs());
      if (!c || c.cid !== client.client_id) throw new InvalidGrantError('Invalid or expired authorization code');
      if (redirectUri && redirectUri !== c.ru) throw new InvalidGrantError('redirect_uri does not match the one used to sign in');
      if (!cfg.accessCodes.has(c.p as string)) throw new InvalidGrantError('Access has been withdrawn');
      return issueTokens(client.client_id, c.p as string, resource?.href ?? (c.res as string | undefined));
    },

    async exchangeRefreshToken(client, refreshToken) {
      const c = verify(refreshToken, cfg.oauthSecret, 'refresh', secs());
      if (!c || c.cid !== client.client_id) throw new InvalidGrantError('Invalid or expired refresh token');
      if (!cfg.accessCodes.has(c.p as string)) throw new InvalidGrantError('Access has been withdrawn');
      return issueTokens(client.client_id, c.p as string, c.res as string | undefined);
    },

    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const c = verify(token, cfg.oauthSecret, 'access', secs());
      if (!c) throw new InvalidTokenError('Invalid or expired token');
      if (!cfg.accessCodes.has(c.p as string)) throw new InvalidTokenError('Access has been withdrawn');
      return { token, clientId: c.cid as string, scopes: ['read'], expiresAt: c.exp as number, extra: { person: c.p } };
    },
  };

  // ---- the page where the access code is typed ----
  const failures = new Map<string, { n: number; until: number }>();   // sign-in attempts that failed, by address
  const login = express.Router();
  login.post('/login', express.urlencoded({ extended: false, limit: '8kb' }), (req, res) => {
    const b = (req.body ?? {}) as Record<string, string>;
    const fields = { client_id: b.client_id ?? '', redirect_uri: b.redirect_uri ?? '', state: b.state ?? '', code_challenge: b.code_challenge ?? '', resource: b.resource ?? '' };
    const ip = req.ip ?? 'unknown';
    const f = failures.get(ip);
    if (f && f.n >= 10 && f.until > now()) return sendPage(res, 429, page(fields, 'Too many wrong codes. Wait a few minutes and try again.'));

    const client = getClient(fields.client_id);
    if (!client || !fields.code_challenge || !sameRedirect(fields.redirect_uri, client.redirect_uris.map(String))) return sendPage(res, 400, '<p>This sign-in link is not valid. Start again from Claude.</p>');

    const person = personFor(b.access_code ?? '');
    if (!person) {
      failures.set(ip, { n: (f && f.until > now() ? f.n : 0) + 1, until: now() + 15 * 60_000 });
      console.warn(JSON.stringify({ t: new Date(now()).toISOString(), event: 'sign-in refused', ip }));
      return sendPage(res, 401, page(fields, 'That code is not right.'));
    }
    failures.delete(ip);
    const code = sign({ k: 'code', cid: client.client_id, ru: fields.redirect_uri, cc: fields.code_challenge, p: person, res: fields.resource || undefined, exp: secs() + cfg.codeTtlSec }, cfg.oauthSecret);
    const target = new URL(fields.redirect_uri);
    target.searchParams.set('code', code);
    if (fields.state) target.searchParams.set('state', fields.state);
    console.log(JSON.stringify({ t: new Date(now()).toISOString(), event: 'signed in', person }));
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }).redirect(302, target.toString());
  });

  return { provider, login };
}
