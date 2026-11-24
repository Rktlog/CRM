import { prisma } from './prisma';
import {
  BUILT_IN_KEYS, DEFAULTS, PLACEHOLDER_HELP, SAMPLE, checkTemplate, cleanLink, fill, isBuiltIn, isCustomKey,
  type BuiltInKey, type LinkRef, type Vars,
} from './salesToolsCore';
import { randomBytes } from 'node:crypto';

// Sales Tools: the team's saved links, and the saved email templates. Nothing here sends an email.
// The tables come from sql/sales-tools.sql. Until it is run, every email uses today's wording and the page says it is not set up.
export class ToolsError extends Error { status: number; constructor(m: string, status = 400) { super(m); this.status = status; } }
type Rep = { id: string; role: string };
const NOT_SET_UP = 'Sales Tools is not set up in the database yet. Ask whoever looks after Radar to run sales-tools.sql.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isManager = (r: Rep) => r.role === 'manager';
const dup = (e: unknown) => /23505|duplicate key/i.test(String((e as any)?.message ?? e));

let seen: { at: number; ok: boolean } | null = null;
export async function toolsReady(): Promise<boolean> {
  if (seen && Date.now() - seen.at < 60_000) return seen.ok;
  let ok = false;
  try { const [r] = await prisma.$queryRaw<{ ok: boolean }[]>`select to_regclass('crm.sales_links') is not null and to_regclass('crm.email_templates') is not null as ok`; ok = !!r?.ok; } catch { ok = false; }
  seen = { at: Date.now(), ok };
  return ok;
}
export const _forgetReady = () => { seen = null; };
const need = async () => { if (!(await toolsReady())) throw new ToolsError(NOT_SET_UP, 503); };

// ---------- links ----------
export type SavedLink = { id: string; name: string; url: string; note: string | null; by: string | null; updatedAt: string };
const asLink = (r: any): SavedLink => ({ id: r.id, name: r.name, url: r.url, note: r.note ?? null, by: r.by ?? null, updatedAt: new Date(r.updated_at).toISOString() });

export async function listLinks(): Promise<{ ready: boolean; links: SavedLink[] }> {
  if (!(await toolsReady())) return { ready: false, links: [] };
  const rows = await prisma.$queryRaw<any[]>`select l.id, l.name, l.url, l.note, l.updated_at, r.name as by from crm.sales_links l left join crm.reps r on r.id = l.created_by order by lower(l.name)`;
  return { ready: true, links: rows.map(asLink) };
}
/** For filling in a template. Never throws: no links is just no links. */
async function linkRefs(): Promise<LinkRef[]> {
  if (!(await toolsReady())) return [];
  try { return await prisma.$queryRaw<LinkRef[]>`select name, url from crm.sales_links`; } catch { return []; }
}
export async function addLink(rep: Rep, b: any): Promise<SavedLink> {
  await need();
  const c = cleanLink(b?.name, b?.url); if ('error' in c) throw new ToolsError(c.error);
  const note = String(b?.note ?? '').trim().slice(0, 300) || null;
  try {
    const [r] = await prisma.$queryRaw<any[]>`insert into crm.sales_links (name, url, note, created_by) values (${c.name}, ${c.url}, ${note}, ${rep.id}::uuid) returning id, name, url, note, updated_at`;
    return asLink(r);
  } catch (e) { if (dup(e)) throw new ToolsError('A link with that name is already saved.', 409); throw e; }
}
export async function editLink(rep: Rep, id: string, b: any): Promise<SavedLink> {
  await need();
  if (!UUID.test(id)) throw new ToolsError('Bad link');
  const c = cleanLink(b?.name, b?.url); if ('error' in c) throw new ToolsError(c.error);
  const note = String(b?.note ?? '').trim().slice(0, 300) || null;
  const [was] = await prisma.$queryRaw<{ name: string }[]>`select name from crm.sales_links where id = ${id}::uuid`;
  if (!was) throw new ToolsError('That link was not found', 404);
  if (was.name.toLowerCase() !== c.name.toLowerCase()) {
    const used = await templatesUsing(was.name);
    if (used.length) throw new ToolsError(`"${was.name}" is used in the template ${used.map(u => `"${u.name}"`).join(', ')}, so its name cannot change. Change the address instead, or edit that template first.`, 409);
  }
  try {
    const [r] = await prisma.$queryRaw<any[]>`update crm.sales_links set name = ${c.name}, url = ${c.url}, note = ${note}, updated_at = now() where id = ${id}::uuid returning id, name, url, note, updated_at`;
    if (!r) throw new ToolsError('That link was not found', 404);
    return asLink(r);
  } catch (e) { if (dup(e)) throw new ToolsError('A link with that name is already saved.', 409); throw e; }
}
/** The saved templates that have [Link: name] in them. */
async function templatesUsing(linkName: string): Promise<{ name: string }[]> {
  const all = await prisma.$queryRaw<{ name: string; body: string }[]>`select name, body from crm.email_templates`;
  const want = linkName.trim().replace(/\s+/g, ' ').toLowerCase();
  return all.filter(t => [...t.body.matchAll(/\[Link:\s*([^\]\n]{1,80}?)\s*\](?!\()/gi)].some(m => m[1]!.trim().replace(/\s+/g, ' ').toLowerCase() === want));
}
/** Managers only, and a link a saved template uses cannot be deleted (it would break that template). */
export async function deleteLink(rep: Rep, id: string): Promise<void> {
  await need();
  if (!isManager(rep)) throw new ToolsError('Only a manager can delete a link.', 403);
  if (!UUID.test(id)) throw new ToolsError('Bad link');
  const [l] = await prisma.$queryRaw<{ name: string }[]>`select name from crm.sales_links where id = ${id}::uuid`;
  if (!l) throw new ToolsError('That link was not found', 404);
  const used = await templatesUsing(l.name);
  if (used.length) throw new ToolsError(`"${l.name}" is used in the template ${used.map(u => `"${u.name}"`).join(', ')}. Change that template first.`, 409);
  await prisma.$executeRaw`delete from crm.sales_links where id = ${id}::uuid`;
}

