import { Prisma } from '@prisma/client';
import { prisma } from './prisma';

// The rep's weekly activity summary: what the team's "Weekly Activity Summary" sheet tracks by hand, worked out from the Activity Log,
// the orders and the accounts. Shown to reps on Sales Data, and downloadable by managers from Reports (dataset "Weekly activity").
//
//  - Visits, calls and emails are the rep's own Activity Log entries (F2F visit, Phone, Email), by the day they say they happened.
//  - Sales quotes are the live orders (SQ...) placed that week on accounts in the rep's states, by order date, real orders only.
//  - New customer: an account's first order ever (history included). Returning: an order after no order for the 12 months before.
//    The value is what those accounts ordered that day. New in DEAR: accounts created in DEAR that week.
//  - Sales figures follow the rep's states, as the rest of Sales Data does. Weeks run Monday to Sunday (Melbourne time).

// The team's targets (their Targets and Processes sheet). One place, sent to the screen and the Excel file so they always agree.
export const ACTIVITY_TARGETS = { f2fPerWeek: 25, quotesPerWeek: 5, newPerMonth: 10 } as const;

export type Grain = 'week' | 'month';
export type SummaryRow = {
  period: string;   // the Monday of the week, or the first of the month (YYYY-MM-DD)
  f2f: number; phone: number; email: number; contacts: number;
  quotes: number; quoteValue: number;
  newCustomers: number; newValue: number; reactivated: number; reactivatedValue: number; totalNew: number;
  newInDear: number;
};

const NOT_A_SALE = ['DRAFT', 'ESTIMATING', 'ESTIMATED', 'ORDERING', 'VOIDED', 'CREDITED'];
const DAY = 86_400_000;
const r2 = (n: number) => Math.round(n * 100) / 100;

