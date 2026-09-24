import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiGet } from '../lib/api';
import { Account, STAGES, STAGE_LABELS, fmtMoney, flagFor } from '../lib/types';

const ALL_STATES = ['NSW', 'ACT', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'NT', 'NZ'];

export default function Pipeline() {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [region, setRegion] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    setAccounts(null);
    const params = new URLSearchParams({ scope: 'all' });
    if (region) params.set('region', region);
    apiGet(`/accounts?${params.toString()}`).then(setAccounts).catch(e => setError(e.message));
  }, [region]);

  if (error) return <div className="empty-state">Couldn't load accounts: {error}</div>;

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h1>Pipeline</h1>
        <select value={region} onChange={e => setRegion(e.target.value)}>
          <option value="">All states</option>
          {ALL_STATES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      {!accounts ? (
        <div className="empty-state">Loading…</div>
      ) : (
        <div className="board">
          {STAGES.map(stage => {
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