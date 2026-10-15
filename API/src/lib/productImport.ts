import * as XLSX from 'xlsx';
import ExcelJS from 'exceljs';

// Product status labels, ETA dates and photo links, set by hand or in bulk from a spreadsheet.
// Everything else about a product (name, brand, stock, prices) comes from DEAR through the product sync.
//
// File: one row per product. Columns SKU, Product name, Image link, Status, ETA (found by their headings, in any
// order, other columns ignored).
//   Product name  for reading only. DEAR's name stands.
//   Image link    blank = leave the photo as it is. Never wipes a photo.
//   Status        blank = no status. If the file has no Status column at all, statuses are left alone.
//   ETA           the date the next delivery should arrive. Blank = no ETA of your own (DEAR's date on an incoming
//                 order shows instead). If the file has no ETA column at all, ETAs are left alone.

export const PRODUCT_STATUSES = [
  { key: 'eol', label: 'EOL', meaning: 'End of line: being cleared, will not be reordered' },
  { key: 'discontinued', label: 'Discontinued', meaning: 'No longer available' },
  { key: 'preorder', label: 'Pre-order', meaning: 'Not in stock yet, taking orders' },
  { key: 'new', label: 'New', meaning: 'New to the range' },
] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number]['key'];
export const isStatusKey = (v: unknown): v is ProductStatus => PRODUCT_STATUSES.some(s => s.key === v);
export const statusLabel = (k: ProductStatus | null) => PRODUCT_STATUSES.find(s => s.key === k)?.label ?? '';
export const MAX_IMPORT_CHANGES = 5000;

// What someone typed -> a status key, null for blank, 'invalid' for anything else.
export function parseStatus(text: string): ProductStatus | null | 'invalid' {
  const n = text.toLowerCase().replace(/[^a-z]/g, '');
  if (!n) return null;
  if (n.startsWith('eol') || n.startsWith('endofl')) return 'eol';
  if (n.startsWith('disc')) return 'discontinued';
  if (n.startsWith('preorder')) return 'preorder';
  if (n === 'new') return 'new';
  return 'invalid';
}

// ---- Dates: YYYY-MM-DD, 21/10/2026 (day first), 21 Oct 2026, or an Excel date number ----
const pad = (n: number) => String(n).padStart(2, '0');
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function validDay(y: number, m: number, d: number): string | null {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null;
}
const fullYear = (y: number) => (y < 100 ? 2000 + y : y);
// A day as a text, from what a spreadsheet cell holds. null = blank, 'invalid' = not a date.
export function parseDay(text: string): string | null | 'invalid' {
  const t = text.trim();
  if (!t) return null;
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/);
  if (m) return validDay(+m[1], +m[2], +m[3]) ?? 'invalid';
  m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
  if (m) return validDay(fullYear(+m[3]), +m[2], +m[1]) ?? 'invalid';
  m = t.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{2}|\d{4})$/);
  if (m) { const mi = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()); return mi >= 0 ? validDay(fullYear(+m[3]), mi + 1, +m[1]) ?? 'invalid' : 'invalid'; }
  if (/^\d{5}$/.test(t)) { const d = new Date(Date.UTC(1899, 11, 30) + Number(t) * 86400000); return d.toISOString().slice(0, 10); }
  return 'invalid';
}

export type ImportRow = { row: number; sku: string; name: string; image: string; status: string; eta: string };
export type ParsedFile = { rows: ImportRow[]; hasStatus: boolean; hasImage: boolean; hasEta: boolean };

const norm = (v: unknown) => String(v ?? '').toLowerCase().replace(/[^a-z]/g, '');
// A cell as text. A real date becomes its day (rounded to the nearest day so a time-zone wobble can't shift it).
const cell = (v: unknown) => {
  if (v == null) return '';
  if (v instanceof Date) return new Date(Math.round(v.getTime() / 86400000) * 86400000).toISOString().slice(0, 10);
  return String(v).trim();
};

