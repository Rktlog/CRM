import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';

// Attaches req.rep so every route handler knows who's calling and
// whether they're a manager, without re-checking Supabase each time.
declare global {
  namespace Express {
    interface Request {
      rep?: { id: string; role: 'rep' | 'manager' };
    }
  }
}

// Verifying the JWT's signature locally, with the project's own JWT
// secret, instead of calling supabase.auth.getUser(token) — that call
// made a real network round-trip to Supabase's Auth servers on every
// single API request, which is what was actually making every page
// feel slow (it's paid once per request, and a page fires many).
// Supabase-issued tokens are standard signed JWTs; verifying the
// signature is exactly as secure as asking Supabase to do it for us,
// just without leaving this server.
const JWT_SECRET: string = process.env.SUPABASE_JWT_SECRET ?? (() => {
  throw new Error('SUPABASE_JWT_SECRET is not set — required to verify login tokens locally.');
})();

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }

  let userId: string;
  try {
    const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as { sub?: string };
    if (!payload.sub) throw new Error('Token has no subject');
    userId = payload.sub;
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const rep = await prisma.rep.findUnique({
    where: { id: userId },
    select: { id: true, role: true },
  });

  if (!rep) {
    // A valid Supabase login that has no matching crm.reps row yet —
    // happens if someone forgot step 5 (seed the rep) for this user.
    return res.status(403).json({ error: 'No rep record for this account' });
  }

  req.rep = rep;
  next();
}