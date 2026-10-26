import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { apiGet } from '../lib/api';
import { fmtDate } from '../lib/types';
import { ACTIVITY_LABEL, ActivityKind } from '../lib/activityLabels';
import { useMe } from '../lib/useMe';
import { activityQuery, Range, RANGE_LABEL, rangeDates } from '../lib/activityRange';
import LogVisitModal from '../components/LogVisitModal';
import EditActivityModal from '../components/EditActivityModal';

// Activity log: every phone call, email and F2F visit logged against any store the person can
// see, newest first, and a place to log a new one. (This was the F2F visit log.)

type Row = {
  id: string; accountId: string; accountName: string; accountRegion: string; repId: string | null; repName: string | null;
  type: ActivityKind; occurredAt: string; note: string; photoUrl: string | null;
  orderId?: string | null; orderNumber?: string | null;
};
type Filter = '' | ActivityKind;
const COLS = '1.4fr 0.8fr 1fr 1fr 2fr 0.7fr 0.4fr';
const CONTROL = { padding: '7px 10px', border: '1px solid var(--line)', borderRadius: 6, font: 'inherit', fontSize: 13, background: 'var(--panel)' } as const;

export default function ActivityLog() {
  const [type, setType] = useState<Filter>('');
  const [search, setSearch] = useState('');
  const [repId, setRepId] = useState('');
  const [range, setRange] = useState<Range>('all');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [reps, setReps] = useState<{ id: string; name: string }[]>([]);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logging, setLogging] = useState(false);
  const [editing, setEditing] = useState<Row | null>(null);
  const me = useMe();
  // The rep who logged it, or a manager, can edit it (the API checks this too).
  const canEdit = (r: Row) => !!me && (me.role === 'manager' || r.repId === me.id);
  const navigate = useNavigate();

  const { from, to } = rangeDates(range, custom);
  const backwards = !!from && !!to && to < from;          // a typed range that ends before it starts: nothing is asked of the server
  const filtersOn = !!repId || range !== 'all';
  const latest = useRef(0);                                // only the newest request may fill the list, never a slower older one

  function load() {
    if (backwards) return;
    setError(null);
    const mine = ++latest.current;
    apiGet(`/activity${activityQuery({ type, repId, from, to })}`).then(r => { if (latest.current === mine) setRows(r); }).catch(e => { if (latest.current === mine) setError(e.message); });
  }
  useEffect(() => { if (backwards) return; setRows(null); load(); }, [type, repId, from, to]);
  useEffect(() => { apiGet('/activity/reps').then(setReps).catch(() => undefined); }, []);

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
          {([['', 'All'], ['call', ACTIVITY_LABEL.call], ['email', ACTIVITY_LABEL.email], ['visit', ACTIVITY_LABEL.visit], ['remark', ACTIVITY_LABEL.remark]] as const).map(([key, label]) => (
            <button key={key} className={'tab' + (type === key ? ' active' : '')} onClick={() => setType(key)}>{label}</button>
          ))}
        </div>
        <input
          type="search" placeholder="Search store, rep or note" value={search} onChange={e => setSearch(e.target.value)}
          style={{ ...CONTROL, minWidth: 220, flex: '1 1 220px', maxWidth: 360 }}
        />
        <select aria-label="Rep" value={repId} onChange={e => setRepId(e.target.value)} style={CONTROL}>
          <option value="">All reps</option>
          {reps.map(r => <option key={r.id} value={r.id}>{r.name}{me?.id === r.id ? ' (me)' : ''}</option>)}
        </select>
        <select aria-label="Date" value={range} onChange={e => setRange(e.target.value as Range)} style={CONTROL}>
          {(Object.keys(RANGE_LABEL) as Range[]).map(k => <option key={k} value={k}>{RANGE_LABEL[k]}</option>)}
        </select>
        {range === 'custom' && (
          <>
            <input type="date" aria-label="From" value={custom.from} max={custom.to || undefined} onChange={e => setCustom(c => ({ ...c, from: e.target.value }))} style={CONTROL} />
            <span className="acct-region">to</span>
            <input type="date" aria-label="To" value={custom.to} min={custom.from || undefined} onChange={e => setCustom(c => ({ ...c, to: e.target.value }))} style={CONTROL} />
          </>
        )}
        {filtersOn && <button className="edit-link" onClick={() => { setRepId(''); setRange('all'); setCustom({ from: '', to: '' }); }}>Clear filters</button>}
      </div>
      {backwards && <div className="save-msg err" role="alert" style={{ marginBottom: 10 }}>The end date is before the start date.</div>}

      {!rows ? (
        <div className="empty-state">Loading…</div>
      ) : !shown.length ? (
        <div className="empty-state">
          {rows.length ? 'Nothing matches your search.' : filtersOn ? 'No activity matches those filters.' : `No ${type ? ACTIVITY_LABEL[type].toLowerCase() + ' activity' : 'activity'} logged yet.`}
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

      {logging && (
        <LogVisitModal defaultType={type || undefined} onCreated={load} onClose={() => setLogging(false)} />
      )}
    </>
  );
}