// Reads the first sheet named Products (or the first sheet) from an .xlsx or .csv, sent as base64.
export function parseFile(base64: string): ParsedFile {
  if (!base64.trim()) throw new Error('The file is empty');
  let wb: XLSX.WorkBook;
  try { wb = XLSX.read(Buffer.from(base64.trim(), 'base64'), { type: 'buffer', cellDates: true }); }
  catch { throw new Error("Couldn't open that file. Use the template (.xlsx) or a .csv"); }
  const name = wb.SheetNames.find(n => n.toLowerCase() === 'products') ?? wb.SheetNames[0];
  if (!name) throw new Error('The file has no sheets');
  const grid = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, defval: '', raw: true, blankrows: false });

  const headAt = grid.slice(0, 15).findIndex(r => r.some(c => norm(c) === 'sku'));
  if (headAt < 0) throw new Error("Couldn't find a SKU column. Start from the template.");
  const head = grid[headAt].map(norm);
  const col = (test: (h: string) => boolean) => head.findIndex(test);
  const iSku = col(h => h === 'sku');
  const iName = col(h => ['productname', 'product', 'name', 'description'].includes(h));
  const iImage = col(h => ['imagelink', 'image', 'imageurl', 'photo', 'photolink', 'link'].includes(h));
  const iStatus = col(h => ['status', 'label', 'lifecycle'].includes(h));
  const iEta = col(h => h.startsWith('eta') || h === 'expected' || h === 'nextarrival');

  const rows: ImportRow[] = [];
  grid.slice(headAt + 1).forEach((r, k) => {
    const sku = cell(r[iSku]);
    const image = iImage >= 0 ? cell(r[iImage]) : '';
    const status = iStatus >= 0 ? cell(r[iStatus]) : '';
    const eta = iEta >= 0 ? cell(r[iEta]) : '';
    if (!sku && !image && !status && !eta) return;          // blank line
    if (/^example/i.test(sku)) return;                      // the example row in the blank template
    rows.push({ row: headAt + k + 2, sku, name: iName >= 0 ? cell(r[iName]) : '', image, status, eta });
  });
  return { rows, hasStatus: iStatus >= 0, hasImage: iImage >= 0, hasEta: iEta >= 0 };
}

export type CurrentProduct = { sku: string; name: string; imageUrl: string | null; lifecycle: string | null; eta: string | null };
export type Change = {
  sku: string; name: string;
  image?: { from: string | null; to: string };
  status?: { from: ProductStatus | null; to: ProductStatus | null };
  eta?: { from: string | null; to: string | null };
};
export type Plan = {
  counts: { rows: number; matched: number; toUpdate: number; unchanged: number; notFound: number; problems: number; statusesSet: number; statusesCleared: number; imagesSet: number; etasSet: number; etasCleared: number; nameDiffers: number };
  changes: Change[];
  problems: { row: number; sku: string; message: string }[];
};

