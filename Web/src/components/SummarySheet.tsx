import { useEffect, useState } from 'react';
import { apiGet } from '../lib/api';
import { CELL_STYLES, COLUMN_WIDTHS, DEFAULT_FONT_SIZE, FONT, ROW_HEIGHTS, type CellStyle } from '../lib/summarySheetStyle';

// The rep's Summary on the Dashboard: the team's Summary_Rhonda sheet, cell for cell, but only its two monthly tables (rows 1 to 20: budget,
// percentage to budget, invoiced sales this year and last, variance, quotes awaiting payment, new and reactivated stockists). The quarter budget
// block and the unpaid quotes list that sit below them on the sheet are left off the screen. The API works out every cell (with the sheet's own
// formulas) and this draws them with the sheet's own fonts, fills, borders, number formats and column widths (lib/summarySheetStyle.ts, generated
// from the sheet). Managers see every rep's on the Dashboard (RepSummaries) and download the full sheet, with everything, from Reports.
type Cell = { v: string | number | null; f?: string };
type Unpaid = { order: string; orderId: string; accountId: string };
type Model = { fy: number; title: string; regions: string[]; budgetSource: 'months' | 'quarters' | 'none'; cells: Record<string, Cell>; unpaid: Unpaid[] };

const COLS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'];
const pxOf = (w: number) => Math.round(w * 7 + 5);             // Excel column width (characters) to pixels
const ptPx = (pt: number) => Math.round(pt * (4 / 3) * 100) / 100;   // points to pixels
const LINE = { t: '1px solid #000', d: '3px double #000', m: '2px solid #000' } as Record<string, string>;
const GREEN = '#34A853', RED = '#FF0000', DARK_RED = '#CC0000';

const num = (v: number, min: number, max: number) => (Object.is(v, -0) ? 0 : v).toLocaleString('en-AU', { minimumFractionDigits: min, maximumFractionDigits: max });
export function fmtCell(v: Cell['v'], fmt?: string): string {
  if (v === null || v === undefined) return fmt && /%/.test(fmt) ? '–' : '';   // a percentage with nothing to divide by
  if (typeof v === 'string') return v;
  if (fmt === '0.00%') return `${num(v * 100, 2, 2)}%`;
  if (fmt === '0%') return `${num(v * 100, 0, 0)}%`;
  if (fmt === '#,##0.00') return num(v, 2, 2);
  if (fmt === '#,##0') return num(v, 0, 0);
  if (fmt === '"$"#,##0.00') return `$${num(v, 2, 2)}`;
  return String(v);
}

// The colours the sheet's conditional formatting gives: percentage to budget green from 100% and red below; variances green above zero, red below.
export function cellColour(addr: string, v: Cell['v'], style: CellStyle): { color?: string; bold?: boolean } {
  const row = Number(addr.replace(/^[A-Z]+/, '')), col = addr[0];
  if ((row === 4 || row === 14) && col !== 'A') return typeof v === 'number' ? (v >= 1 ? { color: GREEN, bold: true } : { color: RED }) : { color: RED };
  if ([7, 8, 17, 18].includes(row) && typeof v === 'number') return v > 0 ? { color: GREEN } : v < 0 ? { color: RED } : { color: style.color ? `#${style.color}` : undefined };
  return { color: style.color ? `#${style.color}` : undefined };
}

