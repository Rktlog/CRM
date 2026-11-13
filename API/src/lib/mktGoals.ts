// Events, giveaways and EDM campaigns (the rows on the detail pages), their goals and failure lines, and the numbers typed in by hand.
// A goal's live numbers change ONLY when a manager approves: a new goal or a change waits as a proposal, and a different manager has to approve it (unless there is only one manager).
import { prisma } from './prisma';
import { MktError, guard, managerCount, uuidOk, dayText, type Rep } from './mktShared';
import { PRIMARY, canApprove, hasMetric, isDay, metricsOf, daysBetween, validateGoal, type Kind, type Outcome } from './mktCore';

export type Init = { id: string; kind: 'edm' | 'event' | 'giveaway'; name: string; series: string | null; outcome: Outcome; startsOn: string; endsOn: string | null; venue: string | null; postUrl: string | null; notes: string | null; primaryMetric: string; externalId: string | null };
type InitRow = { id: string; kind: Init['kind']; name: string; series: string | null; outcome: Outcome; starts_on: string; ends_on: string | null; venue: string | null; post_url: string | null; notes: string | null; primary_metric: string | null; external_id: string | null };
export const INIT_SELECT = `select id, kind, name, series, outcome, ${dayText('starts_on')} as starts_on, ${dayText('ends_on')} as ends_on, venue, post_url, notes, primary_metric, external_id from crm.mkt_initiatives`;
export const toInit = (r: InitRow): Init => ({ id: r.id, kind: r.kind, name: r.name, series: r.series, outcome: r.outcome, startsOn: r.starts_on, endsOn: r.ends_on, venue: r.venue, postUrl: r.post_url, notes: r.notes, primaryMetric: r.primary_metric ?? PRIMARY[r.kind], externalId: r.external_id });
export async function listInitiatives(kind: Init['kind']): Promise<Init[]> {
  return (await prisma.$queryRawUnsafe<InitRow[]>(`${INIT_SELECT} where kind = $1 order by starts_on desc, created_at desc limit 500`, kind)).map(toInit);
}
export async function getInitiative(id: unknown): Promise<Init> {
  if (!uuidOk(id)) throw new MktError('That was not found.', 404);
  const [r] = await prisma.$queryRawUnsafe<InitRow[]>(`${INIT_SELECT} where id = $1::uuid`, id);
  if (!r) throw new MktError('That was not found.', 404);
  return toInit(r);
}
const text = (v: unknown, max: number, what: string, required = false): string | null => {
  const s = typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim() : '';
  if (!s) { if (required) throw new MktError(`Give the ${what}.`); return null; }
  if (s.length > max) throw new MktError(`Keep the ${what} to ${max} characters or fewer.`);
  return s;
};
const outcomeOf = (v: unknown): Outcome => { if (v === undefined || v === null || v === '') return 'sales'; if (v === 'brand' || v === 'sales' || v === 'awareness') return v; throw new MktError('Choose Brand recognition, Sales or Awareness / education.'); };
type Fields = { name: string; series: string | null; outcome: Outcome; startsOn: string; endsOn: string | null; venue: string | null; postUrl: string | null; notes: string | null; primaryMetric: string };
function fields(kind: 'event' | 'giveaway', b: Record<string, unknown>, base?: Init): Fields {
  const name = text(b.name ?? base?.name, 120, 'name', true)!;
  const startsOn = (b.startsOn ?? base?.startsOn) as unknown; if (!isDay(startsOn)) throw new MktError('Give the date it starts, like 2026-11-20.');
  const endsRaw = b.endsOn !== undefined ? b.endsOn : base?.endsOn; const endsOn = endsRaw === null || endsRaw === '' || endsRaw === undefined ? null : endsRaw;
  if (endsOn !== null && !isDay(endsOn)) throw new MktError('Give the date it ends, like 2026-11-22, or leave it empty for one day.');
  if (endsOn !== null && endsOn < startsOn) throw new MktError('It cannot end before it starts.');
  if (endsOn !== null && daysBetween(startsOn, endsOn) > 120) throw new MktError('That runs for more than 120 days. Check the dates.');
  const postUrl = kind === 'giveaway' ? text(b.postUrl !== undefined ? b.postUrl : base?.postUrl, 300, 'post link') : null;
  if (postUrl && !/^https?:\/\//i.test(postUrl)) throw new MktError('The post link must be a web address starting with http.');
  const pm = (b.primaryMetric ?? base?.primaryMetric ?? PRIMARY[kind]) as string;
  if (!hasMetric(kind, '', pm)) throw new MktError('Choose one of the numbers listed for it.');
  return { name, series: text(b.series !== undefined ? b.series : base?.series, 80, 'series'), outcome: outcomeOf(b.outcome ?? base?.outcome), startsOn, endsOn, venue: kind === 'event' ? text(b.venue !== undefined ? b.venue : base?.venue, 120, 'venue') : null, postUrl, notes: text(b.notes !== undefined ? b.notes : base?.notes, 1000, 'notes'), primaryMetric: pm };
}
export async function createInitiative(rep: Rep, kind: unknown, b: Record<string, unknown>): Promise<Init> {
  if (kind !== 'event' && kind !== 'giveaway') throw new MktError('Only events and giveaways are added by hand. EDMs come from Mailchimp.');
  const f = fields(kind, b);
  return guard(async () => {
    const [dup] = await prisma.$queryRawUnsafe<{ id: string }[]>(`select id from crm.mkt_initiatives where kind = $1 and lower(name) = lower($2) and starts_on = $3::date`, kind, f.name, f.startsOn);
    if (dup) throw new MktError(`There is already ${kind === 'event' ? 'an event' : 'a giveaway'} called "${f.name}" starting that day.`, 409);
    const [r] = await prisma.$queryRawUnsafe<InitRow[]>(`insert into crm.mkt_initiatives (kind, name, series, outcome, starts_on, ends_on, venue, post_url, notes, primary_metric, created_by) values ($1, $2, $3, $4, $5::date, $6::date, $7, $8, $9, $10, $11::uuid)
      returning id, kind, name, series, outcome, ${dayText('starts_on')} as starts_on, ${dayText('ends_on')} as ends_on, venue, post_url, notes, primary_metric, external_id`, kind, f.name, f.series, f.outcome, f.startsOn, f.endsOn, f.venue, f.postUrl, f.notes, f.primaryMetric, rep.id);
    return toInit(r!);
  });
}
export async function updateInitiative(id: unknown, b: Record<string, unknown>): Promise<Init> {
  return guard(async () => {
    const cur = await getInitiative(id);
    if (cur.kind === 'edm') {   // an EDM's name, dates and send details come from Mailchimp: only how it is grouped and what it is for can be changed
      const [r] = await prisma.$queryRawUnsafe<InitRow[]>(`update crm.mkt_initiatives set series = $2, outcome = $3, notes = $4, updated_at = now() where id = $1::uuid
        returning id, kind, name, series, outcome, ${dayText('starts_on')} as starts_on, ${dayText('ends_on')} as ends_on, venue, post_url, notes, primary_metric, external_id`, cur.id, text(b.series !== undefined ? b.series : cur.series, 80, 'series'), outcomeOf(b.outcome ?? cur.outcome), text(b.notes !== undefined ? b.notes : cur.notes, 1000, 'notes'));
      return toInit(r!);
    }
    const f = fields(cur.kind, b, cur);
    const [r] = await prisma.$queryRawUnsafe<InitRow[]>(`update crm.mkt_initiatives set name = $2, series = $3, outcome = $4, starts_on = $5::date, ends_on = $6::date, venue = $7, post_url = $8, notes = $9, primary_metric = $10, updated_at = now() where id = $1::uuid
      returning id, kind, name, series, outcome, ${dayText('starts_on')} as starts_on, ${dayText('ends_on')} as ends_on, venue, post_url, notes, primary_metric, external_id`, cur.id, f.name, f.series, f.outcome, f.startsOn, f.endsOn, f.venue, f.postUrl, f.notes, f.primaryMetric);
    return toInit(r!);
  });
}
export async function deleteInitiative(id: unknown): Promise<void> {
  await guard(async () => {
    const cur = await getInitiative(id);
    if (cur.kind === 'edm') throw new MktError('An EDM comes from Mailchimp, so it cannot be deleted here.', 400);
    await prisma.$queryRaw`delete from crm.mkt_initiatives where id = ${cur.id}::uuid`;
  });
}

// ---------- the numbers typed in by hand ----------
/** Sets (or clears, with null) a number typed in by hand. Only the numbers marked as typed-in for that kind can be set. */
export async function setResult(rep: Rep, id: unknown, metric: unknown, value: unknown): Promise<void> {
  await guard(async () => {
    const init = await getInitiative(id);
    if (init.kind === 'edm') throw new MktError('EDM numbers come from Mailchimp and your orders, so they cannot be typed in.');
    const def = metricsOf(init.kind, '').find(x => x.key === metric);
    if (!def || !def.manual) throw new MktError('That number cannot be typed in.');
    if (value === null || value === '') { await prisma.$queryRaw`delete from crm.mkt_results where initiative_id = ${init.id}::uuid and metric = ${def.key}`; return; }
    const n = typeof value === 'string' ? Number(value) : value;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1e9) throw new MktError('Give a number, zero or more.');
    if (!def.money && !Number.isInteger(n)) throw new MktError(`${def.label} is a whole number.`);
    await prisma.$queryRaw`insert into crm.mkt_results (initiative_id, metric, value, updated_by) values (${init.id}::uuid, ${def.key}, ${Math.round(n * 100) / 100}, ${rep.id}::uuid)
      on conflict (initiative_id, metric) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`;
  });
}
export async function loadResults(ids: string[]): Promise<Map<string, Record<string, number>>> {
  const out = new Map<string, Record<string, number>>(); if (!ids.length) return out;
  const rows = await prisma.$queryRaw<{ initiative_id: string; metric: string; value: number }[]>`select initiative_id, metric, value::float8 as value from crm.mkt_results where initiative_id = any(${ids}::uuid[])`;
  for (const r of rows) out.set(r.initiative_id, { ...(out.get(r.initiative_id) ?? {}), [r.metric]: Number(r.value) });
  return out;
}

