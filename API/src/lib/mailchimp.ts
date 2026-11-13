// Mailchimp, READ ONLY. Radar reads your sent and scheduled campaigns (name, date, who it went to, opens, clicks) and who clicked each one, so the marketing dashboard can credit orders and
// carts to a campaign. It never sends, edits, deletes or subscribes anything in Mailchimp: only GET requests are made (a test checks this).
// The API key is MAILCHIMP_API_KEY on the API (a read-only key made under a dedicated Mailchimp user is best). It is never logged and never sent to the browser.
import { prisma } from './prisma';
import { MktError, guard, orderAny, orderLive, oday } from './mktShared';
import { getSettings } from './marketing/settings';

export type Fetch = (url: string, init?: any) => Promise<Response>;
let ft: Fetch = (u, i) => fetch(u, i);
let baseOverride: string | null = null;
/** For tests only: point the client at a fake Mailchimp. */
export function setMailchimpForTests(o: { fetch?: Fetch; base?: string } | null) { ft = o?.fetch ?? ((u, i) => fetch(u, i)); baseOverride = o?.base ?? null; }
export class MailchimpError extends Error { status: number; constructor(message: string, status = 502) { super(message); this.status = status; } }
const key = () => process.env.MAILCHIMP_API_KEY?.trim() || '';
export const mailchimpConfigured = (): boolean => /^[0-9a-f]+-[a-z]{2}\d+$/i.test(key());
const base = () => baseOverride ?? `https://${key().split('-').pop()}.api.mailchimp.com/3.0`;
async function get(path: string, retries = 1): Promise<any> {
  if (!mailchimpConfigured()) throw new MailchimpError('MAILCHIMP_API_KEY is not set on the server (it looks like abcdef0123-us21).', 400);
  const res = await ft(`${base()}${path}`, { method: 'GET', headers: { Authorization: `Basic ${Buffer.from(`radar:${key()}`).toString('base64')}`, Accept: 'application/json' } });
  if (res.status === 429 && retries > 0) { await new Promise(r => setTimeout(r, Math.min(Number(res.headers.get('retry-after') ?? 2), 5) * 1000)); return get(path, retries - 1); }
  if (res.status === 401 || res.status === 403) throw new MailchimpError('Mailchimp did not accept the API key.', res.status);
    if (!res.ok) { let t = ''; try { t = String(((await res.json()) as { detail?: unknown } | null)?.detail ?? '').slice(0, 120); } catch { /* not JSON */ } throw new MailchimpError(t || `Mailchimp answered ${res.status}`, res.status); }
  return res.json();
}
export type Campaign = { id: string; title: string; subject: string | null; status: 'sent' | 'scheduled'; at: string | null; listName: string | null; segment: string | null; emailsSent: number; opens: number; clicks: number };
const FIELDS = 'total_items,campaigns.id,campaigns.status,campaigns.send_time,campaigns.emails_sent,campaigns.settings.title,campaigns.settings.subject_line,campaigns.recipients.list_name,campaigns.recipients.segment_text,campaigns.report_summary.opens,campaigns.report_summary.clicks';
async function campaignsWith(status: 'sent' | 'schedule', sinceIso?: string): Promise<Campaign[]> {
  const out: Campaign[] = [];
  for (let offset = 0; offset < 1000; offset += 200) {
    const b = await get(`/campaigns?count=200&offset=${offset}&status=${status}&sort_field=send_time&sort_dir=DESC${sinceIso ? `&since_send_time=${encodeURIComponent(sinceIso)}` : ''}&fields=${FIELDS}`);
    for (const c of b?.campaigns ?? []) out.push({
      id: String(c.id), title: String(c.settings?.title ?? c.settings?.subject_line ?? 'Untitled campaign').slice(0, 200), subject: c.settings?.subject_line ? String(c.settings.subject_line).slice(0, 300) : null,
      status: status === 'sent' ? 'sent' : 'scheduled', at: c.send_time ? String(c.send_time) : null, listName: c.recipients?.list_name ? String(c.recipients.list_name) : null,
      segment: c.recipients?.segment_text ? String(c.recipients.segment_text).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300) || null : null,
      emailsSent: Number(c.emails_sent ?? 0), opens: Number(c.report_summary?.opens ?? 0), clicks: Number(c.report_summary?.clicks ?? 0),
    });
    if (offset + 200 >= Number(b?.total_items ?? 0)) break;
  }
  return out;
}
/** Sent campaigns from the last 400 days, and the ones scheduled to go. */
export async function listCampaigns(): Promise<Campaign[]> {
  const since = new Date(Date.now() - 400 * 86400000).toISOString();
  return [...await campaignsWith('sent', since), ...await campaignsWith('schedule')];
}
/** Who clicked a campaign, and when (every click, so an order can be matched to the click just before it). Up to 20,000 recipients. */
export async function clickersOf(campaignId: string): Promise<Map<string, Date[]>> {
  const out = new Map<string, Date[]>();
  for (let offset = 0; offset < 20_000; offset += 1000) {
    const b = await get(`/reports/${encodeURIComponent(campaignId)}/email-activity?count=1000&offset=${offset}&fields=total_items,emails.email_address,emails.activity`);
    for (const e of b?.emails ?? []) {
      const email = String(e.email_address ?? '').trim().toLowerCase(); if (!email) continue;
      const times = (e.activity ?? []).filter((a: any) => a?.action === 'click' && a.timestamp).map((a: any) => new Date(a.timestamp)).filter((d: Date) => !Number.isNaN(d.getTime()));
      if (times.length) out.set(email, [...(out.get(email) ?? []), ...times].slice(0, 20));
    }
    if (offset + 1000 >= Number(b?.total_items ?? 0)) break;
  }
  return out;
}

