import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';

// The audience: who can be emailed, and who a campaign goes to.
//   subscribed   can be emailed
//   pending      came from the CRM as a lead: someone must confirm they agreed to emails first
//   unsubscribed / bounced / complained   never emailed again
export type AudienceFilter = { tags?: string[]; excludeTags?: string[]; regions?: string[]; types?: string[]; sources?: string[] };
export const EMAIL_OK = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
// The same check for the database, written without backslashes and passed as a parameter, because a
// backslash typed inside a JS template string is dropped before it reaches SQL.
const EMAIL_SQL = '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$';
export const normTag = (t: string) => t.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 40);
const list = (v: unknown, norm: (s: string) => string = s => s.trim()) => (Array.isArray(v) ? [...new Set(v.map(x => norm(String(x))).filter(Boolean))].slice(0, 50) : []);

export function cleanFilter(f: any): AudienceFilter {
  return { tags: list(f?.tags, normTag), excludeTags: list(f?.excludeTags, normTag), regions: list(f?.regions), types: list(f?.types), sources: list(f?.sources) };
}
// Tags: has ANY of them. Everything else narrows.
export function audienceConds(f: AudienceFilter, a = 'c'): Prisma.Sql[] {
  const c = Prisma.raw(a);
  const w: Prisma.Sql[] = [];
  if (f.tags?.length) w.push(Prisma.sql`${c}.tags && ${f.tags}::text[]`);
  if (f.excludeTags?.length) w.push(Prisma.sql`not (${c}.tags && ${f.excludeTags}::text[])`);
  if (f.regions?.length) w.push(Prisma.sql`${c}.region = any(${f.regions})`);
  if (f.types?.length) w.push(Prisma.sql`${c}.contact_type = any(${f.types})`);
  if (f.sources?.length) w.push(Prisma.sql`${c}.source = any(${f.sources})`);
  return w;
}
const where = (w: Prisma.Sql[]) => (w.length ? Prisma.sql`where ${Prisma.join(w, ' and ')}` : Prisma.empty);

// Who a campaign with this filter would reach right now: subscribed, not on the do-not-email list.
export async function countAudience(f: AudienceFilter): Promise<number> {
  const [r] = await prisma.$queryRaw<{ n: number }[]>`
    select count(*)::int as n from crm.marketing_contacts c
    ${where([Prisma.sql`c.status = 'subscribed'`, Prisma.sql`not exists (select 1 from crm.marketing_suppressions s where s.email = lower(c.email))`, ...audienceConds(f)])}`;
  return r?.n ?? 0;
}

export type ContactQuery = { q?: string; status?: string; tag?: string; region?: string; source?: string; limit?: number; offset?: number };
export async function listContacts(f: ContactQuery) {
  const w: Prisma.Sql[] = [];
  if (f.status) w.push(Prisma.sql`c.status = ${f.status}`);
  if (f.tag) w.push(Prisma.sql`${normTag(f.tag)} = any(c.tags)`);
  if (f.region) w.push(Prisma.sql`c.region = ${f.region}`);
  if (f.source) w.push(Prisma.sql`c.source = ${f.source}`);
  if (f.q) { const like = `%${f.q}%`; w.push(Prisma.sql`(c.email ilike ${like} or coalesce(c.first_name,'') ilike ${like} or coalesce(c.last_name,'') ilike ${like} or coalesce(c.company,'') ilike ${like})`); }
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 200), offset = Math.max(f.offset ?? 0, 0);
  const rows = await prisma.$queryRaw<any[]>`
    select c.id, c.email, c.first_name as "firstName", c.last_name as "lastName", c.company, c.account_id as "accountId", c.source, c.status,
           c.tags, c.region, c.contact_type as "contactType", c.consent_note as "consentNote", c.created_at as "createdAt",
           count(*) over()::int as total
    from crm.marketing_contacts c ${where(w)} order by c.created_at desc, c.email limit ${limit} offset ${offset}`;
  return { total: rows[0]?.total ?? 0, rows: rows.map(({ total, ...r }) => r) };
}
export async function audienceSummary() {
  const [r] = await prisma.$queryRaw<any[]>`
    select count(*)::int as total,
           count(*) filter (where status = 'subscribed')::int as subscribed, count(*) filter (where status = 'pending')::int as pending,
           count(*) filter (where status = 'unsubscribed')::int as unsubscribed, count(*) filter (where status in ('bounced','complained'))::int as bounced
    from crm.marketing_contacts`;
  const tags = await prisma.$queryRaw<{ tag: string; n: number }[]>`select t as tag, count(*)::int as n from crm.marketing_contacts, unnest(tags) t group by t order by n desc, t limit 200`;
  const regions = await prisma.$queryRaw<{ region: string; n: number }[]>`select region, count(*)::int as n from crm.marketing_contacts where region is not null group by region order by region`;
  return { ...r, tags, regions };
}

