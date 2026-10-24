import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { apiGet, apiPost } from '../lib/api';
import { fmtDate } from '../lib/types';
import { ACTIVITY_LABEL, ActivityKind } from '../lib/activityLabels';
import { useMe } from '../lib/useMe';
import LogVisitModal from '../components/LogVisitModal';
import EditActivityModal from '../components/EditActivityModal';
import ActivityRemarksModal from '../components/ActivityRemarksModal';

// Activity log: every phone call, email and F2F visit logged against any store the person can
// see, newest first, and a place to log a new one. (This was the F2F visit log.)

type Row = {
  id: string; accountId: string; accountName: string; accountRegion: string; repId: string | null; repName: string | null;
  type: ActivityKind; occurredAt: string; note: string; photoUrl: string | null;
  orderId?: string | null; orderNumber?: string | null;
};
type Summary = Record<string, { count: number; last: { author: string; body: string; at: string } }>;   // remarks on each log: how many, and the latest
type Filter = '' | ActivityKind;
const clip = (t: string, n: number) => { const one = t.replace(/\s+/g, ' ').trim(); return one.length > n ? `${one.slice(0, n - 1).trimEnd()}…` : one; };
const COLS = '1.4fr 0.8fr 1fr 1fr 2fr 0.7fr 0.4fr';

export default function ActivityLog() {
  const [type, setType] = useState<Filter>('');
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logging, setLogging] = useState(false);
  const [editing, setEditing] = useState<Row | null>(null);
  const [remarking, setRemarking] = useState<Row | null>(null);   // the log whose remarks are open
  const [summary, setSummary] = useState<Summary>({});
  const me = useMe();
  // The rep who logged it, or a manager, can edit it (the API checks this too).
  const canEdit = (r: Row) => !!me && (me.role === 'manager' || r.repId === me.id);
  const navigate = useNavigate();

  // How many remarks each log has, and the latest, for the logs on the page.
  function loadSummary(list: Row[]) {
    if (!list.length) return setSummary({});
    apiPost('/remarks/summary', { kind: 'activity', ids: list.map(r => r.id) }).then(d => setSummary(d?.summary ?? {})).catch(() => setSummary({}));
  }
  function load() {
    setError(null);
    apiGet(`/activity${type ? `?type=${type}` : ''}`).then((list: Row[]) => { setRows(list); loadSummary(list); }).catch(e => setError(e.message));
  }
  useEffect(() => { setRows(null); load(); }, [type]);

  if (error) return <div className="empty-state">Couldn't load the activity log: {error}</div>;

  const needle = search.trim().toLowerCase();
  const shown = (rows ?? []).filter(r => !needle
    || [r.accountName, r.repName ?? '', r.note, ACTIVITY_LABEL[r.type]].some(v => v.toLowerCase().includes(needle)));

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h1>Activity log</h1>
        <button className="btn" onClick={() => setLogging(true)}>+ Log activity</button>
      </div>

      <div className="controls" style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', margin: '4px 0 12px' }}>
        <div className="tab-bar" style={{ margin: 0 }}>
          {([['', 'All'], ['call', ACTIVITY_LABEL.call], ['email', ACTIVITY_LABEL.email], ['visit', ACTIVITY_LABEL.visit]] as const).map(([key, label]) => (
            <button key={key} className={'tab' + (type === key ? ' active' : '')} onClick={() => setType(key)}>{label}</button>
          ))}
        </div>
        <input
          type="search" placeholder="Search store, rep or note" value={search} onChange={e => setSearch(e.target.value)}
          style={{ padding: '7px 10px', border: '1px solid var(--line)', borderRadius: 6, font: 'inherit', fontSize: 13, background: 'var(--panel)', minWidth: 220, flex: '1 1 220px', maxWidth: 360 }}
        />
      </div>

      {!rows ? (
        <div className="empty-state">Loading…</div>
      ) : !shown.length ? (
        <div className="empty-state">
          {rows.length ? 'Nothing matches your search.' : `No ${type ? ACTIVITY_LABEL[type].toLowerCase() + ' activity' : 'activity'} logged yet.`}
        </div>
      ) : (
        <div className="manifest">
          <div className="m-row head" style={{ gridTemplateColumns: COLS }}>
            <div>Account</div><div>Type</div><div>Rep</div><div>Date</div><div>Note</div><div>Photo</div><div></div>
          </div>
          {shown.map(v => (
            <div className="m-row" key={v.id} style={{ gridTemplateColumns: COLS }} onClick={() => navigate(`/accounts/${v.accountId}`)}>
              <div>
                <div className="acct-name">{v.accountName}</div>
                <div className="acct-region">{v.accountRegion}</div>
              </div>
              <div><span className={`pill ${v.type === 'visit' ? 'teal' : 'neutral'}`}>{ACTIVITY_LABEL[v.type] ?? v.type}</span></div>
              <div>{v.repName ?? '—'}</div>
              <div>{fmtDate(v.occurredAt)}</div>
              <div style={{ color: 'var(--ink-soft)' }}>
                {v.orderNumber && v.orderId && <div><Link to={`/orders/${v.orderId}`} className="order-link" onClick={e => e.stopPropagation()}>On order {v.orderNumber}</Link></div>}
                {v.note}
                <div style={{ marginTop: summary[v.id] ? 6 : 4 }}>
                  {summary[v.id] && <div style={{ fontSize: 12.5, fontStyle: 'italic', color: 'var(--muted)' }}>{summary[v.id].last.author}: {clip(summary[v.id].last.body, 100)}</div>}
                  <button className="edit-link" onClick={e => { e.stopPropagation(); setRemarking(v); }}>{summary[v.id] ? `Remarks (${summary[v.id].count})` : 'Add remark'}</button>
                </div>
              </div>
              <div>
                {v.type !== 'visit' ? <span className="acct-region">—</span>
                  : v.photoUrl ? <span className="pill teal">Attached</span> : <span className="pill neutral">None</span>}
              </div>
              <div>
                {canEdit(v) && (
                  <button className="edit-link" onClick={e => { e.stopPropagation(); setEditing(v); }}>Edit</button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {rows && rows.length === 300 && (
        <div style={{ marginTop: 12, fontSize: 12, color: 'var(--muted)' }}>
          Showing the most recent 300{type ? ` ${ACTIVITY_LABEL[type].toLowerCase()} logs` : ' logs'}.
        </div>
      )}

      {editing && (
        <EditActivityModal activity={editing} onSaved={load} onClose={() => setEditing(null)} />
      )}

      {remarking && (
        <ActivityRemarksModal activity={remarking} onChanged={() => loadSummary(rows ?? [])} onClose={() => setRemarking(null)} />
      )}

      {logging && (
        <LogVisitModal defaultType={type || undefined} onCreated={load} onClose={() => setLogging(false)} />
      )}
    </>
  );
}