// ---------- the copy in Radar ----------
export type SyncResult = { campaigns: number; clickRefreshes: number; stopped: string | null };
const dayIn = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Australia/Melbourne' });
async function setState(v: Record<string, unknown>) { await prisma.$queryRaw`insert into crm.mkt_state (key, value) values ('mailchimp', ${JSON.stringify(v)}::jsonb) on conflict (key) do update set value = excluded.value, updated_at = now()`; }
/** Reads Mailchimp and keeps the copy: the campaigns (each also becomes a row on the EDMs page) and who clicked the recent ones. A few campaigns' clicks are read per run, newest first. */
export async function syncMailchimp(budgetMs = 25_000, maxClickReads = 6): Promise<SyncResult> {
  const out: SyncResult = { campaigns: 0, clickRefreshes: 0, stopped: null }; const until = Date.now() + budgetMs;
  if (!mailchimpConfigured()) return { ...out, stopped: 'MAILCHIMP_API_KEY is not set' };
  try {
    return await guard(async () => {
      let list: Campaign[];
      try { list = await listCampaigns(); } catch (e) { const msg = e instanceof MailchimpError ? e.message : 'Mailchimp would not answer'; await setState({ at: new Date().toISOString(), ok: false, error: msg }); return { ...out, stopped: msg }; }
      for (const c of list) {
        if (!c.at) continue;
        const day = dayIn(c.at);
        const [i] = await prisma.$queryRaw<{ id: string }[]>`insert into crm.mkt_initiatives (kind, name, outcome, starts_on, primary_metric, external_id) values ('edm', ${c.title}, 'sales', ${day}::date, 'sales', ${c.id})
          on conflict (external_id) do update set name = excluded.name, starts_on = excluded.starts_on, updated_at = now() returning id`;
        await prisma.$queryRaw`insert into crm.mkt_edm_campaigns (campaign_id, initiative_id, title, subject, status, sent_at, scheduled_for, list_name, segment, emails_sent, opens, clicks)
          values (${c.id}, ${i!.id}::uuid, ${c.title}, ${c.subject}, ${c.status}, ${c.status === 'sent' ? c.at : null}::timestamptz, ${c.status === 'scheduled' ? c.at : null}::timestamptz, ${c.listName}, ${c.segment}, ${c.emailsSent}, ${c.opens}, ${c.clicks})
          on conflict (campaign_id) do update set title = excluded.title, subject = excluded.subject, status = excluded.status, sent_at = excluded.sent_at, scheduled_for = excluded.scheduled_for, list_name = excluded.list_name, segment = excluded.segment,
            emails_sent = excluded.emails_sent, opens = excluded.opens, clicks = excluded.clicks, synced_at = now()`;
        out.campaigns++;
      }
      // who clicked: the newest campaigns first, those sent in the last 30 days again each time (late clicks), older ones only once
      const todo = await prisma.$queryRaw<{ campaign_id: string }[]>`select campaign_id from crm.mkt_edm_campaigns where status = 'sent' and clicks > 0 and (activity_synced_at is null or sent_at > now() - interval '30 days') order by sent_at desc limit ${maxClickReads}::int`;
      let error: string | null = null;
      for (const t of todo) {
        if (Date.now() > until) { out.stopped = 'out of time for this run: the rest is read next time'; break; }
        try {
          const clickers = await clickersOf(t.campaign_id);
          await prisma.$queryRaw`delete from crm.mkt_edm_clicks where campaign_id = ${t.campaign_id}`;
          for (const [email, times] of clickers) await prisma.$queryRaw`insert into crm.mkt_edm_clicks (campaign_id, email, click_times) values (${t.campaign_id}, ${email}, ${times.map(d => d.toISOString())}::timestamptz[])`;
          await prisma.$queryRaw`update crm.mkt_edm_campaigns set activity_synced_at = now() where campaign_id = ${t.campaign_id}`;
          out.clickRefreshes++;
        } catch (e) { error = e instanceof MailchimpError ? e.message : 'Mailchimp would not answer'; out.stopped = error; break; }
      }
      await setState({ at: new Date().toISOString(), ok: !error, campaigns: out.campaigns, clickRefreshes: out.clickRefreshes, error });
      return out;
    });
  } catch (e) { if (e instanceof MktError) return { ...out, stopped: e.status === 503 ? 'not set up in the database yet' : e.message }; throw e; }
}
export async function mailchimpState(): Promise<{ configured: boolean; at: string | null; ok: boolean | null; error: string | null; campaigns: number | null }> {
  const [r] = await prisma.$queryRaw<{ value: any; updated_at: Date }[]>`select value, updated_at from crm.mkt_state where key = 'mailchimp'`;
  return { configured: mailchimpConfigured(), at: r ? new Date(r.updated_at).toISOString() : null, ok: r ? !!r.value?.ok : null, error: r?.value?.error ?? null, campaigns: r?.value?.campaigns ?? null };
}

