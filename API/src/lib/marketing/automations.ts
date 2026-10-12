import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { EMAIL_OK } from './audience';
import { getSettings, MarketingSettings } from './settings';
import { drainQueue, queueDueCampaigns } from './sender';
import { ensureStarters } from './starters';

// The automatic emails. Each one looks at your orders and carts, finds who should get an email now,
// and queues it. They never send until switched on AND the email service is connected. "Preview" shows
// exactly who would get one, so you can check before turning anything on.
export type AutoKey = 'unpaid_quote' | 'unpaid_invoice' | 'sales_invoice' | 'tracking_number' | 'abandoned_cart';
export const AUTOMATIONS: Record<AutoKey, { name: string; blurb: string; marketing: boolean; waitFrom: string; windowDays: number; tags: string[] }> = {
  unpaid_quote: { name: 'Unpaid quote', marketing: false, waitFrom: 'the quote was sent', windowDays: 60,
    blurb: 'Reminds a customer who pays before dispatch that their quote is waiting for payment.', tags: ['first_name', 'company', 'quote_number', 'amount', 'portal_link'] },
  unpaid_invoice: { name: 'Unpaid invoice', marketing: false, waitFrom: 'the invoice date', windowDays: 180,
    blurb: 'Reminds a customer that an invoice still has an amount owing.', tags: ['first_name', 'company', 'invoice_number', 'invoice_date', 'due_date', 'amount_due'] },
  sales_invoice: { name: 'Sales invoice', marketing: false, waitFrom: 'the invoice was issued', windowDays: 2,
    blurb: 'Tells a customer their tax invoice has been issued.', tags: ['first_name', 'company', 'invoice_number', 'invoice_date', 'amount', 'order_number'] },
  tracking_number: { name: 'Tracking number', marketing: false, waitFrom: 'the parcel was sent', windowDays: 3,
    blurb: 'Sends the tracking number and a tracking link when an order ships.', tags: ['first_name', 'company', 'order_number', 'carrier', 'tracking_number', 'tracking_link'] },
  abandoned_cart: { name: 'Abandoned cart', marketing: true, waitFrom: 'the cart was left', windowDays: 7,
    blurb: 'Reminds an opted-in customer about items left in their cart, if they have not ordered since. Marketing, so it stops if they unsubscribe.', tags: ['first_name', 'company', 'cart_total', 'cart_link'] },
};
export const AUTO_KEYS = Object.keys(AUTOMATIONS) as AutoKey[];