// ---------- goals and failure lines ----------
export type GoalRow = { id: string; kind: Kind; initiativeId: string | null; scope: string; metric: string; outcome: Outcome; perDays: number | null; goal: number | null; failure: number | null; pending: { goal: number; failure: number; by: string | null; byId: string | null; at: string } | null; approvedBy: string | null; approvedAt: string | null };
type GRow = { id: string; kind: Kind; initiative_id: string | null; scope: string; metric: string; outcome: Outcome; per_days: number | null; goal: number | null; failure_line: number | null; pending_goal: number | null; pending_failure: number | null; proposed_by: string | null; proposer: string | null; proposed_at: Date | null; approver: string | null; approved_at: Date | null };
const toGoal = (r: GRow): GoalRow => ({
  id: r.id, kind: r.kind, initiativeId: r.initiative_id, scope: r.scope, metric: r.metric, outcome: r.outcome, perDays: r.per_days, goal: r.goal == null ? null : Number(r.goal), failure: r.failure_line == null ? null : Number(r.failure_line),
  pending: r.pending_goal == null ? null : { goal: Number(r.pending_goal), failure: Number(r.pending_failure), by: r.proposer, byId: r.proposed_by, at: new Date(r.proposed_at ?? Date.now()).toISOString() },
  approvedBy: r.approver, approvedAt: r.approved_at ? new Date(r.approved_at).toISOString() : null,
});
const GOAL_SELECT = `select g.id, g.kind, g.initiative_id, g.scope, g.metric, g.outcome, g.per_days, g.goal::float8 as goal, g.failure_line::float8 as failure_line, g.pending_goal::float8 as pending_goal, g.pending_failure::float8 as pending_failure,
  g.proposed_by, pr.name as proposer, g.proposed_at, ap.name as approver, g.approved_at from crm.mkt_goals g left join crm.reps pr on pr.id = g.proposed_by left join crm.reps ap on ap.id = g.approved_by`;
