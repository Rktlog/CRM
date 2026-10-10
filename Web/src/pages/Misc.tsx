import { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiGet, apiDownload } from '../lib/api';
import { fmtMoney, fmtDateWithYear } from '../lib/types';

// Warranty and marketing orders. They are billed to one account (e.g. "Rhino Rhino
// Marketing") but sent to many people and stores, so each row shows who it was sent
// to and which state, the same as the Excel report.

type MiscRow = {
  id: string; number: string; date: string; accountId: string; accountName: string;
  region: string; amount: number; reference: string | null; source: string;
  sentTo: string; sentToContact: string; sentToSuburb: string; sentToState: string;
};
type MiscData = { type: string; count: number; total: number; rows: MiscRow[] };
type SortKey = 'accountName' | 'sentTo' | 'state' | 'date' | 'amount';

const COLS = '1.3fr 1.5fr 0.5fr 0.85fr 0.85fr 0.85fr 0.6fr';

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

  const filtered = useMemo(() => {
    if (!data) return [];
    const needle = search.trim().toLowerCase();
    // Search the account, who it was sent to (name, contact, suburb) and the state.
    const rows = data.rows.filter(r => !needle || [r.accountName, r.sentTo, r.sentToContact, r.sentToSuburb, r.sentToState, r.number]
      .some(v => (v ?? '').toLowerCase().includes(needle)));
    return [...rows].sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'accountName') cmp = a.accountName.localeCompare(b.accountName);
      else if (sortKey === 'sentTo') cmp = a.sentTo.localeCompare(b.sentTo);
      else if (sortKey === 'state') cmp = (a.sentToState || '~').localeCompare(b.sentToState || '~');   // blanks last
      else if (sortKey === 'date') cmp = new Date(a.date).getTime() - new Date(b.date).getTime();
      else if (sortKey === 'amount') cmp = a.amount - b.amount;
      return sortDir === 1 ? cmp : -cmp;
    });
  }, [data, search, sortKey, sortDir]);

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
              placeholder="Search account, sent to, suburb or state…"
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
                <div className="m-row head" style={{ gridTemplateColumns: COLS }}>
                  <div className="sortable-head" onClick={() => toggleSort('accountName')}>Account{sortArrow('accountName')}</div>
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
                    style={{ gridTemplateColumns: COLS }}
                    onClick={() => navigate(`/accounts/${r.accountId}`)}
                  >
                    <div>
                      <div className="acct-name">{r.accountName}</div>
                      <div className="acct-region">{r.region}</div>
                    </div>
                    <div>
                      <div className="acct-name">{r.sentTo}</div>
                      {(r.sentToContact && r.sentToContact !== r.sentTo) || r.sentToSuburb ? (
                        <div className="acct-region">{[r.sentToContact !== r.sentTo ? r.sentToContact : '', r.sentToSuburb].filter(Boolean).join(' · ')}</div>
                      ) : null}
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