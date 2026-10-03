import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { apiGet } from '../lib/api';
import { Account, STAGES, STAGE_LABELS, fmtMoney, flagFor } from '../lib/types';
import { useMe, stateOptionsFor, territoryLabel } from '../lib/useMe';

export default function Pipeline() {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [region, setRegion] = useState('');
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
        {stateOptions.length > 1 && (
          <select value={region} onChange={e => setRegion(e.target.value)}>
            <option value="">{me?.role === 'manager' ? 'All states' : 'All my states'}</option>
            {stateOptions.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        )}
      </div>
      {!accounts ? (
        <div className="empty-state">Loading…</div>
      ) : (
        <div className="board">
          {/* New business only: once an account's order has shipped, it's a
              customer and lives on the Customers board instead. */}
          {STAGES.filter(stage => stage !== 'dispatched').map(stage => {
            const deals = accounts.filter(a => a.stage === stage);
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
                        <div className="dc-name">{a.name}</div>
                        <div className="dc-meta">
                          <span>{a.region}</span>
                          <span className="num">{fmtMoney(a.spend90)}</span>
                        </div>
                        {a.repName && <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 2 }}>{a.repName}</div>}
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