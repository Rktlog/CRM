import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { apiGet } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { fmtDate, fmtDuration, daysBetween } from '../lib/types';

// Stockists set up in DEAR that have never placed an order, or haven't ordered
// for 12 months or more. The Dashboard shows the number; this is the list.
// ?kind=never or ?kind=lapsed opens straight onto one tab.

type Row = {
  id: string; name: string; region: string; repName: string | null; contactName: string | null;
  phone: string | null; email: string | null; paymentTerms: string | null; lastOrderAt: string | null;
};
type Kind = 'all' | 'never' | 'lapsed';
const PAGE = 50;

export default function InactiveStockists() {
  const [params, setParams] = useSearchParams();
  const k = params.get('kind');
  const kind: Kind = k === 'never' || k === 'lapsed' ? k : 'all';
  const setKind = (next: Kind) => setParams(next === 'all' ? {} : { kind: next });

  const [search, setSearch] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [counts, setCounts] = useState<{ never: number; lapsed: number } | null>(null);
  const [matches, setMatches] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const { role } = useAuth();
  const showRep = role === 'manager';

  async function load(offset: number, append: boolean) {
    setLoading(true);
    setError(null);
    try {
      const d = await apiGet(`/accounts/inactive-stockists?kind=${kind}&limit=${PAGE}&offset=${offset}&q=${encodeURIComponent(search.trim())}`);
      setRows(prev => (append ? [...prev, ...d.rows] : d.rows));
      setCounts({ never: d.neverCount, lapsed: d.lapsedCount });
      setMatches(d.matches);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  // First page now, and again (after a short pause) when the tab or search changes.
  useEffect(() => {
    const t = setTimeout(() => load(0, false), search ? 300 : 0);
    return () => clearTimeout(t);
  }, [kind, search]);

  const total = counts ? counts.never + counts.lapsed : 0;
  const cols = showRep ? '2fr 0.6fr 1fr 1.3fr 1.3fr 1fr' : '2fr 0.6fr 1.3fr 1.3fr 1fr';
  const TABS: { key: Kind; label: string; n: number | null }[] = [
    { key: 'all', label: 'All', n: counts ? total : null },
    { key: 'never', label: 'Never ordered', n: counts?.never ?? null },
    { key: 'lapsed', label: '12+ months', n: counts?.lapsed ?? null },
  ];

  return (
    <>
      <Link to="/" className="order-link">← Dashboard</Link>
      <h1>Inactive stockists</h1>
      <div className="stock-as-of">
        Stores set up in DEAR that have never placed an order, or haven't ordered for 12 months or more.
        {counts && <> {total.toLocaleString('en-AU')} {total === 1 ? 'store' : 'stores'}.</>}
      </div>

      <div className="tab-bar" style={{ margin: '12px 0' }}>
        {TABS.map(t => (
          <button key={t.key} className={'tab' + (kind === t.key ? ' active' : '')} onClick={() => setKind(t.key)}>
            {t.label}{t.n != null ? ` (${t.n.toLocaleString('en-AU')})` : ''}
          </button>
        ))}
      </div>
      <input
        type="search"
        placeholder="Search by store name"
        value={search}
        onChange={e => setSearch(e.target.value)}
        style={{ width: '100%', maxWidth: 320, boxSizing: 'border-box', marginBottom: 12, padding: '8px 10px', border: '1px solid var(--line)', borderRadius: 6, font: 'inherit', fontSize: 13, background: 'var(--panel)' }}
      />

      {error && <div className="empty-state">Couldn't load the list: {error}</div>}
      {!error && loading && rows.length === 0 && <div className="empty-state">Loading…</div>}
      {!error && !loading && rows.length === 0 && (
        <div className="empty-state">{search ? `No stores match "${search}".` : 'None in this list.'}</div>
      )}

      {!error && rows.length > 0 && (
        <div className="manifest">
          <div className="m-row head" style={{ gridTemplateColumns: cols }}>
            <div>Store</div><div>State</div>{showRep && <div>Rep</div>}<div>Last order</div><div>Contact</div><div>Payment terms</div>
          </div>
          {rows.map(r => (
            <div className="m-row" key={r.id} style={{ gridTemplateColumns: cols }} onClick={() => navigate(`/accounts/${r.id}`)}>
              <div className="acct-name">{r.name}</div>
              <div>{r.region}</div>
              {showRep && <div>{r.repName ?? ''}</div>}
              <div>
                {r.lastOrderAt
                  ? <>{fmtDate(r.lastOrderAt)}<div className="acct-region">{fmtDuration(daysBetween(r.lastOrderAt))} ago</div></>
                  : <span className="pill neutral">Never ordered</span>}
              </div>
              <div>
                {r.contactName ?? <span className="acct-region">No name</span>}
                {(r.phone || r.email) && <div className="acct-region">{r.phone ?? r.email}</div>}
              </div>
              <div className="acct-region">{r.paymentTerms ?? 'None in DEAR'}</div>
            </div>
          ))}
        </div>
      )}

      {rows.length > 0 && rows.length < matches && (
        <button className="btn secondary" style={{ marginTop: 12 }} disabled={loading} onClick={() => load(rows.length, true)}>
          {loading ? 'Loading…' : `Show ${Math.min(PAGE, matches - rows.length)} more (${(matches - rows.length).toLocaleString('en-AU')} left)`}
        </button>
      )}
    </>
  );
}