// ---- From the CRM: every account with an email, customers and leads ----
// Customers are subscribed (they already deal with you). Leads come in as "pending" until someone
// confirms they agreed to be emailed. Anyone who has unsubscribed stays unsubscribed. Re-running
// updates names, states and customer type, and never changes a status.
export async function syncFromCrm() {
  const [counts] = await prisma.$queryRaw<{ with_email: number; invalid: number }[]>`
    select count(*) filter (where email is not null and btrim(email) <> '')::int as with_email,
           count(*) filter (where email is not null and btrim(email) <> '' and btrim(email) !~* ${EMAIL_SQL})::int as invalid
    from crm.accounts where archived = false and misc = false and type <> 'cold_lead'`;
  const rows = await prisma.$queryRaw<{ inserted: boolean; status: string }[]>`
    with src as (
      select distinct on (lower(btrim(a.email)))
             a.id as account_id, lower(btrim(a.email)) as email,
             nullif(split_part(btrim(coalesce(a.contact_name, '')), ' ', 1), '') as first_name,
             nullif(btrim(substr(btrim(coalesce(a.contact_name, '')), length(split_part(btrim(coalesce(a.contact_name, '')), ' ', 1)) + 1)), '') as last_name,
             a.name as company, a.region,
             case when a.type = 'customer' then 'crm_customer' else 'crm_lead' end as source,
             case when a.type <> 'customer' then 'prospect'
                  when a.last_order_at is null or a.last_order_at < now() - interval '12 months' then 'inactive' else 'customer' end as contact_type
      from crm.accounts a
      where a.archived = false and a.misc = false and a.type <> 'cold_lead' and a.email is not null and btrim(a.email) ~* ${EMAIL_SQL}
      order by lower(btrim(a.email)), (a.type = 'customer') desc, a.last_order_at desc nulls last
    )
    insert into crm.marketing_contacts (email, first_name, last_name, company, account_id, source, status, consent_note, region, contact_type)
    select s.email, s.first_name, s.last_name, s.company, s.account_id, s.source,
           case when s.source = 'crm_customer' then 'subscribed' else 'pending' end,
           case when s.source = 'crm_customer' then 'Existing customer (from the CRM)' else 'Lead from the CRM: confirm they agreed to emails before emailing' end,
           s.region, s.contact_type
    from src s
    on conflict (lower(email)) do update set
      first_name = coalesce(crm.marketing_contacts.first_name, excluded.first_name),
      last_name = coalesce(crm.marketing_contacts.last_name, excluded.last_name),
      company = coalesce(excluded.company, crm.marketing_contacts.company),
      account_id = excluded.account_id, region = excluded.region, contact_type = excluded.contact_type, updated_at = now()
    returning (xmax = 0) as inserted, status`;
  // Anyone already on the do-not-email list stays off it.
  await prisma.$queryRaw`update crm.marketing_contacts c set status = 'bounced' where c.status in ('subscribed','pending') and exists (select 1 from crm.marketing_suppressions s where s.email = lower(c.email))`;
  const added = rows.filter(r => r.inserted);
  return {
    accountsWithEmail: counts?.with_email ?? 0, skippedInvalid: counts?.invalid ?? 0,
    added: added.length, updated: rows.length - added.length,
    addedSubscribed: added.filter(r => r.status === 'subscribed').length, addedPending: added.filter(r => r.status === 'pending').length,
  };
}

// ---- From a file (a Mailchimp export, or any CSV with an email column) ----
export function parseCsv(input: string): string[][] {
  const text = input.replace(/^\uFEFF/, ''); const rows: string[][] = []; let row: string[] = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}
const HEAD: Record<string, string> = { email: 'email', emailaddress: 'email', mail: 'email', firstname: 'first', fname: 'first', first: 'first', lastname: 'last', surname: 'last', lname: 'last',
  company: 'company', business: 'company', store: 'company', organisation: 'company', organization: 'company', companyname: 'company', tags: 'tags', tag: 'tags', status: 'status' };

