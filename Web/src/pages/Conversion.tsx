import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { apiGet, apiDownload } from '../lib/api';
import { fmtDate, fmtMoney } from '../lib/types';
import { Period, decodePeriod, encodePeriod, periodLabel, conversionQuery } from '../lib/period';
import ConversionFilters from '../components/ConversionFilters';

// Conversion detail: the customers behind each number on the Dashboard. Pick a funnel, then
// who started, who ordered, who got a sales quote, or who has not converted yet. Open any
// customer, order or quote. Filter by period (days, month, fiscal quarter) and by state.

type Row = {
  who: string; state: string; rep: string | null; started: string; email?: string; cartValue?: number; accountId: string | null;
  orderId: string | null; orderNo: string | null; orderDate: string | null; quoteId: string | null; quoteNo: string | null; quoteDate: string | null;
};
type Funnel = { key: string; title: string; description: string; started: number; orders: number; quotes: number };
type Outcome = 'started' | 'order' | 'quote' | 'none';
type SortKey = 'who' | 'state' | 'started';
const COLS = '1.7fr 0.5fr 0.8fr 0.8fr 1.1fr 1.1fr';
const SHORT: Record<string, string> = { abandoned_cart: 'Abandoned Cart', prospect: 'Prospect added to DEAR', new_lead: 'New Lead', inactive_stockist: 'Inactive Stockist' };
const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 1000) / 10}%` : '0%');

export default function Conversion() {
  const [params, setParams] = useSearchParams();
  const funnelKey = params.get('funnel') ?? 'abandoned_cart';
  const outcome = (['started', 'order', 'quote', 'none'].includes(params.get('outcome') ?? '') ? params.get('outcome') : 'started') as Outcome;
  const period = useMemo(() => decodePeriod(params.get('period')), [params]);
  const region = params.get('region') ?? '';
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('started');
  const [sortDir, setSortDir] = useState<1 | -1>(-1);

  const [funnels, setFunnels] = useState<Funnel[] | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  // The URL holds the choices, so a link opens exactly this view and Back works.
  const set = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) { if (v) next.set(k, v); else next.delete(k); }
    setParams(next, { replace: true });
  };
  const query = conversionQuery(period, region);

  useEffect(() => {
    setError(null);
    apiGet(`/conversion?${query}`).then(d => setFunnels(d.funnels)).catch(e => setError(e.message));
  }, [query]);
  useEffect(() => {
    setRows(null);
    apiGet(`/conversion?${query}&funnel=${funnelKey}&detail=1`).then(d => setRows(d.funnel.rows)).catch(e => setError(e.message));
  }, [query, funnelKey]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) setSortDir(d => (d === -1 ? 1 : -1));
    else { setSortKey(key); setSortDir(key === 'started' ? -1 : 1); }
  }
  const arrow = (key: SortKey) => (sortKey === key ? (sortDir === -1 ? ' ↓' : ' ↑') : '');

  const counts = useMemo(() => ({
    started: rows?.length ?? 0,
    order: rows?.filter(r => r.orderNo).length ?? 0,
    quote: rows?.filter(r => r.quoteNo).length ?? 0,
    none: rows?.filter(r => !r.orderNo && !r.quoteNo).length ?? 0,
  }), [rows]);

  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const list = (rows ?? []).filter(r =>
      (outcome === 'started' || (outcome === 'order' && r.orderNo) || (outcome === 'quote' && r.quoteNo) || (outcome === 'none' && !r.orderNo && !r.quoteNo))
      && (!needle || [r.who, r.rep ?? '', r.state, r.email ?? '', r.orderNo ?? '', r.quoteNo ?? ''].some(v => v.toLowerCase().includes(needle))));
    return list.sort((a, b) => {
      const cmp = sortKey === 'who' ? a.who.localeCompare(b.who) : sortKey === 'state' ? a.state.localeCompare(b.state) : new Date(a.started).getTime() - new Date(b.started).getTime();
      return sortDir === 1 ? cmp : -cmp;
    });
  }, [rows, outcome, search, sortKey, sortDir]);

  async function download() {
    setDownloading(true);
    try { await apiDownload(`/exports/conversion?${query}`, 'conversion.xlsx'); }
    catch { alert('Download failed. Check the API is running.'); }
    finally { setDownloading(false); }
  }

  const isCart = funnelKey === 'abandoned_cart';
  const segments: { key: Outcome; label: string; n: number; sub?: string }[] = [
    { key: 'started', label: 'Started', n: counts.started },
    { key: 'order', label: 'Order', n: counts.order, sub: pct(counts.order, counts.started) },
    { key: 'quote', label: 'Sales Quote', n: counts.quote, sub: pct(counts.quote, counts.started) },
    { key: 'none', label: 'Not converted', n: counts.none, sub: pct(counts.none, counts.started) },
  ];

  return (
    <>
      <Link to="/" className="order-link">← Dashboard</Link>
      <h1>Conversion</h1>
      <div className="stock-as-of">
        {periodLabel(period)}{region ? `, ${region.split(',').length} ${region.split(',').length === 1 ? 'state' : 'states'}` : ''}. Counts what happened inside that period. Open any customer, order or quote.
      </div>

      <div className="controls" style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', margin: '12px 0' }}>
        <ConversionFilters
          period={period} onPeriod={(p: Period) => set({ period: encodePeriod(p) })}
          region={region} onRegion={r => set({ region: r || null })}
        />
        <input
          type="search" placeholder="Search customer, rep, order or quote" value={search} onChange={e => setSearch(e.target.value)}
          style={{ padding: '7px 10px', border: '1px solid var(--line)', borderRadius: 6, font: 'inherit', fontSize: 13, background: 'var(--panel)', minWidth: 230, flex: '1 1 230px', maxWidth: 380 }}
        />
        <button className="btn secondary" style={{ marginLeft: 'auto' }} disabled={downloading} onClick={download}>{downloading ? 'Downloading…' : '⬇ Excel'}</button>
      </div>

      <div className="tab-bar" style={{ marginBottom: 8 }}>
        {(funnels ?? []).map(f => (
          <button key={f.key} className={'tab' + (f.key === funnelKey ? ' active' : '')} onClick={() => set({ funnel: f.key, outcome: 'started' })}>
            {SHORT[f.key] ?? f.title} <span className="tab-count">{f.started.toLocaleString('en-AU')}</span>
          </button>
        ))}
      </div>
      {funnels && <div className="acct-region" style={{ marginBottom: 10, maxWidth: 760 }}>{funnels.find(f => f.key === funnelKey)?.description}</div>}

      <div className="tab-bar" style={{ marginBottom: 10 }} aria-label="Who to show">
        {segments.map(s => (
          <button key={s.key} className={'tab' + (outcome === s.key ? ' active' : '')} onClick={() => set({ outcome: s.key })}>
            {s.label} · {s.n.toLocaleString('en-AU')}{s.sub ? ` (${s.sub})` : ''}
          </button>
        ))}
      </div>

      {error && <div className="empty-state">Couldn't load this: {error}</div>}
      {!error && !rows && <div className="empty-state">Loading…</div>}
      {!error && rows && !shown.length && <div className="empty-state">{rows.length ? 'Nobody matches.' : 'Nobody started in this period.'}</div>}

      {!error && rows && shown.length > 0 && (
        <div className="manifest">
          <div className="m-row head" style={{ gridTemplateColumns: COLS }}>
            <div className="sortable-head" onClick={() => toggleSort('who')}>Customer{arrow('who')}</div>
            <div className="sortable-head" onClick={() => toggleSort('state')}>State{arrow('state')}</div>
            <div>Rep</div>
            <div className="sortable-head" onClick={() => toggleSort('started')}>{isCart ? 'Cart left' : 'Started'}{arrow('started')}</div>
            <div>Order</div><div>Sales Quote</div>
          </div>
          {shown.map((r, i) => (
            <div className="m-row" key={`${r.accountId ?? r.email}-${r.started}-${i}`} style={{ gridTemplateColumns: COLS, cursor: 'default' }}>
              <div>
                {r.accountId ? <Link to={`/accounts/${r.accountId}`} className="order-link acct-name">{r.who}</Link> : <div className="acct-name">{r.who || '—'}</div>}
                {isCart && (
                  <div className="acct-region">
                    {r.cartValue != null ? `${fmtMoney(r.cartValue)} cart` : ''}{r.email ? ` · ${r.email}` : ''}{!r.accountId ? ' · not in the CRM' : ''}
                  </div>
                )}
              </div>
              <div>{r.state || <span className="acct-region">—</span>}</div>
              <div>{r.rep ?? <span className="acct-region">—</span>}</div>
              <div>{fmtDate(r.started)}</div>
              <div>
                {r.orderNo && r.orderId ? <><Link to={`/orders/${r.orderId}`} className="order-link">{r.orderNo}</Link><div className="acct-region">{r.orderDate ? fmtDate(r.orderDate) : ''}</div></> : <span className="acct-region">—</span>}
              </div>
              <div>
                {r.quoteNo && r.quoteId ? <><Link to={`/orders/${r.quoteId}`} className="order-link">{r.quoteNo}</Link><div className="acct-region">{r.quoteDate ? fmtDate(r.quoteDate) : ''}</div></> : <span className="acct-region">—</span>}
              </div>
            </div>
          ))}
        </div>
      )}
      {rows && shown.length > 0 && <div className="acct-region" style={{ marginTop: 8 }}>{shown.length.toLocaleString('en-AU')} shown.</div>}
    </>
  );
}