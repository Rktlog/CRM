import { useEffect, useState, type CSSProperties } from 'react';
import { apiGet } from '../lib/api';
import { useAuth } from '../context/AuthContext';

type Block = {
  key: string; label: string; kind: 'month' | 'quarter' | 'half'; years: number[]; status: 'done' | 'partial' | 'future';
  values: Record<string, number[]>; variance: Record<string, number | null>;
};
type Data = { fy: number; fyYears: number[]; rows: string[]; blocks: Block[]; asOf: string };

const money = (n: number) => n.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (n: number) => `${n > 0 ? '+' : ''}${(n * 100).toFixed(1)}%`;
const isTotal = (row: string) => row.startsWith('TOTAL');
// One colour per year column so the three years are easy to tell apart: the oldest is grey, the middle dark, the newest green.
const YEAR_COLOUR = ['var(--muted)', '#2b2b2b', 'var(--teal)'];
const YEAR_BG = ['transparent', 'transparent', 'var(--teal-bg)'];

// Change: green when up, red when down, bold either way. While the newest quarter or half is still running it says so; a period that has not started shows nothing.
const changeStyle = (v: number | null): CSSProperties => ({ fontWeight: 700, color: v == null ? 'var(--muted)' : v > 0 ? 'var(--teal)' : v < 0 ? 'var(--rust)' : undefined });
const changeText = (v: number | null, status: Block['status']) => (v != null ? pct(v) : status === 'partial' ? 'not finished' : '');

export default function Ellen() {
  const { role } = useAuth();
  const thisFy = (() => { const d = new Date(); return d.getMonth() >= 6 ? d.getFullYear() : d.getFullYear() - 1; })();
  const [fy, setFy] = useState(thisFy);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (role !== 'manager') return;
    setData(null); setError(null);
    apiGet(`/reports/ellen?fy=${fy}`).then(setData).catch(e => setError(e.message));
  }, [fy, role]);

  if (role !== 'manager') return <div className="empty-state">The Ellen report is for managers.</div>;

  const halves = data ? [data.blocks.filter(b => b.key.startsWith('h1')), data.blocks.filter(b => b.key.startsWith('h2'))] : [];

  return (
    <div className="ledger">
      <div className="ledger-head">
        <div>
          <div className="ledger-tag">Insights &amp; Reporting</div>
          <h1 className="ledger-title">Ellen</h1>
          <div className="ledger-sub">Monthly sales by state, three financial years side by side. Live from Radar, counted the same way as Sales Data.</div>
        </div>
        <select value={fy} onChange={e => setFy(Number(e.target.value))}>
          {[thisFy + 1, thisFy, thisFy - 1, thisFy - 2].map(y => <option key={y} value={y}>FY {y}/{String(y + 1).slice(2)}</option>)}
        </select>
      </div>

      {error && <div style={{ color: 'var(--rust)', fontSize: 13 }}>Couldn't load: {error}</div>}
      {!data && !error && <div style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</div>}

      {data && (
        <>
          <p style={{ color: 'var(--muted)', fontSize: 13 }}>
            The three columns are {data.fyYears.map(y => `FY ${y}/${String(y + 1).slice(2)}`).join(', ')}, oldest first. Change is the newest year against the year before it, as a share of the year before.
            Green is up, red is down. It is left out ("not finished") while the newest quarter or half is still running, so a part year is not compared with a whole one.
            Sales are goods ex GST on the invoice date, credit notes taken off, marketing and warranty included. MeeQ Custom is the DEAR brand "Miffy Plush - Custom"; only the VIC/HO row leaves it out, and Others is whatever is left, as in Ellen's sheet.
          </p>
          {halves.map((blocks, hi) => (
            <div key={hi} className="card" style={{ marginBottom: 16 }}>
              <h3 style={{ marginTop: 0 }}>{blocks[blocks.length - 1].label}</h3>
              <div className="ledger-table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th />
                      {blocks.map(b => <th key={b.key} colSpan={b.kind === 'month' ? 3 : 4} className="num-col" style={{ textAlign: 'center', fontWeight: 800, fontSize: 14, color: '#111', borderLeft: '1px solid var(--line)' }}>{b.label}{b.status === 'partial' ? ' (so far)' : b.status === 'future' ? ' (not started)' : ''}</th>)}
                    </tr>
                    <tr>
                      <th />
                      {blocks.flatMap(b => [
                        ...b.years.map((y, i) => <th key={`${b.key}-${i}`} className="num-col" style={{ fontWeight: 700, color: YEAR_COLOUR[i], background: YEAR_BG[i], borderLeft: i === 0 ? '1px solid var(--line)' : undefined }}>{y}</th>),
                        ...(b.kind === 'month' ? [] : [<th key={`${b.key}-v`} className="num-col" style={{ fontWeight: 700 }}>Change</th>]),
                      ])}
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map(row => (
                      <tr key={row} style={isTotal(row) ? { fontWeight: 600, background: 'var(--bg)' } : undefined}>
                        <td style={{ whiteSpace: 'nowrap' }}>{row}</td>
                        {blocks.flatMap(b => [
                          ...b.values[row].map((v, i) => (
                            <td key={`${b.key}-${i}`} className="num-col" style={{ color: i === 2 && b.status === 'future' ? 'var(--muted)' : YEAR_COLOUR[i], background: YEAR_BG[i], fontWeight: i === 2 ? 600 : undefined, borderLeft: i === 0 ? '1px solid var(--line)' : undefined }}>
                              {i === 2 && b.status === 'future' ? '–' : money(v)}
                            </td>
                          )),
                          ...(b.kind === 'month' ? [] : [<td key={`${b.key}-v`} className="num-col" style={changeStyle(b.variance[row])}>{changeText(b.variance[row], b.status)}</td>]),
                        ])}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
