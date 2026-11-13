// The marketing dashboard's pages, put together: the overview (three stockist cards, a row for each of the four focus areas, a calendar) and the four detail pages.
// A stockist is counted by their FIRST ORDER (the marketing way). The sales tracker and the main dashboard count at the first QUOTE (Ellen's rules) and are not touched by any of this.
import { prisma } from './prisma';
import { guard, orderAny, orderLive, oday, type Rep } from './mktShared';
import { METRICS, IG_PRIMARY, IG_SCOPES, addDays, allMet, changePct, elapsedFraction, lightFor, melbourneToday, metGoal, overlaps, scaleGoal, worst, type Light, type Metric, type Outcome, type Period } from './mktCore';
import { goalKey, listGoals, listInitiatives, loadResults, waitingGoals, type GoalRow, type Init, type Waiting } from './mktGoals';
import { compare, igLastImport, igPosts, igValues, listGifts, type Gift, type IgValues, type PostOut } from './mktInstagram';
import { creditByCampaign, mailchimpState, type Credit, type Tag } from './mailchimp';
import { getSettings } from './marketing/settings';

// ---------- the stockist cards ----------
export type Stockists = { new: number; existing: number; reactivated: number };
/** New: first order EVER falls in the period (the customer's older history, even from before DEAR, counts: someone who bought years ago is not new). Existing: ordered in the period and the order before was within 12 months. Reactivated: ordered in the period and the order before was more than 12 months earlier. Each ordering stockist is exactly one of the three. */
export async function stockists(from: string, to: string): Promise<Stockists> {
  const [r] = await prisma.$queryRawUnsafe<{ n: number; e: number; r: number }[]>(`
    with first_in as (select q.account_id, min(${oday('q')}) as d from crm.quotes q where ${orderLive('q')} and ${oday('q')} between $1::date and $2::date group by q.account_id),
    tagged as (select f.account_id, f.d, (select max(${oday('p')}) from crm.quotes p where p.account_id = f.account_id and ${orderAny('p')} and ${oday('p')} < f.d) as prev from first_in f)
    select count(*) filter (where prev is null)::int as n, count(*) filter (where prev is not null and prev >= (d - interval '12 months')::date)::int as e, count(*) filter (where prev is not null and prev < (d - interval '12 months')::date)::int as r from tagged`, from, to);
  return { new: r?.n ?? 0, existing: r?.e ?? 0, reactivated: r?.r ?? 0 };
}

// ---------- one number against its goal ----------
export type Cell = { metric: string; label: string; stage: 'pre' | 'at' | 'post' | null; money: boolean; manual: boolean; entered: boolean; value: number; prev: number | null; goal: number | null; failure: number | null; pending: GoalRow['pending']; goalId: string | null; outcome: Outcome | null; light: Light };
function cell(def: Metric, o: { value: number | null; prev: number | null; g: GoalRow | undefined; fraction: number; scaleDays?: number }): Cell {
  const g = o.g, entered = o.value !== null;
  const goal = g?.goal == null ? null : scaleGoal(g.goal, g.perDays, o.scaleDays ?? 0), failure = g?.failure == null ? null : scaleGoal(g.failure, g.perDays, o.scaleDays ?? 0);
  return { metric: def.key, label: def.label, stage: def.stage ?? null, money: !!def.money, manual: def.manual, entered, value: o.value ?? 0, prev: o.prev, goal: goal == null ? null : Math.round(goal * 10) / 10, failure: failure == null ? null : Math.round(failure * 10) / 10, pending: g?.pending ?? null, goalId: g?.id ?? null, outcome: g?.outcome ?? null,
    light: entered && goal != null ? lightFor(o.value ?? 0, goal, failure, o.fraction) : 'none' };
}
const normUrl = `lower(regexp_replace(regexp_replace(btrim(%s), '[?#].*$', ''), '/+$', ''))`;   // a post link with or without a trailing slash or a ?igsh=... tail is the same post
const post = (c: string) => normUrl.replace('%s', c);