// What the file would change, without changing anything.
export function planImport(file: ParsedFile, products: CurrentProduct[]): Plan {
  const exact = new Map(products.map(p => [p.sku, p]));
  const lower = new Map(products.map(p => [p.sku.toLowerCase(), p]));
  const seen = new Map<string, number>();
  const changes: Change[] = [];
  const problems: Plan['problems'] = [];
  const c = { rows: file.rows.length, matched: 0, toUpdate: 0, unchanged: 0, notFound: 0, problems: 0, statusesSet: 0, statusesCleared: 0, imagesSet: 0, etasSet: 0, etasCleared: 0, nameDiffers: 0 };
  const problem = (row: number, sku: string, message: string) => { c.problems++; problems.push({ row, sku, message }); };

  for (const r of file.rows) {
    if (!r.sku) { problem(r.row, '', 'No SKU on this row'); continue; }
    const key = r.sku.toLowerCase();
    if (seen.has(key)) { problem(r.row, r.sku, `Same SKU as row ${seen.get(key)}, ignored`); continue; }
    seen.set(key, r.row);
    const p = exact.get(r.sku) ?? lower.get(key);
    if (!p) { c.notFound++; problem(r.row, r.sku, 'SKU not found in the CRM (products come from DEAR)'); continue; }
    c.matched++;
    if (r.name && r.name.trim().toLowerCase() !== p.name.trim().toLowerCase()) c.nameDiffers++;

    const change: Change = { sku: p.sku, name: p.name };
    if (file.hasImage && r.image) {
      if (!/^https?:\/\//i.test(r.image)) problem(r.row, p.sku, 'Image link must start with http:// or https://, photo left as it was');
      else if (r.image !== (p.imageUrl ?? '')) change.image = { from: p.imageUrl, to: r.image };
    }
    if (file.hasStatus) {
      const s = parseStatus(r.status);
      if (s === 'invalid') problem(r.row, p.sku, `"${r.status}" is not a status. Use EOL, Discontinued, Pre-order, New, or leave it blank`);
      else if (s !== ((p.lifecycle as ProductStatus | null) ?? null)) change.status = { from: (p.lifecycle as ProductStatus | null) ?? null, to: s };
    }
    if (file.hasEta) {
      const d = parseDay(r.eta);
      if (d === 'invalid') problem(r.row, p.sku, `"${r.eta}" is not a date. Use a date like 21 Oct 2026, or leave it blank`);
      else if (d !== (p.eta ?? null)) change.eta = { from: p.eta, to: d };
    }
    if (change.image || change.status || change.eta) {
      changes.push(change); c.toUpdate++;
      if (change.image) c.imagesSet++;
      if (change.status) { if (change.status.to) c.statusesSet++; else c.statusesCleared++; }
      if (change.eta) { if (change.eta.to) c.etasSet++; else c.etasCleared++; }
    } else c.unchanged++;
  }
  return { counts: c, changes, problems: problems.slice(0, 300) };
}

// ---- The template ----
const FONT = { name: 'Arial', size: 10 };
export async function productTemplate(
  products: { sku: string; name: string; brand: string | null; imageUrl: string | null; lifecycle: string | null; eta: string | null }[],
  blank: boolean,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Products', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: 'SKU', key: 'sku', width: 24 },
    { header: 'Product name', key: 'name', width: 48 },
    { header: 'Image link', key: 'image', width: 64 },
    { header: 'Status', key: 'status', width: 16 },
    { header: 'ETA', key: 'eta', width: 14 },
    { header: 'Brand (for filtering only)', key: 'brand', width: 24 },
  ];
  const day = (s: string | null) => (s ? new Date(`${s}T00:00:00Z`) : null);
  const rows = blank
    ? [{ sku: 'EXAMPLE-SKU', name: 'Example product (delete this row)', image: 'https://www.dropbox.com/s/abc123/photo.jpg?dl=0', status: 'EOL', eta: day('2026-12-01'), brand: '' }]
    : products.map(p => ({ sku: p.sku, name: p.name, image: p.imageUrl ?? '', status: statusLabel(isStatusKey(p.lifecycle) ? p.lifecycle : null), eta: day(p.eta), brand: p.brand ?? '' }));
  rows.forEach(r => ws.addRow(r));

  const last = Math.max(rows.length + 1, 2) + (blank ? 499 : 200);   // dropdown and date format also on the empty rows below, for new entries
  ws.getRow(1).eachCell(c => { c.font = { ...FONT, bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3A4D' } }; });
  for (let r = 2; r <= last; r++) {
    ws.getCell(r, 1).numFmt = '@';
    ws.getCell(r, 5).numFmt = 'dd mmm yyyy';
    for (let c = 1; c <= 6; c++) ws.getCell(r, c).font = c === 2 || c === 6 ? { ...FONT, color: { argb: 'FF7F7F7F' } } : FONT;
    ws.getCell(r, 4).dataValidation = {
      type: 'list', allowBlank: true, formulae: ['"EOL,Discontinued,Pre-order,New"'],
      showErrorMessage: true, errorTitle: 'Status', error: 'Pick EOL, Discontinued, Pre-order or New, or leave it blank.',
    };
    ws.getCell(r, 5).dataValidation = {
      type: 'date', operator: 'between', allowBlank: true, formulae: [new Date('2020-01-01T00:00:00Z'), new Date('2100-01-01T00:00:00Z')],
      showErrorMessage: true, errorTitle: 'ETA', error: 'Enter a date like 21 Oct 2026, or leave it blank.',
    };
  }
  if (rows.length) ws.autoFilter = { from: 'A1', to: `F${rows.length + 1}` };

  const how = wb.addWorksheet('How to fill in');
  how.getColumn(1).width = 22; how.getColumn(2).width = 100;
  const lines: [string, string][] = [
    ['Fill in', 'Products sheet. One row per product. Keep the headings in row 1.'],
    ['SKU', 'Must match the SKU in DEAR. Products themselves come from DEAR, this file cannot add one.'],
    ['Product name', 'To help you find the product. DEAR\'s name is the one used, changes here are ignored.'],
    ['Image link', 'A link to the photo, for example a Dropbox share link as it is. Leave blank to keep the photo the product has now.'],
    ['Status', 'Pick from the list, or leave blank for no status. If you delete the whole Status column, statuses are not touched.'],
    ['ETA', 'The date the next delivery should arrive, so reps can tell customers. Leave blank for no date of your own: the date on an incoming order in DEAR shows instead. If you delete the whole ETA column, ETAs are not touched.'],
    ['Brand', 'Only there so you can filter the sheet. Not imported.'],
    ['', ''],
    ...PRODUCT_STATUSES.map(s => [s.label, s.meaning] as [string, string]),
    ['', ''],
    ['Before it changes anything', 'The import shows what it would change first, and you confirm. Rows it cannot use are listed and skipped.'],
  ];
  lines.forEach(([a, b]) => { const row = how.addRow([a, b]); row.eachCell(c => { c.font = FONT; c.alignment = { vertical: 'top', wrapText: true }; }); row.getCell(1).font = { ...FONT, bold: true }; });
  return Buffer.from(await wb.xlsx.writeBuffer());
}