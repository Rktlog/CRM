// Instagram on the marketing dashboard: Meta's reports (imported by hand, about once a month), posts (imported or added by hand), the gifting log for influencers and HORECA venues,
// and the numbers for a period. Radar never talks to Instagram or Meta itself.
import { prisma } from './prisma';
import { MktError, guard, uuidOk, dayText, type Rep } from './mktShared';
import { isDay, round1 } from './mktCore';
import { parseDailyReport, parseMoment, parsePostsReport } from './mktImport';

export const MAX_IMPORT_CHARS = 90_000;
export const MAX_IMPORT_ROWS = 1000;
export type ImportResult = { added: number; updated: number; from: string | null; to: string | null; problems: string[] };
const MEL = `(posted_at at time zone 'Australia/Melbourne')::date`;

/** A daily account report from Meta: one row per day, added or updated. A number the file does not give is left as it was. */
export async function importDaily(csv: unknown, metric?: unknown): Promise<ImportResult> {
  if (typeof csv !== 'string' || !csv.trim()) throw new MktError('Choose a file to import.');
  if (csv.length > MAX_IMPORT_CHARS) throw new MktError('That file is too big to import at once. Import a month at a time.');
  const { rows, problems } = parseDailyReport(csv, typeof metric === 'string' ? metric : undefined);
  if (!rows.length) throw new MktError(problems[0] ?? 'No rows could be read from that file.');
  if (rows.length > MAX_IMPORT_ROWS) throw new MktError(`That file has more than ${MAX_IMPORT_ROWS} days. Import a smaller one.`);
  return guard(async () => {
    let added = 0, updated = 0;
    for (const r of rows) {
      const [x] = await prisma.$queryRaw<{ inserted: boolean }[]>`
        insert into crm.mkt_ig_daily (day, reach, profile_visits, followers_gained, views, likes, comments, shares, saves)
        values (${r.day}::date, ${r.reach}, ${r.profile_visits}, ${r.followers_gained}, ${r.views}, ${r.likes}, ${r.comments}, ${r.shares}, ${r.saves})
        on conflict (day) do update set reach = coalesce(excluded.reach, crm.mkt_ig_daily.reach), profile_visits = coalesce(excluded.profile_visits, crm.mkt_ig_daily.profile_visits),
          followers_gained = coalesce(excluded.followers_gained, crm.mkt_ig_daily.followers_gained), views = coalesce(excluded.views, crm.mkt_ig_daily.views), likes = coalesce(excluded.likes, crm.mkt_ig_daily.likes),
          comments = coalesce(excluded.comments, crm.mkt_ig_daily.comments), shares = coalesce(excluded.shares, crm.mkt_ig_daily.shares), saves = coalesce(excluded.saves, crm.mkt_ig_daily.saves), imported_at = now()
        returning (xmax = 0) as inserted`;
      if (x?.inserted) added++; else updated++;
    }
    return { added, updated, from: rows[0]!.day, to: rows[rows.length - 1]!.day, problems };
  });
}
/** A posts report from Meta: one row per post. A post with a link that is already there is updated, so importing the same month twice never doubles anything. */
export async function importPosts(csv: unknown): Promise<ImportResult> {
  if (typeof csv !== 'string' || !csv.trim()) throw new MktError('Choose a file to import.');
  if (csv.length > MAX_IMPORT_CHARS) throw new MktError('That file is too big to import at once. Import a month at a time.');
  const { rows, problems } = parsePostsReport(csv);
  if (!rows.length) throw new MktError(problems[0] ?? 'No posts could be read from that file.');
  if (rows.length > MAX_IMPORT_ROWS) throw new MktError(`That file has more than ${MAX_IMPORT_ROWS} posts. Import a smaller one.`);
  return guard(async () => {
    let added = 0, updated = 0; const days: string[] = [];
    for (const r of rows) {
      days.push(r.postedAt.slice(0, 10));
      const status = new Date(r.postedAt).getTime() > Date.now() ? 'scheduled' : 'posted';
      let hit: { id: string }[] = [];
      if (r.permalink) hit = await prisma.$queryRaw<{ id: string }[]>`select id from crm.mkt_ig_posts where lower(permalink) = lower(${r.permalink})`;
      else hit = await prisma.$queryRaw<{ id: string }[]>`select id from crm.mkt_ig_posts where posted_at = ${r.postedAt}::timestamptz and coalesce(caption, '') = ${r.caption ?? ''}`;
      if (hit[0]) {
        await prisma.$queryRaw`update crm.mkt_ig_posts set posted_at = ${r.postedAt}::timestamptz, status = ${status}, kind = coalesce(${r.kind}, kind), caption = coalesce(${r.caption}, caption), likes = coalesce(${r.likes}::int, likes), comments = coalesce(${r.comments}::int, comments),
          shares = coalesce(${r.shares}::int, shares), saves = coalesce(${r.saves}::int, saves), reach = coalesce(${r.reach}::int, reach), profile_activity = coalesce(${r.profile_activity}::int, profile_activity), updated_at = now() where id = ${hit[0].id}::uuid`;
        updated++;
      } else {
        await prisma.$queryRaw`insert into crm.mkt_ig_posts (posted_at, status, kind, caption, permalink, likes, comments, shares, saves, reach, profile_activity, source)
          values (${r.postedAt}::timestamptz, ${status}, ${r.kind}, ${r.caption}, ${r.permalink}, ${r.likes}, ${r.comments}, ${r.shares}, ${r.saves}, ${r.reach}, ${r.profile_activity}, 'import')`;
        added++;
      }
    }
    days.sort();
    return { added, updated, from: days[0] ?? null, to: days[days.length - 1] ?? null, problems };
  });
}