// ---------- the numbers behind each initiative ----------
type Values = { values: Record<string, number>; entered: Set<string> };
async function valuesOf(inits: Init[], credit: Map<string, Credit>): Promise<Map<string, Values>> {
  const out = new Map<string, Values>(); const ids = inits.map(i => i.id);
  const res = await loadResults(ids);
  const derived = new Map<string, { likes: number | null; comments: number | null; act: number | null }>();
  const gws = inits.filter(i => i.kind === 'giveaway' && i.postUrl);
  if (gws.length) for (const r of await prisma.$queryRawUnsafe<{ id: string; likes: number | null; comments: number | null; act: number | null }[]>(`select i.id, p.likes, p.comments, p.profile_activity as act from crm.mkt_initiatives i join crm.mkt_ig_posts p on ${post('p.permalink')} = ${post('i.post_url')} where i.id = any($1::uuid[])`, gws.map(g => g.id))) derived.set(r.id, r);
  const camps = new Map((await prisma.$queryRaw<{ initiative_id: string; clicks: number; campaign_id: string }[]>`select initiative_id, clicks, campaign_id from crm.mkt_edm_campaigns where initiative_id = any(${ids}::uuid[])`).map(c => [c.initiative_id, c]));
  for (const i of inits) {
    const v: Record<string, number> = { ...(res.get(i.id) ?? {}) }; const entered = new Set(Object.keys(v));
    if (i.kind === 'giveaway') { const d = derived.get(i.id); if (d) for (const [k, x] of [['entrants', d.likes], ['entries', d.comments], ['profile_activity', d.act]] as const) if (x !== null && v[k] === undefined) { v[k] = x; entered.add(k); } }
    if (i.kind === 'edm') { const c = camps.get(i.id), cr = c ? credit.get(c.campaign_id) : undefined; if (c) { v.clicks = c.clicks; v.sales = cr?.sales ?? 0; v.carts = cr?.carts ?? 0; for (const k of ['clicks', 'sales', 'carts']) entered.add(k); } }
    out.set(i.id, { values: v, entered });
  }
  return out;
}
/** The last earlier run to compare with: in the same series if it has one, otherwise the last earlier one of the same kind. */
export function previousRun(init: Init, all: Init[]): Init | null {
  const mine = all.filter(x => x.id !== init.id && x.startsOn < init.startsOn && (init.series ? (x.series ?? '').toLowerCase() === init.series.toLowerCase() : true));
  return mine.sort((a, b) => b.startsOn.localeCompare(a.startsOn))[0] ?? null;
}
const goalMap = (goals: GoalRow[]) => new Map(goals.map(g => [goalKey(g), g]));
const fractionOf = (i: Init, today: string, windowDays = 0) => elapsedFraction(i.startsOn, i.kind === 'edm' ? addDays(i.startsOn, windowDays) : i.endsOn, today);

