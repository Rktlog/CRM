import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { getProvider } from './provider';
import { getSettings } from './settings';
import { audienceSummary } from './audience';
import { AUTO_KEYS, AUTOMATIONS } from './automations';

// The numbers behind the Marketing dashboard and the campaign reports.
//
// Orders from emails: a confirmed order counts for a marketing email when the customer clicked a link in it
// within N days BEFORE the order was created (N is the order window in settings, 7 by default). If they clicked
// several emails, the one clicked last gets the credit, and an order is only ever counted once. Order emails
// (invoice, tracking...) never take credit. The customer is matched through the contact's account, or the
// order's own email address. "Confirmed order" is the same definition the Conversion section uses.
const NOT_AN_ORDER = ['DRAFT', 'ESTIMATING', 'ESTIMATED', 'ORDERING', 'VOIDED', 'CREDITED'];

export type AttributedOrder = { orderId: string; number: string; orderAt: string; value: number; accountId: string; accountName: string; messageId: string; campaignId: string | null; campaignName: string | null; automationKey: string | null; clickedAt: string };

export async function attributedOrders(from: Date, to: Date, days: number, campaignId?: string): Promise<AttributedOrder[]> {
  return prisma.$queryRaw<AttributedOrder[]>`
    select q.id as "orderId", q.number, q.sent_at as "orderAt", coalesce(q.goods_total, q.amount)::float as value, a.id as "accountId", a.name as "accountName",
           e.message_id as "messageId", m.campaign_id as "campaignId", cp.name as "campaignName", m.automation_key as "automationKey", e.occurred_at as "clickedAt"
    from crm.quotes q
    join crm.accounts a on a.id = q.account_id
    join lateral (
      select ev.message_id, ev.occurred_at
      from crm.marketing_events ev
      join crm.marketing_messages mm on mm.id = ev.message_id and mm.marketing = true
      left join crm.marketing_contacts c on c.id = mm.contact_id
      where ev.type = 'click' and ev.occurred_at <= q.sent_at and ev.occurred_at >= q.sent_at - make_interval(days => ${days}::int)
        and (c.account_id = q.account_id or lower(mm.email) = lower(coalesce(q.order_email, '')))
      order by ev.occurred_at desc limit 1
    ) e on true
    join crm.marketing_messages m on m.id = e.message_id
    left join crm.marketing_campaigns cp on cp.id = m.campaign_id
    where q.misc_type is null and q.source <> 'rhino-history' and q.number !~ '^Q'
      and upper(coalesce(q.fulfillment_status, '')) <> all(${NOT_AN_ORDER}::text[])
      and q.sent_at >= ${from} and q.sent_at <= ${to}
      ${campaignId ? Prisma.sql`and m.campaign_id = ${campaignId}::uuid` : Prisma.empty}
    order by q.sent_at desc`;
}

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : 0);
const ordersOf = (rows: AttributedOrder[]) => ({ count: rows.length, revenue: Math.round(rows.reduce((s, r) => s + r.value, 0) * 100) / 100 });

export async function sendingStatus() {
  const s = await getSettings(); const p = getProvider();
  const missing = [!s.from_email && 'Sender email', !s.footer_address.trim() && 'Business address', !s.tracking_base_url && 'Public web address of this API'].filter(Boolean) as string[];
  return { connected: p.connected, provider: p.name, ready: p.connected && !missing.length, missing, fromEmail: s.from_email, attributionDays: s.attribution_days };
}