// ---------- templates ----------
export type TemplateInfo = { key: string; name: string; subject: string; body: string; builtIn: boolean; when: string | null; customised: boolean; locked: boolean; updatedAt: string | null; usesNumber: boolean };
const usesNumber = (t: { subject: string; body: string }) => /\[Number\](?!\()/i.test(t.subject + t.body);

/** The template for one trigger: the saved one, or today's wording. Never throws, so an email is never stopped by a problem here. */
export async function templateText(key: BuiltInKey): Promise<{ subject: string; body: string; saved: boolean }> {
  const d = DEFAULTS[key];
  if (!(await toolsReady())) return { subject: d.subject, body: d.body, saved: false };
  try {
    const [r] = await prisma.$queryRaw<{ subject: string; body: string }[]>`select subject, body from crm.email_templates where key = ${key}`;
    return r ? { subject: r.subject, body: r.body, saved: true } : { subject: d.subject, body: d.body, saved: false };
  } catch { return { subject: d.subject, body: d.body, saved: false }; }
}
/** A trigger's email, filled in. If the saved template cannot be filled in, today's wording is used instead. */
export async function renderBuiltIn(key: BuiltInKey, v: Vars): Promise<{ subject: string; body: string; usedSaved: boolean }> {
  const d = DEFAULTS[key], t = await templateText(key);
  try {
    const links = await linkRefs();
    const s = fill(t.subject, v, links), b = fill(t.body, v, links);
    if (s.text.trim() && b.text.trim()) return { subject: s.text, body: b.text, usedSaved: t.saved };
  } catch { /* fall through to today's wording */ }
  return { subject: fill(d.subject, v).text, body: fill(d.body, v).text, usedSaved: false };
}

export async function listTemplates(): Promise<{ ready: boolean; templates: TemplateInfo[]; help: typeof PLACEHOLDER_HELP }> {
  if (!(await toolsReady())) return { ready: false, templates: [], help: PLACEHOLDER_HELP };
  const rows = await prisma.$queryRaw<any[]>`select key, name, subject, body, updated_at from crm.email_templates`;
  const by = new Map<string, any>(rows.map(r => [r.key as string, r] as [string, any]));
  const out: TemplateInfo[] = BUILT_IN_KEYS.map(k => {
    const r = by.get(k), d = DEFAULTS[k], t = { subject: r?.subject ?? d.subject, body: r?.body ?? d.body };
    return { key: k, name: d.label, ...t, builtIn: true, when: d.when, customised: !!r, locked: true, updatedAt: r ? new Date(r.updated_at).toISOString() : null, usesNumber: usesNumber(t) };
  });
  for (const r of rows.filter(x => isCustomKey(x.key)).sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
    out.push({ key: r.key, name: r.name, subject: r.subject, body: r.body, builtIn: false, when: null, customised: true, locked: false, updatedAt: new Date(r.updated_at).toISOString(), usesNumber: usesNumber(r) });
  }
  return { ready: true, templates: out, help: PLACEHOLDER_HELP };
}

async function validate(subject: unknown, body: unknown): Promise<{ subject: string; body: string }> {
  const s = String(subject ?? '').trim(), b = String(body ?? '').replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  const problems = checkTemplate(s, b, await linkRefs());
  if (problems.length) throw new ToolsError(problems.join(' '));
  return { subject: s, body: b };
}
const cleanName = (n: unknown) => { const v = String(n ?? '').trim().replace(/\s+/g, ' '); if (!v) throw new ToolsError('Give the template a name.'); if (v.length > 60) throw new ToolsError('The name is too long (60 characters at most).'); return v; };

/** Saves a template. The ones that run by themselves (payment reminder, abandoned cart, order email) can only be changed by a manager. */
export async function saveTemplate(rep: Rep, key: string, b: any): Promise<void> {
  await need();
  const builtIn = isBuiltIn(key);
  if (!builtIn && !isCustomKey(key)) throw new ToolsError('Unknown template', 404);
  if (builtIn && !isManager(rep)) throw new ToolsError('Only a manager can change this template, because every email of this kind follows it.', 403);
  const t = await validate(b?.subject, b?.body);
  const name = builtIn ? DEFAULTS[key as BuiltInKey].label : cleanName(b?.name);
  if (!builtIn) { const [e] = await prisma.$queryRaw<{ n: number }[]>`select count(*)::int as n from crm.email_templates where key = ${key}`; if (!e?.n) throw new ToolsError('That template was not found', 404); }
  await prisma.$executeRaw`insert into crm.email_templates (key, name, subject, body, updated_by) values (${key}, ${name}, ${t.subject}, ${t.body}, ${rep.id}::uuid)
    on conflict (key) do update set name = excluded.name, subject = excluded.subject, body = excluded.body, updated_by = excluded.updated_by, updated_at = now()`;
}
export async function createTemplate(rep: Rep, b: any): Promise<{ key: string }> {
  await need();
  const name = cleanName(b?.name), t = await validate(b?.subject, b?.body);
  const [c] = await prisma.$queryRaw<{ n: number }[]>`select count(*)::int as n from crm.email_templates where key like 'c-%'`;
  if ((c?.n ?? 0) >= 100) throw new ToolsError('There are 100 templates already. Delete one you no longer use.');
  const key = 'c-' + randomBytes(4).toString('hex');
  await prisma.$executeRaw`insert into crm.email_templates (key, name, subject, body, updated_by) values (${key}, ${name}, ${t.subject}, ${t.body}, ${rep.id}::uuid)`;
  return { key };
}
/** Back to today's wording (a built-in one) , or removes a team-made one. Managers only. */
export async function removeTemplate(rep: Rep, key: string): Promise<void> {
  await need();
  if (!isManager(rep)) throw new ToolsError('Only a manager can do that.', 403);
  if (!isBuiltIn(key) && !isCustomKey(key)) throw new ToolsError('Unknown template', 404);
  await prisma.$executeRaw`delete from crm.email_templates where key = ${key}`;
}

/** What a template looks like with made-up details, before it is saved. */
export async function previewTemplate(b: any): Promise<{ subject: string; body: string; problems: string[] }> {
  const subject = String(b?.subject ?? ''), body = String(b?.body ?? '').replace(/\r\n?/g, '\n');
  const links = await linkRefs(), problems = checkTemplate(subject, body, links);
  return { subject: fill(subject, SAMPLE, links).text, body: fill(body, SAMPLE, links).text, problems };
}

/** Team templates (and the three built-in ones) ready for an email window: filled in for this customer. */
export async function templatesFor(v: Vars & { hasNumber: boolean }): Promise<{ key: string; name: string }[]> {
  if (!(await toolsReady())) return [];
  const all = await listTemplates();
  return all.templates.filter(t => v.hasNumber || !t.usesNumber).map(t => ({ key: t.key, name: t.name }));
}
export async function renderAny(key: string, v: Vars): Promise<{ subject: string; body: string; missing: string[] }> {
  await need();
  if (!isBuiltIn(key) && !isCustomKey(key)) throw new ToolsError('Unknown template', 404);
  let subject: string, body: string;
  if (isBuiltIn(key)) { const t = await templateText(key); subject = t.subject; body = t.body; }
  else {
    const [r] = await prisma.$queryRaw<{ subject: string; body: string }[]>`select subject, body from crm.email_templates where key = ${key}`;
    if (!r) throw new ToolsError('That template was not found', 404);
    subject = r.subject; body = r.body;
  }
  const links = await linkRefs(), s = fill(subject, v, links), bd = fill(body, v, links);
  return { subject: s.text, body: bd.text, missing: [...new Set([...s.missing, ...bd.missing])] };
}
