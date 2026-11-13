// What the marketing dashboard's database code shares: its error type, the rule for "who is a manager", and how an order is recognised (the same as the Marketing and Conversion sections).
import { prisma } from './prisma';

export class MktError extends Error { status: number; constructor(message: string, status = 400) { super(message); this.status = status; } }
export type Rep = { id: string; role: string };
export const NOT_SET_UP = 'The marketing dashboard is not set up in the database yet. Ask whoever looks after Radar to run marketing-dashboard.sql.';
const tableMissing = (e: any) => e?.code === '42P01' || e?.meta?.code === '42P01' || (/mkt_/.test(String(e?.message ?? e)) && /does not exist|relation/i.test(String(e?.message ?? e)));
export async function guard<T>(f: () => Promise<T>): Promise<T> { try { return await f(); } catch (e) { if (tableMissing(e)) throw new MktError(NOT_SET_UP, 503); throw e; } }
export const isTableMissing = tableMissing;
export const uuidOk = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

// An order, as the Marketing and Conversion sections count it: not a quote, not a miscellaneous order, not a draft or a cancelled one.
// "ANY" also takes in the old history (to know whether a customer has EVER bought); "LIVE" is what counts as an order in a period.
const NOT_AN_ORDER = `('DRAFT', 'ESTIMATING', 'ESTIMATED', 'ORDERING', 'VOIDED', 'CREDITED')`;
export const orderAny = (a: string) => `${a}.misc_type is null and ${a}.number !~ '^Q' and upper(coalesce(${a}.fulfillment_status, '')) not in ${NOT_AN_ORDER}`;
export const orderLive = (a: string) => `${orderAny(a)} and ${a}.source <> 'rhino-history'`;
/** The Melbourne day an order was placed. */
export const oday = (a: string) => `((${a}.sent_at at time zone 'UTC') at time zone 'Australia/Melbourne')::date`;

export async function managerCount(): Promise<number> {
  const [r] = await prisma.$queryRaw<{ n: number }[]>`select count(*)::int as n from crm.reps where role::text = 'manager'`;
  return r?.n ?? 0;
}
export const dayText = (c: string) => `to_char(${c}, 'YYYY-MM-DD')`;
