import { useEffect, useMemo, useRef, useState } from 'react';
import { apiGet } from '../lib/api';
import OrderingExport from '../components/OrderingExport';
import { useMe } from '../lib/useMe';
import { fmtDate } from '../lib/types';
import { distinct, filterRows, NO_FILTERS, STATUS_LABEL, STATUS_TONE, TABS, toCsv, type Filters, type OrderingData, type OrderRow, type Settings, type Tab } from '../lib/ordering';

// Ordering: what to order, how much, and how urgent, worked out from the CRM database (DEAR is synced into it), so nothing is exported or pasted.
// Stock, customers waiting on a backorder, purchase orders still to arrive, and what customers have ordered each month all come from the database.
// The forecast is worked out by code and backtested on recent months, the same one the Assistant uses, and each row says how far to trust it.

const DEFAULTS: Settings = { lead: 3, cover: 3, plan: 'expected', history: 24 };
const SAVED = 'ordering.settings';
const COLS = '2.3fr 0.9fr 0.7fr 0.7fr 1fr 0.9fr 0.7fr 0.8fr 0.9fr';
const CONTROL = { padding: '7px 10px', border: '1px solid var(--line)', borderRadius: 6, font: 'inherit', fontSize: 13, background: 'var(--panel)' } as const;
const PAGE = 200;
const n0 = (v: number) => Math.round(v).toLocaleString('en-AU');
const months = (v: number | null) => (v == null ? '—' : v > 36 ? '36+' : String(v));

function savedSettings(): Settings {
  try { const s = JSON.parse(localStorage.getItem(SAVED) ?? 'null'); if (s && typeof s.lead === 'number' && typeof s.cover === 'number') return { ...DEFAULTS, ...s }; } catch { /* no saved settings, or storage is off */ }
  return DEFAULTS;
}

