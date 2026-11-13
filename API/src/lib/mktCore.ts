// The marketing dashboard's plain rules: the periods, the goals and failure lines, the three colours, and the lists of numbers for each kind of initiative.
// Nothing here touches the database, so all of it is tested on its own (scripts/test-mkt.ts).
export type Kind = 'edm' | 'event' | 'giveaway' | 'instagram';
export type Light = 'green' | 'amber' | 'red' | 'none';
export type Outcome = 'brand' | 'sales' | 'awareness';
export const OUTCOMES: Record<Outcome, string> = { brand: 'Brand recognition', sales: 'Sales', awareness: 'Awareness / education' };
export const OUTCOME_ROLE: Record<Outcome, string> = { brand: 'Primary', sales: 'Primary', awareness: 'Supportive' };
export type Metric = { key: string; label: string; stage?: 'pre' | 'at' | 'post'; manual: boolean; money?: boolean };
export const STAGES = { pre: 'Pre-event', at: 'At event', post: 'Post-event' } as const;
const m = (key: string, label: string, manual: boolean, extra: Partial<Metric> = {}): Metric => ({ key, label, manual, ...extra });
export const METRICS: { edm: Metric[]; event: Metric[]; giveaway: Metric[]; instagram: Record<'influencers' | 'scheduled' | 'horeca', Metric[]> } = {
  edm: [m('sales', 'Sales (orders)', false), m('clicks', 'Clicks', false), m('carts', 'Carts left behind', false)],
  event: [
    m('rsvp', "RSVP'd", true, { stage: 'pre' }), m('came_no_spend', "Came (didn't spend)", true, { stage: 'pre' }), m('came_spent', 'Came and spent', true, { stage: 'pre' }),
    m('booked_appointments', 'Booked appointment', true, { stage: 'at' }), m('signup_edm', 'Signed up from EDM', true, { stage: 'at' }), m('signup_instagram', 'Signed up from Instagram', true, { stage: 'at' }),
    m('signup_both', 'Signed up from both', true, { stage: 'at' }), m('new_leads', 'New leads', true, { stage: 'at' }), m('new_customers', 'New customers', true, { stage: 'at' }), m('returning_customers', 'Returning customers', true, { stage: 'at' }),
    m('leads_followed_up', 'Leads followed up', true, { stage: 'post' }), m('leads_converted', 'Leads converted', true, { stage: 'post' }), m('post_show_sales', 'Post-show sales ($)', true, { stage: 'post', money: true }),
  ],
  giveaway: [m('prize_value', 'Prize value ($)', true, { money: true }), m('entries', '# Entries (comments)', true), m('entrants', '# Entrants (likes)', true), m('profile_activity', 'Profile activity (visits)', true)],
  instagram: {
    influencers: [m('qty_gifted_avg', 'Qty gifted per influencer (average)', false), m('interactions_avg', 'Interactions per influencer (average)', false)],
    scheduled: [m('posted', 'Qty posted', false), m('interactions', 'Interactions', false), m('profile_activity', 'Profile activity', false), m('reached', 'Accounts reached', false)],
    horeca: [m('qty_gifted_avg', 'Qty gifted per venue (average)', false), m('interactions_avg', 'Interactions per venue (average)', false)],
  },
};
/** The number that decides each kind's colour on the overview (an event or a giveaway can choose another). */
export const PRIMARY = { edm: 'sales', event: 'new_customers', giveaway: 'entries' } as const;
export const IG_PRIMARY: Record<'influencers' | 'scheduled' | 'horeca', string> = { influencers: 'interactions_avg', scheduled: 'interactions', horeca: 'interactions_avg' };
export const IG_SCOPES = ['influencers', 'scheduled', 'horeca'] as const;
export const metricsOf = (kind: Kind, scope = ''): Metric[] => kind === 'instagram' ? (METRICS.instagram as any)[scope] ?? [] : METRICS[kind];
export const hasMetric = (kind: Kind, scope: string, key: string) => metricsOf(kind, scope).some(x => x.key === key);

