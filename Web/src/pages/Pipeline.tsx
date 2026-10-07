import { useEffect, useMemo, useState } from 'react';
import StateFilter from '../components/StateFilter';
import { Link, useNavigate } from 'react-router-dom';
import { apiGet } from '../lib/api';
import { Account, STAGES, STAGE_LABELS, fmtMoney, fmtDate, flagFor } from '../lib/types';
import { useMe, stateOptionsFor, territoryLabel } from '../lib/useMe';

export default function Pipeline() {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [region, setRegion] = useState('');
  // Filter by when the account was added, and where it came from.
  const [added, setAdded] = useState<'any' | '7' | '30' | '90' | 'year' | 'range'>('any');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [source, setSource] = useState<'all' | 'dear' | 'crm'>('all');
  const navigate = useNavigate();
  const me = useMe();
  const stateOptions = stateOptionsFor(me);

  useEffect(() => {
    setAccounts(null);
    // The API limits reps to their states; region only narrows further.
    const params = new URLSearchParams();
    if (region) params.set('region', region);
    apiGet(`/accounts?${params.toString()}`).then(setAccounts).catch(e => setError(e.message));
  }, [region]);

  const shown = useMemo(() => {
    if (!accounts) return null;
    const now = new Date();
    const start =
      added === 'any' ? null
      : added === 'year' ? new Date(now.getFullYear(), 0, 1)
      : added === 'range' ? (from ? new Date(`${from}T00:00:00`) : null)
      : new Date(now.getTime() - Number(added) * 86400000);
    const end = added === 'range' && to ? new Date(`${to}T23:59:59`) : null;
    return accounts.filter(a => {
      const created = new Date(a.createdAt);
      if (start && created < start) return false;
      if (end && created > end) return false;
      if (source === 'dear' && !a.dearCustomerId) return false;
      if (source === 'crm' && a.dearCustomerId) return false;
      return true;
    });
  }, [accounts, added, from, to, source]);

  if (error) return <div className="empty-state">Couldn't load accounts: {error}</div>;

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div>
          <h1>Pipeline</h1>
          {territoryLabel(me) && <div className="territory-note">{territoryLabel(me)}</div>}
          <div className="territory-note">
            New business. Once a store's first order ships, it moves to <Link to="/customers" className="order-link">Customers</Link>.
          </div>
        </div>
        <div className="pipeline-filters">
          <select value={added} onChange={e => setAdded(e.target.value as typeof added)} aria-label="Added">
            <option value="any">Added: any time</option>
            <option value="7">Added: last 7 days</option>
            <option value="30">Added: last 30 days</option>
            <option value="90">Added: last 90 days</option>
            <option value="year">Added: this year</option>
            <option value="range">Added: date range…</option>
          </select>
          {added === 'range' && (
            <>
              <input type="date" value={from} onChange={e => setFrom(e.target.value)} aria-label="Added from" />
              <span className="acct-region">to</span>
              <input type="date" value={to} onChange={e => setTo(e.target.value)} aria-label="Added to" />
            </>
          )}
          <select value={source} onChange={e => setSource(e.target.value as typeof source)} aria-label="Source">
            <option value="all">Source: all</option>
            <option value="dear">Source: from DEAR</option>
            <option value="crm">Source: added in the CRM</option>
          </select>
          {stateOptions.length > 1 && (
            <StateFilter value={region} onChange={setRegion} options={stateOptions}
              allLabel={me?.role === 'manager' ? 'All states' : 'All my states'} />
          )}
        </div>
      </div>
      {!shown ? (
        <div className="empty-state">Loading…</div>
      ) : (
        <div className="board">
          {/* New business only: once an account's order has shipped, it's a
              customer and lives on the Customers board instead. */}
          {STAGES.filter(stage => stage !== 'dispatched').map(stage => {
            // Newest first, so recently added accounts are at the top.
            const deals = shown
              .filter(a => a.stage === stage)
              .sort((x, y) => new Date(y.createdAt).getTime() - new Date(x.createdAt).getTime());
            return (
              <div className="bay" key={stage}>
                <div className="bay-head">
                  <span>{STAGE_LABELS[stage]}</span>
                  <span className="n">{deals.length}</span>
                </div>
                <div className="bay-body">
                  {deals.length === 0 && <div style={{ color: 'var(--muted)', fontSize: 12, padding: '8px 2px' }}>No deals</div>}
                  {deals.map(a => {
                    const flag = flagFor(a);
                    return (
                      <div
                        key={a.id}
                        className={'deal-card' + (flag ? ` flag-${flag}` : '')}
                        onClick={() => navigate(`/accounts/${a.id}`)}
                      >
                        <div className="dc-name">
                          {a.name}
                          {a.dearCustomerId && <span className="dear-tag small" title="Linked to a DEAR customer">DEAR</span>}
                        </div>
                        <div className="dc-meta">
                          <span>{a.region}</span>
                          <span className="num">{fmtMoney(a.spend90)}</span>
                        </div>
                        <div className="dc-added">
                          Added {fmtDate(a.createdAt)}{a.repName ? ` · ${a.repName}` : ''}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}