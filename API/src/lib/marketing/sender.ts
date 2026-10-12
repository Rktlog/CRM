import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { retailPrice } from '../pricing';
import { getProvider, NotConnectedError, Outgoing, SendResult } from './provider';
import { renderEmail, Block, unknownTags } from './blocks';
import { getSettings } from './settings';
import { audienceConds, cleanFilter } from './audience';

export const linkSecret = () => process.env.MARKETING_SECRET || process.env.SYNC_SECRET || 'rhino-radar-dev-secret';

const hasContent = (blocks: Block[]) => (blocks ?? []).some(b => b.type !== 'spacer' && b.type !== 'divider');

// Everything that must be true before a campaign can go out. Returns the first problem, in plain words.
export async function campaignProblems(c: { subject: string; blocks: Block[] }): Promise<string | null> {
  const s = await getSettings();
  if (!c.subject?.trim()) return 'Add a subject line.';
  if (!hasContent(c.blocks)) return 'The email is empty. Add some content.';
  const bad = unknownTags(c.subject, c.blocks);
  if (bad.length) return `These merge tags are not recognised: ${bad.map(t => `{{${t}}}`).join(', ')}.`;
  if (!s.from_email) return 'Set the sender email address in Marketing settings.';
  if (!s.footer_address.trim()) return 'Add your business address in Marketing settings. It is printed in every email, and the law requires it.';
  if (!s.tracking_base_url) return 'Set this API\'s public web address in Marketing settings (or PUBLIC_API_URL), so opens and clicks can be counted.';
  return null;
}

