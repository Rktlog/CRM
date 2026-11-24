import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { apiGet } from '../lib/api';
import { useMe } from '../lib/useMe';
import TsShowForm from '../components/TsShowForm';
import TsHidden from '../components/TsHidden';
import { $, errMsg, shortDay, type FollowUpItem, type Show } from '../lib/tradeshow';

// Trade Shows: every show, and the follow-ups from all of them (mine, the sales team's, or everyone's).
const th: CSSProperties = { textAlign: 'left', fontSize: 13, color: 'var(--muted)', fontWeight: 500, padding: '8px 10px', borderBottom: '1px solid var(--line)', whiteSpace: 'nowrap' };
const td: CSSProperties = { padding: '9px 10px', borderBottom: '1px solid var(--line)', fontSize: 14, verticalAlign: 'top' };

export function FollowUpTable({ items, showShow }: { items: FollowUpItem[]; showShow: boolean }) {
  if (!items.length) return <div className="empty-state" style={{ padding: 24 }}>Nothing to follow up.</div>;
  return (
    <div style={{ overflowX: 'auto', border: '1px solid var(--line)', borderRadius: 4, background: 'var(--panel)' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr><th style={th}>Due</th><th style={th}>For</th><th style={th}>Customer</th><th style={th}>What</th>{showShow && <th style={th}>Show</th>}<th style={{ ...th, textAlign: 'right' }}>Total</th><th style={th}>Where it is</th></tr></thead>
        <tbody>{items.map(f => (
          <tr key={f.id}>
            <td style={{ ...td, whiteSpace: 'nowrap' }}>{shortDay(f.dueOn)}{f.overdue && <> <span className="pill rust">Overdue</span></>}</td>
            <td style={td}>{f.who?.name ?? 'Sales team'}</td>
            <td style={td}>{f.customer} <span className="acct-region">{f.region}</span></td>
            <td style={td}><Link to={f.kind === 'lead' ? `/trade-shows/leads/${f.targetId}` : `/trade-shows/orders/${f.targetId}`}>{f.kind === 'lead' ? 'Lead' : `${f.kind === 'quote' ? 'Quote' : 'Order'} ${f.label}`}</Link></td>
            {showShow && <td style={td}><Link to={`/trade-shows/${f.show.id}`}>{f.show.name}</Link></td>}
            <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>{$(f.amount)}</td>
            <td style={td}>{f.stage}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

export default function TradeShows() {
  const me = useMe(), isManager = me?.role === 'manager', nav = useNavigate();
  const [shows, setShows] = useState<Show[] | null>(null);
  const [fu, setFu] = useState<FollowUpItem[] | null>(null);
  const [who, setWho] = useState<'mine' | 'team' | 'all'>('mine');
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const load = useCallback(() => { apiGet('/tradeshow/shows', { fresh: true }).then((d: { shows: Show[] }) => { setShows(d.shows); setErr(null); }).catch(e => setErr(errMsg(e))); }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setFu(null); apiGet(`/tradeshow/followups?who=${who}`, { fresh: true }).then((d: { followUps: FollowUpItem[] }) => setFu(d.followUps)).catch(e => setErr(errMsg(e))); }, [who]);
  const upcoming = (shows ?? []).filter(s => !s.archived), closed = (shows ?? []).filter(s => s.archived);
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, flexWrap: 'wrap' }}><h1 style={{ margin: 0 }}>Trade Shows</h1><Link to="/trade-shows/compare">Compare shows</Link></div>
      <div className="acct-region" style={{ marginBottom: 14, maxWidth: 700 }}>Write orders and take leads at a show. Each order is emailed to sales with the file DEAR imports, and every order and lead gets a follow-up a week later.</div>
      {err && <div className="save-msg err" role="alert">{err}</div>}
      <div className="section">
        <div style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}><div className="panel-title" style={{ flex: 1 }}>Shows</div>{isManager && !adding && <button type="button" className="btn" onClick={() => setAdding(true)}>New show</button>}</div>
        {adding && <TsShowForm onSaved={id => nav(`/trade-shows/${id}`)} onCancel={() => setAdding(false)} />}
        {shows === null && !err && <div className="acct-region">Loading…</div>}
        {shows && !shows.length && <div className="empty-state">No shows yet.{isManager ? ' Press New show to set one up.' : ' A manager sets them up.'}</div>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
          {upcoming.map(s => (
            <Link key={s.id} to={`/trade-shows/${s.id}`} className="card" style={{ marginBottom: 0, textDecoration: 'none', color: 'inherit', display: 'block' }}>
              <div style={{ fontWeight: 600, fontSize: 15.5 }}>{s.name}</div>
              <div className="acct-region" style={{ fontSize: 13, margin: '4px 0 8px' }}>{shortDay(s.startsOn)}{s.endsOn !== s.startsOn ? ` to ${shortDay(s.endsOn)}` : ''}{s.venue ? ` · ${s.venue}` : ''}{s.stand ? ` · stand ${s.stand}` : ''}</div>
              <div style={{ fontSize: 13.5 }}>{s.orders} {s.orders === 1 ? 'order' : 'orders'} · {s.quotes} {s.quotes === 1 ? 'quote' : 'quotes'} · {s.leads} {s.leads === 1 ? 'lead' : 'leads'}</div>
            </Link>
          ))}
        </div>
        {closed.length > 0 && <div className="acct-region" style={{ marginTop: 10, fontSize: 13 }}>Closed: {closed.map((s, i) => <span key={s.id}>{i ? ', ' : ''}<Link to={`/trade-shows/${s.id}`}>{s.name}</Link></span>)}</div>}
      </div>
      {isManager && <TsHidden />}
      <div className="section">
        <div style={{ display: 'flex', gap: 12, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <div className="panel-title" style={{ flex: 1 }}>Follow-ups</div>
          <select value={who} onChange={e => setWho(e.target.value as typeof who)} style={{ padding: '5px 8px', border: '1px solid var(--line)', borderRadius: 3, font: 'inherit' }}>
            <option value="mine">Mine{isManager ? ' (and the sales team\'s)' : ''}</option><option value="team">Sales team</option><option value="all">Everyone</option>
          </select>
        </div>
        {fu === null ? <div className="acct-region">Loading…</div> : <FollowUpTable items={fu} showShow />}
      </div>
    </>
  );
}
