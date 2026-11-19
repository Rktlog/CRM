import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiDelete, apiGet, apiPost, apiPut } from '../lib/api';
import { useMe } from '../lib/useMe';
import { $, errMsg, shortDay } from '../lib/tradeshow';
import { pctText, sel, signedPct, tableBox, td, tdr, th, type Compare, type CompareDay, type CompareShow } from '../lib/tsExtra';

// The Sales Comparison: the same show in different years side by side, worked out from the orders (old shows from the figures loaded for them).
// It answers "do we take this show?": sales against cost, the change on last year, new stockists and how many ordered, and how much was paid.
type Row = { label: string; get: (s: CompareShow) => string; note?: string };
const ROWS: Row[] = [
  { label: 'Total sales (ex GST)', get: s => $(s.totals.sales) }, { label: 'Change on the show before', get: s => signedPct(s.vsPrevious.sales) }, { label: 'Orders', get: s => String(s.totals.orders) },
  { label: 'Average order', get: s => $(s.totals.averageOrder) }, { label: 'New business', get: s => $(s.totals.newSales) }, { label: 'New business, share of sales', get: s => pctText(s.totals.newPct) },
  { label: 'New returning', get: s => $(s.totals.newReturningSales) }, { label: 'Existing business', get: s => $(s.totals.existingSales) }, { label: 'Paid', get: s => pctText(s.totals.paidPct) },
  { label: 'New stockists signed up', get: s => (s.totals.newSignedUp === null ? '' : String(s.totals.newSignedUp)) }, { label: 'New stockists who ordered', get: s => (s.totals.newOrders === null ? '' : String(s.totals.newOrders)) },
  { label: 'New business conversion', get: s => pctText(s.totals.conversion) }, { label: 'Show cost', get: s => (s.totals.cost ? $(s.totals.cost) : '') },
  { label: 'Sales for each $1 of cost', get: s => (s.totals.returnOnCost === null ? '' : `${s.totals.returnOnCost.toFixed(1)}x`) }, { label: 'Target', get: s => $(s.totals.target) }, { label: 'Reached', get: s => pctText(s.totals.toTarget) },
];

function Editor({ show, onDone }: { show: CompareShow; onDone: () => void }) {
  const [days, setDays] = useState<Omit<CompareDay, 'n'>[]>(() => {
    if (show.days.length) return show.days.map(({ n: _n, ...d }) => d);
    const out: Omit<CompareDay, 'n'>[] = [];   // a new old show has no days yet: one empty row for each day of the show
    const end = new Date(`${show.endsOn.slice(0, 10)}T00:00:00Z`);
    for (let d = new Date(`${show.startsOn.slice(0, 10)}T00:00:00Z`); d <= end && out.length < 60; d.setUTCDate(d.getUTCDate() + 1))
      out.push({ day: d.toISOString().slice(0, 10), sales: 0, orders: 0, newSales: null, newReturningSales: null, existingSales: null, newStockists: null, newOrders: null });
    return out;
  });
  const [bundles, setBundles] = useState(show.bundles.map(b => ({ ...b })));
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (i: number, k: keyof Omit<CompareDay, 'n'>, v: string) => setDays(d => d.map((x, j) => (j === i ? { ...x, [k]: v === '' ? null : k === 'day' ? v : Number(v) } : x)));
  const cols: [keyof Omit<CompareDay, 'n'>, string][] = [['sales', 'Sales ex GST'], ['orders', 'Orders'], ['newSales', 'New business'], ['newReturningSales', 'New returning'], ['existingSales', 'Existing'], ['newStockists', 'New stockists'], ['newOrders', 'New orders']];
  async function save() { setBusy(true); setErr(null); try { await apiPut(`/tradeshow/shows/${show.id}/history`, { days, bundles }); onDone(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); } }
  return (
    <div className="card" style={{ marginTop: 10 }}>
      <div className="panel-title">{show.name}: figures</div>
      <div style={tableBox}><table style={{ borderCollapse: 'collapse' }}>
        <thead><tr><th style={th}>Day</th>{cols.map(c => <th key={c[0]} style={th}>{c[1]}</th>)}</tr></thead>
        <tbody>{days.map((d, i) => <tr key={i}><td style={td}>{shortDay(d.day)}</td>{cols.map(([k]) => <td key={k} style={td}><input inputMode="decimal" style={{ ...sel, width: 100, padding: '3px 6px', fontSize: 13 }} value={d[k] === null || d[k] === undefined ? '' : String(d[k])} onChange={e => set(i, k, e.target.value)} /></td>)}</tr>)}</tbody></table></div>
      <div className="panel-title" style={{ marginTop: 12 }}>Bundles sold</div>
      {bundles.map((b, i) => <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 6 }}><input style={{ ...sel, flex: 1, maxWidth: 320 }} value={b.name} onChange={e => setBundles(x => x.map((y, j) => (j === i ? { ...y, name: e.target.value } : y)))} /><input inputMode="numeric" style={{ ...sel, width: 80 }} value={b.qty} onChange={e => setBundles(x => x.map((y, j) => (j === i ? { ...y, qty: Number(e.target.value) || 0 } : y)))} /><button type="button" className="link-btn" onClick={() => setBundles(x => x.filter((_, j) => j !== i))}>Remove</button></div>)}
      <button type="button" className="link-btn" onClick={() => setBundles(x => [...x, { name: '', qty: 1 }])}>Add a bundle</button>
      {err && <div className="save-msg err" role="alert">{err}</div>}
      <div style={{ display: 'flex', gap: 10, marginTop: 12 }}><button type="button" className="btn" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button><button type="button" className="btn secondary" onClick={onDone}>Cancel</button></div>
    </div>
  );
}

