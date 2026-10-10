import { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiGet, apiDownload } from '../lib/api';
import { fmtMoney, fmtDateWithYear } from '../lib/types';

// Warranty and marketing orders. Marketing orders are all billed to one account
// ("Rhino Rhino Marketing"), which says nothing about them, so each row shows the FULL
// SHIP-TO DETAILS (name, contact, street, suburb, state, postcode) and the state. A
// line that is only the billing account's name is left out. The billing account column
// is not shown for marketing; for warranty only when the orders are billed to more than
// one account. A row opens the order.

type MiscRow = {
  id: string; number: string; date: string; accountId: string; accountName: string;
  region: string; amount: number; reference: string | null; source: string;
  sentTo: string; sentToContact: string; sentToSuburb: string; sentToState: string; sentToLines: string[];
};
type MiscData = { type: string; count: number; total: number; rows: MiscRow[] };
type SortKey = 'accountName' | 'sentTo' | 'state' | 'date' | 'amount';

const COLS_WITH_ACCOUNT = '1.3fr 1.5fr 0.5fr 0.85fr 0.85fr 0.85fr 0.6fr';
const COLS = '2fr 0.5fr 0.9fr 0.9fr 0.9fr 0.6fr';

export default function Misc() {
  const [tab, setTab] = useState<'marketing' | 'warranty'>('warranty');
  const [data, setData] = useState<MiscData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('date');
  const [sortDir, setSortDir] = useState<1 | -1>(-1);
  const navigate = useNavigate();

  useEffect(() => {
    setData(null);
    apiGet(`/misc-orders?type=${tab}`).then(setData).catch(e => setError(e.message));
  }, [tab]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) setSortDir(d => (d === -1 ? 1 : -1));
    else { setSortKey(key); setSortDir(key === 'date' || key === 'amount' ? -1 : 1); }
  }

  // Marketing: never (they are all the one marketing account). Warranty: only when the
  // orders are billed to different accounts.
  const showAccount = !!data && tab === 'warranty' && new Set(data.rows.map(r => r.accountId)).size > 1;
  const cols = showAccount ? COLS_WITH_ACCOUNT : COLS;

  const filtered = useMemo(() => {
    if (!data) return [];
    const needle = search.trim().toLowerCase();
    const key: SortKey = sortKey === 'accountName' && !showAccount ? 'date' : sortKey;
    // Search who it was sent to (name, contact, suburb), the state and the order number.
    const rows = data.rows.filter(r => !needle || [...(r.sentToLines ?? []), r.sentToState, r.number, showAccount ? r.accountName : '']
      .some(v => (v ?? '').toLowerCase().includes(needle)));
    return [...rows].sort((a, b) => {
      // Nothing saved (no ship-to, or no state) always goes last, whichever way it is sorted.
      const blank = (r: MiscRow) => (key === 'state' ? !r.sentToState : key === 'sentTo' ? !r.sentToLines?.length : false);
      if (blank(a) !== blank(b)) return blank(a) ? 1 : -1;
      let cmp = 0;
      if (key === 'accountName') cmp = a.accountName.localeCompare(b.accountName);
      else if (key === 'sentTo') cmp = (a.sentToLines?.[0] ?? '').localeCompare(b.sentToLines?.[0] ?? '');
      else if (key === 'state') cmp = a.sentToState.localeCompare(b.sentToState);
      else if (key === 'date') cmp = new Date(a.date).getTime() - new Date(b.date).getTime();
      else if (key === 'amount') cmp = a.amount - b.amount;
      return sortDir === 1 ? cmp : -cmp;
    });
  }, [data, search, sortKey, sortDir, showAccount]);

  async function download() {
    setDownloading(true);
    try {
      await apiDownload(`/exports/misc-${tab}`, `misc-${tab}.xlsx`);
    } finally {
      setDownloading(false);
    }
  }

  if (error) return <div className="empty-state">Couldn't load misc orders: {error}</div>;

  function sortArrow(key: SortKey) {
    return sortKey === key ? (sortDir === -1 ? ' ↓' : ' ↑') : '';
  }

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h1>Misc</h1>
        <button className="btn secondary" style={{ padding: '5px 12px', fontSize: 12 }} disabled={downloading || !data} onClick={download}>
          {downloading ? 'Downloading…' : '⬇ Excel'}
        </button>
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 16, maxWidth: 600 }}>
        Real orders that aren't commercial sales — warranty replacements and marketing/sample
        giveaways. Excluded from every performance figure across the app, kept visible here for
        reference. Each one shows who it was sent to and which state.
      </div>

      <div className="tab-bar">
        <button className={'tab' + (tab === 'warranty' ? ' active' : '')} onClick={() => setTab('warranty')}>
          Warranty {data && tab === 'warranty' && <span className="tab-count">{data.count}</span>}
        </button>
        <button className={'tab' + (tab === 'marketing' ? ' active' : '')} onClick={() => setTab('marketing')}>
          Marketing {data && tab === 'marketing' && <span className="tab-count">{data.count}</span>}
        </button>
      </div>

      {!data ? (
        <div className="empty-state">Loading…</div>
      ) : (
        <>
          <div className="toolbar">
            <input
              className="search-input"
              placeholder="Search ship-to name, address, suburb, state or order…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            <span className="toolbar-count">{filtered.length} of {data.count} · {fmtMoney(data.total)} total</span>
          </div>

          {filtered.length === 0 ? (
            <div className="empty-state">No {tab} orders {search ? 'match your search' : 'found'}.</div>
          ) : (
            <div className="scroll-capped-10">
              <div className="manifest">
                <div className="m-row head" style={{ gridTemplateColumns: cols }}>
                  {showAccount && <div className="sortable-head" onClick={() => toggleSort('accountName')}>Account{sortArrow('accountName')}</div>}
                  <div className="sortable-head" onClick={() => toggleSort('sentTo')}>Sent to{sortArrow('sentTo')}</div>
                  <div className="sortable-head" onClick={() => toggleSort('state')}>State{sortArrow('state')}</div>
                  <div>Order</div>
                  <div className="sortable-head" onClick={() => toggleSort('date')}>Date{sortArrow('date')}</div>
                  <div className="num sortable-head" onClick={() => toggleSort('amount')}>Amount{sortArrow('amount')}</div>
                  <div>Source</div>
                </div>
                {filtered.map(r => (
                  <div
                    className="m-row"
                    key={r.id}
                    style={{ gridTemplateColumns: cols }}
                    onClick={() => navigate(`/orders/${r.id}`)}
                  >
                    {showAccount && (
                      <div>
                        <div className="acct-name">{r.accountName}</div>
                        <div className="acct-region">{r.region}</div>
                      </div>
                    )}
                    <div>
                      {r.sentToLines && r.sentToLines.length ? (
                        <>
                          <div className="acct-name">{r.sentToLines[0]}</div>
                          {r.sentToLines.slice(1).map((line, i) => <div className="acct-region" key={i}>{line}</div>)}
                        </>
                      ) : (
                        <div className="acct-region">No ship-to saved</div>
                      )}
                    </div>
                    <div>{r.sentToState || <span className="acct-region">—</span>}</div>
                    <div className="num">{r.number}</div>
                    <div>{fmtDateWithYear(r.date)}</div>
                    <div className="num">{fmtMoney(r.amount)}</div>
                    <div>
                      {r.source === 'rhino-history' ? (
                        <span className="badge muted">History</span>
                      ) : (
                        <span className="badge" style={{ color: 'var(--teal)', borderColor: 'var(--teal)' }}>Live</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}