// ---------- the overview ----------
export type Row = { focus: 'edm' | 'event' | 'instagram' | 'giveaway'; label: string; current: Light; previous: boolean | null; judged: number; unjudged: number; previousJudged: number };
export type CalendarItem = { kind: 'edm' | 'event' | 'instagram' | 'giveaway'; id: string | null; title: string; start: string; end: string; state: 'done' | 'upcoming' | 'scheduled' };
export type Overview = { period: Period; today: string; cards: { current: Stockists; previous: Stockists; change: { new: number | null; existing: number | null; reactivated: number | null } }; rows: Row[]; calendar: { from: string; to: string; items: CalendarItem[] }; waiting: Waiting[]; mailchimp: { configured: boolean; at: string | null; ok: boolean | null } };
export async function overview(rep: Rep, p: Period, now = new Date()): Promise<Overview> {
  return guard(async () => {
    const today = melbourneToday(now);
    const [cur, prev] = [await stockists(p.from, p.to), await stockists(p.prevFrom, p.prevTo)];
    const goals = goalMap(await listGoals()), credit = await creditByCampaign(), win = (await getSettings()).attribution_days;
    const rows: Row[] = [];
    for (const kind of ['edm', 'event', 'giveaway'] as const) {
      const all = await listInitiatives(kind), vals = await valuesOf(all, credit);
      const lights: Light[] = [], met: (boolean | null)[] = []; let judged = 0, unjudged = 0, previousJudged = 0;
      for (const i of all) {
        const inCur = overlaps(i.startsOn, i.endsOn, p.from, p.to), inPrev = overlaps(i.startsOn, i.endsOn, p.prevFrom, p.prevTo);
        if (!inCur && !inPrev) continue;
        const g = goals.get(goalKey({ kind, initiativeId: kind === 'edm' ? null : i.id, scope: '', metric: i.primaryMetric })), v = vals.get(i.id)!;
        if (g?.goal == null) { if (inCur) unjudged++; continue; }
        if (!v.entered.has(i.primaryMetric)) { if (inCur) unjudged++; continue; }
        const value = v.values[i.primaryMetric] ?? 0;
        if (inCur) { lights.push(lightFor(value, g.goal, g.failure, fractionOf(i, today, win))); judged++; }
        if (inPrev) { met.push(metGoal(value, g.goal)); previousJudged++; }
      }
      rows.push({ focus: kind, label: kind === 'edm' ? 'EDMs' : kind === 'event' ? 'Trade shows / events' : 'Giveaways', current: worst(lights), previous: allMet(met), judged, unjudged, previousJudged });
    }
    const [vCur, vPrev] = [await igValues(p.from, p.to), await igValues(p.prevFrom, p.prevTo)];
    const lights: Light[] = [], met: (boolean | null)[] = []; let judged = 0, unjudged = 0, previousJudged = 0;
    for (const scope of IG_SCOPES) {
      const g = goals.get(goalKey({ kind: 'instagram', initiativeId: null, scope, metric: IG_PRIMARY[scope] }));
      if (g?.goal == null) { unjudged++; continue; }
      const val = (v: IgValues) => (v as any)[scope][IG_PRIMARY[scope]] as number, goal = scaleGoal(g.goal, g.perDays, p.days), fail = g.failure == null ? null : scaleGoal(g.failure, g.perDays, p.days);
      lights.push(lightFor(val(vCur), goal, fail, 1)); judged++;
      if (vPrev.account.daysWithData > 0 || scope !== 'scheduled') { met.push(metGoal(val(vPrev), goal)); previousJudged++; }
    }
    rows.splice(2, 0, { focus: 'instagram', label: 'Instagram', current: worst(lights), previous: allMet(met), judged, unjudged, previousJudged });
    const calFrom = p.from < addDays(today, -7) ? p.from : addDays(today, -7), calTo = p.to > addDays(today, 56) ? p.to : addDays(today, 56);
    const items: CalendarItem[] = [];
    for (const kind of ['event', 'giveaway', 'edm'] as const) for (const i of await listInitiatives(kind)) {
      if (!overlaps(i.startsOn, i.endsOn, calFrom, calTo)) continue;
      const sched = kind === 'edm' && (await prisma.$queryRaw<{ n: number }[]>`select count(*)::int as n from crm.mkt_edm_campaigns where initiative_id = ${i.id}::uuid and status = 'scheduled'`)[0]!.n > 0;
      items.push({ kind, id: i.id, title: i.name, start: i.startsOn, end: i.endsOn ?? i.startsOn, state: sched ? 'scheduled' : (i.endsOn ?? i.startsOn) < today ? 'done' : 'upcoming' });
    }
    for (const x of await prisma.$queryRawUnsafe<{ day: string; status: 'posted' | 'scheduled'; n: number }[]>(`select to_char((posted_at at time zone 'Australia/Melbourne')::date, 'YYYY-MM-DD') as day, status, count(*)::int as n from crm.mkt_ig_posts where (posted_at at time zone 'Australia/Melbourne')::date between $1::date and $2::date group by 1, 2 order by 1`, calFrom, calTo))
      items.push({ kind: 'instagram', id: null, title: `${x.n} post${x.n === 1 ? '' : 's'}`, start: x.day, end: x.day, state: x.status === 'scheduled' ? 'scheduled' : x.day < today ? 'done' : 'upcoming' });
    items.sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
    const mc = await mailchimpState();
    return { period: p, today, cards: { current: cur, previous: prev, change: { new: changePct(cur.new, prev.new), existing: changePct(cur.existing, prev.existing), reactivated: changePct(cur.reactivated, prev.reactivated) } }, rows, calendar: { from: calFrom, to: calTo, items }, waiting: await waitingGoals(rep), mailchimp: { configured: mc.configured, at: mc.at, ok: mc.ok } };
  });
}

