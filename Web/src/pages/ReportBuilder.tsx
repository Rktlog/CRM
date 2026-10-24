import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { apiGet, apiPost, apiPut, apiDelete, apiDownload } from '../lib/api';
import { fmtMoney } from '../lib/types';
import { Col, Definition, Filters, SavedReport, downloadUrl, encodeDef, fileName } from '../lib/reportDefinition';

// Build your own report: pick what it is about, the columns, filters, and (if you like) how to add it up. Preview it,
// download it as Excel, or save it to run again. What you see follows your own states, like the rest of the app.

type Dataset = { key: string; label: string; blurb: string; filters: string[]; columns: Col[] };
type Meta = {
  datasets: Dataset[];
  options: { brands: string[]; productCategories: string[]; accountCategories: string[]; states: string[]; productStatuses: { key: string; label: string }[]; customerStatuses: string[]; reps: string[] };
};
type Preview = { total: number; columns: Col[]; rows: Record<string, string | number | null>[]; truncated: boolean };

const DEFAULT_COLUMNS: Record<string, string[]> = {
  sales: ['orderDate', 'customer', 'brand', 'sku', 'product', 'qty', 'lineTotal'],
  products: ['sku', 'name', 'brand', 'status', 'available', 'onOrder', 'eta'],
  customers: ['name', 'state', 'status', 'rep', 'spend365', 'lastOrder'],
  weekly_activity: ['weekStart', 'rep', 'f2f', 'phone', 'email', 'quotes', 'quoteValue', 'newCustomers', 'reactivated', 'newInDear'],
};

