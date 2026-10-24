import ExcelJS from 'exceljs';
import { CELL_STYLES, COLUMN_WIDTHS, DEFAULT_FONT_SIZE, FONT, ROW_HEIGHTS } from './summarySheetStyle';
import type { SheetModel } from './summarySheet';

// The Summary sheet as an Excel file: the team's Summary_Rhonda layout (its fonts, fills, borders, number formats and column widths),
// with the sheet's own formulas, so it recalculates if anything is changed. One tab per rep.
const BORDER: Record<string, ExcelJS.BorderStyle | undefined> = { t: 'thin', d: 'double', m: 'medium', '-': undefined };
const argb = (hex: string) => `FF${hex}`;

// Variance and percentage cells turn green above the line and red below it, as in the sheet (conditional formatting, so it follows edits).
function colourRules(ws: ExcelJS.Worksheet) {
  const green = { font: { color: { argb: argb('34A853') } } }, red = { font: { color: { argb: argb('FF0000') } } };
  for (const r of [4, 14]) ws.addConditionalFormatting({ ref: `B${r}:J${r}`, rules: [
    { type: 'expression', formulae: [`AND(ISNUMBER(B${r}),B${r}>=1)`], priority: 1, style: { font: { bold: true, color: { argb: argb('34A853') } } } },   // 100% or more of budget
    { type: 'expression', formulae: [`AND(ISNUMBER(B${r}),B${r}<1)`], priority: 2, style: red },
  ] });
  for (const r of [7, 8, 17, 18]) ws.addConditionalFormatting({ ref: `A${r}:J${r}`, rules: [
    { type: 'cellIs', operator: 'greaterThan', formulae: [0], priority: 1, style: green },
    { type: 'cellIs', operator: 'lessThan', formulae: [0], priority: 2, style: red },
  ] });
}

export function addSummarySheet(wb: ExcelJS.Workbook, name: string, m: SheetModel) {
  const ws = wb.addWorksheet(name, { properties: { tabColor: { argb: argb('00FFFF') } } });
  Object.entries(COLUMN_WIDTHS).forEach(([L, w]) => { ws.getColumn(L).width = w; });
  Object.entries(ROW_HEIGHTS).forEach(([r, h]) => { ws.getRow(Number(r)).height = h; });

  // the sheet's formatting, cell by cell
  for (const [addr, s] of Object.entries(CELL_STYLES)) {
    const cell = ws.getCell(addr);
    cell.font = { name: FONT, size: s.sz ?? DEFAULT_FONT_SIZE, bold: !!s.b, italic: !!s.i, ...(s.color ? { color: { argb: argb(s.color) } } : {}) };
    if (s.fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(s.fill) } };
    if (s.fmt) cell.numFmt = s.fmt;
    if (s.al || s.va) cell.alignment = { ...(s.al ? { horizontal: s.al as ExcelJS.Alignment['horizontal'] } : {}), ...(s.va ? { vertical: (s.va === 'center' ? 'middle' : s.va) as ExcelJS.Alignment['vertical'] } : {}) };   // Excel files call vertically centred "middle"
    if (s.bd) cell.border = { top: side(s.bd[0]), bottom: side(s.bd[1]), left: side(s.bd[2]), right: side(s.bd[3]) };
  }
  // the values, with the sheet's formulas
  for (const [addr, c] of Object.entries(m.cells)) {
    const cell = ws.getCell(addr);
    cell.value = c.f ? { formula: c.f.slice(1), result: c.v === null ? { error: '#DIV/0!' } : c.v } as ExcelJS.CellFormulaValue : c.v;
    if (!CELL_STYLES[addr]) {   // the unpaid quotes list below the sheet's styled area
      const col = addr[0];
      cell.font = { name: FONT, size: DEFAULT_FONT_SIZE };
      cell.alignment = { horizontal: col === 'C' ? 'left' : 'center' };
      if (col === 'D') cell.numFmt = '#,##0.00';
    }
  }
  ws.mergeCells('A1:J1');
  colourRules(ws);
  return ws;
}
const side = (ch: string): Partial<ExcelJS.Border> | undefined => (BORDER[ch] ? { style: BORDER[ch] } : undefined);

// Tab names: at most 31 characters, none of []:*?/\, and different from each other.
export function tabName(name: string, taken: Set<string>): string {
  const base = (`Summary_${name}`.replace(/[\[\]:*?/\\]/g, ' ').trim() || 'Summary').slice(0, 31);
  let out = base, n = 2;
  while (taken.has(out.toLowerCase())) out = `${base.slice(0, 31 - String(n).length - 1)}_${n++}`;
  taken.add(out.toLowerCase());
  return out;
}

export async function summaryWorkbook(sheets: { name: string; model: SheetModel }[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.calcProperties = { fullCalcOnLoad: true };
  const taken = new Set<string>();
  for (const s of sheets) addSummarySheet(wb, tabName(s.name, taken), s.model);
  return Buffer.from(await wb.xlsx.writeBuffer());
}