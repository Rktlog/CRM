import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiDelete, apiGet, apiPost } from '../lib/api';

// Settings (managers): accounts kept off a rep's lists even though they're
// in the rep's states, e.g. house accounts or ones someone else looks
// after. The rep stops seeing them everywhere (Accounts, Pipeline,
// Customers, Planner, Orders, Sales Data). Managers still see everything,
// and the account itself is untouched.

type Hidden = { accountId: string; name: string; region: string; createdAt: string; hiddenBy: string | null };
type AccountOption = { id: string; name: string; region: string; type: string };

export default function RepHiddenAccounts({ repId, repName, regions, onChange }: {
  repId: string; repName: string; regions: string[]; onChange?: () => void;
}) {
  const [hidden, setHidden] = useState<Hidden[] | null>(null);
  const [accounts, setAccounts] = useState<AccountOption[] | null>(null);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => apiGet(`/rep-regions/hidden?repId=${repId}`).then(setHidden).catch(e => setError(e.message));
  useEffect(() => { setHidden(null); setSearch(''); load(); }, [repId]);

  // Only accounts in this rep's states can be hidden from them.
  useEffect(() => {
    if (search.trim().length >= 2 && !accounts) apiGet('/accounts').then(setAccounts).catch(e => setError(e.message));
  }, [search]);

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!accounts || q.length < 2) return [];
    const already = new Set((hidden ?? []).map(h => h.accountId));
    return accounts
      .filter(a => regions.includes(a.region) && !already.has(a.id) && a.name.toLowerCase().includes(q))
      .slice(0, 8);
  }, [accounts, search, hidden, regions]);

  async function hide(a: AccountOption) {
    setBusy(true); setError(null);
    try {
      await apiPost('/rep-regions/hidden', { repId, accountId: a.id });
      setSearch('');
      await load();
      onChange?.();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }

  async function show(h: Hidden) {
    setBusy(true); setError(null);
    try {
      await apiDelete(`/rep-regions/hidden/${repId}/${h.accountId}`);
      await load();
      onChange?.();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }

  return (
    <div className="hidden-accounts">
      <div className="hidden-accounts-title">Accounts hidden from {repName}</div>
      <div className="acct-region" style={{ marginBottom: 8 }}>
        In {repName}'s states, but kept off their lists everywhere: Accounts, Pipeline, Customers, Planner, Orders and Sales Data.
      </div>

      <input
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder={regions.length ? `Search an account in ${regions.join(', ')} to hide` : 'Assign states first'}
        disabled={!regions.length || busy}
        className="credit-input"
      />
      {matches.length > 0 && (
        <div className="task-matches">
          {matches.map(a => (
            <div key={a.id} className="task-match" onMouseDown={e => { e.preventDefault(); hide(a); }}>
              {a.name}<span>{a.region}, {a.type}</span>
            </div>
          ))}
        </div>
      )}
      {error && <div className="save-msg err">{error}</div>}

      {!hidden ? (
        <div className="acct-region" style={{ marginTop: 8 }}>Loading…</div>
      ) : hidden.length === 0 ? (
        <div className="acct-region" style={{ marginTop: 8 }}>None hidden. {repName} sees every account in their states.</div>
      ) : (
        <div className="credit-list" style={{ marginTop: 8 }}>
          {hidden.map(h => (
            <div className="credit-row" key={h.accountId}>
              <div>
                <Link to={`/accounts/${h.accountId}`} className="acct-name">{h.name}</Link>
                <div className="acct-region">
                  {h.region}{h.hiddenBy ? `, hidden by ${h.hiddenBy}` : ''} on {new Date(h.createdAt).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}
                </div>
              </div>
              <button className="btn secondary" style={{ padding: '4px 10px', fontSize: 12 }} disabled={busy} onClick={() => show(h)}>
                Show again
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}