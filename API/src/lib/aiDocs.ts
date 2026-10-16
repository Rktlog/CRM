// Written reports for the assistant: markdown in, a Word (.docx) or PDF file out.
// The assistant writes the report as markdown, the way it would in chat; this turns it into a tidy document with
// headings, lists, tables, bold and italic. The document libraries are loaded only when a Word or PDF is asked for,
// so the API still starts without them (npm install docx pdfkit).

export type Run = { text: string; bold?: boolean; italic?: boolean; code?: boolean };
export type Item = { level: number; ordered: boolean; runs: Run[] };
export type Block =
  | { t: 'h'; level: 1 | 2 | 3 | 4; runs: Run[] }
  | { t: 'p'; runs: Run[] }
  | { t: 'list'; items: Item[] }
  | { t: 'code'; text: string }
  | { t: 'table'; head: string[]; rows: string[][] }
  | { t: 'quote'; runs: Run[] }
  | { t: 'hr' };
export type Meta = { title: string; on: string };

// ---------- markdown -> blocks ----------
export function inlineRuns(text: string, base: Omit<Run, 'text'> = {}): Run[] {
  const out: Run[] = [];
  const re = /(`[^`\n]+`)|(\*\*(?=\S)(?:[^*\n]|\*(?!\*))+?\*\*)|(\*(?!\*)(?=\S)[^*\n]+?(?<=\S)\*)|(\[[^\]\n]+\]\([^)\s]+\))/g;
  let last = 0, m: RegExpExecArray | null;
  const plain = (s: string) => { if (s) out.push({ text: s, ...base }); };
  while ((m = re.exec(text))) {
    plain(text.slice(last, m.index));
    const t = m[0];
    if (m[1]) out.push({ text: t.slice(1, -1), ...base, code: true });
    else if (m[2]) out.push(...inlineRuns(t.slice(2, -2), { ...base, bold: true }));
    else if (m[3]) out.push(...inlineRuns(t.slice(1, -1), { ...base, italic: true }));
    else { const [, label, url] = t.match(/^\[([^\]]+)\]\(([^)]+)\)$/)!; plain(/^(https?:\/\/|mailto:)/i.test(url) ? `${label} (${url})` : t); }
    last = m.index + t.length;
  }
  plain(text.slice(last));
  return out;
}

const isRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const isSep = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l) && l.includes('-');
const cells = (l: string) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
const listMatch = (l: string) => l.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);

export function parseMarkdown(md: string): Block[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0, para: string[] = [];
  const flush = () => { if (para.length) { blocks.push({ t: 'p', runs: inlineRuns(para.join(' ')) }); para = []; } };
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) { flush(); const code: string[] = []; i++; while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]); i++; blocks.push({ t: 'code', text: code.join('\n') }); continue; }
    if (isRow(line) && i + 1 < lines.length && isSep(lines[i + 1])) {
      flush(); const head = cells(line); i += 2; const rows: string[][] = [];
      while (i < lines.length && isRow(lines[i])) rows.push(head.map((_, c) => cells(lines[i])[c] ?? '')), i++;
      blocks.push({ t: 'table', head, rows }); continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { flush(); blocks.push({ t: 'h', level: h[1].length as 1 | 2 | 3 | 4, runs: inlineRuns(h[2]) }); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); blocks.push({ t: 'hr' }); i++; continue; }
    if (/^>\s?/.test(line)) { flush(); const q: string[] = []; while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, '')); blocks.push({ t: 'quote', runs: inlineRuns(q.join(' ')) }); continue; }
    if (listMatch(line)) {
      flush(); const items: Item[] = [];
      while (i < lines.length) { const m = listMatch(lines[i]); if (!m) break; items.push({ level: Math.floor(m[1].replace(/\t/g, '  ').length / 2), ordered: /\d/.test(m[2]), runs: inlineRuns(m[3]) }); i++; }
      const base = Math.min(...items.map(x => x.level)); items.forEach(x => { x.level = Math.min(Math.max(x.level - base, 0), 2); });
      blocks.push({ t: 'list', items }); continue;
    }
    if (line.trim() === '') { flush(); i++; continue; }
    para.push(line.trim()); i++;
  }
  flush();
  return blocks;
}

const plainText = (runs: Run[]) => runs.map(r => r.text).join('');
// The title is the first heading; otherwise the file name. The document always starts with it.
export function withTitle(blocks: Block[], fallback: string): { blocks: Block[]; title: string } {
  const first = blocks.find(b => b.t === 'h' && b.level === 1) as Extract<Block, { t: 'h' }> | undefined;
  if (first && blocks[0] === first) return { blocks, title: plainText(first.runs) };
  const title = first ? plainText(first.runs) : fallback;
  return { blocks: first ? blocks : [{ t: 'h', level: 1, runs: [{ text: title }] }, ...blocks], title };
}

// Shown to the person as it is (unlike an unexpected failure).
export class DocsMissingError extends Error {}

export async function loadPackage(name: string): Promise<any> {
  try { return await import(name); }
  catch { throw new DocsMissingError(`Word and PDF reports need two more packages on the API: npm install docx pdfkit. Until then the assistant can make Excel and CSV.`); }
}

// Column widths for a table, as fractions of the page width: wider for longer text, never very thin.
export function colFractions(head: string[], rows: string[][]): number[] {
  const weight = head.map((h, c) => Math.min(Math.max(h.length, ...rows.map(r => (r[c] ?? '').length), 4), 34));
  const total = weight.reduce((s, v) => s + v, 0);
  const raw = weight.map(v => Math.max(0.07, v / total)), sum = raw.reduce((s, v) => s + v, 0);
  return raw.map(v => v / sum);
}

const isNumberish = (s: string) => /^[\s$€£+-]*[\d,]+(\.\d+)?\s*%?\s*$/.test(s);

// ---------- Word ----------
export async function renderDocx(input: Block[], meta: Meta): Promise<Buffer> {
  const d = await loadPackage('docx');
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, ShadingType, AlignmentType, LevelFormat, Footer, PageNumber, BorderStyle, TableLayoutType } = d;
  const PAGE_W = 11906 - 2 * 1134;   // A4 minus the margins, in twentieths of a point
  const { blocks } = withTitle(input, meta.title);
  const runs = (rs: Run[], extra: Record<string, unknown> = {}) => rs.map(r => new TextRun({ text: r.text, bold: r.bold, italics: r.italic, font: r.code ? 'Consolas' : undefined, ...extra }));
  const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4];
  const grey = { style: BorderStyle.SINGLE, size: 4, color: 'BBBBBB' };
  const levels = (format: string, text: (n: number) => string) => [0, 1, 2].map(level => ({ level, format, text: text(level + 1), alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720 + level * 360, hanging: 360 } } } }));
  let listNo = 0;
  const children: any[] = [];

  for (const b of blocks) {
    if (b.t === 'h') children.push(new Paragraph({ heading: HEADINGS[b.level], children: runs(b.runs) }));
    else if (b.t === 'p') children.push(new Paragraph({ spacing: { after: 120 }, children: runs(b.runs) }));
    else if (b.t === 'quote') children.push(new Paragraph({ spacing: { after: 120 }, indent: { left: 360 }, border: { left: { style: BorderStyle.SINGLE, size: 12, color: 'BBBBBB', space: 8 } }, children: runs(b.runs, { italics: true, color: '555555' }) }));
    else if (b.t === 'hr') children.push(new Paragraph({ spacing: { after: 120 }, border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'CCCCCC', space: 1 } }, children: [] }));
    else if (b.t === 'code') b.text.split('\n').forEach(line => children.push(new Paragraph({ shading: { type: ShadingType.CLEAR, fill: 'F3F4F6' }, children: [new TextRun({ text: line || ' ', font: 'Consolas', size: 18 })] })));
    else if (b.t === 'list') {
      const instance = ++listNo;
      for (const it of b.items) children.push(new Paragraph({ spacing: { after: 40 }, numbering: it.ordered ? { reference: 'numbers', level: it.level, instance } : { reference: 'bullets', level: it.level }, children: runs(it.runs) }));
      children.push(new Paragraph({ spacing: { after: 60 }, children: [] }));
    } else if (b.t === 'table') {
      const widths = colFractions(b.head, b.rows).map(f => Math.round(f * PAGE_W));
      const cell = (text: string, head: boolean, i: number) => new TableCell({
        width: { size: widths[i], type: WidthType.DXA },
        shading: head ? { type: ShadingType.CLEAR, fill: 'E5E7EB' } : undefined,
        margins: { top: 50, bottom: 50, left: 90, right: 90 },
        children: [new Paragraph({ alignment: !head && isNumberish(text) ? AlignmentType.RIGHT : AlignmentType.LEFT, children: runs(inlineRuns(text, head ? { bold: true } : {}), { size: 20 }) })],
      });
      children.push(new Table({
        width: { size: PAGE_W, type: WidthType.DXA }, columnWidths: widths, layout: TableLayoutType.FIXED,
        borders: { top: grey, bottom: grey, left: grey, right: grey, insideHorizontal: grey, insideVertical: grey },
        rows: [new TableRow({ tableHeader: true, cantSplit: true, children: b.head.map((h, i) => cell(h, true, i)) }), ...b.rows.map(r => new TableRow({ cantSplit: true, children: r.map((c, i) => cell(c, false, i)) }))],
      }));
      children.push(new Paragraph({ spacing: { after: 120 }, children: [] }));
    }
  }

  const doc = new Document({
    creator: 'Rhino CRM assistant', title: meta.title,
    styles: {
      default: {
        document: { run: { font: 'Calibri', size: 22 } },
        heading1: { run: { font: 'Calibri', size: 36, bold: true, color: '1F2937' }, paragraph: { spacing: { before: 240, after: 120 } } },
        heading2: { run: { font: 'Calibri', size: 28, bold: true, color: '1F2937' }, paragraph: { spacing: { before: 220, after: 100 } } },
        heading3: { run: { font: 'Calibri', size: 24, bold: true, color: '374151' }, paragraph: { spacing: { before: 180, after: 80 } } },
        heading4: { run: { font: 'Calibri', size: 22, bold: true, color: '374151' }, paragraph: { spacing: { before: 140, after: 60 } } },
      },
    },
    numbering: { config: [
      { reference: 'bullets', levels: levels(LevelFormat.BULLET, () => '•') },
      { reference: 'numbers', levels: levels(LevelFormat.DECIMAL, n => `%${n}.`) },
    ] },
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, right: 1134, bottom: 1134, left: 1134 } } },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [
        new TextRun({ text: `${meta.title} · ${meta.on} · Page `, size: 16, color: '777777' }),
        new TextRun({ children: [PageNumber.CURRENT], size: 16, color: '777777' }),
        new TextRun({ text: ' of ', size: 16, color: '777777' }),
        new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 16, color: '777777' }),
      ] })] }) },
      children,
    }],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

// ---------- PDF ----------
// The built-in PDF fonts cover Western European text. Anything else is swapped for something close, or a ?.
const CP1252 = new Set('\u2013\u2014\u2018\u2019\u201A\u201C\u201D\u201E\u2020\u2021\u2022\u2026\u2030\u2039\u203A\u20AC\u2122\u0152\u0153\u0160\u0161\u0178\u017D\u017E\u0192\u02C6\u02DC'.split(''));
const SWAP: Record<string, string> = { '→': '->', '←': '<-', '↑': '^', '↓': 'v', '✓': 'v', '✔': 'v', '✗': 'x', '✘': 'x', '≥': '>=', '≤': '<=', '≠': '!=', '−': '-', '\u00A0': ' ', '\u200B': '', '\uFE0F': '', '▪': '-', '●': '•', '◦': '-', '‑': '-' };
export function pdfSafe(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (SWAP[ch] !== undefined) out += SWAP[ch];
    else if ((c >= 32 && c <= 126) || (c >= 160 && c <= 255) || c === 9 || c === 10 || CP1252.has(ch)) out += ch;
    else if (c > 0xFFFF || (c >= 0x2600 && c <= 0x27BF) || (c >= 0xFE00 && c <= 0xFE0F)) out += '';   // emoji and symbols
    else out += '?';
  }
  return out;
}

export async function renderPdf(input: Block[], meta: Meta): Promise<Buffer> {
  const mod = await loadPackage('pdfkit');
  const PDFDocument = mod.default ?? mod;
  const { blocks } = withTitle(input, meta.title);
  const M = 50, doc = new PDFDocument({ size: 'A4', margins: { top: M, bottom: 60, left: M, right: M }, bufferPages: true, info: { Title: pdfSafe(meta.title), Author: 'Rhino CRM assistant' } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const finished = new Promise<Buffer>((res, rej) => { doc.on('end', () => res(Buffer.concat(chunks))); doc.on('error', rej); });

  const W = doc.page.width - 2 * M;
  const font = (r: { bold?: boolean; italic?: boolean; code?: boolean }) => (r.code ? 'Courier' : r.bold && r.italic ? 'Helvetica-BoldOblique' : r.bold ? 'Helvetica-Bold' : r.italic ? 'Helvetica-Oblique' : 'Helvetica');
  const bottom = () => doc.page.height - 60;
  const need = (h: number) => { if (doc.y + h > bottom()) doc.addPage(); };
  // Mixed bold and plain text stays on one line only if the later pieces pass just the options (no x or y).
  const write = (runs: Run[], size: number, x: number, width: number, opts: Record<string, unknown> = {}, y: number = doc.y) => {
    const rs = runs.filter(r => r.text);
    if (!rs.length) { doc.moveDown(0.3); return; }
    rs.forEach((r, i) => {
      const o = { width, continued: i < rs.length - 1, ...opts };
      doc.font(font(r)).fontSize(size);
      if (i === 0) doc.text(pdfSafe(r.text), x, y, o); else doc.text(pdfSafe(r.text), o);
    });
  };
  const SIZES = [0, 20, 16, 13, 11.5];

  for (const b of blocks) {
    doc.fillColor('#111111');
    if (b.t === 'h') { need(40); doc.moveDown(b.level === 1 ? 0.2 : 0.7); write(b.runs.map(r => ({ ...r, bold: true })), SIZES[b.level], M, W); doc.moveDown(0.3); }
    else if (b.t === 'p') { write(b.runs, 10.5, M, W, { lineGap: 2 }); doc.moveDown(0.5); }
    else if (b.t === 'quote') { need(30); const y0 = doc.y; doc.fillColor('#555555'); write(b.runs.map(r => ({ ...r, italic: true })), 10.5, M + 14, W - 14, { lineGap: 2 }); doc.moveTo(M + 4, y0).lineTo(M + 4, doc.y).lineWidth(2).stroke('#BBBBBB'); doc.moveDown(0.5); }
    else if (b.t === 'hr') { need(12); doc.moveTo(M, doc.y + 2).lineTo(M + W, doc.y + 2).lineWidth(0.7).stroke('#CCCCCC'); doc.moveDown(0.8); }
    else if (b.t === 'code') { doc.font('Courier').fontSize(9); const h = doc.heightOfString(pdfSafe(b.text), { width: W - 12 }) + 10; need(Math.min(h, 120)); const y0 = doc.y; doc.rect(M, y0, W, h).fill('#F3F4F6'); doc.fillColor('#111111').font('Courier').fontSize(9).text(pdfSafe(b.text), M + 6, y0 + 5, { width: W - 12 }); doc.y = y0 + h; doc.moveDown(0.6); }
    else if (b.t === 'list') {
      const counters = [0, 0, 0];
      for (const it of b.items) {
        need(18);
        counters[it.level] = it.ordered ? counters[it.level] + 1 : 0; for (let l = it.level + 1; l < 3; l++) counters[l] = 0;
        const x = M + 8 + it.level * 16, y = doc.y;
        doc.font('Helvetica').fontSize(10.5).text(it.ordered ? `${counters[it.level]}.` : '•', x, y, { width: 16, lineBreak: false });
        write(it.runs, 10.5, x + 16, W - (x - M) - 16, { lineGap: 2 }, y);
        doc.moveDown(0.15);
      }
      doc.moveDown(0.4);
    } else if (b.t === 'table') {
      const widths = colFractions(b.head, b.rows).map(f => f * W), pad = 4;
      const rowH = (cs: string[], head: boolean) => Math.max(...cs.map((c, i) => { doc.font(head ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5); return doc.heightOfString(pdfSafe(c.replace(/\*\*|`/g, '')), { width: widths[i] - 2 * pad }); })) + 2 * pad;
      const drawRow = (cs: string[], head: boolean) => {
        const h = rowH(cs, head);
        if (doc.y + h > bottom()) { doc.addPage(); if (!head) drawRow(b.head, true); }
        const y = doc.y; let x = M;
        cs.forEach((c, i) => {
          if (head) doc.rect(x, y, widths[i], h).fill('#E5E7EB');
          doc.rect(x, y, widths[i], h).lineWidth(0.5).stroke('#BBBBBB');
          doc.fillColor('#111111').font(head ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5).text(pdfSafe(c.replace(/\*\*|`/g, '')), x + pad, y + pad, { width: widths[i] - 2 * pad, align: !head && isNumberish(c) ? 'right' : 'left' });
          x += widths[i];
        });
        doc.y = y + h;
      };
      need(40); drawRow(b.head, true); b.rows.forEach(r => drawRow(r, false)); doc.moveDown(0.8);
    }
  }

  const pages = doc.bufferedPageRange();
  for (let i = 0; i < pages.count; i++) {
    doc.switchToPage(pages.start + i);
    doc.page.margins.bottom = 0;   // so writing in the footer does not start a new page
    doc.font('Helvetica').fontSize(8).fillColor('#777777');
    doc.text(pdfSafe(`${meta.title} · ${meta.on}`), M, doc.page.height - 36, { width: W / 2, lineBreak: false });
    doc.text(`Page ${i + 1} of ${pages.count}`, M + W / 2, doc.page.height - 36, { width: W / 2, align: 'right', lineBreak: false });
  }
  doc.end();
  return finished;
}