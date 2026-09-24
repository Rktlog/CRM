import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiGet } from '../lib/api';
import { Account, Quote, fmtDate } from '../lib/types';

type BackorderAccount = Account & { quotes: Quote[] };

export default function BackorderCard() {
  const [accounts, setAccounts] = useState<BackorderAccount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    apiGet('/accounts/backorders').then(setAccounts).catch(e => setError(e.message));
  }, []);

  if (error || (accounts && accounts.length === 0)) return null; // nothing to show, don't clutter the dashboard

  return (
    <div className="section">
      <div className="panel-title">Active backorders {accounts && accounts.length > 0 && `(${accounts.length})`}</div>
      {!accounts ? (
        <div className="empty-state">Loading…</div>
      ) : (
        <div className="scroll-capped-10">
          <div className="manifest">
            <div className="m-row head" style={{ gridTemplateColumns: '2fr 1fr 1fr' }}>
              <div>Account</div><div>Order</div><div>Since</div>
            </div>
            {accounts.map(a => {
              const quote = a.quotes[0];
              return (
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
                  <div><span className="pill rust">{quote?.number ?? '—'}</span></div>
                  <div>{quote ? fmtDate(quote.sentAt) : '—'}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}