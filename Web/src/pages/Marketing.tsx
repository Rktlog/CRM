import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiGet, apiDownload } from '../lib/api';
import { fmtDate } from '../lib/types';
import { Period, encodePeriod, decodePeriod, periodQuery, periodLabel, periodOptions } from '../lib/period';
import { money, pct, num, CAMPAIGN_STATUS } from '../lib/marketing';
import { MarketingNav, ManagersOnly, SendingBanner, PeriodSelect, Pill } from '../components/marketing/Ui';

// Marketing dashboard: what was sent, what people did with it, and the orders that followed.
type Overview = {
  days: number; attributionDays: number; status: any;
  totals: { sent: number; delivered: number; opened: number; clicked: number; unsubscribed: number; bounced: number; complained: number; failed: number; waiting: number };
  rates: { delivered: number; opened: number; clicked: number; unsubscribed: number; bounced: number };
  orders: { count: number; revenue: number; recent: { orderId: string; number: string; orderAt: string; value: number; accountId: string; accountName: string; campaignName: string | null; automationKey: string | null }[] };
  daily: { day: string; sent: number; opens: number; clicks: number }[];
  campaigns: { id: string; name: string; status: string; sentAt: string; sent: number; openRate: number; clickRate: number; orders: number; revenue: number; unsubscribed: number }[];
  automations: { key: string; name: string; marketing: boolean; sent: number; opened: number; clicked: number; waiting: number; orders: number }[];
  audience: { total: number; subscribed: number; pending: number; unsubscribed: number; bounced: number };
};

function Tile({ label, value, sub, strong }: { label: string; value: string; sub?: string; strong?: boolean }) {
  return (
    <div style={{ background: strong ? '#e3efe9' : 'var(--panel)', border: '1px solid var(--line)', borderRadius: 6, padding: '12px 14px' }}>
      <div className="stat-label">{label}</div>
      <div className="num" style={{ fontSize: 24, fontWeight: 700, lineHeight: 1.2 }}>{value}</div>
      {sub && <div className="acct-region">{sub}</div>}
    </div>
  );
}

// Emails sent as bars, opens and clicks as lines, one point a day.
export function TrendChart({ daily }: { daily: Overview['daily'] }) {
  if (!daily.length) return <div className="acct-region" style={{ padding: '18px 0' }}>Nothing sent in this period yet. The chart fills in as emails go out.</div>;
  const W = 720, H = 170, pad = 28; const max = Math.max(1, ...daily.flatMap(d => [d.sent, d.opens, d.clicks]));
  const x = (i: number) => pad + (daily.length === 1 ? (W - pad * 2) / 2 : (i * (W - pad * 2)) / (daily.length - 1));
  const y = (v: number) => H - pad - (v / max) * (H - pad * 2);
  const line = (k: 'opens' | 'clicks') => daily.map((d, i) => `${x(i)},${y(d[k])}`).join(' ');
  const barW = Math.max(3, Math.min(26, (W - pad * 2) / daily.length - 4));
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Emails sent, opens and clicks by day" style={{ width: '100%', height: 'auto', maxHeight: 220 }}>
        <line x1={pad} y1={H - pad} x2={W - pad} y2={H - pad} stroke="#dfe2d8" />
        {daily.map((d, i) => <rect key={d.day} x={x(i) - barW / 2} y={y(d.sent)} width={barW} height={H - pad - y(d.sent)} fill="#cfd8d2"><title>{`${d.day}: ${d.sent} sent`}</title></rect>)}
        <polyline points={line('opens')} fill="none" stroke="#d99a2b" strokeWidth="2" /><polyline points={line('clicks')} fill="none" stroke="#2f6b5e" strokeWidth="2.5" />
        {daily.map((d, i) => <circle key={d.day} cx={x(i)} cy={y(d.clicks)} r="3" fill="#2f6b5e"><title>{`${d.day}: ${d.opens} opens, ${d.clicks} clicks`}</title></circle>)}
        <text x={pad} y={H - 8} fontSize="10" fill="#7a8290">{daily[0].day}</text><text x={W - pad} y={H - 8} fontSize="10" fill="#7a8290" textAnchor="end">{daily[daily.length - 1].day}</text>
        <text x={pad} y={12} fontSize="10" fill="#7a8290">{max}</text>
      </svg>
      <div className="acct-region" style={{ display: 'flex', gap: 16 }}>
        <span><span style={{ color: '#9fb3a8' }}>■</span> Sent</span><span><span style={{ color: '#d99a2b' }}>━</span> Opens</span><span><span style={{ color: '#2f6b5e' }}>━</span> Clicks</span>
      </div>
    </div>
  );
}