export default function TradeShowCompare() {
  const me = useMe(), isManager = me?.role === 'manager';
  const [c, setC] = useState<Compare | null>(null);
  const [series, setSeries] = useState<string>('');
  const [err, setErr] = useState<string | null>(null);
  const [rule, setRule] = useState('3');
  const [edit, setEdit] = useState<string | null>(null);
  const [adding, setAdding] = useState<{ name: string; startsOn: string; endsOn: string } | null>(null);
  const load = useCallback((s: string) => { apiGet(`/tradeshow/compare${s ? `?series=${encodeURIComponent(s)}` : ''}`, { fresh: true }).then((x: Compare) => { setC(x); setErr(null); if (!s && x.selected) setSeries(x.selected); }).catch(e => setErr(errMsg(e))); }, []);
  useEffect(() => { load(series); }, [load, series]);
  async function addOld() {
    if (!adding) return;
    try { const r = await apiPost('/tradeshow/history-shows', { ...adding, series: c?.selected ?? series }); setAdding(null); setEdit(r.id); load(series); } catch (e) { setErr(errMsg(e)); }
  }
  async function removeOld(s: CompareShow) { if (window.confirm(`Delete the old show "${s.name}" and its figures?`)) { try { await apiDelete(`/tradeshow/shows/${s.id}`); load(series); } catch (e) { setErr(errMsg(e)); } } }
  if (err && !c) return <><p><Link to="/trade-shows">← Trade Shows</Link></p><div className="save-msg err" role="alert">{err}</div></>;
  if (!c) return <div className="acct-region">Loading…</div>;
  const shows = c.shows, last = shows[shows.length - 1], prev = shows[shows.length - 2];
  const need = Number(rule) || 0, ret = last?.totals.returnOnCost ?? null;
  const verdict = !last ? null : ret === null ? { tone: 'amber', text: 'Add the show costs to see the return.' } : ret >= need ? { tone: 'teal', text: `Worth taking: ${ret.toFixed(1)}x the cost (you asked for ${need}x).` } : { tone: 'rust', text: `Below the bar: ${ret.toFixed(1)}x the cost (you asked for ${need}x).` };
  const dayCount = Math.max(0, ...shows.map(s => s.days.length));
  const bundleNames = [...new Set(shows.flatMap(s => s.bundles.map(b => b.name)))];
  return (
    <>
      <p style={{ margin: '0 0 6px' }}><Link to="/trade-shows">← Trade Shows</Link></p>
      <h1>Sales Comparison</h1>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
        <select style={sel} value={c.selected ?? ''} onChange={e => setSeries(e.target.value)}>{c.series.map(s => <option key={s} value={s}>{s}</option>)}</select>
        <span className="acct-region" style={{ fontSize: 13 }}>Worked out from the orders written in Radar. Old shows use the figures loaded for them. Sales are ex GST.</span>
      </div>
      {err && <div className="save-msg err" role="alert">{err}</div>}
      {!shows.length && <div className="empty-state">No shows in this series yet.</div>}
      {last && (
        <div className="card" style={{ maxWidth: 820 }}>
          <div className="panel-title">Take {last.name}?</div>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
            {verdict && <span className={`pill ${verdict.tone}`} style={{ fontSize: 14 }}>{verdict.text}</span>}
            <label style={{ fontSize: 13, display: 'flex', gap: 6, alignItems: 'center' }}>Worth taking if sales are at least <input inputMode="decimal" style={{ ...sel, width: 60, padding: '3px 6px' }} value={rule} onChange={e => setRule(e.target.value)} /> × the cost</label>
          </div>
          <div style={{ fontSize: 14, lineHeight: 1.7 }}>
            Sales {$(last.totals.sales)}{prev ? `, ${signedPct(last.vsPrevious.sales) || 'no change figure'} on ${prev.name}` : ''}. {last.totals.orders} orders{last.totals.averageOrder ? `, average ${$(last.totals.averageOrder)}` : ''}.
            {last.totals.newSignedUp !== null && <> {last.totals.newSignedUp} new stockists signed up{last.totals.newOrders !== null ? `, ${last.totals.newOrders} ordered (${pctText(last.totals.conversion)})` : ''}.</>}
            {last.totals.paidPct !== null && <> {pctText(last.totals.paidPct)} paid.</>}
            {last.totals.target ? <> {pctText(last.totals.toTarget)} of the {$(last.totals.target)} target.</> : null}
          </div>
        </div>
      )}
      {shows.length > 0 && <>
        <div className="panel-title" style={{ marginTop: 16 }}>Summary</div>
        <div style={tableBox}><table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr><th style={th} />{shows.map(s => <th key={s.id} style={{ ...th, textAlign: 'right' }}>{s.history ? s.name : <Link to={`/trade-shows/${s.id}`}>{s.name}</Link>}<div style={{ fontWeight: 400 }}>{shortDay(s.startsOn)}</div></th>)}</tr></thead>
          <tbody>{ROWS.map(r => <tr key={r.label}><td style={td}>{r.label}</td>{shows.map(s => <td key={s.id} style={tdr}>{r.get(s)}</td>)}</tr>)}</tbody></table></div>
        <div className="panel-title" style={{ marginTop: 16 }}>By day</div>
        <div style={tableBox}><table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr><th style={th}>Day</th>{shows.map(s => <th key={s.id} style={{ ...th, textAlign: 'right' }}>{s.name}</th>)}{prev && <th style={{ ...th, textAlign: 'right' }}>Change</th>}</tr></thead>
          <tbody>{Array.from({ length: dayCount }, (_, i) => { const a = prev?.days[i], b = last?.days[i]; return (
            <tr key={i}><td style={td}>Day {i + 1}</td>{shows.map(s => <td key={s.id} style={tdr}>{s.days[i] ? <>{$(s.days[i]!.sales)}<div className="acct-region" style={{ fontSize: 12 }}>{s.days[i]!.orders} orders</div></> : ''}</td>)}
              {prev && <td style={tdr}>{a && b && a.sales > 0 ? signedPct((b.sales - a.sales) / a.sales) : ''}</td>}</tr>); })}</tbody></table></div>
        {bundleNames.length > 0 && <>
          <div className="panel-title" style={{ marginTop: 16 }}>Bundles sold</div>
          <div style={tableBox}><table style={{ width: '100%', borderCollapse: 'collapse' }}><thead><tr><th style={th} />{shows.map(s => <th key={s.id} style={{ ...th, textAlign: 'right' }}>{s.name}</th>)}</tr></thead>
            <tbody>{bundleNames.map(n => <tr key={n}><td style={td}>{n}</td>{shows.map(s => <td key={s.id} style={tdr}>{s.bundles.find(b => b.name === n)?.qty ?? 0}</td>)}</tr>)}</tbody></table></div>
        </>}
        {last && last.byState.length > 0 && <>
          <div className="panel-title" style={{ marginTop: 16 }}>{last.name}: sales by state</div>
          <div style={tableBox}><table style={{ borderCollapse: 'collapse', minWidth: 320 }}><tbody>{last.byState.map(x => <tr key={x.state}><td style={td}>{x.state}</td><td style={tdr}>{$(x.sales)}</td><td style={tdr}>{x.orders} {x.orders === 1 ? 'order' : 'orders'}</td></tr>)}</tbody></table></div>
        </>}
      </>}
      {isManager && (
        <div className="section" style={{ marginTop: 22 }}>
          <div className="panel-title">Old shows</div>
          <div className="acct-region" style={{ fontSize: 13, marginBottom: 8 }}>Shows from before Radar have no orders in it, so their figures are typed in here, or loaded from the workbook (open a show, Offers tab, Load from the Excel workbook).</div>
          {shows.filter(s => s.history).map(s => (
            <div key={s.id} style={{ padding: '4px 0', fontSize: 14 }}>{s.name} · {shortDay(s.startsOn)} · {s.days.length} days · {$(s.totals.sales)}{' '}
              <button type="button" className="link-btn" onClick={() => setEdit(edit === s.id ? null : s.id)}>{edit === s.id ? 'Close' : 'Edit figures'}</button> · <button type="button" className="link-btn" style={{ color: 'var(--rust)' }} onClick={() => removeOld(s)}>Delete</button>
              {edit === s.id && <Editor show={s} onDone={() => { setEdit(null); load(series); }} />}</div>
          ))}
          {!adding ? <button type="button" className="btn secondary" style={{ marginTop: 8 }} onClick={() => setAdding({ name: '', startsOn: '', endsOn: '' })}>Add an old show</button> : (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8, alignItems: 'end' }}>
              <label style={{ display: 'grid', gap: 3, fontSize: 13 }}>Name<input style={sel} placeholder="LIS Sydney Feb 2025" value={adding.name} onChange={e => setAdding({ ...adding, name: e.target.value })} /></label>
              <label style={{ display: 'grid', gap: 3, fontSize: 13 }}>First day<input type="date" style={sel} value={adding.startsOn} onChange={e => setAdding({ ...adding, startsOn: e.target.value, endsOn: adding.endsOn || e.target.value })} /></label>
              <label style={{ display: 'grid', gap: 3, fontSize: 13 }}>Last day<input type="date" style={sel} value={adding.endsOn} onChange={e => setAdding({ ...adding, endsOn: e.target.value })} /></label>
              <button type="button" className="btn" disabled={!adding.name || !adding.startsOn} onClick={addOld}>Add</button><button type="button" className="btn secondary" onClick={() => setAdding(null)}>Cancel</button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
