import * as XLSX from 'xlsx';
import { randomUUID } from 'crypto';
import type Anthropic from '@anthropic-ai/sdk';

// Files in and out of the assistant.
//   In:  what the person attaches. Images and PDFs go to Claude as they are. Spreadsheets, CSV and text are turned into
//        text first. Word files are read if the optional `mammoth` package is installed.
//   Out: reports the assistant creates (Excel, CSV). They are kept in memory for 30 minutes, only for the person who
//        asked, so nothing is left on disk or in the database.
export type Attachment = { name: string; type: string; data: string };   // data is base64
export type Kind = 'image' | 'pdf' | 'sheet' | 'text' | 'word';

export const MAX_FILES = 5;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_CHARS = 150_000;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const IMAGE_EXT: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };

const ext = (n: string) => (n.toLowerCase().split('.').pop() ?? '');
export function kindOf(a: { name: string; type: string }): Kind | null {
  const t = (a.type || '').toLowerCase(), e = ext(a.name);
  if (IMAGE_TYPES.includes(t) || IMAGE_EXT[e]) return 'image';   // some browsers send no type for a dropped file, so the ending counts too
  if (t === 'application/pdf' || e === 'pdf') return 'pdf';
  if (['xlsx', 'xls', 'xlsm'].includes(e) || t.includes('spreadsheetml') || t === 'application/vnd.ms-excel') return 'sheet';
  if (['csv', 'tsv', 'txt', 'md', 'json'].includes(e) || t.startsWith('text/')) return 'text';
  if (e === 'docx' || t.includes('wordprocessingml')) return 'word';
  return null;
}
const bytesOf = (a: Attachment) => Math.floor((a.data.length * 3) / 4);

// null = fine, otherwise what to tell the person.
export function checkAttachments(list: Attachment[]): string | null {
  if (list.length > MAX_FILES) return `Attach up to ${MAX_FILES} files at a time.`;
  let total = 0;
  for (const a of list) {
    if (!a || typeof a.name !== 'string' || typeof a.data !== 'string' || !a.data) return 'One of the files did not arrive properly. Attach it again.';
    if (!kindOf(a)) return `${a.name}: that kind of file can't be read. Use a PDF, image, Excel, CSV, text or Word file.`;
    const b = bytesOf(a);
    if (b > MAX_FILE_BYTES) return `${a.name} is over ${MAX_FILE_BYTES / 1024 / 1024} MB.`;
    total += b;
  }
  if (total > MAX_TOTAL_BYTES) return `Those files add up to more than ${MAX_TOTAL_BYTES / 1024 / 1024} MB. Attach fewer or smaller files.`;
  return null;
}

const clip = (s: string) => (s.length > MAX_TEXT_CHARS ? `${s.slice(0, MAX_TEXT_CHARS)}\n…(cut: the file is longer than I can read at once)` : s);
export function sheetText(buf: Buffer): string {
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
  return clip(wb.SheetNames.slice(0, 10).map(n => {
    const lines = XLSX.utils.sheet_to_csv(wb.Sheets[n], { blankrows: false }).split('\n');
    const more = lines.length > 2001;
    return `--- Sheet: ${n} (${Math.max(lines.length - 1, 0)} rows${more ? ', first 2000 shown' : ''}) ---\n${lines.slice(0, 2001).join('\n')}`;
  }).join('\n\n'));
}

async function wordText(buf: Buffer): Promise<string> {
  let mammoth: any;
  try { const name = 'mammoth'; mammoth = await import(name); }
  catch { throw new Error('Word files need one more package on the API (npm install mammoth). Until then, save the file as a PDF and attach that.'); }
  return clip((await (mammoth.default ?? mammoth).extractRawText({ buffer: buf })).value ?? '');
}

// The pieces of a message that carry the files, in the shape the Messages API takes.
export async function attachmentBlocks(list: Attachment[]): Promise<Anthropic.ContentBlockParam[]> {
  const out: Anthropic.ContentBlockParam[] = [];
  for (const a of list) {
    const kind = kindOf(a)!;
    const buf = Buffer.from(a.data, 'base64');
    if (kind === 'image') {
      out.push({ type: 'text', text: `Attached image: ${a.name}` });
      out.push({ type: 'image', source: { type: 'base64', media_type: (IMAGE_TYPES.includes(a.type.toLowerCase()) ? a.type.toLowerCase() : IMAGE_EXT[ext(a.name)]) as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp', data: a.data } });
    } else if (kind === 'pdf') {
      out.push({ type: 'document', title: a.name, source: { type: 'base64', media_type: 'application/pdf', data: a.data } });
    } else {
      const body = kind === 'sheet' ? sheetText(buf) : kind === 'word' ? await wordText(buf) : clip(buf.toString('utf8'));
      out.push({ type: 'text', text: `Attached file "${a.name}":\n${body}` });
    }
  }
  return out;
}

// ---- Files the assistant makes ----
type Stored = { repId: string; name: string; mime: string; buffer: Buffer; expires: number };
const store = new Map<string, Stored>();
const TTL_MS = 30 * 60 * 1000, MAX_STORE_BYTES = 150 * 1024 * 1024;

function purge(now = Date.now()) {
  for (const [id, f] of store) if (f.expires <= now) store.delete(id);
  let total = [...store.values()].reduce((s, f) => s + f.buffer.length, 0);
  for (const [id, f] of store) { if (total <= MAX_STORE_BYTES) break; total -= f.buffer.length; store.delete(id); }   // oldest first
}
export function saveFile(repId: string, f: { name: string; mime: string; buffer: Buffer }, now = Date.now()) {
  purge(now);
  const id = randomUUID();
  store.set(id, { repId, name: f.name, mime: f.mime, buffer: f.buffer, expires: now + TTL_MS });
  return { id, name: f.name, size: f.buffer.length };
}
export function takeFile(repId: string, id: string, now = Date.now()): { name: string; mime: string; buffer: Buffer } | null {
  purge(now);
  const f = store.get(id);
  return f && f.repId === repId ? f : null;   // somebody else's file looks the same as no file
}

export type OutFormat = 'xlsx' | 'csv' | 'docx' | 'pdf';
export const safeFilename = (raw: unknown, format: OutFormat) => {
  const base = String(raw ?? 'report').replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/[^A-Za-z0-9 _-]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'report';
  return `${base}.${format}`;
};

// A CSV that is safe to open in Excel: a cell that starts with = + - or @ would be run as a formula.
export function toCsv(header: string[], rows: unknown[][]): string {
  const cell = (v: unknown) => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header, ...rows].map(r => r.map(cell).join(',')).join('\r\n');
}