// ---------- posts added by hand (a scheduled post, or one the report has not caught up with) ----------
const count = (v: unknown, what: string): number | null => { if (v === undefined || v === null || v === '') return null; const n = Number(v); if (!Number.isFinite(n) || n < 0 || n > 2e9 || !Number.isInteger(n)) throw new MktError(`${what} must be a whole number, zero or more.`); return n; };
export async function addPost(b: Record<string, unknown>): Promise<{ id: string }> {
  const at = typeof b.postedAt === 'string' ? parseMoment(b.postedAt) : null;
  if (!at) throw new MktError('Give the date of the post, like 2026-11-20.');
  const status = b.status === 'scheduled' ? 'scheduled' : 'posted';
  const caption = typeof b.caption === 'string' ? b.caption.trim().slice(0, 500) || null : null;
  const kind = typeof b.kind === 'string' ? b.kind.trim().toLowerCase().slice(0, 30) || null : null;
  const link = typeof b.permalink === 'string' ? b.permalink.trim() : '';
  if (link && !/^https?:\/\//i.test(link)) throw new MktError('The link must be a web address starting with http.');
  const nums = { likes: count(b.likes, 'Likes'), comments: count(b.comments, 'Comments'), shares: count(b.shares, 'Shares'), saves: count(b.saves, 'Saves'), reach: count(b.reach, 'Reach'), profile_activity: count(b.profileActivity, 'Profile activity') };
  return guard(async () => {
    if (link) { const [d] = await prisma.$queryRaw<{ id: string }[]>`select id from crm.mkt_ig_posts where lower(permalink) = lower(${link})`; if (d) throw new MktError('That post is already in the list.', 409); }
    const [r] = await prisma.$queryRaw<{ id: string }[]>`insert into crm.mkt_ig_posts (posted_at, status, kind, caption, permalink, likes, comments, shares, saves, reach, profile_activity, source)
      values (${at}::timestamptz, ${status}, ${kind}, ${caption}, ${link || null}, ${nums.likes}, ${nums.comments}, ${nums.shares}, ${nums.saves}, ${nums.reach}, ${nums.profile_activity}, 'manual') returning id`;
    return { id: r!.id };
  });
}
export async function deletePost(id: unknown): Promise<void> {
  if (!uuidOk(id)) throw new MktError('That was not found.', 404);
  await guard(async () => { const r = await prisma.$queryRaw<{ id: string }[]>`delete from crm.mkt_ig_posts where id = ${id}::uuid returning id`; if (!r.length) throw new MktError('That was not found.', 404); });
}

// ---------- the gifting log (influencers and HORECA venues) ----------
export type Gift = { id: string; kind: 'influencer' | 'horeca'; name: string; handle: string | null; giftedOn: string; qty: number; likes: number; comments: number; shares: number; notes: string | null; interactions: number };
type GiftRow = { id: string; kind: 'influencer' | 'horeca'; name: string; handle: string | null; gifted_on: string; qty: number; likes: number; comments: number; shares: number; notes: string | null };
const toGift = (r: GiftRow): Gift => ({ id: r.id, kind: r.kind, name: r.name, handle: r.handle, giftedOn: r.gifted_on, qty: r.qty, likes: r.likes, comments: r.comments, shares: r.shares, notes: r.notes, interactions: r.likes + r.comments + r.shares });
const GIFT_SELECT = `select id, kind, name, handle, ${dayText('gifted_on')} as gifted_on, qty, likes, comments, shares, notes from crm.mkt_gifts`;
function giftFields(b: Record<string, unknown>): { kind: 'influencer' | 'horeca'; name: string; handle: string | null; giftedOn: string; qty: number; likes: number; comments: number; shares: number; notes: string | null } {
  if (b.kind !== 'influencer' && b.kind !== 'horeca') throw new MktError('Choose influencer or HORECA.');
  const name = typeof b.name === 'string' ? b.name.trim() : ''; if (!name || name.length > 100) throw new MktError('Give the name (up to 100 characters).');
  if (!isDay(b.giftedOn)) throw new MktError('Give the date it was gifted, like 2026-11-05.');
  const n = (v: unknown, what: string, dflt: number) => { const x = count(v, what); return x ?? dflt; };
  const handle = typeof b.handle === 'string' ? b.handle.trim().replace(/^@?/, '@').slice(0, 60) : ''; const notes = typeof b.notes === 'string' ? b.notes.trim().slice(0, 500) : '';
  return { kind: b.kind, name, handle: handle.length > 1 ? handle : null, giftedOn: b.giftedOn, qty: n(b.qty, 'Qty gifted', 1), likes: n(b.likes, 'Likes', 0), comments: n(b.comments, 'Comments', 0), shares: n(b.shares, 'Shares', 0), notes: notes || null };
}
export async function addGift(rep: Rep, b: Record<string, unknown>): Promise<Gift> {
  const f = giftFields(b);
  return guard(async () => (toGift((await prisma.$queryRawUnsafe<GiftRow[]>(`insert into crm.mkt_gifts (kind, name, handle, gifted_on, qty, likes, comments, shares, notes, created_by) values ($1, $2, $3, $4::date, $5, $6, $7, $8, $9, $10::uuid)
    returning id, kind, name, handle, ${dayText('gifted_on')} as gifted_on, qty, likes, comments, shares, notes`, f.kind, f.name, f.handle, f.giftedOn, f.qty, f.likes, f.comments, f.shares, f.notes, rep.id))[0]!)));
}
export async function updateGift(id: unknown, b: Record<string, unknown>): Promise<Gift> {
  if (!uuidOk(id)) throw new MktError('That was not found.', 404);
  return guard(async () => {
    const [cur] = await prisma.$queryRawUnsafe<GiftRow[]>(`${GIFT_SELECT} where id = $1::uuid`, id); if (!cur) throw new MktError('That was not found.', 404);
    const f = giftFields({ kind: cur.kind, name: cur.name, handle: cur.handle, giftedOn: cur.gifted_on, qty: cur.qty, likes: cur.likes, comments: cur.comments, shares: cur.shares, notes: cur.notes, ...b });
    const [r] = await prisma.$queryRawUnsafe<GiftRow[]>(`update crm.mkt_gifts set kind = $2, name = $3, handle = $4, gifted_on = $5::date, qty = $6, likes = $7, comments = $8, shares = $9, notes = $10 where id = $1::uuid
      returning id, kind, name, handle, ${dayText('gifted_on')} as gifted_on, qty, likes, comments, shares, notes`, id, f.kind, f.name, f.handle, f.giftedOn, f.qty, f.likes, f.comments, f.shares, f.notes);
    return toGift(r!);
  });
}
export async function deleteGift(id: unknown): Promise<void> {
  if (!uuidOk(id)) throw new MktError('That was not found.', 404);
  await guard(async () => { const r = await prisma.$queryRaw<{ id: string }[]>`delete from crm.mkt_gifts where id = ${id}::uuid returning id`; if (!r.length) throw new MktError('That was not found.', 404); });
}
export async function listGifts(from: string, to: string): Promise<Gift[]> {
  return (await prisma.$queryRawUnsafe<GiftRow[]>(`${GIFT_SELECT} where gifted_on between $1::date and $2::date order by gifted_on desc, name limit 500`, from, to)).map(toGift);
}

// ---------- the numbers for a period ----------
export type Block = { people: number; qty_gifted_avg: number; interactions_avg: number };
export type IgValues = { account: { reach: number; profile_visits: number; followers_gained: number; views: number; interactions: number; daysWithData: number }; scheduled: { posted: number; interactions: number; profile_activity: number; reached: number }; influencers: Block; horeca: Block };
async function giftBlock(kind: 'influencer' | 'horeca', from: string, to: string): Promise<Block> {
  const [r] = await prisma.$queryRawUnsafe<{ people: number; qty: number; inter: number }[]>(`select count(distinct lower(name))::int as people, coalesce(sum(qty), 0)::int as qty, coalesce(sum(likes + comments + shares), 0)::int as inter from crm.mkt_gifts where kind = $1 and gifted_on between $2::date and $3::date`, kind, from, to);
  const people = r?.people ?? 0;
  return { people, qty_gifted_avg: people ? round1((r!.qty) / people) : 0, interactions_avg: people ? round1((r!.inter) / people) : 0 };
}
export async function igValues(from: string, to: string): Promise<IgValues> {
  const [d] = await prisma.$queryRaw<{ reach: number; visits: number; follows: number; views: number; inter: number; days: number; has_inter: boolean }[]>`
    select coalesce(sum(reach), 0)::int as reach, coalesce(sum(profile_visits), 0)::int as visits, coalesce(sum(followers_gained), 0)::int as follows, coalesce(sum(views), 0)::int as views,
      coalesce(sum(coalesce(likes, 0) + coalesce(comments, 0) + coalesce(shares, 0)), 0)::int as inter, count(*)::int as days, bool_or(likes is not null or comments is not null or shares is not null) as has_inter
    from crm.mkt_ig_daily where day between ${from}::date and ${to}::date`;
  const [p] = await prisma.$queryRawUnsafe<{ posted: number; inter: number; act: number; reach: number }[]>(`select count(*) filter (where status = 'posted')::int as posted,
      coalesce(sum(coalesce(likes, 0) + coalesce(comments, 0) + coalesce(shares, 0)) filter (where status = 'posted'), 0)::int as inter, coalesce(sum(profile_activity) filter (where status = 'posted'), 0)::int as act, coalesce(sum(reach) filter (where status = 'posted'), 0)::int as reach
    from crm.mkt_ig_posts where ${MEL} between $1::date and $2::date`, from, to);
  return {
    account: { reach: d?.reach ?? 0, profile_visits: d?.visits ?? 0, followers_gained: d?.follows ?? 0, views: d?.views ?? 0, interactions: d?.has_inter ? (d.inter ?? 0) : (p?.inter ?? 0), daysWithData: d?.days ?? 0 },
    scheduled: { posted: p?.posted ?? 0, interactions: p?.inter ?? 0, profile_activity: p?.act ?? 0, reached: p?.reach ?? 0 },
    influencers: await giftBlock('influencer', from, to), horeca: await giftBlock('horeca', from, to),
  };
}
export type PostOut = { id: string; at: string; day: string; status: 'posted' | 'scheduled'; kind: string | null; caption: string | null; permalink: string | null; likes: number | null; comments: number | null; shares: number | null; saves: number | null; reach: number | null; profileActivity: number | null; interactions: number; engagement: number | null; source: 'import' | 'manual' };
export async function igPosts(from: string, to: string): Promise<PostOut[]> {
  const rows = await prisma.$queryRawUnsafe<{ id: string; posted_at: Date; day: string; status: 'posted' | 'scheduled'; kind: string | null; caption: string | null; permalink: string | null; likes: number | null; comments: number | null; shares: number | null; saves: number | null; reach: number | null; profile_activity: number | null; source: 'import' | 'manual' }[]>(
    `select id, posted_at, to_char(${MEL}, 'YYYY-MM-DD') as day, status, kind, caption, permalink, likes, comments, shares, saves, reach, profile_activity, source from crm.mkt_ig_posts where ${MEL} between $1::date and $2::date order by posted_at desc limit 500`, from, to);
  return rows.map(r => { const inter = (r.likes ?? 0) + (r.comments ?? 0) + (r.shares ?? 0); return { id: r.id, at: new Date(r.posted_at).toISOString(), day: r.day, status: r.status, kind: r.kind, caption: r.caption, permalink: r.permalink, likes: r.likes, comments: r.comments, shares: r.shares, saves: r.saves, reach: r.reach, profileActivity: r.profile_activity, interactions: inter, engagement: r.reach ? Math.round((inter / r.reach) * 1000) / 10 : null, source: r.source }; });
}
/** What works and what does not: the average result by kind of post, and the best and the weakest posts. Only posts that have already gone out. */
export function compare(posts: PostOut[]): { byKind: { kind: string; posts: number; avgInteractions: number; avgEngagement: number | null }[]; best: PostOut[]; weakest: PostOut[] } {
  const done = posts.filter(p => p.status === 'posted'); const groups = new Map<string, PostOut[]>();
  for (const p of done) groups.set(p.kind ?? 'other', [...(groups.get(p.kind ?? 'other') ?? []), p]);
  const byKind = [...groups.entries()].map(([kind, l]) => { const eng = l.filter(x => x.engagement !== null); return { kind, posts: l.length, avgInteractions: round1(l.reduce((t, x) => t + x.interactions, 0) / l.length), avgEngagement: eng.length ? round1(eng.reduce((t, x) => t + (x.engagement ?? 0), 0) / eng.length) : null }; }).sort((a, b) => b.avgInteractions - a.avgInteractions);
  const ranked = [...done].sort((a, b) => b.interactions - a.interactions);
  return { byKind, best: ranked.slice(0, 3), weakest: done.length >= 6 ? ranked.slice(-3).reverse() : [] };
}
export async function igLastImport(): Promise<{ dailyTo: string | null; postsTo: string | null }> {
  const [r] = await prisma.$queryRaw<{ d: string | null; p: string | null }[]>`select (select to_char(max(day), 'YYYY-MM-DD') from crm.mkt_ig_daily) as d,
    (select to_char((max(posted_at) at time zone 'Australia/Melbourne')::date, 'YYYY-MM-DD') from crm.mkt_ig_posts where status = 'posted') as p`;
  return { dailyTo: r?.d ?? null, postsTo: r?.p ?? null };
}