export default function Marketing() {
  const options = useMemo(() => periodOptions(), []);
  const [period, setPeriod] = useState<Period>({ kind: 'days', days: 30 });
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  useEffect(() => { setError(null); apiGet(`/marketing/overview?${periodQuery(period)}`).then(setData).catch(e => setError(e.message)); }, [period]);
  async function download() {
    setDownloading(true);
    try { await apiDownload(`/exports/marketing?${periodQuery(period)}`, 'marketing.xlsx'); } catch { alert('Download failed. Check the API is running.'); } finally { setDownloading(false); }
  }
  const t = data?.totals; const th = { fontWeight: 600, fontSize: 12, color: 'var(--muted)', textAlign: 'left' as const, padding: '6px 8px' }; const td = { padding: '7px 8px', fontSize: 13, borderTop: '1px solid var(--line)' };

  return (
    <ManagersOnly>
      <h1>Marketing</h1>
      <MarketingNav />
      <SendingBanner status={data?.status} />
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', margin: '0 0 12px' }}>
        <PeriodSelect value={encodePeriod(period)} onChange={v => setPeriod(decodePeriod(v))} options={options} />
        <span className="acct-region">{periodLabel(period)}. Counts emails sent in that period.</span>
        <button className="btn secondary" style={{ marginLeft: 'auto' }} disabled={downloading} onClick={download}>{downloading ? 'Downloading…' : '⬇ Excel report'}</button>
        <Link to="/marketing/campaigns?new=1" className="btn">Create campaign</Link>
      </div>
      {error && <div className="empty-state">Couldn't load Marketing: {error}</div>}
      {!error && !data && <div className="empty-state">Loading…</div>}
      {data && t && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, marginBottom: 10 }}>
            <Tile label="Emails sent" value={num(t.sent)} sub={t.waiting ? `${num(t.waiting)} waiting to send` : undefined} />
            <Tile label="Delivered" value={pct(data.rates.delivered)} sub={`${num(t.delivered)} emails`} />
            <Tile label="Opened" value={pct(data.rates.opened)} sub={`${num(t.opened)} people (approximate)`} />
            <Tile label="Clicked" value={pct(data.rates.clicked)} sub={`${num(t.clicked)} people`} />
            <Tile label="Unsubscribed" value={num(t.unsubscribed)} sub={pct(data.rates.unsubscribed)} />
            <Tile label="Bounced" value={num(t.bounced + t.complained)} sub={pct(data.rates.bounced)} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 10, marginBottom: 16 }}>
            <Tile strong label="Orders from emails" value={num(data.orders.count)} sub={`Confirmed orders placed within ${data.attributionDays} days of a click`} />
            <Tile strong label="Sales from those orders" value={money(data.orders.revenue)} sub="Ex GST, ex freight" />
            <Tile label="Average order" value={data.orders.count ? money(data.orders.revenue / data.orders.count) : '$0.00'} sub="From emails" />
          </div>
          <div className="section"><div className="panel-title">Activity</div><TrendChart daily={data.daily} />
            <div className="acct-region">Opens are approximate, because some inboxes load pictures automatically. Clicks and orders are the numbers to trust.</div></div>

          <div className="section">
            <div className="panel-title">Campaigns <Link to="/marketing/campaigns" className="order-link" style={{ fontSize: 12, marginLeft: 8 }}>All campaigns</Link></div>
            {!data.campaigns.length ? <div className="acct-region">No campaigns sent in this period.</div> : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}><thead><tr><th style={th}>Campaign</th><th style={th}>Sent</th><th style={th}>Emails</th><th style={th}>Opened</th><th style={th}>Clicked</th><th style={th}>Orders</th><th style={th}>Sales</th></tr></thead>
                <tbody>{data.campaigns.map(c => (
                  <tr key={c.id}><td style={td}><Link to={`/marketing/campaigns/${c.id}/report`} className="order-link">{c.name}</Link> <Pill tone={CAMPAIGN_STATUS[c.status]?.tone}>{CAMPAIGN_STATUS[c.status]?.label ?? c.status}</Pill></td>
                    <td style={td}>{fmtDate(c.sentAt)}</td><td style={td}>{num(c.sent)}</td><td style={td}>{pct(c.openRate)}</td><td style={td}>{pct(c.clickRate)}</td><td style={td}>{num(c.orders)}</td><td style={td}>{money(c.revenue)}</td></tr>
                ))}</tbody></table>
            )}
          </div>

          <div className="section">
            <div className="panel-title">Orders from emails <span className="plan-count">the last click before the order gets the credit</span></div>
            {!data.orders.recent.length ? <div className="acct-region">No orders yet in this period. They appear here when a customer clicks an email and then orders within {data.attributionDays} days.</div> : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}><thead><tr><th style={th}>Order</th><th style={th}>Customer</th><th style={th}>Date</th><th style={th}>Sales</th><th style={th}>Credited to</th></tr></thead>
                <tbody>{data.orders.recent.map(o => (
                  <tr key={o.orderId}><td style={td}><Link to={`/orders/${o.orderId}`} className="order-link">{o.number}</Link></td><td style={td}><Link to={`/accounts/${o.accountId}`} className="order-link">{o.accountName}</Link></td>
                    <td style={td}>{fmtDate(o.orderAt)}</td><td style={td}>{money(o.value)}</td><td style={td}>{o.campaignName ?? o.automationKey}</td></tr>
                ))}</tbody></table>
            )}
          </div>

          <div className="section">
            <div className="panel-title">Automatic emails <Link to="/marketing/automations" className="order-link" style={{ fontSize: 12, marginLeft: 8 }}>Manage</Link></div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}><thead><tr><th style={th}>Email</th><th style={th}>Sent</th><th style={th}>Opened</th><th style={th}>Clicked</th><th style={th}>Waiting</th><th style={th}>Orders</th></tr></thead>
              <tbody>{data.automations.map(a => (
                <tr key={a.key}><td style={td}>{a.name} {a.marketing && <Pill tone="muted">Marketing</Pill>}</td><td style={td}>{num(a.sent)}</td><td style={td}>{num(a.opened)}</td><td style={td}>{num(a.clicked)}</td><td style={td}>{num(a.waiting)}</td><td style={td}>{a.marketing ? num(a.orders) : <span className="acct-region">n/a</span>}</td></tr>
              ))}</tbody></table>
          </div>

          <div className="section">
            <div className="panel-title">Audience <Link to="/marketing/audience" className="order-link" style={{ fontSize: 12, marginLeft: 8 }}>Open</Link></div>
            <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap' }}>
              <span><b className="num">{num(data.audience.subscribed)}</b> <span className="acct-region">can be emailed</span></span>
              <span><b className="num">{num(data.audience.pending)}</b> <span className="acct-region">need a consent check</span></span>
              <span><b className="num">{num(data.audience.unsubscribed)}</b> <span className="acct-region">unsubscribed</span></span>
              <span><b className="num">{num(data.audience.bounced)}</b> <span className="acct-region">bounced or spam</span></span>
            </div>
          </div>
        </>
      )}
    </ManagersOnly>
  );
}