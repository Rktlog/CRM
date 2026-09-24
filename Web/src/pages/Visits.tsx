import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiGet } from '../lib/api';
import { fmtDate } from '../lib/types';
import LogVisitModal from '../components/LogVisitModal';

type VisitRow = {
  id: string;
  accountId: string;
  accountName: string;
  accountRegion: string;
  repName: string | null;
  occurredAt: string;
  note: string;
  photoUrl: string | null;
};

export default function Visits() {
  const [rows, setRows] = useState<VisitRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showNewVisit, setShowNewVisit] = useState(false);
  const navigate = useNavigate();

  function load() {
    apiGet('/activity?type=visit').then(setRows).catch(e => setError(e.message));
  }

  useEffect(load, []);

  if (error) return <div className="empty-state">Couldn't load visits: {error}</div>;

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h1>Visit log</h1>
        <button className="btn" onClick={() => setShowNewVisit(true)}>+ New visit</button>
      </div>

      {!rows ? (
        <div className="empty-state">Loading…</div>
      ) : !rows.length ? (
        <div className="empty-state">No visits logged yet.</div>
      ) : (
        <div className="manifest">
          <div className="m-row head" style={{ gridTemplateColumns: '1.4fr 1fr 1fr 2fr 0.8fr' }}>
            <div>Account</div><div>Rep</div><div>Date</div><div>Note</div><div>Photo</div>
          </div>
          {rows.map(v => (
            <div
              className="m-row"
              key={v.id}
              style={{ gridTemplateColumns: '1.4fr 1fr 1fr 2fr 0.8fr' }}
              onClick={() => navigate(`/accounts/${v.accountId}`)}
            >
              <div>
                <div className="acct-name">{v.accountName}</div>
                <div className="acct-region">{v.accountRegion}</div>
              </div>
              <div>{v.repName ?? '—'}</div>
              <div>{fmtDate(v.occurredAt)}</div>
              <div style={{ color: 'var(--ink-soft)' }}>{v.note}</div>
              <div>{v.photoUrl ? <span className="pill teal">Attached</span> : <span className="pill neutral">None</span>}</div>
            </div>
          ))}
        </div>
      )}

      {rows && rows.length === 300 && (
        <div style={{ marginTop: 12, fontSize: 12, color: 'var(--muted)' }}>
          Showing the most recent 300 visits.
        </div>
      )}

      {showNewVisit && (
        <LogVisitModal onCreated={load} onClose={() => setShowNewVisit(false)} />
      )}
    </>
  );
}