// Turns a campaign into one queued email per person in its audience. Nothing is sent here.
export async function queueCampaign(campaignId: string): Promise<{ queued: number } | { error: string }> {
  const [c] = await prisma.$queryRaw<any[]>`select id, subject, blocks, audience, status from crm.marketing_campaigns where id = ${campaignId}::uuid`;
  if (!c) return { error: 'Campaign not found' };
  if (!['draft', 'scheduled'].includes(c.status)) return { error: 'This campaign has already been sent.' };
  const problem = await campaignProblems(c); if (problem) return { error: problem };
  const conds = [Prisma.sql`c.status = 'subscribed'`, Prisma.sql`not exists (select 1 from crm.marketing_suppressions s where s.email = lower(c.email))`, ...audienceConds(cleanFilter(c.audience))];
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    insert into crm.marketing_messages (campaign_id, contact_id, email, to_name, subject, context, marketing)
    select ${campaignId}::uuid, c.id, c.email, nullif(btrim(concat_ws(' ', c.first_name, c.last_name)), ''), ${c.subject},
           jsonb_build_object('first_name', coalesce(c.first_name, ''), 'last_name', coalesce(c.last_name, ''), 'company', coalesce(c.company, ''), 'email', c.email), true
    from crm.marketing_contacts c where ${Prisma.join(conds, ' and ')}
    on conflict do nothing returning id`;
  if (!rows.length) {
    const [have] = await prisma.$queryRaw<{ n: number }[]>`select count(*)::int as n from crm.marketing_messages where campaign_id = ${campaignId}::uuid`;
    if (!have.n) return { error: 'Nobody is in this audience. Change who it goes to.' };
  }
  await prisma.$queryRaw`update crm.marketing_campaigns set status = 'sending', updated_at = now() where id = ${campaignId}::uuid`;
  return { queued: rows.length };
}

let draining = false;
// Sends queued emails, up to `max` at a time, 100 per request. Does nothing until the email service is connected.
export async function drainQueue(max = 500): Promise<{ sent: number; failed: number; skipped: number; connected: boolean }> {
  const provider = getProvider();
  const out = { sent: 0, failed: 0, skipped: 0, connected: provider.connected };
  if (!provider.connected || draining) return out;
  draining = true;
  try {
    const s = await getSettings();
    // A crash can leave emails marked as being sent. Nothing else is sending now, so put them back.
    await prisma.$queryRaw`update crm.marketing_messages set status = 'queued' where status = 'sending'`;
    while (out.sent + out.failed + out.skipped < max) {
      const claimed = await prisma.$queryRaw<{ id: string }[]>`
        update crm.marketing_messages set status = 'sending'
        where id in (select id from crm.marketing_messages where status = 'queued' order by queued_at, id limit 100 for update skip locked) returning id`;
      if (!claimed.length) break;
      const ids = claimed.map(c => c.id);
      const msgs = await prisma.$queryRaw<any[]>`
        select m.id, m.email, m.to_name, m.subject, m.context, m.marketing, m.token, m.automation_key, m.campaign_id,
               coalesce(c.blocks, t.blocks) as blocks, coalesce(c.preview_text, t.preview_text, '') as preview, c.from_name as campaign_from, c.reply_to as campaign_reply,
               k.status as contact_status,
               exists (select 1 from crm.marketing_suppressions s where s.email = lower(m.email)) as suppressed
        from crm.marketing_messages m
        left join crm.marketing_campaigns c on c.id = m.campaign_id
        left join crm.marketing_templates t on t.id = m.template_id
        left join crm.marketing_contacts k on k.id = m.contact_id
        where m.id = any(${ids}::uuid[])`;

      // The product pictures and prices that this batch's emails show.
      const skus = [...new Set(msgs.flatMap(m => (m.blocks ?? []).filter((b: Block) => b.type === 'products').flatMap((b: any) => b.skus ?? [])))] as string[];
      const prods = skus.length ? await prisma.$queryRaw<any[]>`select sku, name, image_url, prices from crm.products where sku = any(${skus})` : [];
      const products = Object.fromEntries(prods.map(p => [p.sku, { name: p.name, imageUrl: p.image_url, price: retailPrice(p.prices) }]));

      const toSend: { id: string; msg: Outgoing }[] = [];
      for (const m of msgs) {
        const skip = m.suppressed ? 'On the do-not-email list' : m.marketing && m.contact_status !== 'subscribed' ? `Contact is ${m.contact_status ?? 'no longer a contact'}` : null;
        if (skip) { await prisma.$queryRaw`update crm.marketing_messages set status = 'skipped', error = ${skip} where id = ${m.id}::uuid`; out.skipped++; continue; }
        const ctx = (m.context ?? {}) as any;
        const r = renderEmail({
          subject: m.subject, preview: m.preview, blocks: m.blocks ?? [],
          // {{portal_link}} and {{cart_link}} come from the settings unless this email has its own.
          ctx: { values: { portal_link: s.portal_url, cart_link: s.portal_url, ...(ctx.values ?? ctx) }, items: ctx.items, facts: ctx.facts, products },
          footer: { address: s.footer_address, business: s.business_name, unsubscribe: !!m.marketing },
          track: { baseUrl: s.tracking_base_url, token: m.token, secret: linkSecret() },
        });
        const from = `${(m.campaign_from || s.from_name || 'Rhino Rhino').replace(/["<>]/g, '')} <${s.from_email}>`;
        toSend.push({ id: m.id, msg: {
          to: m.email, toName: m.to_name ?? undefined, from, replyTo: m.campaign_reply || s.reply_to || undefined, subject: r.subject, html: r.html, text: r.text,
          headers: m.marketing ? { 'List-Unsubscribe': `<${s.tracking_base_url}/m/u/${m.token}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : undefined,
        } });
      }
      if (toSend.length) {
        let results: SendResult[];
        try { results = await provider.sendBatch(toSend.map(x => x.msg)); }
        catch (e) {
          if (e instanceof NotConnectedError) { await prisma.$queryRaw`update crm.marketing_messages set status = 'queued' where id = any(${toSend.map(x => x.id)}::uuid[])`; return out; }
          results = toSend.map(() => ({ error: String((e as Error).message ?? e).slice(0, 300) }));
        }
        for (const [i, x] of toSend.entries()) {
          const r = results[i];
          if (r?.id) { await prisma.$queryRaw`update crm.marketing_messages set status = 'sent', sent_at = now(), provider_id = ${r.id}, error = null where id = ${x.id}::uuid`; out.sent++; }
          else { await prisma.$queryRaw`update crm.marketing_messages set status = 'failed', error = ${r?.error ?? 'No answer from the email service'} where id = ${x.id}::uuid`; out.failed++; }
        }
      }
    }
    // A campaign is finished when nothing of it is waiting any more.
    await prisma.$queryRaw`
      update crm.marketing_campaigns c set status = 'sent', sent_at = coalesce(c.sent_at, now()), updated_at = now()
      where c.status = 'sending' and not exists (select 1 from crm.marketing_messages m where m.campaign_id = c.id and m.status in ('queued', 'sending'))`;
  } finally { draining = false; }
  return out;
}

// Campaigns set for a time that has now arrived.
export async function queueDueCampaigns(): Promise<number> {
  const due = await prisma.$queryRaw<{ id: string }[]>`select id from crm.marketing_campaigns where status = 'scheduled' and scheduled_at <= now()`;
  let n = 0;
  for (const c of due) {
    const r = await queueCampaign(c.id);
    if ('error' in r) await prisma.$queryRaw`update crm.marketing_campaigns set status = 'draft', updated_at = now() where id = ${c.id}::uuid`;   // back to draft so someone sees it
    else n++;
  }
  return n;
}