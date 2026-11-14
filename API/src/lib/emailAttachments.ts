// Files a rep adds to an email wait here (in the database, for at most a day) until the email is sent or saved as a draft. They are never shown to anyone else.
import { prisma } from './prisma';
import { BLOCKED_FILE, safeFileName, type Attachment } from './emailHtml';

export const MAX_FILE = 10 * 1024 * 1024, MAX_TOTAL = 15 * 1024 * 1024, MAX_FILES = 8;   // Gmail's limit is about 25 MB for the whole email, and the email grows by a third when it is sent
export class AttachError extends Error { status: number; constructor(message: string, status = 400) { super(message); this.status = status; } }
const uuidOk = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const missing = (e: any) => e?.code === '42P01' || (/email_attachments/.test(String(e?.message ?? e)) && /does not exist|relation/i.test(String(e?.message ?? e)));
const NOT_SET_UP = 'Attachments are not set up in the database yet. Ask whoever looks after Radar to run email-attachments.sql.';
export const mb = (n: number) => `${Math.round(n / 104857.6) / 10} MB`;
export type Staged = { id: string; name: string; size: number };

/** Reads a request's body, giving up as soon as it is bigger than `max`. */
export async function readBody(req: AsyncIterable<Uint8Array>, max: number): Promise<Buffer> {
  const parts: Buffer[] = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > max) throw new AttachError(`That file is bigger than ${mb(max)}. Send it another way, or make it smaller.`, 413); parts.push(Buffer.from(c)); }
  return Buffer.concat(parts);
}
export async function stageAttachment(repId: string, rawName: string, rawType: string, data: Buffer): Promise<Staged> {
  const name = safeFileName(rawName);
  if (BLOCKED_FILE.test(name)) throw new AttachError('Gmail does not deliver that kind of file (programs and scripts). Zip it, or send it another way.');
  if (!data.length) throw new AttachError('That file is empty.');
  if (data.length > MAX_FILE) throw new AttachError(`That file is bigger than ${mb(MAX_FILE)}. Send it another way, or make it smaller.`, 413);
  const mime = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(rawType) ? rawType.toLowerCase() : 'application/octet-stream';
  try {
    await prisma.$queryRaw`delete from crm.email_attachments where created_at < now() - interval '24 hours'`;
    const [t] = await prisma.$queryRaw<{ n: number; total: number }[]>`select count(*)::int as n, coalesce(sum(size), 0)::int as total from crm.email_attachments where rep_id = ${repId}::uuid`;
    if ((t?.n ?? 0) >= MAX_FILES) throw new AttachError(`Up to ${MAX_FILES} files on one email.`);
    if ((t?.total ?? 0) + data.length > MAX_TOTAL) throw new AttachError(`Together the files can be up to ${mb(MAX_TOTAL)}. Remove one, or send the big one another way.`, 413);
    const [r] = await prisma.$queryRaw<{ id: string }[]>`insert into crm.email_attachments (rep_id, name, mime, size, data) values (${repId}::uuid, ${name}, ${mime}, ${data.length}, ${data}) returning id`;
    return { id: r!.id, name, size: data.length };
  } catch (e) { if (missing(e)) throw new AttachError(NOT_SET_UP, 503); throw e; }
}
/** The person's own staged files for these ids, in the order asked. A file that is not theirs, or has gone, stops the send with a plain message. */
export async function loadAttachments(repId: string, ids: unknown): Promise<{ list: Attachment[]; ids: string[]; total: number }> {
  if (ids === undefined || ids === null) return { list: [], ids: [], total: 0 };
  if (!Array.isArray(ids) || ids.length > MAX_FILES || !ids.every(uuidOk)) throw new AttachError('Something is wrong with the attachments. Remove them and add them again.');
  if (!ids.length) return { list: [], ids: [], total: 0 };
  try {
    const rows = await prisma.$queryRaw<{ id: string; name: string; mime: string; data: Buffer }[]>`select id, name, mime, data from crm.email_attachments where rep_id = ${repId}::uuid and id = any(${ids}::uuid[])`;
    const by = new Map(rows.map(r => [r.id, r]));
    const list = ids.map(id => { const r = by.get(id); if (!r) throw new AttachError('An attachment is no longer there (they are kept for a day). Add it again.', 409); return { name: r.name, mime: r.mime, data: Buffer.from(r.data) }; });
    return { list, ids, total: list.reduce((t, a) => t + a.data.length, 0) };
  } catch (e) { if (missing(e)) throw new AttachError(NOT_SET_UP, 503); throw e; }
}
export async function removeAttachment(repId: string, id: unknown): Promise<void> {
  if (!uuidOk(id)) throw new AttachError('That file was not found.', 404);
  try { await prisma.$queryRaw`delete from crm.email_attachments where id = ${id}::uuid and rep_id = ${repId}::uuid`; } catch (e) { if (missing(e)) throw new AttachError(NOT_SET_UP, 503); throw e; }
}
export async function forgetAttachments(repId: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  try { await prisma.$queryRaw`delete from crm.email_attachments where rep_id = ${repId}::uuid and id = any(${ids}::uuid[])`; } catch { /* they are cleared after a day anyway */ }
}
