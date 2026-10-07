import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiGet } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { Account, fmtDate, fmtMoney, daysBetween, isOverdueCustomer, fmtDuration } from '../lib/types';
import { HEALTH_COLUMNS, Health, healthOf } from '../lib/customerHealth';
import AccountTable from '../components/AccountTable';
import BackorderCard from '../components/BackorderCard';
import TeamActivityCard from '../components/TeamActivityCard';
import TeamLogCard from '../components/TeamLogCard';

export default function Dashboard() {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  // Same list as the Customers board, so the counts always match it.
  // Money owed across the person's accounts (same figures as Orders → Balances).
  const [owed, setOwed] = useState<{ balance: number; over60: number; d30: number; d60: number } | null>(null);
  const [customers, setCustomers] = useState<{ lastOrderAt: string | null; avgOrderGapDays: number | null; spend365: number }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const { role } = useAuth();

  useEffect(() => {
    apiGet('/accounts').then(setAccounts).catch(e => setError(e.message));
    apiGet('/accounts/customers').then(setCustomers).catch(() => {});
    apiGet('/orders/views/balances').then(b => setOwed(b.totals)).catch(() => {});
  }, []);

  if (error) return <div className="empty-state">Couldn't load accounts: {error}</div>;
  if (!accounts) return <div className="empty-state">Loading…</div>;

  // Open deals: accounts someone is actually working, from first contact
  // until payment clears. Untouched new leads are counted separately, and
  // dispatched means the deal's done (the account is a customer now).
  const approached = accounts.filter(a => a.stage === 'approached').length;
  const quoteSent = accounts.filter(a => a.stage === 'quote_sent').length;
  const paymentCleared = accounts.filter(a => a.stage === 'payment_cleared').length;
  const openDeals = approached + quoteSent + paymentCleared;
  const newLeads = accounts.filter(a => a.stage === 'new_lead').length;

  // Inactive: customers overdue against their own usual reorder gap.
  // Most overdue first, so the top of "Needs attention" is who to call.
  const overdueBy = (a: Account) => {
    const threshold = a.avgOrderGapDays ? Math.max(a.avgOrderGapDays * 1.5, 14) : 75;
    return daysBetween(a.lastOrderAt!) - threshold;
  };
  const inactive = accounts.filter(isOverdueCustomer).sort((a, b) => overdueBy(b) - overdueBy(a));

  const now = Date.now();
  const dueFollowUps = accounts
    .filter(a => a.nextFollowUpAt && new Date(a.nextFollowUpAt).getTime() <= now)
    .sort((a, b) => new Date(a.nextFollowUpAt!).getTime() - new Date(b.nextFollowUpAt!).getTime());

  return (
    <>
      <h1>Dashboard</h1>
      <div className="stat-row">
        <div className="stat flag-teal clickable" onClick={() => navigate('/pipeline')} title="Open the Pipeline">
          <div className="stat-label">Open deals</div>
          <div className="stat-value num">{openDeals}</div>
          <div className="stat-sub">{approached} approached, {quoteSent} quote sent, {paymentCleared} awaiting dispatch</div>
        </div>
        <div className="stat clickable" onClick={() => navigate('/pipeline')} title="Open the Pipeline">
          <div className="stat-label">New leads</div>
          <div className="stat-value num">{newLeads}</div>
          <div className="stat-sub">not contacted yet</div>
        </div>
        <a className="stat flag-amber clickable" href="#follow-ups">
          <div className="stat-label">Follow-ups due</div>
          <div className="stat-value num">{dueFollowUps.length}</div>
          <div className="stat-sub">from notes or set manually</div>
        </a>
        {owed && (
          <div className="stat flag-amber clickable" onClick={() => navigate('/orders?tab=balances')} title="Open Orders → Balances">
            <div className="stat-label">Owed to us</div>
            <div className="stat-value num">{fmtMoney(Math.round(owed.balance))}</div>
            <div className="stat-sub">{fmtMoney(Math.round(owed.over60))} more than 2 months overdue</div>
          </div>
        )}
        <a className="stat flag-rust clickable" href="#needs-attention">
          <div className="stat-label">Inactive customers</div>
          <div className="stat-value num">{inactive.length}</div>
          <div className="stat-sub">overdue against their usual reorder gap</div>
        </a>
      </div>

      {/* ---- Customer base at a glance (same rules as the Customers board) ---- */}
      {customers && customers.length > 0 && (() => {
        const counts: Record<Health, { n: number; value: number }> = {
          recent: { n: 0, value: 0 }, due: { n: 0, value: 0 }, overdue: { n: 0, value: 0 }, lapsed: { n: 0, value: 0 },
        };
        for (const c of customers) {
          const h = healthOf(c);
          counts[h].n++;
          counts[h].value += c.spend365;
        }
        return (
          <div className="section">
            <div className="panel-title">
              Customers <span className="plan-count">{customers.length} stores, by their own reorder pace</span>
            </div>
            <div className="health-row">
              {HEALTH_COLUMNS.map(col => (
                <div
                  key={col.key}
                  className={`health-stat health-stat-${col.key}`}
                  onClick={() => navigate(`/customers?col=${col.key}`)}
                  title={`${col.hint}. Open on the Customers board.`}
                >
                  <div className="stat-label">{col.title}</div>
                  <div className="stat-value num">{counts[col.key].n}</div>
                  <div className="stat-sub">{fmtMoney(Math.round(counts[col.key].value))} a year</div>
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      {role === 'manager' && (
        <>
          <div className="section">
            <TeamActivityCard />
          </div>
          <div className="section">
            <TeamLogCard />
          </div>
        </>
      )}

      <BackorderCard />

      {dueFollowUps.length > 0 && (
        <div className="section" id="follow-ups">
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
                  <span className="pill amber">{fmtDuration(daysBetween(a.nextFollowUpAt!))} overdue</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="section" id="needs-attention">
        <div className="panel-title">Needs attention {inactive.length > 0 && `(${inactive.length})`}</div>
        <div className="acct-region" style={{ margin: '-6px 0 10px' }}>
          Customers who haven't ordered for longer than usual for them (1.5 times their normal gap between orders, or 75 days if there isn't enough history). Most overdue first.
        </div>
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