// ---------- the EDMs page ----------
export type EdmRow = { id: string; campaignId: string | null; name: string; subject: string | null; date: string; status: 'sent' | 'scheduled'; list: string | null; segment: string | null; sent: number; opens: number; clicks: number; carts: number; sales: number; salesValue: number; byTag: Record<Tag, number>; cells: Cell[]; prevName: string | null };
export async function edmPage(p: Period, now = new Date()) {
  return guard(async () => {
    const today = melbourneToday(now), win = (await getSettings()).attribution_days, credit = await creditByCampaign(), goals = goalMap(await listGoals('edm'));
    const all = await listInitiatives('edm'), vals = await valuesOf(all, credit);
    const camps = new Map((await prisma.$queryRaw<{ initiative_id: string; campaign_id: string; subject: string | null; status: 'sent' | 'scheduled'; list_name: string | null; segment: string | null; emails_sent: number; opens: number }[]>`select initiative_id, campaign_id, subject, status, list_name, segment, emails_sent, opens from crm.mkt_edm_campaigns`).map(c => [c.initiative_id, c]));
    const row = (i: Init): EdmRow => {
      const c = camps.get(i.id), v = vals.get(i.id)!, cr = c ? credit.get(c.campaign_id) : undefined, pv = previousRun(i, all), pvv = pv ? vals.get(pv.id) : undefined, f = fractionOf(i, today, win);
      return { id: i.id, campaignId: c?.campaign_id ?? null, name: i.name, subject: c?.subject ?? null, date: i.startsOn, status: c?.status ?? 'sent', list: c?.list_name ?? null, segment: c?.segment ?? null, sent: c?.emails_sent ?? 0, opens: c?.opens ?? 0, clicks: v.values.clicks ?? 0, carts: v.values.carts ?? 0, sales: v.values.sales ?? 0, salesValue: cr?.value ?? 0, byTag: cr?.byTag ?? { new: 0, existing: 0, reactivated: 0 },
        cells: METRICS.edm.map(d => cell(d, { value: c?.status === 'scheduled' ? null : v.values[d.key] ?? null, prev: pvv ? pvv.values[d.key] ?? 0 : null, g: goals.get(goalKey({ kind: 'edm', initiativeId: null, scope: '', metric: d.key })), fraction: f })), prevName: pv?.name ?? null };
    };
    const inP = (a: string, b: string) => all.filter(i => i.startsOn >= a && i.startsOn <= b).map(row);
    const cur = inP(p.from, p.to), prev = inP(p.prevFrom, p.prevTo);
    const sum = (l: EdmRow[]) => { const sent = l.filter(x => x.status === 'sent'); return { campaigns: sent.length, sent: sent.reduce((t, x) => t + x.sent, 0), opens: sent.reduce((t, x) => t + x.opens, 0), clicks: sent.reduce((t, x) => t + x.clicks, 0), carts: sent.reduce((t, x) => t + x.carts, 0), sales: sent.reduce((t, x) => t + x.sales, 0), salesValue: Math.round(sent.reduce((t, x) => t + x.salesValue, 0) * 100) / 100, byTag: { new: sent.reduce((t, x) => t + x.byTag.new, 0), existing: sent.reduce((t, x) => t + x.byTag.existing, 0), reactivated: sent.reduce((t, x) => t + x.byTag.reactivated, 0) } }; };
    return { period: p, rows: cur, totals: { current: sum(cur), previous: sum(prev) }, goals: METRICS.edm.map(d => cell(d, { value: null, prev: null, g: goals.get(goalKey({ kind: 'edm', initiativeId: null, scope: '', metric: d.key })), fraction: 1 })), attributionDays: win, mailchimp: await mailchimpState() };
  });
}

