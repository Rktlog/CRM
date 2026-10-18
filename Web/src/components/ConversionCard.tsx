import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiGet, apiDownload } from '../lib/api';
import { Period, DEFAULT_PERIOD, encodePeriod, periodLabel, conversionQuery } from '../lib/period';
import ConversionFilters from './ConversionFilters';
import ConversionTiming, { Timing } from './ConversionTiming';

// Dashboard: how much activity turns into business. Four starting points, each followed to an
// Order and a Sales Quote, over a period (last N days, a month, a fiscal quarter) and for some
// or all states. Click a box or a number to open the customers behind it.

type Funnel = { key: string; title: string; description: string; started: number; orders: number; quotes: number; timing?: Timing };
const COLOURS: Record<string, string> = {
  abandoned_cart: 'var(--amber)', prospect: 'var(--teal)', inactive_p1: '#8a7a5c', inactive_p2: 'var(--rust)',
};
const HOW: Record<string, string> = {
  abandoned_cart: 'Carts left in the portal in this period. Counted when that customer places an order or raises a sales quote after the cart.',
  prospect: 'Prospects set up in DEAR in this period that had never ordered before. Counted when they place an order, or have a sales quote still open, after being set up.',
  inactive_p1: 'Set up in DEAR before this period and never ordered (the New Leads are counted here). Counted when they place an order, or have a sales quote still open, in the period.',
  inactive_p2: 'Ordered before, but not in the 12 months before this period. Counted when they place an order, or have a sales quote still open, in the period.',
};
const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 1000) / 10}%` : '0%');

export default function ConversionCard() {
  const [period, setPeriod] = useState<Period>(DEFAULT_PERIOD);
  const [region, setRegion] = useState('');
  const [funnels, setFunnels] = useState<Funnel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    setError(null);
    apiGet(`/conversion?${conversionQuery(period, region)}`).then(d => setFunnels(d.funnels)).catch(e => setError(e.message));
  }, [period, region]);

  async function download() {
    setDownloading(true);
    try { await apiDownload(`/exports/conversion?${conversionQuery(period, region)}`, 'conversion.xlsx'); }
    catch { alert('Download failed. Check the API is running.'); }
    finally { setDownloading(false); }
  }

  // The detail page opens on the same period and states.
  const open = (key: string, outcome: 'started' | 'order' | 'quote') =>
    `/conversion?funnel=${key}&outcome=${outcome}&period=${encodePeriod(period)}${region ? `&region=${encodeURIComponent(region)}` : ''}`;

  // If the API doesn't have this yet, say so quietly rather than breaking the Dashboard.
  if (error && !funnels) return null;

  return (
    <div className="section" id="conversion">
      <div className="panel-title" style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <span>Conversion <span className="plan-count">activity to securing business</span></span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <ConversionFilters period={period} onPeriod={setPeriod} region={region} onRegion={setRegion} />
          <button className="btn secondary" style={{ padding: '5px 12px', fontSize: 12 }} disabled={downloading} onClick={download}>
            {downloading ? 'Downloading…' : '⬇ Excel'}
          </button>
        </span>
      </div>
      {error && <div className="save-msg err" style={{ marginBottom: 8 }}>{error}</div>}

      {!funnels ? (
        <div className="empty-state">Loading…</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(310px, 1fr))', gap: 12 }}>
          {funnels.map(f => (
            <div key={f.key} title={HOW[f.key]}
              style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderLeft: `4px solid ${COLOURS[f.key] ?? 'var(--line)'}`, borderRadius: 6, padding: '12px 14px' }}>
              <Link to={open(f.key, 'started')} className="order-link" style={{ fontWeight: 600, fontSize: 13.5, display: 'block' }}>{f.title}</Link>
              <div className="acct-region" style={{ margin: '3px 0 10px', minHeight: 32 }}>{f.description}</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                <Figure label="Started" value={f.started} to={open(f.key, 'started')} />
                <Figure label="Order" value={f.orders} share={pct(f.orders, f.started)} to={open(f.key, 'order')} />
                <Figure label="Sales Quote" value={f.quotes} share={pct(f.quotes, f.started)} to={open(f.key, 'quote')} />
              </div>
              <div style={{ display: 'flex', height: 6, marginTop: 10, borderRadius: 3, overflow: 'hidden', background: 'var(--paper)' }} aria-hidden="true">
                <div style={{ width: `${f.started ? Math.min(100, (f.orders / f.started) * 100) : 0}%`, background: COLOURS[f.key] }} />
              </div>
              <ConversionTiming timing={f.timing} />
            </div>
          ))}
        </div>
      )}
      <div className="acct-region" style={{ marginTop: 8 }}>
        {periodLabel(period)}{region ? `, ${region.split(',').length} ${region.split(',').length === 1 ? 'state' : 'states'}` : ''}. Counts what happened inside that period.
        Order is a finalised order. Sales Quote is a quote still open, where the order has not been finalised yet. The days run from the start to the order, and the 30, 60 and 90 day figures only count customers who have had that long, so they can be compared between periods. Click a number to open the customers behind it.
      </div>
    </div>
  );
}

function Figure({ label, value, share, to }: { label: string; value: number; share?: string; to: string }) {
  return (
    <Link to={to} style={{ color: 'inherit', textDecoration: 'none' }} title={`Open the ${value.toLocaleString('en-AU')} behind this number`}>
      <div className="stat-label">{label}</div>
      <div className="num" style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.15 }}>{value.toLocaleString('en-AU')}</div>
      <div className="acct-region">{share ?? 'in this period'}</div>
    </Link>
  );
}