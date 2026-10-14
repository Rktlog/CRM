import { prisma } from './prisma';

// What the team has said about each order in a list: how many notes, and the latest one.
// One query for the whole list, so showing it on a page of 200 orders costs nothing extra.
export type OrderNoteSummary = { noteCount: number; lastNote: { text: string; type: string; by: string | null; at: Date } };

export async function orderNoteSummary(orderIds: string[]): Promise<Map<string, OrderNoteSummary>> {
  const ids = [...new Set(orderIds.filter(Boolean))];
  const out = new Map<string, OrderNoteSummary>();
  if (!ids.length) return out;
  const rows = await prisma.$queryRaw<any[]>`
    select distinct on (a.quote_id) a.quote_id as "orderId", a.type::text as type, a.note, a.occurred_at as "at", r.name as "by",
           (select count(*)::int from crm.activity c where c.quote_id = a.quote_id) as n
    from crm.activity a left join crm.reps r on r.id = a.rep_id
    where a.quote_id = any(${ids}::uuid[])
    order by a.quote_id, a.occurred_at desc, a.created_at desc`;
  for (const r of rows) out.set(r.orderId, { noteCount: r.n, lastNote: { text: String(r.note).slice(0, 200), type: r.type, by: r.by ?? null, at: r.at } });
  return out;
}