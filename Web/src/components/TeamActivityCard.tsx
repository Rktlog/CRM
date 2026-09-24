import { useEffect, useState } from 'react';
import { apiGet } from '../lib/api';

type TeamActivityRow = { repId: string; repName: string; calls: number; emails: number; visits: number; total: number };

export default function TeamActivityCard() {
  const [rows, setRows] = useState<TeamActivityRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet('/reports/team-activity?days=7').then(data => setRows(data.rows)).catch(e => setError(e.message));
  }, []);

  if (error) return null;

  return (
    <div className="card">
      <h3>Team activity, last 7 days</h3>
      {!rows ? (
        <div style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={{ color: 'var(--muted)', fontSize: 13 }}>Nothing logged this week yet.</div>
      ) : (
        <div className="manifest" style={{ border: 'none' }}>
          <div className="m-row head" style={{ gridTemplateColumns: '1.4fr 0.7fr 0.7fr 0.7fr 0.7fr', padding: '8px 0' }}>
            <div>Rep</div><div className="num">Calls</div><div className="num">Emails</div><div className="num">Visits</div><div className="num">Total</div>
          </div>
          {rows.map(r => (
            <div className="m-row" key={r.repId} style={{ gridTemplateColumns: '1.4fr 0.7fr 0.7fr 0.7fr 0.7fr', cursor: 'default', padding: '9px 0' }}>
              <div className="acct-name">{r.repName}</div>
              <div className="num">{r.calls}</div>
              <div className="num">{r.emails}</div>
              <div className="num">{r.visits}</div>
              <div className="num" style={{ fontWeight: 600 }}>{r.total}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}