export default function Ordering() {
  const me = useMe();
  const [set, setSet] = useState<Settings>(savedSettings);
  const [data, setData] = useState<OrderingData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [f, setF] = useState<Filters>(NO_FILTERS);
  const [open, setOpen] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [shown, setShown] = useState(PAGE);
  const latest = useRef(0);   // only the newest request may fill the page, never a slower older one

  useEffect(() => {
    if (me && me.role !== 'manager') return;
    try { localStorage.setItem(SAVED, JSON.stringify(set)); } catch { /* storage off: settings just are not remembered */ }
    const t = setTimeout(() => {
      const mine = ++latest.current;
      setLoading(true); setError(null);
      apiGet(`/ordering?lead=${set.lead}&cover=${set.cover}&plan=${set.plan}&history=${set.history}`)
        .then((d: OrderingData) => { if (latest.current === mine) { setData(d); setLoading(false); } })
        .catch((e: Error) => { if (latest.current === mine) { setError(e.message); setLoading(false); } });
    }, 400);   // typing a number should not ask the server for every digit
    return () => clearTimeout(t);
  }, [set, me?.role]);
  useEffect(() => { setShown(PAGE); }, [f]);

  const stageLabel = useMemo(() => { const m = new Map((data?.stages ?? []).map(s => [s.key, s.label])); return (k: string | null) => (k ? m.get(k) ?? k : ''); }, [data]);
  const rows = data?.rows ?? [];
  const list = useMemo(() => filterRows(rows, f), [rows, f]);
  const brands = useMemo(() => distinct(rows, r => r.brand), [rows]), categories = useMemo(() => distinct(rows, r => r.category), [rows]), suppliers = useMemo(() => distinct(rows, r => r.supplier), [rows]);
  const stagesUsed = useMemo(() => [...new Set(rows.map(r => r.stage).filter((s): s is string => !!s))].sort((a, b) => stageLabel(a).localeCompare(stageLabel(b))), [rows, stageLabel]);
  const on = (patch: Partial<Filters>) => setF(x => ({ ...x, ...patch }));
  const filtered = f.search || f.brand || f.category || f.stage || f.supplier || f.outOnly || f.waitingOnly;

  function download() {
    const blob = new Blob(['\ufeff' + toCsv(list, stageLabel)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = `ordering-${data?.asOf ?? 'plan'}.csv`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  if (me && me.role !== 'manager') return <div className="empty-state">Ordering is for managers.</div>;
  if (error && !data) return <div className="empty-state">Couldn't load the ordering plan: {error}</div>;
  if (!data) return <div className="empty-state">Working out the plan…</div>;
  const s = data.summary;
  const syncedAgo = data.stockSyncedAt ? Math.round((Date.now() - new Date(data.stockSyncedAt).getTime()) / 3600000) : null;
  const card = (tab: Tab, label: string, value: string, sub: string, flag: string) => (
    <button type="button" className={`stat flag-${flag} clickable`} onClick={() => on({ tab })} style={{ all: 'unset', boxSizing: 'border-box', cursor: 'pointer', background: 'var(--panel)', border: '1px solid var(--line)', borderLeft: `3px solid var(--${flag})`, borderRadius: 4, padding: '12px 14px' }}>
      <div className="stat-label">{label}</div><div className="stat-value num">{value}</div><div className="stat-sub">{sub}</div>
    </button>
  );

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
        <h1>Ordering</h1>
        <span style={{ display: 'flex', gap: 8 }}>
          <button className="btn secondary" aria-expanded={exporting} onClick={() => setExporting(x => !x)}>{exporting ? 'Hide export' : 'Export reports'}</button>
          <button className="btn secondary" disabled={!list.length} onClick={download}>Download CSV ({list.length.toLocaleString('en-AU')})</button>
        </span>
      </div>
      <div className="acct-region" style={{ maxWidth: 760, marginBottom: 12 }}>
        What to order and when, from what customers have ordered, what is in stock, what customers are waiting for and what is already on purchase orders.
        Stock last synced {syncedAgo == null ? 'at an unknown time' : syncedAgo < 1 ? 'less than an hour ago' : `${syncedAgo} hour${syncedAgo === 1 ? '' : 's'} ago`}.
        {syncedAgo != null && syncedAgo > 36 && <b style={{ color: 'var(--rust)' }}> The stock figures look old: check the sync before ordering.</b>}
      </div>

      {exporting && <OrderingExport />}

      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'end' }}>
          <label className="acct-region">Lead time (months)<br />
            <input type="number" min={0} max={11.5} step={0.5} value={set.lead} onChange={e => setSet(x => ({ ...x, lead: Math.min(11.5, Math.max(0, Number(e.target.value) || 0)) }))} style={{ ...CONTROL, width: 90 }} aria-label="Lead time in months" />
          </label>
          <label className="acct-region">Stock to last after it arrives (months)<br />
            <input type="number" min={0.5} max={12} step={0.5} value={set.cover} onChange={e => setSet(x => ({ ...x, cover: Math.min(12, Math.max(0.5, Number(e.target.value) || 0.5)) }))} style={{ ...CONTROL, width: 90 }} aria-label="Cover in months" />
          </label>
          <label className="acct-region">Plan for<br />
            <select value={set.plan} onChange={e => setSet(x => ({ ...x, plan: e.target.value as Settings['plan'] }))} style={CONTROL} aria-label="Plan for">
              <option value="expected">Expected demand</option><option value="high">A busy period (cautious)</option>
            </select>
          </label>
          <label className="acct-region">Order history used<br />
            <select value={set.history} onChange={e => setSet(x => ({ ...x, history: Number(e.target.value) }))} style={CONTROL} aria-label="History used">
              {[12, 18, 24, 36].map(m => <option key={m} value={m}>{m} months</option>)}
            </select>
          </label>
          {loading && <span className="acct-region" role="status">Updating…</span>}
        </div>
        <div className="acct-region" style={{ marginTop: 8, maxWidth: 760 }}>
          The order quantity covers what customers are expected to order over the lead time plus the cover, plus anything customers are waiting for, less what is available
          and already on order. It is rounded up to the product's order increment. {s.basis}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12, marginBottom: 14 }}>
        {card('now', 'Order now', n0(s.now), 'will run out before an order could arrive', 'rust')}
        {card('soon', 'Order soon', n0(s.soon), 'within about a month of the lead time', 'amber')}
        {card('to_order', 'Units to order', n0(s.unitsToOrder), `across ${n0(s.skusToOrder)} products`, 'teal')}
        {card('to_order', 'Customers waiting', n0(s.backorderedUnits), `units, ${n0(s.backorderedSkus)} products`, 'rust')}
        {card('overstock', 'Overstock', n0(s.overstock), 'more than 12 months of cover', 'amber')}
      </div>

      <div className="tab-bar" style={{ margin: '0 0 10px', flexWrap: 'wrap' }}>
        {TABS.map(t => <button key={t.key} className={'tab' + (f.tab === t.key ? ' active' : '')} onClick={() => on({ tab: t.key })}>{t.label}</button>)}
      </div>
      <div className="controls" style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', margin: '0 0 12px' }}>
        <input type="search" placeholder="Search SKU, product or brand" value={f.search} onChange={e => on({ search: e.target.value })} style={{ ...CONTROL, minWidth: 220, flex: '1 1 220px', maxWidth: 340 }} />
        <select aria-label="Brand" value={f.brand} onChange={e => on({ brand: e.target.value })} style={CONTROL}><option value="">All brands</option>{brands.map(b => <option key={b} value={b}>{b}</option>)}</select>
        <select aria-label="Category" value={f.category} onChange={e => on({ category: e.target.value })} style={CONTROL}><option value="">All categories</option>{categories.map(b => <option key={b} value={b}>{b}</option>)}</select>
        <select aria-label="Stage" value={f.stage} onChange={e => on({ stage: e.target.value })} style={CONTROL}><option value="">All stages</option><option value="__none">No stage</option>{stagesUsed.map(k => <option key={k} value={k}>{stageLabel(k)}</option>)}</select>
        <select aria-label="Supplier" value={f.supplier} onChange={e => on({ supplier: e.target.value })} style={CONTROL}><option value="">All suppliers</option>{suppliers.map(b => <option key={b} value={b}>{b}</option>)}</select>
        <label className="pl-check"><input type="checkbox" checked={f.outOnly} onChange={e => on({ outOnly: e.target.checked })} /><span>Out of stock</span></label>
        <label className="pl-check"><input type="checkbox" checked={f.waitingOnly} onChange={e => on({ waitingOnly: e.target.checked })} /><span>Customers waiting</span></label>
        {filtered && <button className="edit-link" onClick={() => setF(x => ({ ...NO_FILTERS, tab: x.tab }))}>Clear filters</button>}
      </div>
      {error && <div className="save-msg err" role="alert" style={{ marginBottom: 10 }}>Could not update: {error}</div>}

      {!list.length ? (
        <div className="empty-state">{rows.length ? 'Nothing matches those filters.' : 'No products to plan yet.'}</div>
      ) : (
        <div className="manifest" style={{ opacity: loading ? 0.6 : 1 }}>
          <div className="m-row head" style={{ gridTemplateColumns: COLS }}>
            <div>Product</div><div>Stage</div><div className="num">Available</div><div className="num">Waiting</div><div>On order</div><div className="num">Sells / month</div><div className="num">Cover (mo)</div><div className="num">Order</div><div>Status</div>
          </div>
          {list.slice(0, shown).map(r => <Row key={r.sku} r={r} stage={stageLabel(r.stage)} open={open === r.sku} toggle={() => setOpen(open === r.sku ? null : r.sku)} lead={data.settings.lead} />)}
        </div>
      )}
      {list.length > shown && <button className="edit-link" style={{ marginTop: 10 }} onClick={() => setShown(x => x + PAGE)}>Show more ({(list.length - shown).toLocaleString('en-AU')} more)</button>}
      {data.truncated && <div className="acct-region" style={{ marginTop: 10 }}>Showing the first 6,000 products by priority.</div>}

      <details style={{ marginTop: 18, maxWidth: 820 }}>
        <summary className="acct-region" style={{ cursor: 'pointer' }}>Where these numbers come from</summary>
        <div className="acct-region" style={{ marginTop: 6 }}>
          Everything is read from the CRM database, which DEAR syncs into. <b>Stock</b> (on hand, allocated, available): the product's stock as last synced.
          <b> Sells per month and the forecast</b>: units on orders by order date, the same history and rules as the Assistant's sales forecast (drafts, voided and sample orders are left out), so
          quiet months count as zero. <b>Waiting</b>: units on orders not yet shipped that DEAR shows as backordered. <b>On order</b>: what is still to arrive on purchase orders
          (voided and fully received ones are ignored), or DEAR's on-order figure when a product has no purchase order lines; the date is the earliest required-by date.
          <b> On quotes</b> is shown in the row detail and is not counted as demand. Stock movement history is not used. Products on their way out (EOL, Discontinued, Phasing Out,
          For Customer Only Then Cease) are never suggested for reorder. The forecast cannot know about a promotion, a new range or a stock-out that held orders back, so check
          rows marked Low confidence or short history by hand.
        </div>
      </details>
    </>
  );
}

