import { Request, Response, NextFunction } from 'express';
import { supabase } from '../lib/supabase';
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

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const rep = await prisma.rep.findUnique({
    where: { id: data.user.id },
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
