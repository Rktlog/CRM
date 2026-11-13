// Moves the OLD visit photos (kept in Supabase's photo storage and pointed to by a log entry's photo address) into the company Dropbox, one by one.
// - The Supabase originals are never touched: the job only reads them. The log entry keeps its old address; the account page shows the Dropbox copy once and hides the duplicate.
// - Each photo is copied into its customer's Dropbox folder (made if needed), linked to the same log entry and the same rep, dated as the visit was. A photo is moved once (the old address is remembered).
// - Safe by design: a log entry's photo address can be anything a person typed, so ONLY photos in this project's own Supabase photo storage are ever downloaded. Nothing else is fetched, and redirects are refused.
// - A photo that cannot be moved is retried on the next run, up to three times, with the reason kept; one that never can be (gone, not a picture, too big, not ours) is set aside at once.
import { prisma } from './prisma';
import * as dbx from './dropbox';
import { accessToken, ensureFolder, MediaError } from './media';

export const PER_RUN = 20;
export const MAX_TRIES = 3;
const tableMissing = (e: any) => e?.code === '42P01' || e?.code === '42703' || (/photo_move_fails|source_url/.test(String(e?.message ?? e)) && /does not exist|relation|column/i.test(String(e?.message ?? e)));

/** The address as a URL if (and only if) it is a public photo in THIS project's Supabase storage. */
export function ownPhotoUrl(raw: unknown, supabaseUrl: string | undefined): URL | null {
  if (typeof raw !== 'string' || !supabaseUrl) return null;
  let u: URL, base: URL;
  try { u = new URL(raw); base = new URL(supabaseUrl); } catch { return null; }
  if (u.origin !== base.origin || u.username || u.password) return null;
  return u.pathname.startsWith('/storage/v1/object/public/') ? u : null;
}
/** The file's own name, from the end of its address (the picture's name in storage). */
export function sourceName(u: URL): string { const last = u.pathname.split('/').pop() ?? ''; try { return decodeURIComponent(last); } catch { return last; } }
const stampOf = (d: Date) => d.toLocaleString('sv-SE', { timeZone: 'Australia/Melbourne' }).replace(/:/g, '').slice(0, 17);   // 2025-06-03 101500

export type MoveResult = { moved: number; failed: number; remaining: number; givenUp: number; stopped: string | null };
type Row = { id: string; account_id: string; rep_id: string; photo_url: string; occurred_at: Date };
class Permanent extends Error {}
async function* chunks(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const r = body.getReader();
  try { for (;;) { const { done, value } = await r.read(); if (done) return; if (value) yield value; } } finally { r.releaseLock?.(); }
}
const ELIGIBLE = `ac.photo_url is not null and not exists (select 1 from crm.media m where m.source_url = ac.photo_url)
  and coalesce((select f.attempts from crm.photo_move_fails f where f.activity_id = ac.id), 0) < ${MAX_TRIES}`;

