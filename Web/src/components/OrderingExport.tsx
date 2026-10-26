import { useEffect, useState } from 'react';
import { apiDownload, apiGet } from '../lib/api';

// The nine ordering reports as CSV files, made from the CRM database (so nothing is exported from DEAR by hand), one by one or all together in a zip.
// Two date ranges: one for the sales reports (2 to 4), one for the quotes, stock movements and purchase orders (6 to 9). Availability and backorders
// are always as at today. Every report includes all brands with a Brand column, with no status filter, in base currency.
type Range = { from: string; to: string };
type Info = { key: string; no: number; title: string; file: string; basis: 'now' | 'period' | 'year'; note: string };
type Meta = { today: string; defaults: { period: Range; year: Range }; reports: Info[] };

const CONTROL = { padding: '6px 8px', border: '1px solid var(--line)', borderRadius: 6, font: 'inherit', fontSize: 13, background: 'var(--panel)' } as const;
export const rangeProblem = (r: Range): string | null => (!r.from || !r.to ? 'Pick both dates.' : r.to < r.from ? 'The end date is before the start date.' : null);
const query = (r: Range) => `from=${r.from}&to=${r.to}`;
const fileFor = (i: Info, r: Range, today: string) => `${String(i.no).padStart(2, '0')}-${i.file}${i.basis === 'now' ? `_${today}` : `_${r.from}_to_${r.to}`}.csv`;

export default function OrderingExport() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [period, setPeriod] = useState<Range>({ from: '', to: '' });
  const [year, setYear] = useState<Range>({ from: '', to: '' });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet('/ordering/export', { fresh: true }).then((m: Meta) => { setMeta(m); setPeriod(m.defaults.period); setYear(m.defaults.year); })
      .catch((e: Error) => setError(e.message));
  }, []);

  async function download(key: string, path: string, filename: string) {
    setBusy(key); setError(null);
    try { await apiDownload(path, filename); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  if (!meta) return <div className="card" style={{ marginBottom: 14 }}>{error ? <div className="save-msg err" role="alert">Could not load the export: {error}</div> : <div className="acct-region">Loading…</div>}</div>;
  const pBad = rangeProblem(period), yBad = rangeProblem(year);
  const rangeOf = (i: Info) => (i.basis === 'period' ? period : year);
  const badFor = (i: Info) => (i.basis === 'period' ? pBad : i.basis === 'year' ? yBad : null);
  const dateBox = (label: string, value: string, set: (v: string) => void) => (
    <input type="date" aria-label={label} value={value} onChange={e => set(e.target.value)} style={CONTROL} />
  );

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <h3 style={{ marginTop: 0 }}>Export reports</h3>
      <div className="acct-region" style={{ maxWidth: 760, marginBottom: 10 }}>
        The nine reports you give Claude, made from the CRM database, so there is nothing to export from DEAR. All brands with a Brand column, no status filter (every
        order has a Status column and a "Counts as a sale" column), amounts in base currency. Availability and backorders are as at today.
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, marginBottom: 12 }}>
        <div>
          <div className="stat-label">Sales reports (2 to 4)</div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {dateBox('Sales reports from', period.from, v => setPeriod(p => ({ ...p, from: v })))}<span className="acct-region">to</span>{dateBox('Sales reports to', period.to, v => setPeriod(p => ({ ...p, to: v })))}
          </div>
          {pBad && <div className="save-msg err" role="alert" style={{ marginTop: 4 }}>{pBad}</div>}
        </div>
        <div>
          <div className="stat-label">Quotes, stock movements and purchase orders (6 to 9)</div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {dateBox('Quotes, movements and purchase orders from', year.from, v => setYear(p => ({ ...p, from: v })))}<span className="acct-region">to</span>{dateBox('Quotes, movements and purchase orders to', year.to, v => setYear(p => ({ ...p, to: v })))}
          </div>
          {yBad && <div className="save-msg err" role="alert" style={{ marginTop: 4 }}>{yBad}</div>}
        </div>
      </div>

      <div className="manifest">
        {meta.reports.map(i => {
          const bad = badFor(i), r = rangeOf(i);
          return (
            <div key={i.key} className="m-row" style={{ gridTemplateColumns: '2.2rem 1.6fr 1.6fr auto', cursor: 'default', alignItems: 'center' }}>
              <div className="num">{i.no}</div>
              <div><div className="acct-name">{i.title}</div><div className="acct-region">{i.note}</div></div>
              <div className="acct-region">{i.basis === 'now' ? `As at ${meta.today}` : bad ? '—' : `${r.from} to ${r.to}`}</div>
              <button className="btn secondary" style={{ padding: '4px 12px', fontSize: 12 }} disabled={!!busy || !!bad} aria-label={`Download ${i.title}`}
                onClick={() => download(i.key, `/ordering/export/${i.key}${i.basis === 'now' ? '' : `?${query(r)}`}`, fileFor(i, r, meta.today))}>
                {busy === i.key ? 'Preparing…' : 'Download CSV'}
              </button>
            </div>
          );
        })}
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
        <button className="btn" disabled={!!busy || !!pBad || !!yBad} onClick={() => download('zip', `/ordering/export/zip?from=${period.from}&to=${period.to}&yfrom=${year.from}&yto=${year.to}`, `ordering-reports_${meta.today}.zip`)}>
          {busy === 'zip' ? 'Preparing all nine…' : 'Download all 9 (zip)'}
        </button>
        <span className="acct-region">One zip with a README that lists the date ranges and how many rows each report has. A long range can take a minute.</span>
      </div>
      {error && <div className="save-msg err" role="alert" style={{ marginTop: 8 }}>Could not make the report: {error}</div>}
    </div>
  );
}