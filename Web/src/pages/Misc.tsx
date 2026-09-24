import { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiGet, apiDownload } from '../lib/api';
import { fmtMoney, fmtDateWithYear } from '../lib/types';

type MiscRow = {
  id: string; number: string; date: string; accountId: string; accountName: string;
  region: string; amount: number; reference: string | null; source: string;
};
type MiscData = { type: string; count: number; total: number; rows: MiscRow[] };
type SortKey = 'accountName' | 'date' | 'amount';

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
    else { setSortKey(key); setSortDir(-1); }
  }

  const filtered = useMemo(() => {
    if (!data) return [];
    const rows = data.rows.filter(r => !search.trim() || r.accountName.toLowerCase().includes(search.trim().toLowerCase()));
    return [...rows].sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'accountName') cmp = a.accountName.localeCompare(b.accountName);
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
        reference.
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
              placeholder="Search account name…"
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
                <div className="m-row head" style={{ gridTemplateColumns: '1.5fr 0.9fr 0.9fr 0.9fr 0.7fr' }}>
                  <div className="sortable-head" onClick={() => toggleSort('accountName')}>Account{sortArrow('accountName')}</div>
                  <div>Order</div>
                  <div className="sortable-head" onClick={() => toggleSort('date')}>Date{sortArrow('date')}</div>
                  <div className="num sortable-head" onClick={() => toggleSort('amount')}>Amount{sortArrow('amount')}</div>
                  <div>Source</div>
                </div>
                {filtered.map(r => (
                  <div
                    className="m-row"
                    key={r.id}
                    style={{ gridTemplateColumns: '1.5fr 0.9fr 0.9fr 0.9fr 0.7fr' }}
                    onClick={() => navigate(`/accounts/${r.accountId}`)}
                  >
                    <div>
                      <div className="acct-name">{r.accountName}</div>
                      <div className="acct-region">{r.region}</div>
                    </div>
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