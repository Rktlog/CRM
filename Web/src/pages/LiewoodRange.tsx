import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from 'react';
import { Link } from 'react-router-dom';
import { apiGet, apiPatch } from '../lib/api';
import { useMe } from '../lib/useMe';
import { PRICE_CHECK, sendFile, shortDay, type PriceCheck, type RangeImport, type RangeItem, type RangeView, type SeasonImport } from '../lib/liewood';

// The Liewood range (Products, Liewood, Range): one row per Liewood SKU, in place of the Product Range List tab of the Liewood Master File.
// Managers import that tab once, then add each season's files (Liewood's Product Data file, the Customer Forecast Form). Every sales order
// uploaded on the Liewood page then fills its SKUs in from those files. Managers type in the delivery to Australia, ranged and the proposed RRP here.
const th: CSSProperties = { textAlign: 'left', fontSize: 12.5, color: 'var(--muted)', fontWeight: 500, padding: '7px 8px', borderBottom: '1px solid var(--line)', whiteSpace: 'nowrap', position: 'sticky', top: 0, background: 'var(--panel)' };
const td: CSSProperties = { padding: '6px 8px', borderBottom: '1px solid var(--line)', fontSize: 13, verticalAlign: 'top' };
const num: CSSProperties = { ...td, textAlign: 'right', whiteSpace: 'nowrap' };
const field: CSSProperties = { padding: '5px 8px', border: '1px solid var(--line)', borderRadius: 3, font: 'inherit', fontSize: 13.5 };
const aud = (n: number | null | undefined) => (n == null ? '' : `$${n.toFixed(2)}`);
const eur = (n: number | null | undefined) => (n == null ? '' : `€${n.toFixed(2)}`);
const PAGE = 300;

/** A cell a manager can type in. It saves when you leave it, if it changed. */
function EditCell({ value, width, onSave, placeholder }: { value: string; width: number; onSave: (v: string) => Promise<void>; placeholder?: string }) {
  const [v, setV] = useState(value), [state, setState] = useState<'idle' | 'saving' | 'error'>('idle');
  useEffect(() => { setV(value); }, [value]);
  const save = async () => {
    if (v.trim() === value.trim()) return;
    setState('saving');
    try { await onSave(v.trim()); setState('idle'); } catch (e) { setState('error'); window.alert((e as Error).message); setV(value); }
  };
  return <input value={v} placeholder={placeholder} onChange={e => setV(e.target.value)} onBlur={save} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setV(value); }}
    style={{ ...field, width, padding: '3px 6px', fontSize: 13, opacity: state === 'saving' ? 0.5 : 1, borderColor: state === 'error' ? 'var(--rust)' : 'var(--line)' }} />;
}

/** A box to drop one file in (or choose it). */
function Drop({ title, hint, busy, onFile, accept }: { title: string; hint: string; busy: boolean; onFile: (f: File) => void; accept: string }) {
  const [over, setOver] = useState(false), input = useRef<HTMLInputElement>(null);
  const drop = (e: DragEvent) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files?.[0]; if (f) onFile(f); };
  return (
    <div onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={drop}
      style={{ flex: '1 1 300px', border: `2px dashed ${over ? 'var(--teal)' : 'var(--line)'}`, borderRadius: 6, padding: '16px 14px', background: over ? 'var(--teal-bg)' : 'var(--panel)', textAlign: 'center' }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{title}</div>
      <div className="acct-region" style={{ fontSize: 13, marginBottom: 8 }}>{hint}</div>
      <button type="button" className="btn secondary" disabled={busy} onClick={() => input.current?.click()}>{busy ? 'Reading…' : 'Choose the file'}</button>
      <input ref={input} type="file" accept={accept} hidden onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
    </div>
  );
}

