import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { apiGet } from '../lib/api';
import { Account } from '../lib/types';
import AccountTable from '../components/AccountTable';

// The stores in one council. Opened from the council line on an account page, so a visit can be planned around the other stores
// in the same council. It shows the stores this person can see, like the Accounts page.
type WithCouncil = Account & { council?: string | null };

export default function CouncilStores() {
  const { name = '' } = useParams();
  const navigate = useNavigate();
  const [accounts, setAccounts] = useState<WithCouncil[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setAccounts(null);
    setError(null);
    apiGet('/accounts').then(setAccounts).catch(e => setError(e.message));
  }, [name]);

  const stores = useMemo(
    () => (accounts ?? []).filter(a => a.council === name).sort((a, b) => a.name.localeCompare(b.name)),
    [accounts, name],
  );

  return (
    <>
      <button type="button" className="link-btn" onClick={() => navigate(-1)}>← Back</button>
      <h1 style={{ marginTop: 8 }}>{name}</h1>
      {error && <div className="empty-state">Couldn't load the stores: {error}</div>}
      {!error && !accounts && <div className="empty-state">Loading…</div>}
      {!error && accounts && (
        <>
          <div className="territory-note" style={{ marginBottom: 12 }}>
            {stores.length === 1 ? '1 store' : `${stores.length} stores`} in this council
          </div>
          <div className="section">
            {stores.length ? <AccountTable accounts={stores} /> : <div className="empty-state">No stores found in this council.</div>}
          </div>
        </>
      )}
    </>
  );
}