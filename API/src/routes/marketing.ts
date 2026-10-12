import { Router, Request, Response, NextFunction } from 'express';
import express from 'express';
import { prisma } from '../lib/prisma';
import { canSeeAccount } from '../lib/territory';
import { parsePeriod } from './conversion';
import { getProvider, NotConnectedError } from '../lib/marketing/provider';
import { getSettings, saveSettings } from '../lib/marketing/settings';
import { ensureStarters } from '../lib/marketing/starters';
import { renderEmail, cleanBlocks, unknownTags, MERGE_TAGS, SAMPLE_VALUES, Block } from '../lib/marketing/blocks';
import { audienceSummary, changeTags, cleanFilter, countAudience, EMAIL_OK, importContacts, listContacts, normTag, syncFromCrm, ContactQuery, ImportAs } from '../lib/marketing/audience';
import { campaignProblems, drainQueue, queueCampaign } from '../lib/marketing/sender';
import { AUTOMATIONS, AUTO_KEYS, AutoKey, getAutomations, previewAutomation, runMarketing } from '../lib/marketing/automations';
import { campaignReport, overview, sendingStatus } from '../lib/marketing/overview';
import { retailPrice } from '../lib/pricing';
import { directImage } from '../lib/marketing/blocks';

// Marketing: audience, templates, campaigns, automatic emails, the dashboard. Managers only (the one exception is
// an account's own email history, which a rep can see for accounts in their states).
export const marketingRouter = Router();

const fail = (res: Response, status: number, error: string, extra: object = {}) => res.status(status).json({ error, ...extra });
const uuid = (v: unknown) => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v);

// The signed-in manager's name, for the notes ("Consent confirmed by ...") that go on contacts.
async function who(req: Request): Promise<string> {
  const [r] = await prisma.$queryRaw<{ name: string }[]>`select name from crm.reps where id = ${req.rep!.id}::uuid`;
  return r?.name ?? 'a manager';
}

// ---- a rep can read the emails sent to their own account ----
marketingRouter.get('/account/:id/emails', async (req, res) => {
  if (!uuid(req.params.id)) return fail(res, 400, 'Bad account');
  const [a] = await prisma.$queryRaw<any[]>`select id, region, email from crm.accounts where id = ${req.params.id}::uuid`;
  if (!a) return fail(res, 404, 'Account not found');
  if (!(await canSeeAccount(req.rep!, a as any))) return fail(res, 403, 'This account is outside your states');
  const rows = await prisma.$queryRaw<any[]>`
    select m.id, m.subject, m.status, m.sent_at as "sentAt", m.opened_at as "openedAt", m.click_count as clicks, m.marketing,
           coalesce(c.name, ma.key) as "source"
    from crm.marketing_messages m
    left join crm.marketing_contacts k on k.id = m.contact_id
    left join crm.marketing_campaigns c on c.id = m.campaign_id
    left join crm.marketing_automations ma on ma.key = m.automation_key
    where m.sent_at is not null and (k.account_id = ${req.params.id}::uuid or (${a.email ?? ''} <> '' and lower(m.email) = lower(${a.email ?? ''})))
    order by m.sent_at desc limit 20`;
  res.json(rows.map(r => ({ ...r, automation: !!r.source && !r.marketing || AUTO_KEYS.includes(r.source) })));
});

// ---- everything below is for managers ----
marketingRouter.use((req: Request, res: Response, next: NextFunction) => (req.rep!.role === 'manager' ? next() : fail(res, 403, 'Marketing is for managers')));

marketingRouter.get('/overview', async (req, res) => {
  try { const p = parsePeriod(req.query); res.json({ ...(await overview(p.from, p.to)), days: p.days }); }
  catch (e) { fail(res, 400, (e as Error).message); }
});
marketingRouter.get('/status', async (_req, res) => res.json(await sendingStatus()));
marketingRouter.get('/merge-tags', (_req, res) => res.json(MERGE_TAGS));

// ---- settings ----
marketingRouter.get('/settings', async (_req, res) => res.json({ ...(await getSettings()), status: await sendingStatus() }));
marketingRouter.put('/settings', async (req, res) => {
  const err = await saveSettings(req.body ?? {});
  if (err) return fail(res, 400, err);
  res.json({ ...(await getSettings()), status: await sendingStatus() });
});

