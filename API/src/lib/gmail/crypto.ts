import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'crypto';

// Each rep's Google sign-in (a "refresh token") is kept encrypted, so reading the database alone shows nothing
// usable. The key is GMAIL_TOKEN_KEY on the API: 32 random bytes written as base64. Make one with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
const key = (): Buffer | null => {
  const k = process.env.GMAIL_TOKEN_KEY;
  if (!k) return null;
  const b = Buffer.from(k, 'base64');
  return b.length === 32 ? b : null;
};
export const tokenKeyOk = () => !!key();

const b64 = (b: Buffer) => b.toString('base64url');
export function encrypt(plain: string): string {
  const k = key(); if (!k) throw new Error('GMAIL_TOKEN_KEY is missing, or is not 32 bytes written as base64');
  const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', k, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', b64(iv), b64(c.getAuthTag()), b64(enc)].join('.');
}
export function decrypt(blob: string): string {
  const k = key(); if (!k) throw new Error('GMAIL_TOKEN_KEY is missing, or is not 32 bytes written as base64');
  const [v, iv, tag, enc] = blob.split('.');
  if (v !== 'v1' || !iv || !tag || !enc) throw new Error('Stored token is not in a known format');
  const d = createDecipheriv('aes-256-gcm', k, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64url')), d.final()]).toString('utf8');   // throws if anything was changed
}

// The "state" Google hands back after sign-in: who started it and until when, signed so it cannot be forged.
const sign = (body: string) => { const k = key(); if (!k) throw new Error('GMAIL_TOKEN_KEY is missing'); return createHmac('sha256', k).update('gmail-state|' + body).digest('base64url'); };
export function signState(repId: string, ttlMs = 10 * 60 * 1000, now = Date.now()): string {
  const body = b64(Buffer.from(JSON.stringify({ r: repId, e: now + ttlMs, n: randomBytes(8).toString('hex') })));
  return `${body}.${sign(body)}`;
}
export function verifyState(state: string, now = Date.now()): { repId: string } | null {
  try {
    const [body, mac] = String(state ?? '').split('.');
    if (!body || !mac) return null;
    const want = Buffer.from(sign(body)), got = Buffer.from(mac);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return typeof p.r === 'string' && typeof p.e === 'number' && p.e > now ? { repId: p.r } : null;
  } catch { return null; }
}