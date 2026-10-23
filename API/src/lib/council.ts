import { prisma } from './prisma';

// The local council of each account, worked out by the database from the postcode in its address (council.sql). Everything here
// tolerates that SQL not having been run yet: with no council columns it simply returns nothing, so no screen breaks.
export type CouncilInfo = { council: string | null; postcode: string | null };

let cache: { at: number; ok: boolean } | null = null;
export const clearCouncilCache = () => { cache = null; };

// Is council.sql in place? Remembered for a minute (10 seconds while it is not, so it is noticed soon after the SQL is run).
export async function councilReady(): Promise<boolean> {
  if (cache && Date.now() - cache.at < (cache.ok ? 60_000 : 10_000)) return cache.ok;
  let ok = false;
  try {
    const r = await prisma.$queryRaw<{ n: number }[]>`
      select count(*)::int as n from information_schema.columns
      where table_schema = 'crm' and table_name = 'accounts' and column_name in ('council', 'postcode')`;
    ok = Number(r[0]?.n ?? 0) === 2;
  } catch { ok = false; }
  cache = { at: Date.now(), ok };
  return ok;
}

// Council and postcode for these accounts (only the ones that have one).
export async function councilsFor(ids: string[]): Promise<Map<string, CouncilInfo>> {
  const out = new Map<string, CouncilInfo>();
  if (!ids.length || !(await councilReady())) return out;
  try {
    const rows = await prisma.$queryRaw<{ id: string; postcode: string | null; council: string | null }[]>`
      select id::text as id, postcode, council from crm.accounts
      where id = any(${ids}::uuid[]) and (council is not null or postcode is not null)`;
    for (const r of rows) out.set(r.id, { council: r.council, postcode: r.postcode });
  } catch (e) { console.error('council lookup failed:', (e as Error).message); }
  return out;
}