// ---------- crediting orders and carts to campaigns ----------
export type Tag = 'new' | 'existing' | 'reactivated';
/** New: nothing before. Existing: the one before was within 12 months. Reactivated: the one before was more than 12 months earlier. */
export function tagOf(day: string, previous: string | null): Tag {
  if (!previous) return 'new';
  const cut = new Date(`${day}T00:00:00Z`); cut.setUTCFullYear(cut.getUTCFullYear() - 1);
  return previous >= cut.toISOString().slice(0, 10) ? 'existing' : 'reactivated';
}
export type Credit = { sales: number; value: number; carts: number; byTag: Record<Tag, number> };
const EMPTY = (): Credit => ({ sales: 0, value: 0, carts: 0, byTag: { new: 0, existing: 0, reactivated: 0 } });
/** For each campaign: the orders credited to it (a click within the order window BEFORE the order; if there were several the last click wins; an order counts once), the carts left behind after a click, and which kind of stockist ordered. */
export async function creditByCampaign(): Promise<Map<string, Credit>> {
  const out = new Map<string, Credit>(); const days = (await getSettings()).attribution_days;
  const [first] = await prisma.$queryRaw<{ d: Date | null }[]>`select min(coalesce(sent_at, scheduled_for)) as d from crm.mkt_edm_campaigns`;
  if (!first?.d) return out;
  const orders = await prisma.$queryRawUnsafe<{ id: string; value: number; day: string; prev: string | null; campaign_id: string }[]>(`
    select q.id, coalesce(q.goods_total, q.amount)::float8 as value, to_char(${oday('q')}, 'YYYY-MM-DD') as day,
      (select to_char(max(${oday('p')}), 'YYYY-MM-DD') from crm.quotes p where p.account_id = q.account_id and ${orderAny('p')} and ${oday('p')} < ${oday('q')}) as prev, k.campaign_id
    from crm.quotes q join crm.accounts a on a.id = q.account_id
    join lateral (select kk.campaign_id, ct from crm.mkt_edm_clicks kk, unnest(kk.click_times) ct
      where (kk.email = lower(btrim(coalesce(q.order_email, ''))) or kk.email = any(string_to_array(lower(regexp_replace(coalesce(a.email, ''), '[,;\\s]+', ';', 'g')), ';')))
        and ct <= q.sent_at and ct >= q.sent_at - make_interval(days => $1::int) order by ct desc limit 1) k on true
    where ${orderLive('q')} and q.sent_at >= $2::timestamp - interval '1 day'`, days, first.d);
  for (const o of orders) { const c = out.get(o.campaign_id) ?? EMPTY(); c.sales++; c.value += o.value; c.byTag[tagOf(o.day, o.prev)]++; out.set(o.campaign_id, c); }
  const carts = await prisma.$queryRawUnsafe<{ campaign_id: string; n: number }[]>(`
    select k.campaign_id, count(*)::int as n from (select abandoned_at, lower(btrim(email)) as email from crm.abandoned_cart_lines group by abandoned_at, lower(btrim(email))) c
    join lateral (select kk.campaign_id, ct from crm.mkt_edm_clicks kk, unnest(kk.click_times) ct where kk.email = c.email and ct <= c.abandoned_at and ct >= c.abandoned_at - make_interval(days => $1::int) order by ct desc limit 1) k on true
    where c.abandoned_at >= $2::timestamp - interval '1 day' group by k.campaign_id`, days, first.d);
  for (const c of carts) { const v = out.get(c.campaign_id) ?? EMPTY(); v.carts = c.n; out.set(c.campaign_id, v); }
  for (const v of out.values()) v.value = Math.round(v.value * 100) / 100;
  return out;
}