function Row({ r, stage, open, toggle, lead }: { r: OrderRow; stage: string; open: boolean; toggle: () => void; lead: number }) {
  return (
    <>
      <div className={'m-row' + (open ? ' open' : '')} style={{ gridTemplateColumns: COLS }} onClick={toggle} role="button" tabIndex={0} aria-expanded={open}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }}>
        <div>
          <div className="acct-name">{r.product}</div>
          <div className="acct-region">{r.sku}{r.brand ? ` · ${r.brand}` : ''}</div>
        </div>
        <div>{stage ? <span className="pill neutral">{stage}</span> : <span className="acct-region">—</span>}</div>
        <div className="num" style={r.out ? { color: 'var(--rust)', fontWeight: 600 } : undefined}>{n0(r.available)}</div>
        <div className="num" style={r.backordered > 0 ? { color: 'var(--rust)', fontWeight: 600 } : undefined}>{r.backordered > 0 ? n0(r.backordered) : '—'}</div>
        <div>{r.onOrder > 0 ? <>{n0(r.onOrder)}{r.nextArrival && <div className="acct-region">due {fmtDate(r.nextArrival)}</div>}</> : <span className="acct-region">—</span>}</div>
        <div className="num">{r.forecastPerMonth > 0 ? r.forecastPerMonth : '—'}{r.last3Avg > 0 && <div className="acct-region">last 3: {r.last3Avg}</div>}</div>
        <div className="num">{months(r.coverMonths)}</div>
        <div className="num" style={{ fontWeight: 600 }}>{r.suggested > 0 ? n0(r.suggested) : '—'}</div>
        <div><span className={`pill ${STATUS_TONE[r.status]}`}>{STATUS_LABEL[r.status]}</span></div>
      </div>
      {open && (
        <div className="m-row" style={{ gridTemplateColumns: '1fr', background: 'var(--paper)', cursor: 'default' }} onClick={e => e.stopPropagation()}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, fontSize: 13 }}>
            <div>
              <div className="stat-label">Units ordered, last {r.history12.length} months</div>
              <div style={{ fontVariantNumeric: 'tabular-nums' }}>{r.history12.length ? r.history12.join(' · ') : 'No sales in the history used'}</div>
              <div className="stat-label" style={{ marginTop: 8 }}>Forecast, next {r.forecast6.length} months</div>
              <div style={{ fontVariantNumeric: 'tabular-nums' }}>{r.forecast6.length ? r.forecast6.join(' · ') : '—'}</div>
            </div>
            <div>
              <div className="stat-label">Stock</div>
              <div>On hand {n0(r.onHand)} · allocated {n0(r.allocated)} · available {n0(r.available)}</div>
              <div>On open quotes {n0(r.onQuotes)}{r.supplier ? ` · supplier ${r.supplier}` : ''}{r.increment && r.increment > 1 ? ` · orders in ${r.increment}s` : ''}</div>
              <div>{r.runOutMonths == null ? 'No forecast sales' : `Stock runs out in about ${r.runOutMonths} months (lead time ${lead})`}</div>
            </div>
            <div style={{ maxWidth: 420 }}>
              <div className="stat-label">How far to trust it</div>
              <div>{r.method}. {r.confidence} confidence{r.accuracyPct != null ? `, ${r.accuracyPct}% accurate on recent months` : ''}. {r.monthsOfHistory} month{r.monthsOfHistory === 1 ? '' : 's'} of history.</div>
              {r.notes && <div style={{ color: 'var(--ink-soft)', marginTop: 4 }}>{r.notes}</div>}
            </div>
          </div>
        </div>
      )}
    </>
  );
}