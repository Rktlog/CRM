import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiGet } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { fmtDate, fmtMoney, daysBetween, fmtDuration } from '../lib/types';
import { loadDashboardData, type DashboardData } from '../lib/dashboardData';
import { HEALTH_COLUMNS, Health, healthOf } from '../lib/customerHealth';
import AccountTable from '../components/AccountTable';
import BackorderCard from '../components/BackorderCard';
import TeamActivityCard from '../components/TeamActivityCard';
import TeamLogCard from '../components/TeamLogCard';
import MyLogCard from '../components/MyLogCard';
import ConversionCard from '../components/ConversionCard';
import SummarySheet from '../components/SummarySheet';
import RepSummaries from '../components/RepSummaries';
import MyOrderFollowUps from '../components/MyOrderFollowUps';

export default function Dashboard() {
  // The lead and prospect counts, the overdue customers, the follow-ups due and the customer figures, in one request (see lib/dashboardData.ts).
  const [data, setData] = useState<DashboardData | null>(null);
  // Money owed across the person's accounts (same figures as Orders → Balances).
  const [owed, setOwed] = useState<{ balance: number; over60: number; d30: number; d60: number } | null>(null);
  // Stockists set up in DEAR that never ordered, or haven't for 12+ months: just the
  // numbers here; the list is on its own page.
  const [stockists, setStockists] = useState<{ never: number; lapsed: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const { role } = useAuth();
  const fy = new Date().getMonth() >= 6 ? new Date().getFullYear() : new Date().getFullYear() - 1;   // the financial year that started this July or last

  useEffect(() => {
    loadDashboardData().then(setData).catch(e => setError(e.message));
    apiGet('/orders/views/balances').then(b => setOwed(b.totals)).catch(() => {});
    // Never blocks the Dashboard: if this fails the card just doesn't show.
    apiGet('/accounts/inactive-stockists?limit=0').then(d => setStockists({ never: d.neverCount, lapsed: d.lapsedCount })).catch(() => {});
  }, []);

  if (error) return <div className="empty-state">Couldn't load accounts: {error}</div>;
  if (!data) return <div className="empty-state">Loading…</div>;

  // New Lead: set up in DEAR, no order yet, being worked toward a first order (approached, quote sent, or awaiting dispatch). Prospect: identified,
  // not set up in DEAR yet. Inactive: customers overdue against their own usual reorder gap, most overdue first, so the top of "Needs attention" is who
  // to call. Follow-ups due: soonest first. All of it is worked out by the API (GET /accounts/dashboard), from the same status view as the Accounts list.
  const { approached, quoteSent, paymentCleared, prospects } = data.counts;
  const openDeals = approached + quoteSent + paymentCleared;
  const { inactive, dueFollowUps, customers } = data;

  return (
    <>
      <h1>Dashboard</h1>
      <div className="stat-row">
        {stockists && stockists.never + stockists.lapsed > 0 && (
          <div
            className="stat flag-rust clickable"
            onClick={() => navigate('/inactive-stockists')}
            title="P1: set up in DEAR but never ordered. P2: ordered before, but not in the last 12 months. Click to see the list."
          >
            <div className="stat-label">Inactive stockist</div>
            <div style={{ display: 'flex', gap: 28 }}>
              <div>
                <div className="stat-value num">{stockists.never.toLocaleString('en-AU')}</div>
                <div className="stat-sub">P1 Never ordered</div>
              </div>
              <div>
                <div className="stat-value num">{stockists.lapsed.toLocaleString('en-AU')}</div>
                <div className="stat-sub">P2 Inactive 12+ months</div>
              </div>
            </div>
          </div>
        )}
        <div className="stat flag-teal clickable" onClick={() => navigate('/pipeline')} title="Open the Pipeline">
          <div className="stat-label">New Lead</div>
          <div className="stat-value num">{openDeals}</div>
          <div className="stat-sub">working toward first order: {approached} approached, {quoteSent} quote sent, {paymentCleared} awaiting dispatch</div>
        </div>
        <div className="stat clickable" onClick={() => navigate('/pipeline')} title="Open the Pipeline">
          <div className="stat-label">Prospect</div>
          <div className="stat-value num">{prospects}</div>
          <div className="stat-sub">not set up in DEAR yet</div>
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
              Active customers <span className="plan-count">{customers.length} stores, by their own reorder pace</span>
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

      {/* Reps see their own monthly summary here (it used to be on Sales Data). Managers see Conversion, and every rep's summary folded away by state and rep. */}
      {role === 'rep' && <div className="section"><SummarySheet fy={fy} /></div>}
      {role === 'manager' && (
        <>
          <ConversionCard />
          <div className="section">
            <RepSummaries fy={fy} />
          </div>
        </>
      )}

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

      {/* Everyone's own log: the entries they added or edited. (Managers also have the team log above.) */}
      <div className="section">
        <MyLogCard />
      </div>

      <MyOrderFollowUps />

      <BackorderCard />

      {dueFollowUps.length > 0 && (
        <div className="section" id="follow-ups">
          <div className="panel-title">Follow-ups due</div>
          <div className="scroll-capped-10">
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