export async function listGoals(kind?: Kind): Promise<GoalRow[]> {
  return (await prisma.$queryRawUnsafe<GRow[]>(`${GOAL_SELECT} ${kind ? 'where g.kind = $1' : ''} order by g.updated_at desc limit 2000`, ...(kind ? [kind] : []))).map(toGoal);
}
export const goalKey = (g: { kind: string; initiativeId: string | null; scope: string; metric: string }) => `${g.kind}|${g.initiativeId ?? ''}|${g.scope}|${g.metric}`;
/** A manager proposes a goal and a failure line for a number. It does not count until a manager approves it. */
export async function proposeGoal(rep: Rep, b: Record<string, unknown>): Promise<GoalRow> {
  const kind = b.kind as Kind;
  if (!['edm', 'event', 'giveaway', 'instagram'].includes(kind)) throw new MktError('Choose what the goal is for.');
  const scope = kind === 'instagram' ? String(b.scope ?? '') : '';
  const metric = String(b.metric ?? '');
  if (!hasMetric(kind, scope, metric)) throw new MktError('Choose one of the numbers listed for it.');
  const v = validateGoal(b.goal, b.failure); if ('error' in v) throw new MktError(v.error);
  return guard(async () => {
    let initiativeId: string | null = null, outcome: Outcome = outcomeOf(b.outcome);
    if (kind === 'event' || kind === 'giveaway') { const i = await getInitiative(b.initiativeId); if (i.kind !== kind) throw new MktError('That is not ' + (kind === 'event' ? 'an event' : 'a giveaway') + '.'); initiativeId = i.id; if (b.outcome === undefined) outcome = i.outcome; }
    const perDays = kind === 'instagram' ? 30 : null;
    const [have] = await prisma.$queryRawUnsafe<{ id: string; goal: number | null; failure_line: number | null }[]>(`select id, goal::float8 as goal, failure_line::float8 as failure_line from crm.mkt_goals where kind = $1 and coalesce(initiative_id, '00000000-0000-0000-0000-000000000000'::uuid) = coalesce($2::uuid, '00000000-0000-0000-0000-000000000000'::uuid) and scope = $3 and metric = $4`, kind, initiativeId, scope, metric);
    if (have && have.goal === v.goal && have.failure_line === v.failure) throw new MktError('Those are already the approved numbers.', 409);
    const id = have?.id ?? (await prisma.$queryRawUnsafe<{ id: string }[]>(`insert into crm.mkt_goals (kind, initiative_id, scope, metric, outcome, per_days) values ($1, $2::uuid, $3, $4, $5, $6) returning id`, kind, initiativeId, scope, metric, outcome, perDays))[0]!.id;
    await prisma.$queryRaw`update crm.mkt_goals set pending_goal = ${v.goal}, pending_failure = ${v.failure}, proposed_by = ${rep.id}::uuid, proposed_at = now(), outcome = ${outcome}, updated_at = now() where id = ${id}::uuid`;
    return (await prisma.$queryRawUnsafe<GRow[]>(`${GOAL_SELECT} where g.id = $1::uuid`, id)).map(toGoal)[0]!;
  });
}
/** Approve (the proposal becomes the live goal) or reject / withdraw (the proposal is dropped; the live numbers stay). Approving needs a different manager than the one who proposed it, unless there is only one manager. */
export async function decideGoal(rep: Rep, id: unknown, approve: unknown): Promise<GoalRow> {
  if (!uuidOk(id)) throw new MktError('That was not found.', 404);
  if (typeof approve !== 'boolean') throw new MktError('Say whether to approve or reject it.');
  return guard(async () => {
    const [g] = await prisma.$queryRawUnsafe<GRow[]>(`${GOAL_SELECT} where g.id = $1::uuid`, id);
    if (!g) throw new MktError('That was not found.', 404);
    if (g.pending_goal == null) throw new MktError('There is nothing waiting for approval on that.', 409);
    if (approve) {
      if (!canApprove(g.proposed_by, rep.id, await managerCount())) throw new MktError('A different manager has to approve this one: you proposed it.', 403);
      await prisma.$queryRaw`update crm.mkt_goals set goal = pending_goal, failure_line = pending_failure, pending_goal = null, pending_failure = null, approved_by = ${rep.id}::uuid, approved_at = now(), updated_at = now() where id = ${id}::uuid`;
    } else await prisma.$queryRaw`update crm.mkt_goals set pending_goal = null, pending_failure = null, updated_at = now() where id = ${id}::uuid`;
    const [r] = await prisma.$queryRawUnsafe<GRow[]>(`${GOAL_SELECT} where g.id = $1::uuid`, id);
    return toGoal(r!);
  });
}
/** Goals waiting for a manager, with what they are for. */
export type Waiting = { id: string; kind: Kind; what: string; metric: string; goal: number; failure: number; liveGoal: number | null; liveFailure: number | null; by: string | null; byId: string | null; at: string; canApprove: boolean };
export async function waitingGoals(rep: Rep, managers?: number): Promise<Waiting[]> {
  const rows = await prisma.$queryRaw<(GRow & { init_name: string | null })[]>`select g.id, g.kind, g.initiative_id, g.scope, g.metric, g.outcome, g.per_days, g.goal::float8 as goal, g.failure_line::float8 as failure_line, g.pending_goal::float8 as pending_goal, g.pending_failure::float8 as pending_failure,
      g.proposed_by, pr.name as proposer, g.proposed_at, null::text as approver, null::timestamptz as approved_at, i.name as init_name
    from crm.mkt_goals g left join crm.reps pr on pr.id = g.proposed_by left join crm.mkt_initiatives i on i.id = g.initiative_id where g.pending_goal is not null order by g.proposed_at`;
  const n = managers ?? await managerCount();
  const KIND = { edm: 'EDMs', event: 'Event', giveaway: 'Giveaway', instagram: 'Instagram' } as const;
  return rows.map(r => {
    const label = metricsOf(r.kind, r.scope).find(x => x.key === r.metric)?.label ?? r.metric;
    return { id: r.id, kind: r.kind, what: r.init_name ? `${KIND[r.kind]}: ${r.init_name}` : r.kind === 'instagram' ? `Instagram, ${r.scope}` : KIND[r.kind], metric: label, goal: Number(r.pending_goal), failure: Number(r.pending_failure), liveGoal: r.goal == null ? null : Number(r.goal), liveFailure: r.failure_line == null ? null : Number(r.failure_line), by: r.proposer, byId: r.proposed_by, at: new Date(r.proposed_at ?? Date.now()).toISOString(), canApprove: canApprove(r.proposed_by, rep.id, n) };
  });
}
