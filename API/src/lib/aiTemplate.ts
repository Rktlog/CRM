import * as st from './salesTools';
import { DEFAULTS, BUILT_IN_KEYS, planTemplate, type TemplateAsk, type TemplatePlan } from './salesToolsCore';

// Saving a new email template by talking to the assistant. Like the bulk activity log and trade show orders, it never saves on its own: save_template (the tool)
// only builds a PREVIEW, which the chat shows with a Save template button. Pressing it sends the settled template to POST /ai/template/confirm, which checks
// everything again and then saves it. It only ADDS: it never changes or deletes a template, and it cannot touch the payment reminder, abandoned cart or order
// email. A new link in the text is saved on the Links tab at the same moment.
type Rep = { id: string; role: string };
export type TemplateProposal = TemplatePlan;

async function context() {
  const [l, t] = await Promise.all([st.listLinks(), st.listTemplates()]);
  if (!l.ready || !t.ready) throw new st.ToolsError('Sales Tools is not set up in the database yet, so a template cannot be saved. Ask whoever looks after Radar to run sales-tools.sql.', 503);
  return { links: l.links.map(x => ({ name: x.name, url: x.url })), names: [...t.templates.map(x => x.name), ...BUILT_IN_KEYS.map(k => DEFAULTS[k].label)] };
}

export async function previewNewTemplate(ask: TemplateAsk): Promise<{ plan: TemplatePlan } | { problems: string[] }> {
  try { const c = await context(); return planTemplate(ask, c.links, c.names); }
  catch (e) { if (e instanceof st.ToolsError) return { problems: [e.message] }; throw e; }
}

/** Pressing Save template: the same checks again on what the person actually confirmed, then the new links, then the template. */
export async function saveNewTemplate(rep: Rep, b: any): Promise<{ key: string; name: string; linksAdded: string[] }> {
  const c = await context();
  const r = planTemplate({ name: b?.name, subject: b?.subject, body: b?.body, links: b?.newLinks }, c.links, c.names);
  if ('problems' in r) throw new st.ToolsError(r.problems.join(' '));
  const added: string[] = [];
  for (const l of r.plan.newLinks) { await st.addLink(rep, { name: l.name, url: l.url }); added.push(l.name); }
  const { key } = await st.createTemplate(rep, { name: r.plan.name, subject: r.plan.subject, body: r.plan.body });
  return { key, name: r.plan.name, linksAdded: added };
}

/** What the assistant is told after it builds a preview. It never sees "saved". */
export function templateSummary(p: { plan: TemplatePlan } | { problems: string[] }) {
  if ('problems' in p) return { previewShownToPerson: false, savedNothing: true, problems: p.problems, note: 'Nothing is ready yet. Fix what is listed (or ask the person), then call save_template again with the COMPLETE template.' };
  const x = p.plan;
  return {
    previewShownToPerson: true, savedNothingYet: true, name: x.name, subject: x.subject, newLinksThatWillBeSaved: x.newLinks.map(l => l.name),
    note: 'A preview with a Save template button is shown in the chat. NOTHING is saved until the person presses it. Do not say it is saved. Tell them the name, what the fill-in words become, and which new links will be saved with it, and ask them to check the preview.',
  };
}
