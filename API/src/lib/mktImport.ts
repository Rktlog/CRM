// Reading Meta's Instagram reports (CSV files a manager imports by hand, about once a month). Pure: no database. Tested in scripts/test-mkt.ts.
// Dates written with slashes are read the Australian way (day first). A file can have the columns in any order and any capitals; columns it does not have are left alone.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], cell = '', quoted = false;
  const s = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) { if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += c; }
    else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some(x => x.trim() !== '')) rows.push(row); row = []; }
    else cell += c;
  }
  row.push(cell); if (row.some(x => x.trim() !== '')) rows.push(row);
  return rows;
}
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const real = (y: number, mo: number, d: number): string | null => { const t = new Date(Date.UTC(y, mo - 1, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? t.toISOString().slice(0, 10) : null; };
/** A day from the usual ways Meta and Excel write one: 2026-10-05, 2026-10-05T14:30:00, 5/10/2026 (day first), 05-10-2026, 5 Oct 2026, Oct 5, 2026. Anything else (or an impossible day) gives null. */
export function parseDay(raw: unknown): string | null {
  const s = String(raw ?? '').trim(); if (!s) return null;
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T ].*)?$/); if (m) return real(+m[1]!, +m[2]!, +m[3]!);
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:[T ,].*)?$/); if (m) return real(+m[3]!, +m[2]!, +m[1]!);
  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?,?\s+(\d{4})/); if (m) { const mo = MONTHS.indexOf(m[2]!.toLowerCase()); return mo < 0 ? null : real(+m[3]!, mo + 1, +m[1]!); }
  m = s.match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/); if (m) { const mo = MONTHS.indexOf(m[1]!.toLowerCase()); return mo < 0 ? null : real(+m[3]!, mo + 1, +m[2]!); }
  return null;
}
/** A moment, for a post: the day plus the time if there is one (read as Melbourne time). null if there is no real day. */
export function parseMoment(raw: unknown): string | null {
  const day = parseDay(raw); if (!day) return null;
  const t = String(raw).match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?/i);
  let h = t ? +t[1]! : 12, mi = t ? +t[2]! : 0;
  if (t?.[4]) { const pm = t[4].toLowerCase() === 'pm'; if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12; }
  if (h > 23 || mi > 59) { h = 12; mi = 0; }
  return `${day}T${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:00+11:00`;
}
/** A count from a cell: "1,234" is 1234, blank or text is null (not reported), never negative or fractional. */
export function parseCount(raw: unknown): number | null {
  const s = String(raw ?? '').replace(/[,\s]/g, ''); if (s === '' || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Math.round(Number(s)); return n < 0 || n > 2_000_000_000 ? null : n;
}
const key = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const ALIASES: Record<string, string[]> = {
  day: ['date', 'day', 'date range', 'end date'], reach: ['reach', 'accounts reached', 'accounts reached total'], profile_visits: ['profile visits', 'profile activity', 'profile views', 'visits'],
  followers_gained: ['follows', 'new followers', 'followers gained', 'follower gains', 'followers'], views: ['views', 'impressions', 'plays'], likes: ['likes', 'like'], comments: ['comments', 'comment'], shares: ['shares', 'share'], saves: ['saves', 'save'],
  postedAt: ['publish time', 'published', 'posted', 'post time', 'date published', 'publish date', 'date'], caption: ['description', 'caption', 'post caption', 'title'], permalink: ['permalink', 'post link', 'url', 'link'], kind: ['post type', 'type', 'media type'],
};
const find = (headers: string[], names: string[]): number => { const k = headers.map(key); for (const n of names) { const i = k.indexOf(n); if (i >= 0) return i; } return -1; };
export type DailyRow = { day: string; reach: number | null; profile_visits: number | null; followers_gained: number | null; views: number | null; likes: number | null; comments: number | null; shares: number | null; saves: number | null };
export const DAILY_FIELDS = ['reach', 'profile_visits', 'followers_gained', 'views', 'likes', 'comments', 'shares', 'saves'] as const;
export type DailyField = typeof DAILY_FIELDS[number];
/** A daily report. Either several named columns (Date, Reach, Profile visits...) or Meta's two-column export (Date, Primary) with `metric` saying which number it is. */
export function parseDailyReport(text: string, metric?: string): { rows: DailyRow[]; problems: string[] } {
  const table = parseCsv(text); const problems: string[] = [];
  if (table.length < 2) return { rows: [], problems: ['The file has no rows.'] };
  const head = table[0]!, di = find(head, ALIASES.day!);
  if (di < 0) return { rows: [], problems: ['No Date column was found.'] };
  const cols = DAILY_FIELDS.map(f => [f, find(head, ALIASES[f]!)] as const).filter(([, i]) => i >= 0);
  const primary = find(head, ['primary', 'value', 'count']);
  const byDay = new Map<string, DailyRow>();
  const useMetric = cols.length === 0 && primary >= 0;
  if (useMetric && !(DAILY_FIELDS as readonly string[]).includes(metric ?? '')) return { rows: [], problems: ['This file has one number per day. Say which number it is (reach, profile visits, followers gained, views...).'] };
  if (cols.length === 0 && primary < 0) return { rows: [], problems: ['No numbers were found. The columns should be named like Reach, Profile visits, Follows, Views, Likes, Comments, Shares or Saves.'] };
  for (let r = 1; r < table.length; r++) {
    const row = table[r]!, day = parseDay(row[di]);
    if (!day) { problems.push(`Row ${r + 1}: "${row[di] ?? ''}" is not a date.`); continue; }
    const cur = byDay.get(day) ?? { day, reach: null, profile_visits: null, followers_gained: null, views: null, likes: null, comments: null, shares: null, saves: null };
    if (useMetric) { const v = parseCount(row[primary]); if (v !== null) (cur as any)[metric!] = ((cur as any)[metric!] ?? 0) + v; }
    else for (const [f, i] of cols) { const v = parseCount(row[i]); if (v !== null) (cur as any)[f] = ((cur as any)[f] ?? 0) + v; }
    byDay.set(day, cur);
  }
  return { rows: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)), problems: problems.slice(0, 10) };
}
export type PostRow = { postedAt: string; kind: string | null; caption: string | null; permalink: string | null; likes: number | null; comments: number | null; shares: number | null; saves: number | null; reach: number | null; profile_activity: number | null };
/** A posts report (one row per post). A row needs a date; the link is what makes importing the same post again update it instead of adding it twice. */
export function parsePostsReport(text: string): { rows: PostRow[]; problems: string[] } {
  const table = parseCsv(text); const problems: string[] = [];
  if (table.length < 2) return { rows: [], problems: ['The file has no rows.'] };
  const head = table[0]!, idx = { at: find(head, ALIASES.postedAt!), cap: find(head, ALIASES.caption!), link: find(head, ALIASES.permalink!), kind: find(head, ALIASES.kind!), likes: find(head, ALIASES.likes!), comments: find(head, ALIASES.comments!), shares: find(head, ALIASES.shares!), saves: find(head, ALIASES.saves!), reach: find(head, ALIASES.reach!), act: find(head, ['profile activity', 'profile visits']) };
  if (idx.at < 0) return { rows: [], problems: ['No publish date column was found (it should be called Publish time or Date).'] };
  if ([idx.likes, idx.comments, idx.shares, idx.saves, idx.reach, idx.act].every(i => i < 0)) return { rows: [], problems: ['No numbers were found. The columns should be named like Likes, Comments, Shares, Saves, Reach or Profile activity.'] };
  const seen = new Set<string>(), rows: PostRow[] = [];
  const get = (row: string[], i: number) => (i >= 0 ? row[i] : undefined);
  for (let r = 1; r < table.length; r++) {
    const row = table[r]!, at = parseMoment(row[idx.at]);
    if (!at) { problems.push(`Row ${r + 1}: "${row[idx.at] ?? ''}" is not a date.`); continue; }
    const link = (get(row, idx.link) ?? '').trim() || null; if (link && !/^https?:\/\//i.test(link)) { problems.push(`Row ${r + 1}: the link is not a web address.`); continue; }
    if (link && seen.has(link.toLowerCase())) continue; if (link) seen.add(link.toLowerCase());
    rows.push({ postedAt: at, kind: (get(row, idx.kind) ?? '').trim().toLowerCase().slice(0, 30) || null, caption: (get(row, idx.cap) ?? '').trim().slice(0, 500) || null, permalink: link,
      likes: parseCount(get(row, idx.likes)), comments: parseCount(get(row, idx.comments)), shares: parseCount(get(row, idx.shares)), saves: parseCount(get(row, idx.saves)), reach: parseCount(get(row, idx.reach)), profile_activity: parseCount(get(row, idx.act)) });
  }
  return { rows, problems: problems.slice(0, 10) };
}
