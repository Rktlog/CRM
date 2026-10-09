import { useEffect, useState } from 'react';
import { apiGet, apiDownload } from '../lib/api';

// Dashboard: how much activity turns into business. Four starting points, each
// followed to an Order and a Sales Quote. The Reports page has the same numbers
// as an Excel download, with every customer listed.

type Funnel = { key: string; title: string; description: string; started: number; orders: number; quotes: number };
const COLOURS: Record<string, string> = {
  abandoned_cart: 'var(--amber)', prospect: 'var(--teal)', new_lead: '#445064', inactive_stockist: 'var(--rust)',
};
const HOW: Record<string, string> = {
  abandoned_cart: 'Carts left in the portal in this period. Counted when that customer places an order or raises a sales quote after the cart.',
  prospect: 'New customer records set up in DEAR in this period that had never ordered before. Counted when they order or get a sales quote after being set up.',
  new_lead: 'Set up in DEAR before this period, worked by the team, and never ordered before it. Counted when they order or get a sales quote in the period.',
  inactive_stockist: 'Ordered before, but not in the 12 months before this period. Counted when they order or get a sales quote in the period.',
};
const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 1000) / 10}%` : '0%');

export default function ConversionCard() {
  const [days, setDays] = useState(90);
  const [funnels, setFunnels] = useState<Funnel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    setError(null);
    apiGet(`/conversion?days=${days}`).then(d => setFunnels(d.funnels)).catch(e => setError(e.message));
  }, [days]);

  async function download() {
    setDownloading(true);
    try { await apiDownload(`/exports/conversion?days=${days}`, 'conversion.xlsx'); }
    catch { alert('Download failed. Check the API is running.'); }
    finally { setDownloading(false); }
  }

  // If the API doesn't have this yet, say so quietly rather than breaking the Dashboard.
  if (error) return null;

  return (
    <div className="section" id="conversion">
      <div className="panel-title" style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <span>Conversion <span className="plan-count">activity to securing business</span></span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <select value={days} onChange={e => setDays(Number(e.target.value))} aria-label="Period">
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
            <option value={180}>Last 6 months</option>
            <option value={365}>Last 12 months</option>
          </select>
          <button className="btn secondary" style={{ padding: '5px 12px', fontSize: 12 }} disabled={downloading} onClick={download}>
            {downloading ? 'Downloading…' : '⬇ Excel'}
          </button>
        </span>
      </div>

      {!funnels ? (
        <div className="empty-state">Loading…</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(310px, 1fr))', gap: 12 }}>
          {funnels.map(f => (
            <div key={f.key} title={HOW[f.key]}
              style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderLeft: `4px solid ${COLOURS[f.key] ?? 'var(--line)'}`, borderRadius: 6, padding: '12px 14px' }}>
              <div style={{ fontWeight: 600, fontSize: 13.5 }}>{f.title}</div>
              <div className="acct-region" style={{ margin: '3px 0 10px', minHeight: 32 }}>{f.description}</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                <Figure label="Started" value={f.started} />
                <Figure label="Order" value={f.orders} share={pct(f.orders, f.started)} />
                <Figure label="Sales Quote" value={f.quotes} share={pct(f.quotes, f.started)} />
              </div>
              <div style={{ display: 'flex', height: 6, marginTop: 10, borderRadius: 3, overflow: 'hidden', background: 'var(--paper)' }} aria-hidden="true">
                <div style={{ width: `${f.started ? Math.min(100, (f.orders / f.started) * 100) : 0}%`, background: COLOURS[f.key] }} />
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="acct-region" style={{ marginTop: 8 }}>
        Order is a confirmed order. Sales Quote is a quote that was raised, whether it is still open or became an order. Hover a box for how it is counted.
      </div>
    </div>
  );
}

function Figure({ label, value, share }: { label: string; value: number; share?: string }) {
  return (
    <div>
      <div className="stat-label">{label}</div>
      <div className="num" style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.15 }}>{value.toLocaleString('en-AU')}</div>
      <div className="acct-region">{share ?? 'in this period'}</div>
    </div>
  );
}