async function fail(id: string, why: string, permanent: boolean) {
  await prisma.$queryRaw`insert into crm.photo_move_fails (activity_id, attempts, last_error) values (${id}::uuid, ${permanent ? MAX_TRIES : 1}, ${why.slice(0, 200)})
    on conflict (activity_id) do update set attempts = case when ${permanent} then ${MAX_TRIES} else crm.photo_move_fails.attempts + 1 end, last_error = excluded.last_error, last_attempt = now()`;
}
async function moveOne(r: Row, token: string, supabaseUrl: string, doFetch: typeof fetch): Promise<'moved' | 'already'> {
  const u = ownPhotoUrl(r.photo_url, supabaseUrl);
  if (!u) throw new Permanent('The photo is not in this project\'s own photo storage, so it was not downloaded.');
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 20_000);
  let saved: dbx.Saved | null = null;
  try {
    let res: Response;
    try { res = await doFetch(u.href, { signal: ctl.signal, redirect: 'error' }); } catch (e) { throw new Error(`Could not download it (${String((e as Error)?.message ?? e).slice(0, 60)}).`); }
    if (res.status === 404 || res.status === 400 || res.status === 403) throw new Permanent(`The photo is no longer in Supabase (it answered ${res.status}).`);
    if (!res.ok || !res.body) throw new Error(`Supabase answered ${res.status}.`);
    const name = sourceName(u), k = dbx.mediaKind(res.headers.get('content-type'), name);
    if (!k || k.kind !== 'photo') throw new Permanent('That address is not a photo.');
    const len = Number(res.headers.get('content-length'));
    if (Number.isFinite(len) && len > dbx.MAX_PHOTO) throw new Permanent('That photo is too big to move (30 MB at most).');
    // The whole photo is downloaded (30 MB at most, in memory, one at a time) BEFORE any folder is made, so a photo that is empty, too big or cut off never leaves a folder behind.
    const parts: Uint8Array[] = []; let have = 0;
    try { for await (const c of chunks(res.body)) { have += c.length; if (have > dbx.MAX_PHOTO) throw new Permanent('That photo is too big to move (30 MB at most).'); parts.push(c); } }
    catch (e) { if (e instanceof Permanent) throw e; throw new Error(`The download was cut off (${String((e as Error)?.message ?? e).slice(0, 60)}).`); }
    clearTimeout(timer);
    if (have === 0) throw new Permanent('That photo is empty.');
    const bytes = Buffer.concat(parts);
    const folder = await ensureFolder(r.account_id, token);
    const { stem, ext } = dbx.fileParts(name, k.mime);
    async function* whole(): AsyncGenerator<Uint8Array> { yield bytes; }
    try { saved = await dbx.saveFromStream(token, `${folder}/${stampOf(new Date(r.occurred_at))} ${stem}${ext}`, whole(), dbx.MAX_PHOTO); }
    catch (e) { if (e instanceof dbx.DropboxError && (e.code === 'too_large' || e.code === 'empty')) throw new Permanent(e.code === 'empty' ? 'That photo is empty.' : 'That photo is too big to move (30 MB at most).'); throw e; }
    const done = await prisma.$queryRaw<{ id: string }[]>`
      insert into crm.media (account_id, activity_id, uploaded_by, kind, name, mime, size, dropbox_id, dropbox_path, created_at, source_url)
      values (${r.account_id}::uuid, ${r.id}::uuid, ${r.rep_id}::uuid, 'photo', ${saved.name}, ${k.mime}, ${saved.size}, ${saved.id}, ${saved.path}, ${new Date(r.occurred_at)}::timestamp, ${r.photo_url})
      on conflict (source_url) where source_url is not null do nothing returning id`;
    if (!done.length) { await dbx.deleteFile(token, saved.path).catch(() => undefined); return 'already'; }   // another run moved it a moment ago: take the second copy back out
    await prisma.$queryRaw`delete from crm.photo_move_fails where activity_id = ${r.id}::uuid`;
    return 'moved';
  } catch (e) {
    if (saved && !(e instanceof Permanent)) { /* saved in Dropbox but not recorded: take it back out so nothing is left unaccounted for */ await dbx.deleteFile(token, saved.path).catch(() => undefined); }
    throw e;
  } finally { clearTimeout(timer); }
}
/** Moves up to `limit` photos. Run it again until nothing is left to move. */
export async function movePhotos(o: { limit?: number; budgetMs?: number; fetchImpl?: typeof fetch } = {}): Promise<MoveResult> {
  const out: MoveResult = { moved: 0, failed: 0, remaining: 0, givenUp: 0, stopped: null };
  const supabaseUrl = process.env.SUPABASE_URL, until = Date.now() + (o.budgetMs ?? 25_000), doFetch = o.fetchImpl ?? fetch;
  if (!supabaseUrl) return { ...out, stopped: 'SUPABASE_URL is not set on the API' };
  try {
    let token: string;
    try { token = await accessToken(); } catch (e) { return { ...out, stopped: e instanceof MediaError ? e.message : 'Dropbox would not answer' }; }
    const rows = await prisma.$queryRawUnsafe<Row[]>(`select ac.id, ac.account_id, ac.rep_id, ac.photo_url, ac.occurred_at from crm.activity ac join crm.accounts a on a.id = ac.account_id where ${ELIGIBLE} order by ac.occurred_at, ac.id limit $1::int`, o.limit ?? PER_RUN);
    for (const r of rows) {
      if (Date.now() > until) { out.stopped = 'out of time for this run: run it again for the rest'; break; }
      try { const x = await moveOne(r, token, supabaseUrl, doFetch); if (x === 'moved') out.moved++; }
      catch (e) {
        out.failed++; const perm = e instanceof Permanent;
        await fail(r.id, String((e as Error)?.message ?? e), perm);
        if (!perm) console.error('photo move failed', String((e as Error)?.message ?? e).slice(0, 120));
        if (e instanceof dbx.DropboxError && (e.status === 401 || e.status === 429)) { out.stopped = e.status === 429 ? 'Dropbox asked to slow down: run it again in a few minutes' : 'Dropbox no longer accepts the connection'; break; }
      }
    }
    const [n] = await prisma.$queryRawUnsafe<{ left: number; gave: number }[]>(`select count(*) filter (where ${ELIGIBLE})::int as "left",
      count(*) filter (where ac.photo_url is not null and not exists (select 1 from crm.media m where m.source_url = ac.photo_url) and coalesce((select f.attempts from crm.photo_move_fails f where f.activity_id = ac.id), 0) >= ${MAX_TRIES})::int as gave
      from crm.activity ac join crm.accounts a on a.id = ac.account_id`);
    return { ...out, remaining: n?.left ?? 0, givenUp: n?.gave ?? 0 };
  } catch (e) { if (tableMissing(e)) return { ...out, stopped: 'not set up in the database yet (run move-photos.sql)' }; throw e; }
}