export type ImportAs = 'subscribed' | 'unsubscribed' | 'bounced';
export async function importContacts(csv: string, opts: { as: ImportAs; consentNote: string; extraTag?: string }) {
  const rows = parseCsv(csv); if (rows.length < 2) throw new Error('The file is empty.');
  const col: Record<string, number> = {};
  rows[0].forEach((h, i) => { const k = HEAD[h.trim().toLowerCase().replace(/[^a-z]/g, '')]; if (k && col[k] === undefined) col[k] = i; });
  if (col.email === undefined) throw new Error('No email column found. The first row needs a heading like "Email" or "Email Address".');
  const seen = new Set<string>(); let invalid = 0, dupes = 0;
  const data: any[] = [];
  for (const r of rows.slice(1)) {
    const email = (r[col.email] ?? '').trim().toLowerCase();
    if (!EMAIL_OK.test(email)) { invalid++; continue; }
    if (seen.has(email)) { dupes++; continue; }
    seen.add(email);
    const rowStatus = (r[col.status] ?? '').trim().toLowerCase();
    // A "status" column (a Mailchimp export) can only make a person LESS contactable, never more.
    const status: string = opts.as !== 'subscribed' ? opts.as : /^(unsubscribed|non-subscribed|archived)$/.test(rowStatus) ? 'unsubscribed' : /^(cleaned|bounced)$/.test(rowStatus) ? 'bounced' : 'subscribed';
    const tags = [...new Set([...((r[col.tags] ?? '').split(/[;,]/).map(normTag).filter(Boolean)), ...(opts.extraTag ? [normTag(opts.extraTag)] : [])])];
    data.push({ email, first_name: (r[col.first] ?? '').trim() || null, last_name: (r[col.last] ?? '').trim() || null, company: (r[col.company] ?? '').trim() || null, tags, status });
  }
  const res = await prisma.$queryRaw<{ inserted: boolean; status: string }[]>`
    with incoming as (select * from jsonb_to_recordset(${JSON.stringify(data)}::jsonb) as r(email text, first_name text, last_name text, company text, tags jsonb, status text))
    insert into crm.marketing_contacts (email, first_name, last_name, company, source, status, consent_note, tags, unsubscribed_at)
    select i.email, i.first_name, i.last_name, i.company, 'import', i.status, ${opts.consentNote},
           array(select jsonb_array_elements_text(i.tags)), case when i.status = 'unsubscribed' then now() end
    from incoming i
    on conflict (lower(email)) do update set
      first_name = coalesce(crm.marketing_contacts.first_name, excluded.first_name),
      last_name = coalesce(crm.marketing_contacts.last_name, excluded.last_name),
      company = coalesce(crm.marketing_contacts.company, excluded.company),
      tags = array(select distinct unnest(crm.marketing_contacts.tags || excluded.tags)),
      status = case when excluded.status in ('unsubscribed','bounced') then excluded.status else crm.marketing_contacts.status end,
      unsubscribed_at = case when excluded.status = 'unsubscribed' and crm.marketing_contacts.status <> 'unsubscribed' then now() else crm.marketing_contacts.unsubscribed_at end,
      updated_at = now()
    returning (xmax = 0) as inserted, status`;
  const bounced = data.filter(d => d.status === 'bounced').map(d => d.email);
  if (bounced.length) await prisma.$queryRaw`insert into crm.marketing_suppressions (email, reason) select unnest(${bounced}::text[]), 'Cleaned in the imported list' on conflict (email) do nothing`;
  const added = res.filter(r => r.inserted).length;
  return { rows: rows.length - 1, added, updated: res.length - added, skippedInvalid: invalid, skippedDuplicateInFile: dupes,
           unsubscribed: data.filter(d => d.status === 'unsubscribed').length, bounced: bounced.length };
}

// ---- Tags ----
export async function changeTags(ids: string[], tags: string[], mode: 'add' | 'remove') {
  const t = tags.map(normTag).filter(Boolean); if (!ids.length || !t.length) return 0;
  const rows = mode === 'add'
    ? await prisma.$queryRaw<{ id: string }[]>`update crm.marketing_contacts set tags = array(select distinct unnest(tags || ${t}::text[])), updated_at = now() where id = any(${ids}::uuid[]) returning id`
    : await prisma.$queryRaw<{ id: string }[]>`update crm.marketing_contacts set tags = array(select x from unnest(tags) x where x <> all(${t}::text[])), updated_at = now() where id = any(${ids}::uuid[]) returning id`;
  return rows.length;
}