// ---- audience ----
marketingRouter.get('/audience/summary', async (_req, res) => res.json(await audienceSummary()));
marketingRouter.post('/audience/count', async (req, res) => res.json({ count: await countAudience(cleanFilter(req.body?.filter ?? req.body)) }));
marketingRouter.get('/contacts', async (req, res) => {
  const q = req.query; const s = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  res.json(await listContacts({ q: s(q.q), status: s(q.status), tag: s(q.tag), region: s(q.region), source: s(q.source), limit: Number(q.limit) || 50, offset: Number(q.offset) || 0 }));
});
marketingRouter.post('/contacts/sync', async (_req, res) => res.json(await syncFromCrm()));
marketingRouter.post('/contacts/import', express.text({ type: '*/*', limit: '20mb' }), async (req, res) => {
  const me = await who(req);
  const as = (['subscribed', 'unsubscribed', 'bounced'].includes(String(req.query.as)) ? req.query.as : 'subscribed') as ImportAs;
  // Adding people as subscribed needs a yes: that they agreed to be emailed.
  if (as === 'subscribed' && req.query.consent !== '1') return fail(res, 400, 'Confirm that these people agreed to receive your emails.');
  const note = as === 'subscribed' ? `Imported by ${me} on ${new Date().toISOString().slice(0, 10)}: permission confirmed` : `Imported as ${as}`;
  try { res.json(await importContacts(String(req.body ?? ''), { as, consentNote: note, extraTag: typeof req.query.tag === 'string' ? req.query.tag : undefined })); }
  catch (e) { fail(res, 400, (e as Error).message); }
});
marketingRouter.post('/contacts', async (req, res) => {
  const me = await who(req);
  const b = req.body ?? {}; const email = String(b.email ?? '').trim().toLowerCase();
  if (!EMAIL_OK.test(email)) return fail(res, 400, "That doesn't look like an email address.");
  if (b.consent !== true) return fail(res, 400, 'Confirm that this person agreed to receive your emails.');
  const tags = (Array.isArray(b.tags) ? b.tags : []).map((t: string) => normTag(String(t))).filter(Boolean);
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    insert into crm.marketing_contacts (email, first_name, last_name, company, source, status, consent_note, tags)
    values (${email}, ${String(b.firstName ?? '').trim() || null}, ${String(b.lastName ?? '').trim() || null}, ${String(b.company ?? '').trim() || null}, 'manual', 'subscribed', ${`Added by ${me}: permission confirmed`}, ${tags}::text[])
    on conflict (lower(email)) do nothing returning id`;
  if (!rows.length) return fail(res, 409, 'That email address is already in the audience.');
  res.status(201).json({ id: rows[0].id });
});
marketingRouter.patch('/contacts/:id', async (req, res) => {
  const me = await who(req);
  if (!uuid(req.params.id)) return fail(res, 400, 'Bad contact');
  const [c] = await prisma.$queryRaw<any[]>`select id, status from crm.marketing_contacts where id = ${req.params.id}::uuid`;
  if (!c) return fail(res, 404, 'Contact not found');
  const b = req.body ?? {};
  if (b.status !== undefined) {
    if (b.status === 'unsubscribed') await prisma.$queryRaw`update crm.marketing_contacts set status = 'unsubscribed', unsubscribed_at = coalesce(unsubscribed_at, now()), consent_note = ${`Unsubscribed by ${me}`}, updated_at = now() where id = ${c.id}::uuid`;
    else if (b.status === 'subscribed' && c.status === 'pending' && b.consent === true) await prisma.$queryRaw`update crm.marketing_contacts set status = 'subscribed', consent_note = ${`Consent confirmed by ${me} on ${new Date().toISOString().slice(0, 10)}`}, updated_at = now() where id = ${c.id}::uuid`;
    else return fail(res, 400, c.status === 'pending' ? 'Confirm that they agreed to receive your emails.' : 'Someone who has unsubscribed, bounced or complained can only be added back by signing up again themselves.');
  }
  const str = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, 120) || null : undefined);
  await prisma.$queryRaw`update crm.marketing_contacts set first_name = coalesce(${str(b.firstName) ?? null}, first_name), last_name = coalesce(${str(b.lastName) ?? null}, last_name), company = coalesce(${str(b.company) ?? null}, company), updated_at = now() where id = ${c.id}::uuid`;
  if (Array.isArray(b.tags)) await prisma.$queryRaw`update crm.marketing_contacts set tags = ${[...new Set(b.tags.map((t: string) => normTag(String(t))).filter(Boolean))]}::text[], updated_at = now() where id = ${c.id}::uuid`;
  res.json({ ok: true });
});
// Do something to several contacts at once: the ones ticked (ids) or everyone matching a search (query).
marketingRouter.post('/contacts/bulk', async (req, res) => {
  const me = await who(req);
  const b = req.body ?? {};
  let ids: string[] = (Array.isArray(b.ids) ? b.ids : []).filter(uuid);
  if (!ids.length && b.query) ids = (await listContacts({ ...(b.query as ContactQuery), limit: 200, offset: 0 }).then(async r => (r.total <= 200 ? r.rows : (await listContacts({ ...(b.query as ContactQuery), limit: 200, offset: 0 })).rows))).map((r: any) => r.id);
  if (!ids.length) return fail(res, 400, 'Nobody selected.');
  const tags = (Array.isArray(b.tags) ? b.tags : []).map((t: string) => String(t));
  switch (b.action) {
    case 'add_tag': return res.json({ changed: await changeTags(ids, tags, 'add') });
    case 'remove_tag': return res.json({ changed: await changeTags(ids, tags, 'remove') });
    case 'confirm_consent': {
      if (b.confirm !== true) return fail(res, 400, 'Confirm that these people agreed to receive your emails.');
      const r = await prisma.$queryRaw<{ id: string }[]>`update crm.marketing_contacts set status = 'subscribed', consent_note = ${`Consent confirmed by ${me} on ${new Date().toISOString().slice(0, 10)}${b.note ? ': ' + String(b.note).slice(0, 200) : ''}`}, updated_at = now() where id = any(${ids}::uuid[]) and status = 'pending' returning id`;
      return res.json({ changed: r.length });
    }
    case 'unsubscribe': {
      const r = await prisma.$queryRaw<{ id: string }[]>`update crm.marketing_contacts set status = 'unsubscribed', unsubscribed_at = coalesce(unsubscribed_at, now()), consent_note = ${`Unsubscribed by ${me}`}, updated_at = now() where id = any(${ids}::uuid[]) and status in ('subscribed', 'pending') returning id`;
      return res.json({ changed: r.length });
    }
    default: return fail(res, 400, 'Unknown action');
  }
});

// ---- saved segments ----
marketingRouter.get('/segments', async (_req, res) => {
  const rows = await prisma.$queryRaw<any[]>`select id, name, filter from crm.marketing_segments order by name`;
  res.json(await Promise.all(rows.map(async r => ({ ...r, count: await countAudience(cleanFilter(r.filter)) }))));
});
marketingRouter.post('/segments', async (req, res) => {
  const name = String(req.body?.name ?? '').trim().slice(0, 80); if (!name) return fail(res, 400, 'Give the segment a name.');
  const [r] = await prisma.$queryRaw<{ id: string }[]>`insert into crm.marketing_segments (name, filter) values (${name}, ${JSON.stringify(cleanFilter(req.body?.filter))}::jsonb) returning id`;
  res.status(201).json({ id: r.id });
});
marketingRouter.delete('/segments/:id', async (req, res) => { if (uuid(req.params.id)) await prisma.$queryRaw`delete from crm.marketing_segments where id = ${req.params.id}::uuid`; res.json({ ok: true }); });

// ---- templates ----
marketingRouter.get('/templates', async (req, res) => {
  await ensureStarters();
  const kind = req.query.kind === 'automation' ? 'automation' : req.query.kind === 'campaign' ? 'campaign' : null;
  const rows = await prisma.$queryRaw<any[]>`
    select id, name, kind, subject, preview_text as "previewText", blocks, builtin, updated_at as "updatedAt" from crm.marketing_templates
    where (${kind}::text is null or kind = ${kind}) order by builtin desc, name`;
  res.json(rows);
});
marketingRouter.get('/templates/:id', async (req, res) => {
  if (!uuid(req.params.id)) return fail(res, 400, 'Bad template');
  const [t] = await prisma.$queryRaw<any[]>`select id, name, kind, subject, preview_text as "previewText", blocks, builtin from crm.marketing_templates where id = ${req.params.id}::uuid`;
  t ? res.json(t) : fail(res, 404, 'Template not found');
});
const templateFields = (b: any) => ({ name: String(b?.name ?? '').trim().slice(0, 80), subject: String(b?.subject ?? '').slice(0, 200), previewText: String(b?.previewText ?? '').slice(0, 200), blocks: cleanBlocks(b?.blocks) });
marketingRouter.post('/templates', async (req, res) => {
  const t = templateFields(req.body); if (!t.name) return fail(res, 400, 'Give the template a name.');
  const kind = req.body?.kind === 'automation' ? 'automation' : 'campaign';
  const [r] = await prisma.$queryRaw<{ id: string }[]>`insert into crm.marketing_templates (name, kind, subject, preview_text, blocks, created_by) values (${t.name}, ${kind}, ${t.subject}, ${t.previewText}, ${JSON.stringify(t.blocks)}::jsonb, ${req.rep!.id}::uuid) returning id`;
  res.status(201).json({ id: r.id });
});
marketingRouter.put('/templates/:id', async (req, res) => {
  if (!uuid(req.params.id)) return fail(res, 400, 'Bad template');
  const t = templateFields(req.body); if (!t.name) return fail(res, 400, 'Give the template a name.');
  const r = await prisma.$queryRaw<{ id: string }[]>`update crm.marketing_templates set name = ${t.name}, subject = ${t.subject}, preview_text = ${t.previewText}, blocks = ${JSON.stringify(t.blocks)}::jsonb, updated_at = now() where id = ${req.params.id}::uuid returning id`;
  r.length ? res.json({ ok: true }) : fail(res, 404, 'Template not found');
});
marketingRouter.post('/templates/:id/duplicate', async (req, res) => {
  if (!uuid(req.params.id)) return fail(res, 400, 'Bad template');
  const [r] = await prisma.$queryRaw<{ id: string }[]>`insert into crm.marketing_templates (name, kind, subject, preview_text, blocks, created_by) select left(name, 70) || ' (copy)', kind, subject, preview_text, blocks, ${req.rep!.id}::uuid from crm.marketing_templates where id = ${req.params.id}::uuid returning id`;
  r ? res.status(201).json({ id: r.id }) : fail(res, 404, 'Template not found');
});
marketingRouter.delete('/templates/:id', async (req, res) => {
  if (!uuid(req.params.id)) return fail(res, 400, 'Bad template');
  const [inUse] = await prisma.$queryRaw<{ n: number }[]>`select count(*)::int as n from crm.marketing_automations where template_id = ${req.params.id}::uuid`;
  if (inUse.n) return fail(res, 409, 'This design is used by an automatic email. Choose another design for it first.');
  const r = await prisma.$queryRaw<{ id: string }[]>`delete from crm.marketing_templates where id = ${req.params.id}::uuid and builtin = false returning id`;
  r.length ? res.json({ ok: true }) : fail(res, 400, 'The starter designs cannot be deleted. Duplicate one to make your own.');
});

// ---- the live preview in the editor ----
marketingRouter.post('/render', async (req, res) => {
  const blocks = cleanBlocks(req.body?.blocks); const s = await getSettings();
  const skus = [...new Set(blocks.filter(b => b.type === 'products').flatMap((b: any) => b.skus))] as string[];
  const prods = skus.length ? await prisma.$queryRaw<any[]>`select sku, name, image_url, prices from crm.products where sku = any(${skus})` : [];
  const products = Object.fromEntries(prods.map(p => [p.sku, { name: p.name, imageUrl: p.image_url, price: retailPrice(p.prices) }]));
  const subject = String(req.body?.subject ?? '');
  const sample = { ...SAMPLE_VALUES, portal_link: s.portal_url || SAMPLE_VALUES.portal_link, cart_link: s.portal_url || SAMPLE_VALUES.cart_link };
  const r = renderEmail({
    subject, preview: String(req.body?.previewText ?? ''), blocks, footer: { address: s.footer_address || '[Your business address]', business: s.business_name, unsubscribe: true },
    ctx: { values: sample, products, items: [{ name: 'Miffy Lamp', qty: 2, price: 49.9 }, { name: 'Snoopy Plush', qty: 1, price: 20 }], facts: [{ label: 'Quote', value: 'SQ37512' }, { label: 'Amount', value: '$1,240.50' }, { label: 'Due date', value: '23 Oct 2026' }] },
  });
  res.json({ html: r.html, text: r.text, subject: r.subject, unknownTags: unknownTags(subject, blocks) });
});

// ---- campaigns ----
const campaignCols = (cols = '') => cols;
marketingRouter.get('/campaigns', async (_req, res) => {
  const rows = await prisma.$queryRaw<any[]>`
    select c.id, c.name, c.subject, c.status, c.scheduled_at as "scheduledAt", c.sent_at as "sentAt", c.created_at as "createdAt", c.updated_at as "updatedAt",
           count(m.id) filter (where m.sent_at is not null)::int as sent, count(m.id) filter (where m.status in ('bounced', 'complained'))::int as bounced,
           count(m.id) filter (where m.opened_at is not null)::int as opened, count(m.id) filter (where m.click_count > 0)::int as clicked,
           count(m.id) filter (where m.status in ('queued', 'sending'))::int as waiting
    from crm.marketing_campaigns c left join crm.marketing_messages m on m.campaign_id = c.id group by c.id order by c.updated_at desc limit 200`;
  res.json(rows.map(r => { const d = r.sent - r.bounced; return { ...r, delivered: d, openRate: d ? Math.round((r.opened / d) * 1000) / 10 : 0, clickRate: d ? Math.round((r.clicked / d) * 1000) / 10 : 0 }; }));
});
async function loadCampaign(id: string) {
  const [c] = await prisma.$queryRaw<any[]>`select id, name, subject, preview_text as "previewText", from_name as "fromName", reply_to as "replyTo", template_id as "templateId", blocks, audience, status, scheduled_at as "scheduledAt", sent_at as "sentAt" from crm.marketing_campaigns where id = ${id}::uuid`;
  return c;
}
marketingRouter.get('/campaigns/:id', async (req, res) => {
  if (!uuid(req.params.id)) return fail(res, 400, 'Bad campaign');
  const c = await loadCampaign(req.params.id); c ? res.json({ ...c, audienceCount: await countAudience(cleanFilter(c.audience)), problem: await campaignProblems(c) }) : fail(res, 404, 'Campaign not found');
});
marketingRouter.post('/campaigns', async (req, res) => {
  const name = String(req.body?.name ?? '').trim().slice(0, 100); if (!name) return fail(res, 400, 'Give the campaign a name.');
  let subject = '', preview = '', blocks: Block[] = [{ id: 'b1', type: 'text', text: 'Hi {{first_name}},\n\n' }];
  if (uuid(req.body?.templateId)) {
    const [t] = await prisma.$queryRaw<any[]>`select subject, preview_text, blocks from crm.marketing_templates where id = ${req.body.templateId}::uuid`;
    if (t) { subject = t.subject; preview = t.preview_text; blocks = t.blocks; }
  }
  const [r] = await prisma.$queryRaw<{ id: string }[]>`
    insert into crm.marketing_campaigns (name, subject, preview_text, template_id, blocks, audience, created_by)
    values (${name}, ${subject}, ${preview}, ${uuid(req.body?.templateId) ? req.body.templateId : null}::uuid, ${JSON.stringify(blocks)}::jsonb, ${JSON.stringify({})}::jsonb, ${req.rep!.id}::uuid) returning id`;
  res.status(201).json({ id: r.id });
});
marketingRouter.put('/campaigns/:id', async (req, res) => {
  if (!uuid(req.params.id)) return fail(res, 400, 'Bad campaign');
  const c = await loadCampaign(req.params.id); if (!c) return fail(res, 404, 'Campaign not found');
  if (!['draft', 'scheduled'].includes(c.status)) return fail(res, 409, 'A campaign that has gone out cannot be changed. Duplicate it to send a new version.');
  const b = req.body ?? {}; const text = (v: unknown, n: number, keep: string) => (typeof v === 'string' ? v.slice(0, n) : keep);
  const blocks = b.blocks !== undefined ? cleanBlocks(b.blocks) : c.blocks;
  const audience = b.audience !== undefined ? cleanFilter(b.audience) : c.audience;
  await prisma.$queryRaw`
    update crm.marketing_campaigns set name = ${text(b.name, 100, c.name).trim() || c.name}, subject = ${text(b.subject, 200, c.subject)}, preview_text = ${text(b.previewText, 200, c.previewText)},
           from_name = ${b.fromName !== undefined ? String(b.fromName).slice(0, 80) || null : c.fromName}, reply_to = ${b.replyTo !== undefined ? String(b.replyTo).slice(0, 120) || null : c.replyTo},
           blocks = ${JSON.stringify(blocks)}::jsonb, audience = ${JSON.stringify(audience)}::jsonb, updated_at = now()
    where id = ${req.params.id}::uuid`;
  res.json({ ok: true });
});
marketingRouter.delete('/campaigns/:id', async (req, res) => {
  if (!uuid(req.params.id)) return fail(res, 400, 'Bad campaign');
  const r = await prisma.$queryRaw<{ id: string }[]>`delete from crm.marketing_campaigns where id = ${req.params.id}::uuid and status in ('draft', 'cancelled') returning id`;
  r.length ? res.json({ ok: true }) : fail(res, 409, 'Only a draft can be deleted. A campaign that has gone out is part of your reports.');
});
marketingRouter.post('/campaigns/:id/duplicate', async (req, res) => {
  if (!uuid(req.params.id)) return fail(res, 400, 'Bad campaign');
  const [r] = await prisma.$queryRaw<{ id: string }[]>`insert into crm.marketing_campaigns (name, subject, preview_text, from_name, reply_to, template_id, blocks, audience, created_by) select left(name, 90) || ' (copy)', subject, preview_text, from_name, reply_to, template_id, blocks, audience, ${req.rep!.id}::uuid from crm.marketing_campaigns where id = ${req.params.id}::uuid returning id`;
  r ? res.status(201).json({ id: r.id }) : fail(res, 404, 'Campaign not found');
});
marketingRouter.post('/campaigns/:id/schedule', async (req, res) => {
  if (!uuid(req.params.id)) return fail(res, 400, 'Bad campaign');
  const c = await loadCampaign(req.params.id); if (!c) return fail(res, 404, 'Campaign not found');
  if (!['draft', 'scheduled'].includes(c.status)) return fail(res, 409, 'This campaign has already gone out.');
  const at = new Date(String(req.body?.at ?? '')); const now = Date.now();
  if (Number.isNaN(at.getTime()) || at.getTime() < now + 60000 || at.getTime() > now + 366 * 86400000) return fail(res, 400, 'Pick a time at least a minute from now, within a year.');
  const problem = await campaignProblems(c); if (problem) return fail(res, 400, problem);
  await prisma.$queryRaw`update crm.marketing_campaigns set status = 'scheduled', scheduled_at = ${at}, updated_at = now() where id = ${req.params.id}::uuid`;
  res.json({ ok: true, scheduledAt: at });
});
marketingRouter.post('/campaigns/:id/unschedule', async (req, res) => {
  if (!uuid(req.params.id)) return fail(res, 400, 'Bad campaign');
  await prisma.$queryRaw`update crm.marketing_campaigns set status = 'draft', scheduled_at = null, updated_at = now() where id = ${req.params.id}::uuid and status = 'scheduled'`;
  res.json({ ok: true });
});
marketingRouter.post('/campaigns/:id/send', async (req, res) => {
  if (!uuid(req.params.id)) return fail(res, 400, 'Bad campaign');
  if (!getProvider().connected) return fail(res, 409, "Email sending isn't connected yet. Your campaign is saved and ready; connect the email service, then send.", { code: 'not_connected' });
  const r = await queueCampaign(req.params.id);
  if ('error' in r) return fail(res, 400, r.error);
  void drainQueue(100000).catch(e => console.error('marketing send failed', e));   // runs on in the background; the report shows progress
  res.json({ queued: r.queued });
});
marketingRouter.post('/campaigns/:id/cancel', async (req, res) => {
  if (!uuid(req.params.id)) return fail(res, 400, 'Bad campaign');
  await prisma.$queryRaw`update crm.marketing_messages set status = 'skipped', error = 'Cancelled' where campaign_id = ${req.params.id}::uuid and status = 'queued'`;
  await prisma.$queryRaw`update crm.marketing_campaigns set status = 'sent', sent_at = coalesce(sent_at, now()), updated_at = now() where id = ${req.params.id}::uuid and status = 'sending'`;
  res.json({ ok: true });
});
marketingRouter.post('/campaigns/:id/test', async (req, res) => {
  if (!uuid(req.params.id)) return fail(res, 400, 'Bad campaign');
  const to = String(req.body?.to ?? '').trim().toLowerCase(); if (!EMAIL_OK.test(to)) return fail(res, 400, "That doesn't look like an email address.");
  const p = getProvider(); if (!p.connected) return fail(res, 409, "Email sending isn't connected yet, so test emails can't be sent. Use the preview to check the design.", { code: 'not_connected' });
  const c = await loadCampaign(req.params.id); if (!c) return fail(res, 404, 'Campaign not found');
  const s = await getSettings();
  if (!s.from_email) return fail(res, 400, 'Set the sender email address in Marketing settings.');
  const r = renderEmail({ subject: c.subject, preview: c.previewText, blocks: c.blocks, footer: { address: s.footer_address, business: s.business_name, unsubscribe: true }, ctx: { values: { ...SAMPLE_VALUES, portal_link: s.portal_url, cart_link: s.portal_url } } });
  try { const out = await p.sendBatch([{ to, from: `${s.from_name} <${s.from_email}>`, replyTo: s.reply_to || undefined, subject: `[TEST] ${r.subject}`, html: r.html, text: r.text }]); out[0]?.id ? res.json({ ok: true }) : fail(res, 502, out[0]?.error ?? 'The email service refused it'); }
  catch (e) { e instanceof NotConnectedError ? fail(res, 409, "Email sending isn't connected yet", { code: 'not_connected' }) : fail(res, 502, (e as Error).message); }
});
marketingRouter.get('/campaigns/:id/report', async (req, res) => {
  if (!uuid(req.params.id)) return fail(res, 400, 'Bad campaign');
  const r = await campaignReport(req.params.id); r ? res.json(r) : fail(res, 404, 'Campaign not found');
});

// ---- automatic emails ----
marketingRouter.get('/automations', async (_req, res) => {
  const cfgs = await getAutomations();
  const stats = await prisma.$queryRaw<any[]>`
    select automation_key as key, count(*) filter (where sent_at is not null and sent_at >= now() - interval '30 days')::int as sent30, count(*) filter (where status in ('queued', 'sending'))::int as waiting,
           count(*) filter (where status = 'failed' and queued_at >= now() - interval '30 days')::int as failed30, max(sent_at) as "lastSent"
    from crm.marketing_messages where automation_key is not null group by automation_key`;
  res.json(cfgs.map(c => ({ ...c, ...AUTOMATIONS[c.key], key: c.key, name: c.name, sent30: 0, waiting: 0, failed30: 0, lastSent: null, ...(stats.find(s => s.key === c.key) ?? {}) })));
});
marketingRouter.put('/automations/:key', async (req, res) => {
  const key = req.params.key as AutoKey; if (!AUTO_KEYS.includes(key)) return fail(res, 404, 'Unknown automatic email');
  const b = req.body ?? {}; const int = (v: unknown, min: number, max: number) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= min && n <= max ? n : null; };
  const delay = b.delayHours === undefined ? undefined : int(b.delayHours, 0, 24 * 90), repeat = b.repeatDays === undefined ? undefined : int(b.repeatDays, 0, 90), max = b.maxSends === undefined ? undefined : int(b.maxSends, 1, 10);
  if (delay === null || repeat === null || max === null) return fail(res, 400, 'Those numbers are out of range.');
  if (b.templateId !== undefined) {
    const [t] = await prisma.$queryRaw<{ id: string }[]>`select id from crm.marketing_templates where id = ${uuid(b.templateId) ? b.templateId : '00000000-0000-0000-0000-000000000000'}::uuid and kind = 'automation'`;
    if (!t) return fail(res, 400, 'Choose one of the automatic-email designs.');
  }
  await getAutomations();
  await prisma.$queryRaw`
    update crm.marketing_automations set enabled = coalesce(${typeof b.enabled === 'boolean' ? b.enabled : null}::boolean, enabled), template_id = coalesce(${b.templateId ?? null}::uuid, template_id),
           delay_hours = coalesce(${delay ?? null}::int, delay_hours), repeat_days = coalesce(${repeat ?? null}::int, repeat_days), max_sends = coalesce(${max ?? null}::int, max_sends), updated_at = now()
    where key = ${key}`;
  res.json({ ok: true });
});
marketingRouter.get('/automations/:key/preview', async (req, res) => {
  const key = req.params.key as AutoKey; if (!AUTO_KEYS.includes(key)) return fail(res, 404, 'Unknown automatic email');
  res.json(await previewAutomation(key, 100));
});
marketingRouter.post('/run', async (_req, res) => res.json(await runMarketing()));