export async function overview(from: Date, to: Date) {
  const s = await getSettings();
  const [t] = await prisma.$queryRaw<any[]>`
    select count(*) filter (where sent_at is not null)::int as sent, count(*) filter (where status = 'bounced')::int as bounced, count(*) filter (where status = 'complained')::int as complained,
           count(*) filter (where opened_at is not null)::int as opened, count(*) filter (where click_count > 0)::int as clicked, count(*) filter (where unsubscribed_at is not null)::int as unsubscribed,
           count(*) filter (where status = 'failed')::int as failed
    from crm.marketing_messages where marketing = true and sent_at >= ${from} and sent_at <= ${to}`;
  const [w] = await prisma.$queryRaw<{ n: number }[]>`select count(*)::int as n from crm.marketing_messages where status in ('queued', 'sending')`;
  const delivered = t.sent - t.bounced - t.complained;
  const rates = { delivered: pct(delivered, t.sent), opened: pct(t.opened, delivered), clicked: pct(t.clicked, delivered), unsubscribed: pct(t.unsubscribed, delivered), bounced: pct(t.bounced, t.sent) };

  const tz = Prisma.sql`'Australia/Melbourne'`;
  const dailySent = await prisma.$queryRaw<any[]>`
    select to_char((sent_at at time zone 'UTC') at time zone ${tz}, 'YYYY-MM-DD') as day, count(*)::int as sent from crm.marketing_messages
    where marketing = true and sent_at >= ${from} and sent_at <= ${to} group by 1`;
  const dailyEv = await prisma.$queryRaw<any[]>`
    select to_char((e.occurred_at at time zone 'UTC') at time zone ${tz}, 'YYYY-MM-DD') as day, e.type, count(*)::int as n
    from crm.marketing_events e join crm.marketing_messages m on m.id = e.message_id
    where m.marketing = true and e.type in ('open', 'click') and e.occurred_at >= ${from} and e.occurred_at <= ${to} group by 1, 2`;
  const days = new Map<string, { day: string; sent: number; opens: number; clicks: number }>();
  const slot = (d: string) => { if (!days.has(d)) days.set(d, { day: d, sent: 0, opens: 0, clicks: 0 }); return days.get(d)!; };
  for (const r of dailySent) slot(r.day).sent = r.sent;
  for (const r of dailyEv) slot(r.day)[r.type === 'open' ? 'opens' : 'clicks'] = r.n;

  const orders = await attributedOrders(from, to, s.attribution_days);
  const byCampaign = new Map<string, AttributedOrder[]>(); const byAuto = new Map<string, AttributedOrder[]>();
  for (const o of orders) { if (o.campaignId) byCampaign.set(o.campaignId, [...(byCampaign.get(o.campaignId) ?? []), o]); if (o.automationKey) byAuto.set(o.automationKey, [...(byAuto.get(o.automationKey) ?? []), o]); }

  const camps = await prisma.$queryRaw<any[]>`
    select c.id, c.name, c.subject, c.status, c.sent_at as "sentAt",
           count(m.id) filter (where m.sent_at is not null)::int as sent, count(m.id) filter (where m.status in ('bounced', 'complained'))::int as bounced,
           count(m.id) filter (where m.opened_at is not null)::int as opened, count(m.id) filter (where m.click_count > 0)::int as clicked, count(m.id) filter (where m.unsubscribed_at is not null)::int as unsubscribed
    from crm.marketing_campaigns c left join crm.marketing_messages m on m.campaign_id = c.id
    where c.status in ('sending', 'sent') and c.sent_at >= ${from} and c.sent_at <= ${to}
    group by c.id order by c.sent_at desc limit 10`;
  const campaigns = camps.map(c => { const d = c.sent - c.bounced; const o = ordersOf(byCampaign.get(c.id) ?? []);
    return { ...c, delivered: d, openRate: pct(c.opened, d), clickRate: pct(c.clicked, d), orders: o.count, revenue: o.revenue }; });

  const autos = await prisma.$queryRaw<any[]>`
    select automation_key as key, count(*) filter (where sent_at is not null)::int as sent, count(*) filter (where opened_at is not null)::int as opened, count(*) filter (where click_count > 0)::int as clicked,
           count(*) filter (where status in ('queued', 'sending'))::int as waiting
    from crm.marketing_messages where automation_key is not null and (sent_at >= ${from} and sent_at <= ${to} or status in ('queued', 'sending')) group by automation_key`;
  const automations = AUTO_KEYS.map(k => { const r = autos.find(a => a.key === k); const o = ordersOf(byAuto.get(k) ?? []);
    return { key: k, name: AUTOMATIONS[k].name, marketing: AUTOMATIONS[k].marketing, sent: r?.sent ?? 0, opened: r?.opened ?? 0, clicked: r?.clicked ?? 0, waiting: r?.waiting ?? 0, orders: o.count, revenue: o.revenue }; });

  return {
    from, to, attributionDays: s.attribution_days, status: await sendingStatus(),
    totals: { ...t, delivered, waiting: w.n }, rates,
    orders: { ...ordersOf(orders), recent: orders.slice(0, 10) },
    daily: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
    campaigns, automations, audience: await audienceSummary(),
  };
}

