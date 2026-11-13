import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

// The marketing dashboard (managers only): what the API sends, and the small helpers every page shares.
export type Light = 'green' | 'amber' | 'red' | 'none';
export type Outcome = 'brand' | 'sales' | 'awareness';
export type Pending = { goal: number; failure: number; by: string | null; byId: string | null; at: string } | null;
export type Cell = { metric: string; label: string; stage: 'pre' | 'at' | 'post' | null; money: boolean; manual: boolean; entered: boolean; value: number; prev: number | null; goal: number | null; failure: number | null; pending: Pending; goalId: string | null; outcome: Outcome | null; light: Light };
export type Period = { from: string; to: string; days: number; prevFrom: string; prevTo: string };
export type Stockists = { new: number; existing: number; reactivated: number };
export type Row = { focus: 'edm' | 'event' | 'instagram' | 'giveaway'; label: string; current: Light; previous: boolean | null; judged: number; unjudged: number; previousJudged: number };
export type CalendarItem = { kind: Row['focus']; id: string | null; title: string; start: string; end: string; state: 'done' | 'upcoming' | 'scheduled' };
export type Waiting = { id: string; kind: string; what: string; metric: string; goal: number; failure: number; liveGoal: number | null; liveFailure: number | null; by: string | null; byId: string | null; at: string; canApprove: boolean };
export type Overview = { period: Period; today: string; cards: { current: Stockists; previous: Stockists; change: { new: number | null; existing: number | null; reactivated: number | null } }; rows: Row[]; calendar: { from: string; to: string; items: CalendarItem[] }; waiting: Waiting[]; mailchimp: { configured: boolean; at: string | null; ok: boolean | null } };
export type Init = { id: string; kind: 'edm' | 'event' | 'giveaway'; name: string; series: string | null; outcome: Outcome; startsOn: string; endsOn: string | null; venue: string | null; postUrl: string | null; notes: string | null; primaryMetric: string; externalId: string | null };
export type InitOut = { init: Init; cells: Cell[]; primary: Light; prevName: string | null; waitingForResults: boolean };
export type Tags = { new: number; existing: number; reactivated: number };
export type EdmRow = { id: string; campaignId: string | null; name: string; subject: string | null; date: string; status: 'sent' | 'scheduled'; list: string | null; segment: string | null; sent: number; opens: number; clicks: number; carts: number; sales: number; salesValue: number; byTag: Tags; cells: Cell[]; prevName: string | null };
export type EdmTotals = { campaigns: number; sent: number; opens: number; clicks: number; carts: number; sales: number; salesValue: number; byTag: Tags };
export type EdmPage = { period: Period; rows: EdmRow[]; totals: { current: EdmTotals; previous: EdmTotals }; goals: Cell[]; attributionDays: number; mailchimp: { configured: boolean; at: string | null; ok: boolean | null; error: string | null; campaigns: number | null } };
export type InitPage = { period: Period; items: InitOut[]; upcoming: InitOut[] };
export type Gift = { id: string; kind: 'influencer' | 'horeca'; name: string; handle: string | null; giftedOn: string; qty: number; likes: number; comments: number; shares: number; notes: string | null; interactions: number };
export type Post = { id: string; at: string; day: string; status: 'posted' | 'scheduled'; kind: string | null; caption: string | null; permalink: string | null; likes: number | null; comments: number | null; shares: number | null; saves: number | null; reach: number | null; profileActivity: number | null; interactions: number; engagement: number | null; source: 'import' | 'manual' };
export type Account = { reach: number; profile_visits: number; followers_gained: number; views: number; interactions: number; daysWithData: number };
export type IgPage = { period: Period; import: { dailyTo: string | null; postsTo: string | null }; account: { current: Account; previous: Account }; blocks: { influencers: Cell[]; scheduled: Cell[]; horeca: Cell[] }; people: { influencers: number; horeca: number }; gifts: Gift[]; posts: Post[]; compare: { byKind: { kind: string; posts: number; avgInteractions: number; avgEngagement: number | null }[]; best: Post[]; weakest: Post[] }; upcoming: Post[] };
export type ImportResult = { added: number; updated: number; from: string | null; to: string | null; problems: string[] };

export const OUTCOME_LABEL: Record<Outcome, string> = { brand: 'Brand recognition', sales: 'Sales', awareness: 'Awareness / education' };
export const FOCUS_PATH: Record<Row['focus'], string> = { edm: 'edms', event: 'events', instagram: 'instagram', giveaway: 'giveaways' };
export const STAGE_LABEL = { pre: 'Pre-event', at: 'At event', post: 'Post-event' } as const;
export const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The period lives in the address (?from=&to=), so a link or a refresh keeps it, and moving between the pages keeps it. Empty means the last 30 days. */
export function usePeriodParams() {
  const [sp, setSp] = useSearchParams();
  const from = sp.get('from') ?? '', to = sp.get('to') ?? '';
  const query = useMemo(() => (from || to ? `?${new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) })}` : ''), [from, to]);
  const set = (f: string, t: string) => setSp(f || t ? { ...(f ? { from: f } : {}), ...(t ? { to: t } : {}) } : {});
  return { from, to, query, set };
}
export const num = (n: number, money = false) => (money ? `$${n.toLocaleString('en-AU', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}` : n.toLocaleString('en-AU', { maximumFractionDigits: 1 }));
export const day = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
export const dayShort = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
export const LIGHT_TEXT: Record<Light, string> = { green: 'On track', amber: 'Behind pace', red: 'Not on track', none: 'No goal yet' };
export const LIGHT_MARK: Record<Light, string> = { green: '▲', amber: '●', red: '▼', none: '–' };
export const LIGHT_CLASS: Record<Light, string> = { green: 'teal', amber: 'amber', red: 'rust', none: 'neutral' };
/** "+12%" or "-5%" or nothing when there is nothing to compare with. */
export const changeText = (c: number | null) => (c === null ? '' : c === 0 ? 'no change' : `${c > 0 ? '+' : ''}${c}%`);
export const addDaysTo = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** The numbers an event or a giveaway can be judged on (the first is the default). */
export const EVENT_PRIMARY: [string, string][] = [['new_customers', 'New customers'], ['new_leads', 'New leads'], ['came_spent', 'Came and spent'], ['rsvp', "RSVP'd"], ['booked_appointments', 'Booked appointment'], ['returning_customers', 'Returning customers'], ['leads_converted', 'Leads converted'], ['post_show_sales', 'Post-show sales ($)']];
export const GIVEAWAY_PRIMARY: [string, string][] = [['entries', '# Entries (comments)'], ['entrants', '# Entrants (likes)'], ['profile_activity', 'Profile activity (visits)']];
export const todayMel = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Melbourne' });
