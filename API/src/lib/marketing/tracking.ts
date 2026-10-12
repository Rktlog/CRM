import { prisma } from '../prisma';

// What happens when someone opens an email, clicks a link, unsubscribes, or the sending service reports back.
export async function recordOpen(token: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    update crm.marketing_messages set open_count = open_count + 1, opened_at = coalesce(opened_at, now()) where token = ${token} and status in ('sent', 'bounced') returning id`;
  if (!rows.length) return false;
  await prisma.$queryRaw`insert into crm.marketing_events (message_id, type) values (${rows[0].id}::uuid, 'open')`;
  return true;
}
// A click also counts as an open (many inboxes block the picture, so the click is proof they read it).
export async function recordClick(token: string, url: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    update crm.marketing_messages set click_count = click_count + 1, first_click_at = coalesce(first_click_at, now()),
           opened_at = coalesce(opened_at, now()), open_count = case when open_count = 0 then 1 else open_count end
    where token = ${token} and status in ('sent', 'bounced') returning id`;
  if (!rows.length) return false;
  await prisma.$queryRaw`insert into crm.marketing_events (message_id, type, url) values (${rows[0].id}::uuid, 'click', ${url.slice(0, 1000)})`;
  return true;
}

export async function unsubscribeInfo(token: string): Promise<{ email: string; already: boolean } | null> {
  const [r] = await prisma.$queryRaw<any[]>`select m.email, (k.status = 'unsubscribed') as already from crm.marketing_messages m left join crm.marketing_contacts k on k.id = m.contact_id where m.token = ${token}`;
  return r ? { email: r.email, already: !!r.already } : null;
}
export async function unsubscribe(token: string): Promise<boolean> {
  const [m] = await prisma.$queryRaw<any[]>`select id, contact_id, email from crm.marketing_messages where token = ${token}`;
  if (!m) return false;
  // Switch off the contact, whichever email the link came from.
  await prisma.$queryRaw`update crm.marketing_contacts set status = 'unsubscribed', unsubscribed_at = coalesce(unsubscribed_at, now()), consent_note = 'Unsubscribed from an email', updated_at = now() where lower(email) = lower(${m.email}) and status in ('subscribed', 'pending')`;
  await prisma.$queryRaw`update crm.marketing_messages set unsubscribed_at = coalesce(unsubscribed_at, now()) where id = ${m.id}::uuid`;
  await prisma.$queryRaw`insert into crm.marketing_events (message_id, type) select ${m.id}::uuid, 'unsubscribe' where not exists (select 1 from crm.marketing_events where message_id = ${m.id}::uuid and type = 'unsubscribe')`;
  return true;
}

// The sending service reporting back (Resend event names). Only a permanent bounce or a complaint
// puts an address on the do-not-email list.
export async function handleWebhook(body: any): Promise<string> {
  const type = String(body?.type ?? ''); const providerId = String(body?.data?.email_id ?? '');
  if (!providerId) return 'ignored';
  const [m] = await prisma.$queryRaw<any[]>`select id, email from crm.marketing_messages where provider_id = ${providerId}`;
  if (!m) return 'unknown message';
  if (type === 'email.delivered') {
    await prisma.$queryRaw`update crm.marketing_messages set delivered_at = coalesce(delivered_at, now()) where id = ${m.id}::uuid`;
    await prisma.$queryRaw`insert into crm.marketing_events (message_id, type) values (${m.id}::uuid, 'delivered')`;
    return 'delivered';
  }
  const permanent = type === 'email.bounced' && !/transient/i.test(String(body?.data?.bounce?.type ?? ''));
  if (permanent || type === 'email.complained') {
    const complained = type === 'email.complained';
    await prisma.$queryRaw`update crm.marketing_messages set status = ${complained ? 'complained' : 'bounced'} where id = ${m.id}::uuid`;
    await prisma.$queryRaw`update crm.marketing_contacts set status = ${complained ? 'complained' : 'bounced'}, updated_at = now() where lower(email) = lower(${m.email}) and status in ('subscribed', 'pending')`;
    await prisma.$queryRaw`insert into crm.marketing_suppressions (email, reason) values (lower(${m.email}), ${complained ? 'Marked as spam' : 'Bounced'}) on conflict (email) do nothing`;
    await prisma.$queryRaw`insert into crm.marketing_events (message_id, type) values (${m.id}::uuid, ${complained ? 'complaint' : 'bounce'})`;
    return complained ? 'complained' : 'bounced';
  }
  return 'ignored';
}