// ---------- days and periods (all in Melbourne days, written YYYY-MM-DD) ----------
export const isDay = (s: unknown): s is string => { if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false; const t = new Date(`${s}T00:00:00Z`); return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === s; };
export const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const daysBetween = (a: string, b: string): number => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
export const melbourneToday = (now = new Date()): string => now.toLocaleDateString('en-CA', { timeZone: 'Australia/Melbourne' });
export type Period = { from: string; to: string; days: number; prevFrom: string; prevTo: string };
export const MAX_DAYS = 366;
/** The period asked for: the last 30 days (today included) unless a from and a to are given. "Previous" is the same number of days straight before. */
export function parsePeriod(q: { from?: unknown; to?: unknown }, now = new Date()): Period | { error: string } {
  const today = melbourneToday(now);
  const to = q.to === undefined || q.to === '' ? today : q.to, from = q.from === undefined || q.from === '' ? (isDay(to) ? addDays(to, -29) : '') : q.from;
  if (!isDay(to) || !isDay(from)) return { error: 'Use real dates, like 2026-11-01.' };
  if (from > to) return { error: 'The start date is after the end date.' };
  const days = daysBetween(from, to) + 1;
  if (days > MAX_DAYS) return { error: `Pick a period of ${MAX_DAYS} days or fewer.` };
  return { from, to, days, prevFrom: addDays(from, -days), prevTo: addDays(from, -1) };
}
/** Does something that runs from start to end (end empty = one day) overlap the days from..to? */
export const overlaps = (start: string, end: string | null, from: string, to: string): boolean => start <= to && (end ?? start) >= from;
/** How much of a run has happened by `today`: 0 before it starts, 1 once it has ended. */
export function elapsedFraction(start: string, end: string | null, today: string): number {
  const e = end ?? start;
  if (today < start) return 0;
  if (today >= e) return 1;
  return (daysBetween(start, today) + 1) / (daysBetween(start, e) + 1);
}

// ---------- goals, failure lines and the three colours ----------
/** Goal: the number that means it worked. Failure line: the number where we stop or change course, so it must be lower. */
export function validateGoal(goal: unknown, failure: unknown): { goal: number; failure: number } | { error: string } {
  const g = typeof goal === 'string' && goal.trim() !== '' ? Number(goal) : goal, f = typeof failure === 'string' && failure.trim() !== '' ? Number(failure) : failure;
  if (typeof g !== 'number' || typeof f !== 'number' || !Number.isFinite(g) || !Number.isFinite(f)) return { error: 'Give both a goal and a failure line, as numbers.' };
  if (g <= 0) return { error: 'The goal must be more than 0.' };
  if (f < 0) return { error: 'The failure line cannot be below 0.' };
  if (f >= g) return { error: 'The failure line must be lower than the goal: it is the number where you stop or change course.' };
  if (g > 1e9) return { error: 'That goal is too big.' };
  return { goal: g, failure: f };
}
/**
 * Green: on pace for the goal. Red: at or below the failure line (stop or change course). Amber: in between. "None": no approved goal.
 * While a run is under way the goal and the failure line are both scaled to how much of it has passed; once it has ended the full numbers are used.
 * In the first quarter of a run nothing is red (too early to say stop): behind pace is amber until a quarter has passed.
 */
export function lightFor(value: number, goal: number | null | undefined, failure: number | null | undefined, fraction = 1): Light {
  if (goal == null) return 'none';
  const f = Math.min(1, Math.max(0, fraction));
  if (value >= goal * f) return 'green';
  if (failure != null && (f >= 1 ? value <= failure : f >= 0.25 && value < failure * f)) return 'red';
  return 'amber';
}
export const metGoal = (value: number, goal: number | null | undefined): boolean | null => (goal == null ? null : value >= goal);
export const worst = (l: Light[]): Light => (l.includes('red') ? 'red' : l.includes('amber') ? 'amber' : l.includes('green') ? 'green' : 'none');
/** A goal that is "per 30 days" is scaled to the length of the period being shown. */
export const scaleGoal = (n: number, perDays: number | null | undefined, days: number): number => (perDays ? (n * days) / perDays : n);
/** Did every one of these meet its goal? null when there was nothing to judge. */
export const allMet = (l: (boolean | null)[]): boolean | null => { const j = l.filter((x): x is boolean => x !== null); return j.length ? j.every(Boolean) : null; };
/** A different manager has to approve a goal than the one who proposed it, unless there is only one manager. */
export const canApprove = (proposerId: string | null, approverId: string, managers: number): boolean => proposerId !== approverId || managers <= 1;
export const round1 = (n: number): number => Math.round(n * 10) / 10;
/** The change against the previous period, as a plain number: null when the previous was 0 and nothing can be said. */
export const changePct = (cur: number, prev: number): number | null => (prev === 0 ? null : Math.round(((cur - prev) / prev) * 100));