// ---------- events and giveaways ----------
export type InitOut = { init: Init; cells: Cell[]; primary: Light; prevName: string | null; waitingForResults: boolean };
async function initPage(kind: 'event' | 'giveaway', p: Period, now: Date) {
  const today = melbourneToday(now), goals = goalMap(await listGoals(kind)), all = await listInitiatives(kind), vals = await valuesOf(all, new Map());
  const out = (i: Init): InitOut => {
    const v = vals.get(i.id)!, pv = previousRun(i, all), pvv = pv ? vals.get(pv.id) : undefined, f = fractionOf(i, today);
    const cells = METRICS[kind].map(d => cell(d, { value: v.entered.has(d.key) ? v.values[d.key] ?? 0 : null, prev: pvv ? pvv.values[d.key] ?? 0 : null, g: goals.get(goalKey({ kind, initiativeId: i.id, scope: '', metric: d.key })), fraction: f }));
    return { init: i, cells, primary: cells.find(c => c.metric === i.primaryMetric)?.light ?? 'none', prevName: pv?.name ?? null, waitingForResults: i.endsOn ? i.endsOn < today && !v.entered.size : i.startsOn < today && !v.entered.size };
  };
  const running = all.filter(i => overlaps(i.startsOn, i.endsOn, p.from, p.to)).sort((a, b) => b.startsOn.localeCompare(a.startsOn)).map(out);
  const upcoming = all.filter(i => i.startsOn > p.to).sort((a, b) => a.startsOn.localeCompare(b.startsOn)).slice(0, 6).map(out);
  return { period: p, items: running, upcoming };
}
export const eventsPage = (p: Period, now = new Date()) => guard(() => initPage('event', p, now));
export const giveawaysPage = (p: Period, now = new Date()) => guard(() => initPage('giveaway', p, now));

// ---------- Instagram ----------
export async function instagramPage(p: Period) {
  return guard(async () => {
    const goals = goalMap(await listGoals('instagram')), cur = await igValues(p.from, p.to), prev = await igValues(p.prevFrom, p.prevTo);
    const block = (scope: 'influencers' | 'scheduled' | 'horeca'): Cell[] => METRICS.instagram[scope].map(d => cell(d, { value: (cur as any)[scope][d.key], prev: (prev as any)[scope][d.key], g: goals.get(goalKey({ kind: 'instagram', initiativeId: null, scope, metric: d.key })), fraction: 1, scaleDays: p.days }));
    const posts = await igPosts(p.from, p.to);
    const upcoming = await igPosts(melbourneToday(), addDays(melbourneToday(), 60));
    return { period: p, import: await igLastImport(), account: { current: cur.account, previous: prev.account }, blocks: { influencers: block('influencers'), scheduled: block('scheduled'), horeca: block('horeca') }, people: { influencers: cur.influencers.people, horeca: cur.horeca.people },
      gifts: await listGifts(p.from, p.to) as Gift[], posts: posts as PostOut[], compare: compare(posts), upcoming: upcoming.filter(x => x.status === 'scheduled') };
  });
}
