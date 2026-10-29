import { createHmac, timingSafeEqual } from 'node:crypto';

// Signed, self-describing tokens. Nothing is stored: a client address, a sign-in code, an access token and a refresh token are each a small piece of JSON with a
// signature made with OAUTH_SECRET. So a restart or a redeploy signs nobody out, and a token that has been tampered with, has expired, or is of the wrong kind
// is refused. (Changing OAUTH_SECRET invalidates every token at once.)
export type Kind = 'client' | 'code' | 'access' | 'refresh';
export type Claims = { k: Kind; exp?: number; [key: string]: unknown };

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const mac = (payload: string, secret: string) => createHmac('sha256', secret).update(payload).digest();

export function sign(claims: Claims, secret: string): string {
  const payload = b64(JSON.stringify(claims));
  return `${payload}.${b64(mac(payload, secret))}`;
}

/** The claims if the token is genuine, of this kind, and not expired (nowSec in seconds); otherwise null. */
export function verify(token: string, secret: string, kind: Kind, nowSec: number): Claims | null {
  if (typeof token !== 'string' || token.length > 4000) return null;
  const dot = token.indexOf('.');
  if (dot < 1) return null;
  const payload = token.slice(0, dot);
  let given: Buffer;
  try { given = Buffer.from(token.slice(dot + 1), 'base64url'); } catch { return null; }
  const want = mac(payload, secret);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  let claims: Claims;
  try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
  if (!claims || claims.k !== kind) return null;
  if (typeof claims.exp === 'number' && claims.exp < nowSec) return null;
  return claims;
}