// ---- days, as YYYY-MM-DD strings, so no time zone can move them
export const addDays = (day: string, n: number) => new Date(Date.parse(day) + n * DAY).toISOString().slice(0, 10);
export const mondayOf = (day: string) => addDays(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7));
export const monthStart = (day: string) => `${day.slice(0, 7)}-01`;
export const addMonths = (day: string, n: number) => {
  const d = new Date(`${monthStart(day)}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
};
// Every week (or month) from the one holding `from` to the one holding `to`.
export function periodList(from: string, to: string, grain: Grain): string[] {
  const out: string[] = [];
  let p = grain === 'week' ? mondayOf(from) : monthStart(from);
  while (p <= to) { out.push(p); p = grain === 'week' ? addDays(p, 7) : addMonths(p, 1); }
  return out;
}

export async function regionsOf(repId: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ region: string }[]>`select region from crm.rep_regions where rep_id = ${repId}::uuid order by region`;
  return rows.map(r => r.region);
}
export async function repNames(): Promise<Map<string, string>> {
  const rows = await prisma.$queryRaw<{ id: string; name: string }[]>`select id::text as id, name from crm.reps order by name`;
  return new Map(rows.map(r => [r.id, r.name]));
}

// One rep, every week or month from `from` to `to`, zeros included. regions: the states whose sales count for this rep.
export async function activitySummary(opts: { repId: string; regions: string[]; from: string; to: string; grain: Grain }): Promise<SummaryRow[]> {
  const { repId, regions, from, to, grain } = opts;
  const mel = Prisma.sql`at time zone 'UTC' at time zone 'Australia/Melbourne'`;   // dates are kept as UTC moments; the team works in Melbourne
  const notASale = Prisma.join(NOT_A_SALE);

  type ActRow = { period: string; f2f: number; phone: number; email: number };
  const act = await prisma.$queryRaw<ActRow[]>(Prisma.sql`
    select to_char(date_trunc(${grain}, a.occurred_at ${mel}), 'YYYY-MM-DD') as period,
           count(*) filter (where a.type = 'visit')::int as f2f, count(*) filter (where a.type = 'call')::int as phone, count(*) filter (where a.type = 'email')::int as email
    from crm.activity a
    where a.rep_id = ${repId}::uuid and (a.occurred_at ${mel})::date between ${from}::date and ${to}::date
    group by 1`);

  type QuoteRow = { period: string; quotes: number; value: number };
  type StartRow = { period: string; kind: string; n: number; value: number };
  type DearRow = { period: string; n: number };
  let quotes: QuoteRow[] = [];
  let starts: StartRow[] = [];
  let dear: DearRow[] = [];
  if (regions.length) {
    quotes = await prisma.$queryRaw<QuoteRow[]>(Prisma.sql`
      select to_char(date_trunc(${grain}, q.sent_at ${mel}), 'YYYY-MM-DD') as period, count(*)::int as quotes, coalesce(sum(q.amount), 0)::float8 as value
      from crm.quotes q join crm.accounts a on a.id = q.account_id
      where a.region = any(${regions}::text[]) and q.source <> 'rhino-history' and q.number not like 'Q%'
        and upper(coalesce(q.fulfillment_status, '')) not in (${notASale})
        and (q.sent_at ${mel})::date between ${from}::date and ${to}::date
      group by 1`);
    // new = the account's first order day ever; returning = an order day after nothing for the 12 months before it
    starts = await prisma.$queryRaw<StartRow[]>(Prisma.sql`
      with raw as (
        select q.account_id, (q.sent_at ${mel})::date as day, q.amount
        from crm.quotes q join crm.accounts a on a.id = q.account_id
        where a.region = any(${regions}::text[])
          and ((q.source = 'rhino-history' or q.number like 'Q%') or upper(coalesce(q.fulfillment_status, '')) not in (${notASale}))
      ), daily as (
        select account_id, day, sum(amount) as amount from raw group by account_id, day
      ), flagged as (
        select account_id, day, amount,
               case when lag(day) over (partition by account_id order by day) is null then 'new'
                    when lag(day) over (partition by account_id order by day) < (day - interval '12 months')::date then 'returning' end as kind
        from daily
      )
      select to_char(date_trunc(${grain}, day::timestamp), 'YYYY-MM-DD') as period, kind, count(distinct account_id)::int as n, coalesce(sum(amount), 0)::float8 as value
      from flagged where kind is not null and day between ${from}::date and ${to}::date
      group by 1, 2`);
    dear = await prisma.$queryRaw<DearRow[]>(Prisma.sql`
      select to_char(date_trunc(${grain}, a.dear_created_at at time zone 'Australia/Melbourne'), 'YYYY-MM-DD') as period, count(*)::int as n
      from crm.accounts a
      where a.region = any(${regions}::text[]) and (a.dear_created_at at time zone 'Australia/Melbourne')::date between ${from}::date and ${to}::date
      group by 1`);
  }

  const by = <T extends { period: string }>(rows: T[]) => new Map<string, T>(rows.map(r => [r.period, r] as [string, T]));
  const A = by<ActRow>(act), Q = by<QuoteRow>(quotes), D = by<DearRow>(dear);
  const S = new Map<string, { n: number; value: number }>(starts.map(s => [`${s.period}|${s.kind}`, s]));
  return periodList(from, to, grain).map(period => {
    const a = A.get(period), q = Q.get(period), n = S.get(`${period}|new`), re = S.get(`${period}|returning`);
    const f2f = a?.f2f ?? 0, phone = a?.phone ?? 0, email = a?.email ?? 0;
    return {
      period, f2f, phone, email, contacts: f2f + phone + email,
      quotes: q?.quotes ?? 0, quoteValue: r2(q?.value ?? 0),
      newCustomers: n?.n ?? 0, newValue: r2(n?.value ?? 0), reactivated: re?.n ?? 0, reactivatedValue: r2(re?.value ?? 0),
      totalNew: (n?.n ?? 0) + (re?.n ?? 0), newInDear: D.get(period)?.n ?? 0,
    };
  });
}