export function SummaryTable({ model }: { model: Model }) {
  const lastRow = 20;   // the two monthly tables; everything below (the quarter budget block, the unpaid quotes) is not shown
  const rows = Array.from({ length: lastRow }, (_, i) => i + 1);
  const width = COLS.reduce((s, L) => s + pxOf(COLUMN_WIDTHS[L]), 0);
  return (
    <div className="ledger-table-scroll" style={{ maxHeight: 'none', overflowX: 'auto', background: '#fff', border: '1px solid var(--line)' }}>
        <table style={{ borderCollapse: 'collapse', tableLayout: 'fixed', width, fontFamily: `${FONT}, Helvetica, sans-serif`, color: '#000' }} aria-label="Summary">
          <colgroup>{COLS.map(L => <col key={L} style={{ width: pxOf(COLUMN_WIDTHS[L]) }} />)}</colgroup>
          <tbody>
            {rows.map(r => (
              <tr key={r} style={ROW_HEIGHTS[r] ? { height: Math.round(ptPx(ROW_HEIGHTS[r])) } : undefined}>
                {COLS.map(L => {
                  const addr = `${L}${r}`;
                  if (r === 1 && L >= 'B' && L <= 'J') return null;   // the title is merged across A to J
                  const cell = model.cells[addr];
                  const style: CellStyle = CELL_STYLES[addr] ?? {};
                  const { color, bold } = cellColour(addr, cell?.v ?? null, style);
                  const sides = style.bd ?? '----';
                  const text = fmtCell(cell?.v ?? null, style.fmt);
                  const spills = typeof cell?.v === 'string' && cell.v.length > 14 && !style.fill && !['A', 'B', 'C'].includes(L) && r < 32;   // a note running over its empty neighbours, as in the sheet
                  const align = style.al === 'center' ? 'center' : style.al === 'right' ? 'right' : style.al === 'left' ? 'left' : typeof cell?.v === 'number' ? 'right' : 'left';
                  const content = text;
                  return (
                    <td key={L} colSpan={r === 1 && L === 'A' ? 10 : undefined} data-cell={addr}
                      style={{
                        fontSize: ptPx(style.sz ?? DEFAULT_FONT_SIZE), fontWeight: bold || style.b ? 700 : 400, fontStyle: style.i ? 'italic' : 'normal', color,
                        background: style.fill ? `#${style.fill}` : undefined, textAlign: align, verticalAlign: style.va === 'center' ? 'middle' : 'bottom',
                        borderTop: LINE[sides[0]], borderBottom: LINE[sides[1]], borderLeft: LINE[sides[2]], borderRight: LINE[sides[3]],
                        padding: '2px 3px', whiteSpace: spills ? 'nowrap' : 'pre-line', overflow: spills ? 'visible' : 'hidden', textOverflow: 'clip',
                        ...(align === 'right' && typeof cell?.v === 'string' ? { direction: 'rtl', unicodeBidi: 'plaintext' as const, whiteSpace: 'nowrap' as const, overflow: 'visible' } : {}),
                      }}>
                      {spills && align === 'center' ? <div style={{ display: 'flex', justifyContent: 'center', whiteSpace: 'nowrap' }}><span>{content}</span></div> : content}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
  );
}

export default function SummarySheet({ fy, repId, heading = true }: { fy: number; repId?: string; heading?: boolean }) {
  const [model, setModel] = useState<Model | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setModel(null); setError(null);
    apiGet(`/summary-sheet?fy=${fy}${repId ? `&repId=${repId}` : ''}`).then(setModel).catch(e => setError(e.message));
  }, [fy, repId]);

  if (error) return <div className="empty-state">Couldn't load {repId ? 'this summary' : 'your summary'}: {error}</div>;
  if (!model) return <div className="empty-state">Loading {repId ? 'the summary' : 'your summary'}…</div>;

  return (
    <>
      {heading && (
        <div className="ledger-section-head">
          <h2>My summary</h2>
          <span className="ledger-note">FY {model.fy}/{String(model.fy + 1).slice(2)}</span>
        </div>
      )}
      {model.regions.length === 0 && <div className="territory-note" style={{ marginBottom: 8 }}>{repId ? 'This rep has no states assigned, so every figure below is zero.' : 'You have no states assigned, so every figure below is zero. A manager can assign your states in Settings.'}</div>}
      {model.budgetSource === 'none' && <div className="territory-note" style={{ marginBottom: 8 }}>No budget has been set for this financial year yet, so the budget rows show zero.</div>}
      {model.budgetSource === 'quarters' && <div className="territory-note" style={{ marginBottom: 8 }}>The monthly budget is the quarterly target from Settings, spread over its months by last year's sales.</div>}
      <SummaryTable model={model} />
    </>
  );
}