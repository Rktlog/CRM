import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiGet, apiDownload } from '../lib/api';
import { fmtDate } from '../lib/types';
import { CAMPAIGN_STATUS, MESSAGE_STATUS, describeFilter, money, num, pct } from '../lib/marketing';
import { MarketingNav, ManagersOnly, Pill, Back } from '../components/marketing/Ui';

type Report = {
  campaign: { id: string; name: string; subject: string; status: string; audience: any; sentAt: string | null; scheduledAt: string | null }; attributionDays: number;
  stats: { total: number; sent: number; waiting: number; skipped: number; failed: number; bounced: number; complained: number; opened: number; clicked: number; unsubscribed: number; opens: number; clicks: number; delivered: number; openRate: number; clickRate: number; unsubscribeRate: number; bounceRate: number };
  links: { url: string; clicks: number; people: number }[];
  recipients: { id: string; email: string; name: string | null; company: string | null; status: string; error: string | null; sentAt: string | null; openedAt: string | null; opens: number; clicks: number; unsubscribedAt: string | null }[];
  orders: { count: number; revenue: number; rows: { orderId: string; number: string; orderAt: string; value: number; accountId: string; accountName: string; clickedAt: string }[] };
};

export default function MarketingReport() {
  const { id } = useParams(); const [r, setR] = useState<Report | null>(null); const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'opened' | 'clicked' | 'unopened' | 'problem' | 'unsub'>('all'); const [downloading, setDownloading] = useState(false);
  const load = () => apiGet(`/marketing/campaigns/${id}/report`).then(setR).catch(e => setError(e.message));
  useEffect(() => { load(); }, [id]);
  // While emails are still going out, check back every few seconds.
  useEffect(() => { if (!r || r.stats.waiting === 0) return; const t = setInterval(load, 8000); return () => clearInterval(t); }, [r?.stats.waiting]);

  const rows = useMemo(() => (r?.recipients ?? []).filter(x => filter === 'all' || (filter === 'opened' && x.opens > 0) || (filter === 'clicked' && x.clicks > 0)
    || (filter === 'unopened' && x.status === 'sent' && x.opens === 0) || (filter === 'problem' && ['bounced', 'complained', 'failed', 'skipped'].includes(x.status)) || (filter === 'unsub' && !!x.unsubscribedAt)), [r, filter]);
  async function download() { setDownloading(true); try { await apiDownload(`/exports/marketing-campaign?id=${id}`, 'campaign-report.xlsx'); } catch { alert('Download failed.'); } finally { setDownloading(false); } }
  const th = { fontWeight: 600, fontSize: 12, color: 'var(--muted)', textAlign: 'left' as const, padding: '6px 8px' }; const td = { padding: '7px 8px', fontSize: 13, borderTop: '1px solid var(--line)' };
  const Tile = ({ label, value, sub }: { label: string; value: string; sub?: string }) => <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 6, padding: '10px 14px' }}><div className="stat-label">{label}</div><div className="num" style={{ fontSize: 22, fontWeight: 700 }}>{value}</div>{sub && <div className="acct-region">{sub}</div>}</div>;

  if (error) return <ManagersOnly><div className="empty-state">Couldn't load this report: {error}</div></ManagersOnly>;
  if (!r) return <div className="empty-state">Loading…</div>;
  const s = r.stats;
  return (
    <ManagersOnly>
      <Back to="/marketing/campaigns">Campaigns</Back>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0 }}>{r.campaign.name}</h1><Pill tone={CAMPAIGN_STATUS[r.campaign.status]?.tone}>{CAMPAIGN_STATUS[r.campaign.status]?.label}</Pill>
        <button className="btn secondary" style={{ marginLeft: 'auto' }} disabled={downloading} onClick={download}>{downloading ? 'Downloading…' : '⬇ Excel'}</button>
      </div>
      <div className="acct-region" style={{ margin: '4px 0 12px' }}>{r.campaign.subject}. {r.campaign.sentAt ? `Sent ${fmtDate(r.campaign.sentAt)}. ` : ''}{describeFilter(r.campaign.audience)}.</div>
      <MarketingNav />
      {s.waiting > 0 && <div style={{ background: '#fbefd9', color: '#7a4d0e', borderRadius: 6, padding: '9px 14px', fontSize: 13, marginBottom: 12 }}>{num(s.waiting)} of {num(s.total)} emails are still going out. This page updates by itself.</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 10 }}>
        <Tile label="Recipients" value={num(s.total)} sub={`${num(s.sent)} sent`} />
        <Tile label="Delivered" value={num(s.delivered)} sub={s.bounced ? `${num(s.bounced)} bounced` : undefined} />
        <Tile label="Opened" value={pct(s.openRate)} sub={`${num(s.opened)} people (approximate)`} />
        <Tile label="Clicked" value={pct(s.clickRate)} sub={`${num(s.clicked)} people, ${num(s.clicks)} clicks`} />
        <Tile label="Unsubscribed" value={num(s.unsubscribed)} sub={pct(s.unsubscribeRate)} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 10, marginBottom: 16 }}>
        <div style={{ background: '#e3efe9', border: '1px solid var(--line)', borderRadius: 6, padding: '10px 14px' }}><div className="stat-label">Orders from this email</div><div className="num" style={{ fontSize: 22, fontWeight: 700 }}>{num(r.orders.count)}</div><div className="acct-region">Within {r.attributionDays} days of a click</div></div>
        <div style={{ background: '#e3efe9', border: '1px solid var(--line)', borderRadius: 6, padding: '10px 14px' }}><div className="stat-label">Sales from those orders</div><div className="num" style={{ fontSize: 22, fontWeight: 700 }}>{money(r.orders.revenue)}</div><div className="acct-region">Ex GST, ex freight</div></div>
      </div>

      <div className="section"><div className="panel-title">Links clicked</div>
        {!r.links.length ? <div className="acct-region">No clicks yet.</div> : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}><thead><tr><th style={th}>Link</th><th style={th}>Clicks</th><th style={th}>People</th></tr></thead>
            <tbody>{r.links.map(l => <tr key={l.url}><td style={{ ...td, wordBreak: 'break-all' }}><a href={l.url} target="_blank" rel="noreferrer" className="order-link">{l.url}</a></td><td style={td}>{num(l.clicks)}</td><td style={td}>{num(l.people)}</td></tr>)}</tbody></table>
        )}</div>

      <div className="section"><div className="panel-title">Orders from this email</div>
        {!r.orders.rows.length ? <div className="acct-region">None yet. An order appears here when someone who clicked this email places a confirmed order within {r.attributionDays} days.</div> : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}><thead><tr><th style={th}>Order</th><th style={th}>Customer</th><th style={th}>Clicked</th><th style={th}>Ordered</th><th style={th}>Sales</th></tr></thead>
            <tbody>{r.orders.rows.map(o => <tr key={o.orderId}><td style={td}><Link to={`/orders/${o.orderId}`} className="order-link">{o.number}</Link></td><td style={td}><Link to={`/accounts/${o.accountId}`} className="order-link">{o.accountName}</Link></td><td style={td}>{fmtDate(o.clickedAt)}</td><td style={td}>{fmtDate(o.orderAt)}</td><td style={td}>{money(o.value)}</td></tr>)}</tbody></table>
        )}</div>

      <div className="section"><div className="panel-title">Recipients</div>
        <div className="tab-bar" style={{ marginBottom: 8 }}>
          {([['all', 'All'], ['opened', 'Opened'], ['clicked', 'Clicked'], ['unopened', 'Not opened'], ['problem', 'Not delivered'], ['unsub', 'Unsubscribed']] as const).map(([k, l]) => <button key={k} className={'tab' + (filter === k ? ' active' : '')} onClick={() => setFilter(k)}>{l}</button>)}
        </div>
        {!rows.length ? <div className="acct-region">Nobody here.</div> : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}><thead><tr><th style={th}>Email</th><th style={th}>Store</th><th style={th}>Status</th><th style={th}>Opens</th><th style={th}>Clicks</th></tr></thead>
            <tbody>{rows.map(x => (
              <tr key={x.id}><td style={td}>{x.email}{x.name ? <div className="acct-region">{x.name}</div> : null}</td><td style={td}>{x.company ?? ''}</td>
                <td style={td}><Pill tone={MESSAGE_STATUS[x.status]?.tone}>{MESSAGE_STATUS[x.status]?.label ?? x.status}</Pill>{x.unsubscribedAt ? <> <Pill tone="muted">Unsubscribed</Pill></> : null}{x.error ? <div className="acct-region">{x.error}</div> : null}</td>
                <td style={td}>{num(x.opens)}</td><td style={td}>{num(x.clicks)}</td></tr>
            ))}</tbody></table>
        )}
        {r.recipients.length === 500 && <div className="acct-region" style={{ marginTop: 6 }}>Showing the 500 most engaged. The Excel report has everyone.</div>}
      </div>
    </ManagersOnly>
  );
}