export default function ReportBuilder() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const editId = params.get('id');

  const [meta, setMeta] = useState<Meta | null>(null);
  const [dataset, setDataset] = useState('sales');
  const [columns, setColumns] = useState<Set<string>>(new Set(DEFAULT_COLUMNS.sales));
  const [filters, setFilters] = useState<Filters>({ realOrdersOnly: true });
  const [groupOn, setGroupOn] = useState(false);
  const [groupBy, setGroupBy] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState('');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  const [mine, setMine] = useState(true);

  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    apiGet('/custom-reports/meta').then(setMeta).catch(e => setError(e.message));
  }, []);

  // Opening a saved report fills the form with it.
  useEffect(() => {
    if (!editId) return;
    apiGet('/custom-reports').then((list: SavedReport[]) => {
      const r = list.find(x => x.id === editId);
      if (!r) { setError('That report is not there any more'); return; }
      setDataset(r.definition.dataset); setColumns(new Set(r.definition.columns)); setFilters(r.definition.filters ?? {});
      setGroupOn(r.definition.groupBy.length > 0); setGroupBy(new Set(r.definition.groupBy));
      setSortKey(r.definition.sort?.key ?? ''); setSortDir(r.definition.sort?.dir ?? 'desc');
      setName(r.name); setShared(r.shared); setMine(r.mine);
    }).catch(e => setError(e.message));
  }, [editId]);

  const ds = meta?.datasets.find(d => d.key === dataset);
  const cols = ds?.columns ?? [];
  const dims = cols.filter(c => c.dim);

  function pickDataset(key: string) {
    setDataset(key); setColumns(new Set(DEFAULT_COLUMNS[key])); setFilters(key === 'sales' ? { realOrdersOnly: true } : {});
    setGroupOn(false); setGroupBy(new Set()); setSortKey(''); setPreview(null); setError(null);
  }
  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, k: string) => { const n = new Set(set); n.has(k) ? n.delete(k) : n.add(k); setter(n); };
  const setF = (patch: Partial<Filters>) => { setFilters(f => ({ ...f, ...patch })); setPreview(null); };

  const definition: Definition = useMemo(() => ({
    dataset,
    columns: cols.filter(c => columns.has(c.key)).map(c => c.key),
    filters,
    groupBy: groupOn ? dims.filter(c => groupBy.has(c.key)).map(c => c.key) : [],
    sort: sortKey ? { key: sortKey, dir: sortDir } : undefined,
  }), [dataset, cols, columns, filters, groupOn, groupBy, sortKey, sortDir]);

  function problem(): string | null {
    if (!definition.columns.length) return 'Tick at least one column';
    if (groupOn && !definition.groupBy.length) return 'Pick what to add it up by, or turn adding up off';
    return null;
  }

  async function run() {
    const p = problem(); if (p) { setError(p); return; }
    setBusy('run'); setError(null);
    try { setPreview(await apiGet(`/custom-reports/run?def=${encodeDef(definition)}`)); }
    catch (e) { setError((e as Error).message); setPreview(null); }
    finally { setBusy(null); }
  }
  async function download() {
    const p = problem(); if (p) { setError(p); return; }
    setBusy('download'); setError(null);
    try { await apiDownload(downloadUrl(definition, name.trim() || 'Custom report'), fileName(name)); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  }
  async function save() {
    const p = problem(); if (p) { setError(p); return; }
    if (!name.trim()) { setError('Give the report a name to save it'); return; }
    setBusy('save'); setError(null); setSaved(null);
    try {
      if (editId && mine) await apiPut(`/custom-reports/${editId}`, { name, shared, definition });
      else { const r = await apiPost('/custom-reports', { name, shared, definition }); navigate(`/reports/builder?id=${r.id}`, { replace: true }); }
      setSaved('Saved');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  }
  async function remove() {
    if (!editId || !confirm('Delete this report?')) return;
    setBusy('delete');
    try { await apiDelete(`/custom-reports/${editId}`); navigate('/reports'); }
    catch (e) { setError((e as Error).message); setBusy(null); }
  }

  if (!meta) return <div className="empty-state">{error ?? 'Loading…'}</div>;
  const o = meta.options;
  const groupedCols = definition.groupBy.length ? [...dims.filter(c => groupBy.has(c.key)), { key: 'rows', label: 'Rows', type: 'number' as const }, ...cols.filter(c => columns.has(c.key) && (c.type === 'number' || c.type === 'money') && !groupBy.has(c.key))] : cols.filter(c => columns.has(c.key));
  const filterLabel = (key: string) => ({ brands: 'Brand', states: 'State', categories: ds?.key === 'products' ? 'Category' : 'Customer category', statuses: 'Status', reps: 'Rep' } as Record<string, string>)[key];
  const choices = (key: string): { key: string; label: string }[] =>
    key === 'brands' ? o.brands.map(b => ({ key: b, label: b }))
    : key === 'states' ? o.states.map(s => ({ key: s, label: s }))
    : key === 'categories' ? (ds?.key === 'products' ? o.productCategories : o.accountCategories).map(c => ({ key: c, label: c }))
    : key === 'statuses' ? (ds?.key === 'products' ? o.productStatuses : o.customerStatuses.map(s => ({ key: s, label: s })))
    : o.reps.map(r => ({ key: r, label: r }));

  return (
    <>
      <Link to="/reports" className="order-link">← Reports</Link>
      <h1>{editId ? 'Custom report' : 'Build a report'}</h1>
      {!mine && <div className="save-msg err" style={{ marginBottom: 10 }}>This report is shared with you. You can run it and download it. To change it, save your own copy under a new name.</div>}

      <div className="section">
        <div className="panel-title">1. What is it about?</div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {meta.datasets.map(d => (
            <button key={d.key} type="button" onClick={() => pickDataset(d.key)} className={'btn' + (d.key === dataset ? '' : ' secondary')} style={{ textAlign: 'left', maxWidth: 300 }}>
              <b>{d.label}</b><div style={{ fontSize: 11.5, fontWeight: 400, whiteSpace: 'normal' }}>{d.blurb}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="section">
        <div className="panel-title">2. Columns <span className="plan-count">{columns.size} ticked</span></div>
        <div className="terms-menu-tools" style={{ marginBottom: 6 }}>
          <button type="button" className="link-btn" onClick={() => setColumns(new Set(cols.map(c => c.key)))}>Tick all</button>
          <button type="button" className="link-btn" onClick={() => setColumns(new Set())}>Untick all</button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: '4px 14px' }}>
          {cols.map(c => (
            <label key={c.key} className="pl-check"><input type="checkbox" checked={columns.has(c.key)} onChange={() => toggle(columns, setColumns, c.key)} /><span>{c.label}</span></label>
          ))}
        </div>
      </div>

      <div className="section">
        <div className="panel-title">3. Filters</div>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          {ds?.filters.includes('from') && (
            <>
              <label className="modal-field">{ds?.key === 'weekly_activity' ? 'Weeks from' : 'Order date from'}<input type="date" value={filters.from ?? ''} onChange={e => setF({ from: e.target.value || undefined })} /></label>
              <label className="modal-field">to<input type="date" value={filters.to ?? ''} onChange={e => setF({ to: e.target.value || undefined })} /></label>
            </>
          )}
          {(['brands', 'states', 'categories', 'statuses', 'reps'] as const).filter(k => ds?.filters.includes(k) && (k !== 'reps' || o.reps.length)).map(k => (
            <MultiPick key={k} label={filterLabel(k)} options={choices(k)} value={filters[k] ?? []} onChange={v => setF({ [k]: v.length ? v : undefined })} />
          ))}
        </div>
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginTop: 10 }}>
          {ds?.filters.includes('realOrdersOnly') && <Check label="Real orders only (leave out drafts, quotes and voided)" on={filters.realOrdersOnly !== false} set={v => setF({ realOrdersOnly: v })} />}
          {ds?.filters.includes('inStockOnly') && <Check label="In stock only" on={!!filters.inStockOnly} set={v => setF({ inStockOnly: v || undefined })} />}
          {ds?.filters.includes('includeArchived') && <Check label="Include archived accounts" on={!!filters.includeArchived} set={v => setF({ includeArchived: v || undefined })} />}
        </div>
      </div>

      <div className="section">
        <div className="panel-title">4. Add it up, and order it <span className="plan-count">optional</span></div>
        <Check label="Add it up by group (one row per group, with totals of the number columns)" on={groupOn} set={v => { setGroupOn(v); setPreview(null); }} />
        {groupOn && (
          <div style={{ margin: '8px 0 4px' }}>
            <div className="acct-region" style={{ marginBottom: 4 }}>Group by (the number and money columns you ticked are added up):</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: '4px 14px' }}>
              {dims.map(c => <label key={c.key} className="pl-check"><input type="checkbox" checked={groupBy.has(c.key)} onChange={() => toggle(groupBy, setGroupBy, c.key)} /><span>{c.label}</span></label>)}
            </div>
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
          <span className="acct-region">Order by</span>
          <select value={sortKey} onChange={e => setSortKey(e.target.value)}>
            <option value="">Not ordered</option>
            {groupedCols.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
          <select value={sortDir} onChange={e => setSortDir(e.target.value as 'asc' | 'desc')} disabled={!sortKey}>
            <option value="desc">High to low (newest first)</option>
            <option value="asc">Low to high (oldest first)</option>
          </select>
        </div>
      </div>

      <div className="section">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button type="button" className="btn" disabled={!!busy} onClick={run}>{busy === 'run' ? 'Running…' : 'Preview'}</button>
          <button type="button" className="btn secondary" disabled={!!busy} onClick={download}>{busy === 'download' ? 'Downloading…' : '⬇ Excel'}</button>
          <span style={{ width: 16 }} />
          <input placeholder="Name this report to save it" value={name} onChange={e => { setName(e.target.value); setSaved(null); }} style={{ minWidth: 240 }} />
          <label className="acct-region" style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={shared} onChange={e => setShared(e.target.checked)} /> Share with the team</label>
          <button type="button" className="btn secondary" disabled={!!busy} onClick={save}>{busy === 'save' ? 'Saving…' : editId && mine ? 'Save changes' : editId ? 'Save my copy' : 'Save report'}</button>
          {editId && mine && <button type="button" className="link-btn" disabled={!!busy} onClick={remove}>Delete</button>}
          {saved && <span className="save-msg ok">{saved}</span>}
        </div>
        {error && <div className="save-msg err" style={{ marginTop: 10 }}>{error}</div>}
      </div>

      {preview && (
        <div className="section">
          <div className="panel-title">Preview <span className="plan-count">{preview.total.toLocaleString('en-AU')} {preview.total === 1 ? 'row' : 'rows'}{preview.truncated ? `, first ${preview.rows.length} shown` : ''}</span></div>
          {preview.total === 0 ? <div className="empty-state">Nothing matches those filters.</div> : (
            <div className="ledger-table-scroll tall" style={{ maxHeight: 420 }}>
              <table className="ov-table">
                <thead><tr>{preview.columns.map(c => <th key={c.key} className={c.type === 'number' || c.type === 'money' ? 'num-col' : undefined}>{c.label}</th>)}</tr></thead>
                <tbody>
                  {preview.rows.map((r, i) => (
                    <tr key={i}>{preview.columns.map(c => (
                      <td key={c.key} className={c.type === 'number' || c.type === 'money' ? 'num-col num' : undefined}>{show(r[c.key], c)}</td>
                    ))}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </>
  );
}

function show(v: string | number | null | undefined, c: Col) {
  if (v == null || v === '') return <span className="acct-region">–</span>;
  if (c.type === 'money') return fmtMoney(Number(v));
  if (c.type === 'number') return Number(v).toLocaleString('en-AU', { maximumFractionDigits: 2 });
  return String(v);
}

function Check({ label, on, set }: { label: string; on: boolean; set: (v: boolean) => void }) {
  return <label className="acct-region" style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={on} onChange={e => set(e.target.checked)} /> {label}</label>;
}

// A "tick the ones you want" dropdown. Nothing ticked means all of them.
function MultiPick({ label, options, value, onChange }: { label: string; options: { key: string; label: string }[]; value: string[]; onChange: (v: string[]) => void }) {
  const set = new Set(value);
  const flip = (k: string) => { const n = new Set(set); n.has(k) ? n.delete(k) : n.add(k); onChange([...n]); };
  return (
    <div className="modal-field">
      {label}
      <details className="terms-filter">
        <summary>{value.length === 0 ? `All` : value.length === 1 ? options.find(o => o.key === value[0])?.label ?? value[0] : `${value.length} picked`}</summary>
        <div className="terms-menu" style={{ maxHeight: 260, overflowY: 'auto' }}>
          <div className="terms-menu-tools"><button type="button" className="link-btn" onClick={() => onChange([])}>All</button></div>
          {options.map(o => <label key={o.key} className="pl-check"><input type="checkbox" checked={set.has(o.key)} onChange={() => flip(o.key)} /><span>{o.label}</span></label>)}
        </div>
      </details>
    </div>
  );
}