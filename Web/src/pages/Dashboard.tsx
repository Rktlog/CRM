import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiGet } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { Account, fmtDate, daysBetween, flagFor } from '../lib/types';
import AccountTable from '../components/AccountTable';
import BackorderCard from '../components/BackorderCard';
import TeamActivityCard from '../components/TeamActivityCard';

export default function Dashboard() {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const { role } = useAuth();

  useEffect(() => {
    apiGet('/accounts').then(setAccounts).catch(e => setError(e.message));
  }, []);

  if (error) return <div className="empty-state">Couldn't load accounts: {error}</div>;
  if (!accounts) return <div className="empty-state">Loading…</div>;

  const inactive = accounts.filter(a => flagFor(a) === 'rust');
  const active = accounts.filter(a => a.stage !== 'dispatched');

  const now = Date.now();
  const dueFollowUps = accounts
    .filter(a => a.nextFollowUpAt && new Date(a.nextFollowUpAt).getTime() <= now)
    .sort((a, b) => new Date(a.nextFollowUpAt!).getTime() - new Date(b.nextFollowUpAt!).getTime());

  return (
    <>
      <h1>Dashboard</h1>
      <div className="stat-row">
        <div className="stat">
          <div className="stat-label">Active deals</div>
          <div className="stat-value num">{active.length}</div>
        </div>
        <div className="stat flag-amber">
          <div className="stat-label">Follow-ups due</div>
          <div className="stat-value num">{dueFollowUps.length}</div>
          <div className="stat-sub">from notes or set manually</div>
        </div>
        <div className="stat flag-rust">
          <div className="stat-label">Inactive customers</div>
          <div className="stat-value num">{inactive.length}</div>
          <div className="stat-sub">overdue relative to their own pace</div>
        </div>
      </div>

      {role === 'manager' && (
        <div className="section">
          <TeamActivityCard />
        </div>
      )}

      <BackorderCard />

      {dueFollowUps.length > 0 && (
        <div className="section">
          <div className="panel-title">Follow-ups due</div>
          <div className="manifest">
            <div className="m-row head" style={{ gridTemplateColumns: '2fr 1fr 1fr' }}>
              <div>Account</div><div>Due</div><div></div>
            </div>
            {dueFollowUps.map(a => (
              <div
                className="m-row"
                key={a.id}
                style={{ gridTemplateColumns: '2fr 1fr 1fr' }}
                onClick={() => navigate(`/accounts/${a.id}`)}
              >
                <div>
                  <div className="acct-name">{a.name}</div>
                  <div className="acct-region">{a.region}</div>
                </div>
                <div>{fmtDate(a.nextFollowUpAt!)}</div>
                <div>
                  <span className="pill amber">{daysBetween(a.nextFollowUpAt!)}d overdue</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="section">
        <div className="panel-title">Needs attention {inactive.length > 0 && `(${inactive.length})`}</div>
        {inactive.length ? (
          <div className="scroll-capped-10">
            <AccountTable accounts={inactive} />
          </div>
        ) : (
          <div className="empty-state">Nothing needs follow-up right now.</div>
        )}
      </div>

      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
        Sales figures moved to the <a href="/sales-data">Sales Data</a> page — filter by fiscal year, quarter, or compare to last year there.
      </div>
    </>
  );
}