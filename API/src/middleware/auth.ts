import { Request, Response, NextFunction } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { prisma } from '../lib/prisma';
import { makeRepLookup } from '../lib/repLookup';
import { msFromEnv } from '../lib/ttlCache';

// Attaches req.rep so every route handler knows who's calling and
// whether they're a manager, without re-checking Supabase each time.
declare global {
  namespace Express {
    interface Request {
      rep?: { id: string; role: 'rep' | 'manager' };
    }
  }
}

// Verifying the JWT's signature locally, using Supabase's own public
// signing keys, instead of calling supabase.auth.getUser(token) — that
// call made a real network round-trip to Supabase's Auth servers on
// every single API request, which is what was actually making every
// page feel slow (paid once per request, and a page fires many).
//
// This project signs its tokens with an asymmetric key (confirmed via
// the "invalid algorithm" error a shared-secret/HS256 attempt hit), not
// the older shared-secret scheme — so verification needs Supabase's
// public key, not a copied secret. jose fetches and caches that key set
// automatically, and re-fetches it if Supabase ever rotates keys, so
// there's no secret to keep in sync by hand at all.
const SUPABASE_URL = process.env.SUPABASE_URL ?? (() => {
  throw new Error('SUPABASE_URL is not set — required to verify login tokens locally.');
})();
const JWKS = createRemoteJWKSet(new URL(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`));

// Who the caller is (their role) is remembered for AUTH_CACHE_MS (default 60 s; 0 switches it off), so most requests skip a database trip. A role changed directly
// in the database is picked up within that time.
const repLookup = makeRepLookup(id => prisma.rep.findUnique({ where: { id }, select: { id: true, role: true } }), msFromEnv(process.env.AUTH_CACHE_MS, 60_000));
export const clearRepCache = (id?: string) => repLookup.clear(id);

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }

  let userId: string;
  try {
    const { payload } = await jwtVerify(token, JWKS);
    if (!payload.sub) throw new Error('Token has no subject');
    userId = payload.sub;
  } catch (err: any) {
    // Logging the REAL reason server-side (Railway logs) — the response
    // to the client stays a generic 401, but this tells us definitively
    // what's actually failing if something goes wrong again.
    console.error(`Token verification failed: ${err?.name ?? 'Error'} — ${err?.message ?? String(err)}`);
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const rep = await repLookup.find(userId);

  if (!rep) {
    // A valid Supabase login that has no matching crm.reps row yet —
    // happens if someone forgot step 5 (seed the rep) for this user.
    return res.status(403).json({ error: 'No rep record for this account' });
  }

  req.rep = rep;
  next();
}