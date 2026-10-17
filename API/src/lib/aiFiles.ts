import * as XLSX from 'xlsx';
import { prisma } from './prisma';
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

// ---- Reading an attached spreadsheet or CSV as a table (a supplier price list, say) ----
export type Table = { file: string; sheet: string; sheets: string[]; headerRow: number; headers: string[]; rows: Record<string, unknown>[]; truncated: boolean };
export class TableError extends Error {}

// A number typed the way people type money: $1,234.50, 12.5%, (45.00), "AUD 8.40". NaN if it is not a number.
export function parseNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (v == null) return NaN;
  let t = String(v).trim(); if (!t) return NaN;
  const neg = /^\(.*\)$/.test(t) || /^-/.test(t);
  t = t.replace(/^[-(]+|[)]+$/g, '').replace(/[A-Za-z$€£¥%\s]/g, '');
  if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');   // 1.234,50 (European)
  else if (/^\d+,\d{1,2}$/.test(t) && !t.includes('.')) t = t.replace(',', '.');                   // 12,50
  else t = t.replace(/,/g, '');
  const n = Number(t); return Number.isFinite(n) && /\d/.test(t) ? (neg ? -n : n) : NaN;
}

// The header is the first of the top rows that looks like column names: several text cells, mostly text.
function headerIndex(aoa: unknown[][]): number {
  for (let i = 0; i < Math.min(aoa.length, 20); i++) {
    const cells = aoa[i].filter(c => c !== null && c !== undefined && String(c).trim() !== '');
    if (cells.length >= 2 && cells.filter(c => typeof c === 'string' && Number.isNaN(parseNumber(c))).length / cells.length >= 0.6 && aoa.slice(i + 1, i + 4).some(r => r.some(c => c !== null && String(c).trim() !== ''))) return i;
  }
  return 0;
}

export function readTable(a: Attachment, sheetName?: string): Table {
  const kind = kindOf(a);
  if (kind !== 'sheet' && kind !== 'text') throw new TableError(`${a.name} is not a spreadsheet or CSV. For a PDF or image, read it and pass the rows yourself.`);
  let wb: XLSX.WorkBook;
  try { wb = XLSX.read(Buffer.from(a.data, 'base64'), { type: 'buffer', cellDates: true }); } catch { throw new TableError(`${a.name} could not be read as a table.`); }
  const sheets = wb.SheetNames; if (!sheets.length) throw new TableError(`${a.name} has no sheets.`);
  const wanted = sheetName ? sheets.find(n => n.toLowerCase() === sheetName.toLowerCase()) ?? sheets.find(n => n.toLowerCase().includes(sheetName.toLowerCase())) : sheets.find(n => (XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, blankrows: false }) as unknown[][]).length > 0);
  if (!wanted) throw new TableError(sheetName ? `${a.name} has no sheet called "${sheetName}". Its sheets are: ${sheets.join(', ')}.` : `${a.name} has nothing in it.`);
  const aoa = (XLSX.utils.sheet_to_json(wb.Sheets[wanted], { header: 1, raw: true, defval: null, blankrows: false }) as unknown[][]).filter(r => r.some(c => c !== null && String(c).trim() !== ''));
  if (!aoa.length) throw new TableError(`The sheet "${wanted}" is empty.`);
  const hi = headerIndex(aoa), seen = new Map<string, number>();
  const headers = aoa[hi].map((c, i) => { let h = c == null || String(c).trim() === '' ? `Column ${i + 1}` : String(c).trim(); const n = (seen.get(h.toLowerCase()) ?? 0) + 1; seen.set(h.toLowerCase(), n); return n > 1 ? `${h} (${n})` : h; });
  const MAX = 20000, body = aoa.slice(hi + 1), rows = body.slice(0, MAX).map(r => Object.fromEntries(headers.map((h, i) => [h, r[i] instanceof Date ? (r[i] as Date).toISOString().slice(0, 10) : r[i] ?? null])));
  return { file: a.name, sheet: wanted, sheets, headerRow: hi + 1, headers, rows, truncated: body.length > MAX };
}

// ---- Files the assistant makes ----
// Kept in the database for 30 days, only for the person who asked, so a saved chat can still offer its downloads. Up to
// 300 MB per person; the oldest go first.
const MAX_PER_PERSON = 300 * 1024 * 1024;

export async function saveFile(repId: string, f: { name: string; mime: string; buffer: Buffer }): Promise<{ id: string; name: string; size: number }> {
  const [row] = await prisma.$queryRaw<{ id: string }[]>`insert into crm.ai_files (rep_id, name, mime, data, size) values (${repId}::uuid, ${f.name}, ${f.mime}, ${f.buffer}, ${f.buffer.length}) returning id`;
  await prisma.$queryRaw`delete from crm.ai_files where rep_id = ${repId}::uuid and created_at < now() - interval '30 days'`;
  await prisma.$queryRaw`
    delete from crm.ai_files where rep_id = ${repId}::uuid and id in (
      select id from (select id, sum(size) over (order by created_at desc, id) as running from crm.ai_files where rep_id = ${repId}::uuid) t where running > ${MAX_PER_PERSON})`;
  return { id: row.id, name: f.name, size: f.buffer.length };
}
export async function takeFile(repId: string, id: string): Promise<{ name: string; mime: string; buffer: Buffer } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [r] = await prisma.$queryRaw<{ name: string; mime: string; data: Uint8Array }[]>`select name, mime, data from crm.ai_files where id = ${id}::uuid and rep_id = ${repId}::uuid and created_at > now() - interval '30 days'`;
  return r ? { name: r.name, mime: r.mime, buffer: Buffer.from(r.data) } : null;   // somebody else's file looks the same as no file
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