const money = (n: number | null | undefined) => (n == null ? '' : '$' + Number(n).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const day = (d: unknown) => { if (!d) return ''; const t = new Date(d as string); return Number.isNaN(t.getTime()) ? '' : t.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Australia/Melbourne' }); };
const LIVE = Prisma.sql`q.misc_type is null and q.source <> 'rhino-history' and q.number !~ '^Q' and upper(coalesce(q.fulfillment_status, '')) not in ('VOIDED', 'CREDITED', 'DRAFT')`;
const ORDER_EMAIL = Prisma.sql`coalesce(nullif(btrim(q.order_email), ''), nullif(btrim(a.email), ''))`;
const NULLS = { invoice_number: Prisma.sql`null::text`, amount_due: Prisma.sql`null::float`, due_date: Prisma.sql`null::text`, carrier: Prisma.sql`null::text`, tracking_number: Prisma.sql`null::text`, tracking_url: Prisma.sql`null::text`, cart_total: Prisma.sql`null::float`, items: Prisma.sql`null::jsonb` };

// Who is due an email of this kind, before the rules about repeats and consent. `delay` is in hours.
function baseQuery(key: AutoKey, delay: number): Prisma.Sql {
  const d = Prisma.sql`make_interval(hours => ${delay}::int)`;
  const cols = (o: Partial<typeof NULLS> & { entity: Prisma.Sql; number: Prisma.Sql; amount: Prisma.Sql; event_at: Prisma.Sql }) => ({ ...NULLS, ...o });
  switch (key) {
    case 'unpaid_quote': {
      const c = cols({ entity: Prisma.sql`'unpaid_quote:' || q.number`, number: Prisma.sql`q.number`, amount: Prisma.sql`coalesce(q.total, q.amount)`, event_at: Prisma.sql`q.sent_at` });
      return Prisma.sql`
        select ${c.entity} as entity, ${ORDER_EMAIL} as email, a.id as account_id, a.name as account_name, a.contact_name, ${c.number} as number, ${c.invoice_number} as invoice_number,
               ${c.amount}::float as amount, ${c.amount_due} as amount_due, ${c.event_at} as event_at, ${c.due_date} as due_date, ${c.carrier} as carrier,
               ${c.tracking_number} as tracking_number, ${c.tracking_url} as tracking_url, ${c.cart_total} as cart_total, ${c.items} as items
        from crm.quotes q join crm.accounts a on a.id = q.account_id
        where ${LIVE} and q.paid = false and q.invoice_number is null
          and upper(coalesce(q.fulfillment_status, '')) in ('ESTIMATING', 'ESTIMATED', 'ORDERING', 'ORDERED')
          and (coalesce(nullif(btrim(a.payment_terms), ''), 'Prepayment') ~* 'prepay')
          and q.sent_at <= now() - ${d} and q.sent_at >= now() - interval '60 days'`;
    }
    case 'unpaid_invoice': {
      const c = cols({ entity: Prisma.sql`'unpaid_invoice:' || q.number`, number: Prisma.sql`q.number`, amount: Prisma.sql`coalesce(q.invoiced_total, q.total, q.amount)`, event_at: Prisma.sql`q.invoice_date`,
        invoice_number: Prisma.sql`q.invoice_number`, amount_due: Prisma.sql`q.amount_due`, due_date: Prisma.sql`q.invoices->0->>'dueDate'` });
      return Prisma.sql`
        select ${c.entity} as entity, ${ORDER_EMAIL} as email, a.id as account_id, a.name as account_name, a.contact_name, ${c.number} as number, ${c.invoice_number} as invoice_number,
               ${c.amount}::float as amount, ${c.amount_due} as amount_due, ${c.event_at} as event_at, ${c.due_date} as due_date, ${c.carrier} as carrier,
               ${c.tracking_number} as tracking_number, ${c.tracking_url} as tracking_url, ${c.cart_total} as cart_total, ${c.items} as items
        from crm.quotes q join crm.accounts a on a.id = q.account_id
        where ${LIVE} and q.invoice_number is not null and coalesce(q.amount_due, 0) > 0.005
          and q.invoice_date <= now() - ${d} and q.invoice_date >= now() - interval '180 days'`;
    }
    case 'sales_invoice': {
      const c = cols({ entity: Prisma.sql`'sales_invoice:' || q.invoice_number`, number: Prisma.sql`q.number`, amount: Prisma.sql`coalesce(q.invoiced_total, q.total, q.amount)`, event_at: Prisma.sql`q.invoice_date`, invoice_number: Prisma.sql`q.invoice_number` });
      return Prisma.sql`
        select ${c.entity} as entity, ${ORDER_EMAIL} as email, a.id as account_id, a.name as account_name, a.contact_name, ${c.number} as number, ${c.invoice_number} as invoice_number,
               ${c.amount}::float as amount, ${c.amount_due} as amount_due, ${c.event_at} as event_at, ${c.due_date} as due_date, ${c.carrier} as carrier,
               ${c.tracking_number} as tracking_number, ${c.tracking_url} as tracking_url, ${c.cart_total} as cart_total, ${c.items} as items
        from crm.quotes q join crm.accounts a on a.id = q.account_id
        where ${LIVE} and q.invoice_number is not null and q.invoice_date >= now() - interval '48 hours' and q.invoice_date <= now() - ${d}`;
    }
    case 'tracking_number': {
      const shipped = Prisma.sql`coalesce(nullif(s->>'date', '')::timestamp, q.sent_at)`;
      return Prisma.sql`
        select distinct on (s->>'trackingNumber') 'tracking:' || (s->>'trackingNumber') as entity, ${ORDER_EMAIL} as email, a.id as account_id, a.name as account_name, a.contact_name,
               q.number as number, null::text as invoice_number, coalesce(q.total, q.amount)::float as amount, null::float as amount_due, ${shipped} as event_at, null::text as due_date,
               nullif(btrim(s->>'carrier'), '') as carrier, btrim(s->>'trackingNumber') as tracking_number, nullif(btrim(s->>'trackingUrl'), '') as tracking_url, null::float as cart_total, null::jsonb as items
        from crm.quotes q join crm.accounts a on a.id = q.account_id
        cross join lateral jsonb_array_elements(case when jsonb_typeof(q.shipments) = 'array' then q.shipments else '[]'::jsonb end) s
        where ${LIVE} and coalesce(btrim(s->>'trackingNumber'), '') <> '' and ${shipped} >= now() - interval '72 hours' and ${shipped} <= now() - ${d}
        order by s->>'trackingNumber'`;
    }
    case 'abandoned_cart':
      return Prisma.sql`
        with carts as (
          select abandoned_at, lower(email) as email, max(contact) as contact, sum(total)::float as total,
                 jsonb_agg(jsonb_build_object('name', product_name, 'qty', quantity, 'price', total) order by product_name) as items
          from crm.abandoned_cart_lines where contact !~* '[[:<:]]test[[:>:]]' group by abandoned_at, lower(email))
        select 'cart:' || to_char(c.abandoned_at, 'YYYYMMDDHH24MISS') || ':' || c.email as entity, c.email as email, a.id as account_id, a.name as account_name,
               coalesce(c.contact, a.contact_name) as contact_name, null::text as number, null::text as invoice_number, c.total as amount, null::float as amount_due, c.abandoned_at as event_at,
               null::text as due_date, null::text as carrier, null::text as tracking_number, null::text as tracking_url, c.total as cart_total, c.items as items
        from carts c
        left join crm.marketing_contacts k on lower(k.email) = c.email
        left join crm.accounts a on a.id = k.account_id
        where c.abandoned_at <= now() - ${d} and c.abandoned_at >= now() - interval '7 days'
          and not exists (select 1 from crm.quotes q join crm.accounts a2 on a2.id = q.account_id
                          where ${LIVE} and upper(coalesce(q.fulfillment_status, '')) not in ('ESTIMATING', 'ESTIMATED', 'ORDERING')   -- a confirmed order, not just a quote
                            and q.sent_at > c.abandoned_at and (lower(q.order_email) = c.email or lower(a2.email) = c.email))`;
  }
}

export type AutoConfig = { key: AutoKey; name: string; enabled: boolean; templateId: string | null; templateName: string | null; subject: string | null; delayHours: number; repeatDays: number; maxSends: number };
export async function getAutomations(): Promise<AutoConfig[]> {
  await ensureStarters();
  const rows = await prisma.$queryRaw<any[]>`
    select a.key, a.enabled, a.template_id as "templateId", t.name as "templateName", t.subject, a.delay_hours as "delayHours", a.repeat_days as "repeatDays", a.max_sends as "maxSends"
    from crm.marketing_automations a left join crm.marketing_templates t on t.id = a.template_id`;
  return AUTO_KEYS.map(k => { const r = rows.find(x => x.key === k); return { key: k, name: AUTOMATIONS[k].name, enabled: !!r?.enabled, templateId: r?.templateId ?? null, templateName: r?.templateName ?? null, subject: r?.subject ?? null,
    delayHours: r?.delayHours ?? 0, repeatDays: r?.repeatDays ?? 0, maxSends: r?.maxSends ?? 1 }; });
}

export type Candidate = {
  entity: string; seq: number; email: string | null; name: string; accountId: string | null; accountName: string | null; summary: string;
  contactId: string | null; context: { values: Record<string, string>; facts: { label: string; value: string }[]; items?: { name: string; qty?: number; price?: number }[] }; skip: string | null;
};

const trackingLink = (carrier: string | null, n: string | null, url: string | null) =>
  url || (n && /australia ?post|auspost/i.test(carrier ?? '') ? `https://auspost.com.au/mypost/track/#/details/${encodeURIComponent(n)}` : '');

// Everyone due this email now, each marked with a reason if they will be skipped.
export async function findCandidates(key: AutoKey, cfg: AutoConfig, s: MarketingSettings): Promise<Candidate[]> {
  const rows = await prisma.$queryRaw<any[]>`
    with base as (${baseQuery(key, cfg.delayHours)})
    select b.*, coalesce(m.n, 0)::int as sent_count, m.last_sent
    from base b left join (select entity_key, count(*) as n, max(queued_at) as last_sent from crm.marketing_messages where automation_key = ${key} group by entity_key) m on m.entity_key = b.entity`;
  const emails = [...new Set(rows.map(r => (r.email ?? '').toLowerCase()).filter(Boolean))];
  const contacts = emails.length ? await prisma.$queryRaw<any[]>`select id, lower(email) as email, first_name, company, status from crm.marketing_contacts where lower(email) = any(${emails})` : [];
  const suppressed = new Set(emails.length ? (await prisma.$queryRaw<{ email: string }[]>`select email from crm.marketing_suppressions where email = any(${emails})`).map(x => x.email) : []);
  const byEmail = new Map(contacts.map(c => [c.email, c]));
  const out: Candidate[] = [];
  for (const r of rows) {
    const email = (r.email ?? '').trim().toLowerCase() || null;
    const sentCount: number = r.sent_count;
    if (sentCount >= cfg.maxSends) continue;                                                        // all its emails have gone
    const waiting = sentCount > 0 && !(cfg.repeatDays > 0 && new Date(r.last_sent).getTime() <= Date.now() - cfg.repeatDays * 86400000);
    const k = email ? byEmail.get(email) : undefined;
    const first = k?.first_name || (r.contact_name ? String(r.contact_name).trim().split(/\s+/)[0] : '') || '';
    const company = k?.company || r.account_name || '';
    const link = trackingLink(r.carrier, r.tracking_number, r.tracking_url);
    const values: Record<string, string> = {
      first_name: first, company, email: email ?? '', quote_number: r.number ?? '', order_number: r.number ?? '', invoice_number: r.invoice_number ?? '',
      invoice_date: key === 'unpaid_invoice' || key === 'sales_invoice' ? day(r.event_at) : '', due_date: day(r.due_date), amount: money(r.amount), amount_due: money(r.amount_due),
      cart_total: money(r.cart_total), carrier: r.carrier ?? '', tracking_number: r.tracking_number ?? '', tracking_link: link, portal_link: s.portal_url, cart_link: s.portal_url,
    };
    const facts = ({
      unpaid_quote: [['Quote', values.quote_number], ['Quote date', day(r.event_at)], ['Amount', values.amount]],
      unpaid_invoice: [['Invoice', values.invoice_number], ['Order', values.order_number], ['Invoice date', values.invoice_date], ['Due date', values.due_date], ['Amount due', values.amount_due]],
      sales_invoice: [['Invoice', values.invoice_number], ['Order', values.order_number], ['Invoice date', values.invoice_date], ['Amount', values.amount]],
      tracking_number: [['Order', values.order_number], ['Carrier', values.carrier], ['Tracking number', values.tracking_number]],
      abandoned_cart: [['Cart total', values.cart_total], ['Left on', day(r.event_at)]],
    } as Record<AutoKey, string[][]>)[key].map(([label, value]) => ({ label, value }));
    const items = key === 'abandoned_cart' && Array.isArray(r.items) ? r.items.map((i: any) => ({ name: i.name, qty: i.qty, price: i.price })) : undefined;
    const summary = key === 'abandoned_cart' ? `${money(r.cart_total)} cart` : key === 'tracking_number' ? `${r.number} ${r.tracking_number}` : `${r.invoice_number ?? r.number} ${money(key === 'unpaid_invoice' ? r.amount_due : r.amount)}`;
    let skip: string | null = null;
    if (!email || !EMAIL_OK.test(email)) skip = 'No email address on the order or account';
    else if (suppressed.has(email)) skip = 'Bounced or marked as spam before';
    else if (AUTOMATIONS[key].marketing && !k) skip = 'Not in your audience';
    else if (AUTOMATIONS[key].marketing && k.status !== 'subscribed') skip = `Contact is ${k.status}`;
    else if (waiting) skip = 'Waiting for the next reminder';
    out.push({ entity: r.entity, seq: sentCount + 1, email, name: first, accountId: r.account_id ?? null, accountName: r.account_name ?? null, summary, contactId: k?.id ?? null, context: { values, facts, items }, skip });
  }
  return out;
}

export async function previewAutomation(key: AutoKey, limit = 50) {
  const s = await getSettings(); const cfg = (await getAutomations()).find(a => a.key === key)!;
  const all = await findCandidates(key, cfg, s);
  const eligible = all.filter(c => !c.skip); const skipped: Record<string, number> = {};
  for (const c of all) if (c.skip) skipped[c.skip] = (skipped[c.skip] ?? 0) + 1;
  const rows = [...eligible, ...all.filter(c => c.skip)].slice(0, limit).map(c => ({ entity: c.entity, to: c.email, name: c.name, account: c.accountName, summary: c.summary, reminder: c.seq, skip: c.skip }));
  return { key, enabled: cfg.enabled, willSend: eligible.length, skipped, rows };
}

// Queues the emails that are due for one automation (only if it is switched on).
export async function queueAutomation(key: AutoKey): Promise<number> {
  const s = await getSettings(); const cfg = (await getAutomations()).find(a => a.key === key)!;
  if (!cfg.enabled || !cfg.templateId) return 0;
  const [t] = await prisma.$queryRaw<{ subject: string }[]>`select subject from crm.marketing_templates where id = ${cfg.templateId}::uuid`;
  if (!t) return 0;
  const due = (await findCandidates(key, cfg, s)).filter(c => !c.skip).slice(0, 500);
  let n = 0;
  for (const c of due) {
    const r = await prisma.$queryRaw<{ id: string }[]>`
      insert into crm.marketing_messages (automation_key, template_id, contact_id, email, to_name, subject, context, marketing, entity_key, dedupe_key)
      values (${key}, ${cfg.templateId}::uuid, ${c.contactId}::uuid, ${c.email}, ${c.name || null}, ${t.subject}, ${JSON.stringify(c.context)}::jsonb, ${AUTOMATIONS[key].marketing}, ${c.entity}, ${`${c.entity}:${c.seq}`})
      on conflict do nothing returning id`;
    n += r.length;
  }
  return n;
}

// The whole job: queue what is due (automatic emails and scheduled campaigns), then send. Called every few minutes.
export async function runMarketing() {
  const queued: Record<string, number> = {};
  for (const k of AUTO_KEYS) queued[k] = await queueAutomation(k);
  const campaigns = await queueDueCampaigns();
  const sent = await drainQueue();
  return { queued, campaigns, ...sent };
}