export default function LiewoodRange() {
  const me = useMe(), isManager = me?.role === 'manager';
  const [data, setData] = useState<RangeView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState(''), [ranged, setRanged] = useState('all'), [check, setCheck] = useState<'all' | PriceCheck>('all'), [season, setSeason] = useState('all'), [onOrders, setOnOrders] = useState(false);
  const [limit, setLimit] = useState(PAGE);

  const load = useCallback(() => { apiGet('/liewood/range', { fresh: true }).then((d: RangeView) => { setData(d); setErr(null); }).catch((e: Error) => setErr(e.message)); }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setLimit(PAGE); }, [q, ranged, check, season, onOrders]);

  async function importList(f: File) {
    if (busy) return;
    if (!/\.(xlsx|csv)$/i.test(f.name)) { setMsg({ ok: false, text: 'Add the Product Range List tab as a CSV (File, Download, CSV in Google Sheets) or an Excel file.' }); return; }
    if (data?.items.length && !window.confirm('Import the Product Range List? Every SKU in the file is added, or replaced with what the file says (including the delivery to Australia and ranged). SKUs not in the file stay as they are.')) return;
    setBusy(true); setMsg(null);
    try {
      const r = await sendFile<RangeImport>('/liewood/range/import', f);
      const notes = [r.noSku ? `${r.noSku} rows without a SKU (displays, marketing pieces) were left out` : '', r.duplicates.length ? `${r.duplicates.length} SKUs are in the file twice; the lower row was used (${r.duplicates.slice(0, 5).join(', ')})` : '', ...r.problems.slice(0, 3)].filter(Boolean);
      setMsg({ ok: true, text: `Imported ${r.rows.toLocaleString('en-AU')} SKUs: ${r.added} new, ${r.updated} updated.${notes.length ? ' ' + notes.join('. ') + '.' : ''}` });
      load();
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); } finally { setBusy(false); }
  }
  async function addSeasonFile(f: File) {
    if (busy) return;
    if (!/\.xlsx$/i.test(f.name)) { setMsg({ ok: false, text: 'Add the season file as Excel (.xlsx): Liewood\'s Product Data file, or the Customer Forecast Form.' }); return; }
    setBusy(true); setMsg(null);
    try {
      const r = await sendFile<SeasonImport>('/liewood/range/season-file', f);
      const what = r.kind === 'forecast' ? 'Customer Forecast Form' : 'Liewood Product Data file';
      setMsg({ ok: true, text: `${what} added: ${r.skus.toLocaleString('en-AU')} SKUs (from ${r.tabs.join(', ')}). ${r.onOrders ? `${r.onOrders} of them are on uploaded sales orders: ${r.fed.added} added to the range, ${r.fed.updated} brought up to date.` : 'None of them is on an uploaded sales order yet: they go into the range when their sales order is uploaded.'}${r.problems.length ? ' ' + r.problems.slice(0, 3).join(' ') : ''}` });
      load();
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); } finally { setBusy(false); }
  }
  const save = (sku: string, patch: Record<string, unknown>) => async () => { await apiPatch('/liewood/range', { sku, ...patch }); };
  const setItem = (sku: string, patch: Partial<RangeItem>) => setData(d => (d ? { ...d, items: d.items.map(i => (i.sku === sku ? { ...i, ...patch } : i)) } : d));

  const items = data?.items ?? [];
  const seasons = useMemo(() => [...new Set(items.map(i => i.season ?? ''))].filter(Boolean).sort(), [items]);
  const shown = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return items.filter(i => {
      if (ranged !== 'all' && (ranged === 'blank' ? !!i.ranged : (i.ranged ?? '').toUpperCase() !== ranged)) return false;
      if (check !== 'all' && i.check !== check) return false;
      if (season !== 'all' && i.season !== season) return false;
      if (onOrders && !i.orderedTotal) return false;
      if (words.length) { const hay = [i.sku, i.ean, i.name, i.colour, i.category, i.productType].join(' ').toLowerCase(); if (!words.every(w => hay.includes(w))) return false; }
      return true;
    });
  }, [items, q, ranged, check, season, onOrders]);
  const rangedValues = useMemo(() => [...new Set(items.map(i => (i.ranged ?? '').toUpperCase()).filter(Boolean))].sort(), [items]);
  const counts = useMemo(() => { const c: Record<string, number> = {}; for (const i of items) c[i.check] = (c[i.check] ?? 0) + 1; return c; }, [items]);

  return (
    <>
      <p style={{ margin: '0 0 6px' }}><Link to="/liewood">← Liewood orders</Link></p>
      <h1>Liewood range</h1>
      <div className="acct-region" style={{ marginBottom: 14, maxWidth: 820 }}>
        Every Liewood SKU in the range, in place of the Product Range List in the Liewood Master File. When a sales order is uploaded on the Liewood page, its SKUs are filled in here from the season files below:
        the EUR price (STOCK, or PRE when there is no STOCK price) and the drop delivery from Liewood's Product Data file; the order increment and category from the Customer Forecast Form.
        The delivery to Australia, ranged and the proposed RRP are typed in here and never changed by a file.
      </div>

      {isManager && (
        <div className="section">
          <div className="panel-title">Add files</div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', maxWidth: 900 }}>
            <Drop title="Product Range List" hint="Once, to start: that tab of the Liewood Master File as a CSV (File, Download, CSV) or Excel." accept=".csv,.xlsx" busy={busy} onFile={f => void importList(f)} />
            <Drop title="A season file" hint="Each season: Liewood's Product Data file, and the Customer Forecast Form (.xlsx, every tab is read)." accept=".xlsx" busy={busy} onFile={f => void addSeasonFile(f)} />
          </div>
          {msg && <div className={msg.ok ? 'save-msg ok' : 'save-msg err'} role={msg.ok ? 'status' : 'alert'} style={{ maxWidth: 900 }}>{msg.text}</div>}
          {data && data.files.length > 0 && (
            <div className="acct-region" style={{ marginTop: 10, fontSize: 13 }}>
              Season files in Radar: {data.files.map((f, k) => <span key={k}>{k ? '; ' : ''}{f.file} ({f.kind === 'forecast' ? 'Forecast Form' : 'Product Data'}, {f.skus.toLocaleString('en-AU')} SKUs, {shortDay(f.at)})</span>)}
            </div>
          )}
        </div>
      )}

      <div className="section">
        {err && <div className="save-msg err" role="alert">{err}</div>}
        {!err && !data && <div className="acct-region">Loading…</div>}
        {data && data.orderSkusNotInRange > 0 && (
          <div className="save-msg err" style={{ maxWidth: 900 }}>{data.orderSkusNotInRange} SKU{data.orderSkusNotInRange === 1 ? ' is' : 's are'} on uploaded Liewood sales orders but not in the range. Import the Product Range List for older SKUs, and add the season's Product Data file and Customer Forecast Form for new ones.</div>
        )}
        {data && items.length === 0 && <div className="empty-state">The range is empty.{isManager ? ' Import the Product Range List above to start it.' : ''}</div>}
        {items.length > 0 && (
          <>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
              <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search SKU, EAN, name, colour" style={{ ...field, width: 260 }} />
              <select value={ranged} onChange={e => setRanged(e.target.value)} style={field}>
                <option value="all">Ranged: all</option>
                {rangedValues.map(v => <option key={v} value={v}>Ranged: {v}</option>)}
                <option value="blank">Ranged: not decided</option>
              </select>
              <select value={check} onChange={e => setCheck(e.target.value as 'all' | PriceCheck)} style={field}>
                <option value="all">Price check: all</option>
                {(Object.keys(PRICE_CHECK) as PriceCheck[]).map(k => <option key={k} value={k}>{PRICE_CHECK[k].label} ({counts[k] ?? 0})</option>)}
              </select>
              <select value={season} onChange={e => setSeason(e.target.value)} style={field}>
                <option value="all">Season: all</option>
                {seasons.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              <label style={{ fontSize: 13, display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={onOrders} onChange={e => setOnOrders(e.target.checked)} /> On uploaded orders</label>
              <span className="acct-region" style={{ fontSize: 13 }}>{shown.length.toLocaleString('en-AU')} of {items.length.toLocaleString('en-AU')} SKUs</span>
            </div>
            <div style={{ overflow: 'auto', maxHeight: '75vh', border: '1px solid var(--line)', borderRadius: 4, background: 'var(--panel)' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>
                  <th style={th}>SKU</th><th style={th}>Name</th><th style={th}>Colour</th><th style={th}>Season</th><th style={th}>Category</th><th style={th}>Ranged</th>
                  <th style={{ ...th, textAlign: 'right' }} title="Order increment (Master File column L)">Incr.</th>
                  <th style={th} title="Drop delivery to EUR (Master File column M), from Liewood's Product Data file">Drop EUR</th>
                  <th style={th} title="Drop delivery to Australia (Master File column O), typed in">Drop AUS</th>
                  {isManager && <th style={{ ...th, textAlign: 'right' }} title="Liewood's wholesale price in EUR: STOCK, or PRE when there is no STOCK price">W/S EUR</th>}
                  <th style={{ ...th, textAlign: 'right' }}>Proposed RRP</th><th style={{ ...th, textAlign: 'right' }}>DEAR RRP</th><th style={th}>Price check</th>
                  <th style={{ ...th, textAlign: 'right' }} title="Units on the uploaded Liewood sales orders">Ordered</th><th style={{ ...th, textAlign: 'right' }}>DEAR available</th>
                </tr></thead>
                <tbody>
                  {shown.slice(0, limit).map(i => (
                    <tr key={i.sku}>
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>{i.sku}{i.ean && <div className="acct-region" style={{ fontSize: 11.5 }}>{i.ean}</div>}</td>
                      <td style={td}>{i.name}{i.essential && /^yes$/i.test(i.essential) && <> <span className="pill teal">Essential</span></>}</td>
                      <td style={td}>{i.colour}</td>
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>{i.season}</td>
                      <td style={td}>{i.category}{i.productType && <div className="acct-region" style={{ fontSize: 11.5 }}>{i.productType}</div>}</td>
                      <td style={td}>{isManager ? <EditCell value={i.ranged ?? ''} width={70} placeholder="Y / N" onSave={async v => { await save(i.sku, { ranged: v })(); setItem(i.sku, { ranged: v || null }); }} /> : i.ranged}</td>
                      <td style={num}>{i.orderIncrement ?? ''}</td>
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>{i.dropEur}</td>
                      <td style={td}>{isManager ? <EditCell value={i.dropAus ?? ''} width={110} placeholder="e.g. July 2026" onSave={async v => { await save(i.sku, { dropAus: v })(); setItem(i.sku, { dropAus: v || null }); }} /> : i.dropAus}</td>
                      {isManager && <td style={num}>{eur(i.wspEur)}</td>}
                      <td style={num}>{isManager
                        ? <EditCell value={i.proposedRrp == null ? '' : i.proposedRrp.toFixed(2)} width={72} onSave={async v => { await save(i.sku, { proposedRrp: v })(); const p = v ? Math.round(Number(v.replace(/[$,]/g, '')) * 100) / 100 : null; setItem(i.sku, { proposedRrp: p, check: !i.inDear || i.dearRrp == null ? 'not_in_dear' : p == null ? 'no_proposed' : Math.abs(p - i.dearRrp) < 0.005 ? 'match' : 'differs' }); }} />
                        : aud(i.proposedRrp)}</td>
                      <td style={num}>{aud(i.dearRrp)}</td>
                      <td style={td}><span className={`pill ${PRICE_CHECK[i.check].tone}`}>{PRICE_CHECK[i.check].label}</span></td>
                      <td style={num} title={i.ordered.map(o => `${o.so}: ${o.qty}`).join('\n')}>{i.orderedTotal || ''}</td>
                      <td style={num}>{i.inDear ? (i.available ?? 0).toLocaleString('en-AU') : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {shown.length > limit && <div style={{ marginTop: 8 }}><button type="button" className="btn secondary" onClick={() => setLimit(l => l + PAGE)}>Show {Math.min(PAGE, shown.length - limit)} more</button></div>}
            <div className="acct-region" style={{ marginTop: 8, fontSize: 13 }}>Hover over Ordered to see each sales order. DEAR RRP and stock come from DEAR every hour. Nothing here changes DEAR.</div>
          </>
        )}
      </div>
    </>
  );
}
