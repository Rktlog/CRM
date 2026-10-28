import { prisma as defaultPrisma } from './prisma';

// Keeps a few database connections open and warm. Opening one is slow (a handshake of several round trips: about 1 to 1.5 seconds from here to the
// database), and the pool closes any that sit idle for 5 minutes. A page asks for several things at once, each on its own connection, so with only one
// kept warm the others were opened on the spot: the first click after a deploy or a quiet spell was slow even for a tiny request (/me took 1.7 to 2.4 s).
// So a few are opened at start-up and touched with a tiny query every minute (well inside the 5 minutes), and a person's first click finds them ready.
//   KEEP_WARM_CONNECTIONS   how many to keep (default 5; 0 turns it off). Keep it at or below connection_limit on DATABASE_URL.
type Db = { $queryRaw: (...a: any[]) => Promise<unknown> };

export function startKeepWarm(opts: { connections?: number; everyMs?: number; db?: Db } = {}): () => void {
  const connections = opts.connections ?? (Number(process.env.KEEP_WARM_CONNECTIONS ?? 5) || 0);
  const everyMs = opts.everyMs ?? 60_000;
  const db = (opts.db ?? defaultPrisma) as Db;
  if (connections <= 0) return () => {};

  let running = false, warned = false;
  const run = async () => {
    if (running) return;   // the last round has not finished (a slow database): do not pile another on top
    running = true;
    try {
      await Promise.all(Array.from({ length: connections }, () => (db as any).$queryRaw`select 1`));
      warned = false;
    } catch (e) {
      if (!warned) console.warn('keep-warm ping failed:', String((e as Error)?.message ?? e).slice(0, 120));
      warned = true;   // said once until it works again, so a database outage does not fill the log
    } finally { running = false; }
  };
  void run();
  const t = setInterval(() => { void run(); }, everyMs);
  t.unref?.();
  return () => clearInterval(t);
}