export async function campaignReport(id: string) {
  const [c] = await prisma.$queryRaw<any[]>`select id, name, subject, status, audience, scheduled_at as "scheduledAt", sent_at as "sentAt", created_at as "createdAt" from crm.marketing_campaigns where id = ${id}::uuid`;
  if (!c) return null;
  const s = await getSettings();
  const [t] = await prisma.$queryRaw<any[]>`
    select count(*)::int as total, count(*) filter (where sent_at is not null)::int as sent, count(*) filter (where status in ('queued', 'sending'))::int as waiting,
           count(*) filter (where status = 'skipped')::int as skipped, count(*) filter (where status = 'failed')::int as failed,
           count(*) filter (where status = 'bounced')::int as bounced, count(*) filter (where status = 'complained')::int as complained,
           count(*) filter (where opened_at is not null)::int as opened, count(*) filter (where click_count > 0)::int as clicked, count(*) filter (where unsubscribed_at is not null)::int as unsubscribed,
           coalesce(sum(open_count), 0)::int as opens, coalesce(sum(click_count), 0)::int as clicks
    from crm.marketing_messages where campaign_id = ${id}::uuid`;
  const delivered = t.sent - t.bounced - t.complained;
  const links = await prisma.$queryRaw<any[]>`
    select e.url, count(*)::int as clicks, count(distinct e.message_id)::int as people
    from crm.marketing_events e join crm.marketing_messages m on m.id = e.message_id where m.campaign_id = ${id}::uuid and e.type = 'click' group by e.url order by clicks desc limit 20`;
  const recipients = await prisma.$queryRaw<any[]>`
    select m.id, m.email, m.to_name as name, k.company, m.status, m.error, m.sent_at as "sentAt", m.opened_at as "openedAt", m.open_count as opens, m.click_count as clicks, m.unsubscribed_at as "unsubscribedAt"
    from crm.marketing_messages m left join crm.marketing_contacts k on k.id = m.contact_id where m.campaign_id = ${id}::uuid
    order by m.click_count desc, m.open_count desc, m.email limit 500`;
  const from = c.sentAt ? new Date(c.sentAt) : new Date(0), to = new Date();
  const orders = await attributedOrders(from, to, s.attribution_days, id);
  const timeline = await prisma.$queryRaw<any[]>`
    select to_char((e.occurred_at at time zone 'UTC') at time zone 'Australia/Melbourne', 'YYYY-MM-DD') as day, e.type, count(*)::int as n
    from crm.marketing_events e join crm.marketing_messages m on m.id = e.message_id where m.campaign_id = ${id}::uuid and e.type in ('open', 'click') group by 1, 2 order by 1`;
  return {
    campaign: c, attributionDays: s.attribution_days,
    stats: { ...t, delivered, openRate: pct(t.opened, delivered), clickRate: pct(t.clicked, delivered), unsubscribeRate: pct(t.unsubscribed, delivered), bounceRate: pct(t.bounced, t.sent) },
    links, recipients, orders: { ...ordersOf(orders), rows: orders }, timeline,
  };
}