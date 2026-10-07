import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { apiGet } from '../lib/api';
import { fmtMoney, daysBetween, fmtDuration } from '../lib/types';
import { useMe, stateOptionsFor, territoryLabel } from '../lib/useMe';
import { HEALTH_COLUMNS as COLUMNS, Health, healthOf } from '../lib/customerHealth';

const PAGE = 40;

// Existing customers, arranged by reorder health rather than order stage:
// is each store still ordering on its own usual schedule? New business
// lives on the Pipeline; accounts arrive here once they're customers.

type Customer = {
  id: string; name: string; region: string; contactName: string | null; phone: string | null;
  lastOrderAt: string | null; avgOrderGapDays: number | null; spend90: number; spend365: number;
  repName: string | null; openQuote: boolean; backordered: boolean; owing: number;
};
export default function Customers() {
  const [customers, setCustomers] = useState<Customer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [region, setRegion] = useState('');
  const [search, setSearch] = useState('');
  const [shown, setShown] = useState<Record<Health, number>>({ recent: PAGE, due: PAGE, overdue: PAGE, lapsed: PAGE });
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const focus = params.get('col') as Health | null;
  const me = useMe();
  const stateOptions = stateOptionsFor(me);

  useEffect(() => {
    apiGet('/accounts/customers').then(setCustomers).catch(e => setError(e.message));
  }, []);

  // Arriving from the Dashboard with ?col=…: bring that column into view.
  useEffect(() => {
    if (customers && focus) document.getElementById(`col-${focus}`)?.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' });
  }, [customers, focus]);

  const columns = useMemo(() => {
    const q = search.trim().toLowerCase();
    const visible = (customers ?? []).filter(c =>
      (!region || c.region === region) &&
      (!q || c.name.toLowerCase().includes(q) || (c.contactName ?? '').toLowerCase().includes(q)));
    const by: Record<Health, Customer[]> = { recent: [], due: [], overdue: [], lapsed: [] };
    for (const c of visible) by[healthOf(c)].push(c);
    // Most valuable first, so the top of each column is who matters most.
    for (const k of Object.keys(by) as Health[]) by[k].sort((a, b) => b.spend365 - a.spend365);
    return by;
  }, [customers, region, search]);

  if (error) return <div className="empty-state">Couldn't load customers: {error}</div>;

  return (
    <>
      <div className="customers-head">
        <div>
          <h1>Customers</h1>
          {territoryLabel(me) && <div className="territory-note">{territoryLabel(me)}</div>}
        </div>
        <div className="customers-filters">
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search store or contact" />
          {stateOptions.length > 1 && (
            <select value={region} onChange={e => setRegion(e.target.value)}>
              <option value="">{me?.role === 'manager' ? 'All states' : 'All my states'}</option>
              {stateOptions.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          )}
        </div>
      </div>
      <div className="acct-region" style={{ marginBottom: 12 }}>
        Grouped by each store's own reorder pace. Most valuable first. New stores are on the Pipeline until their first order ships.
      </div>

      {!customers ? (
        <div className="empty-state">Loading…</div>
      ) : (
        <div className="board">
          {COLUMNS.map(col => {
            const list = columns[col.key];
            const value = list.reduce((s, c) => s + c.spend365, 0);
            return (
              <div className={`bay health-${col.key}` + (focus === col.key ? ' focused' : '')} key={col.key} id={`col-${col.key}`}>
                <div className="bay-head">
                  <span>{col.title}</span>
                  <span className="n">{list.length}</span>
                </div>
                <div className="bay-sub">{col.hint}. {fmtMoney(Math.round(value))} a year.</div>
                <div className="bay-body">
                  {list.length === 0 && <div className="bay-empty">Nobody here</div>}
                  {list.slice(0, shown[col.key]).map(c => {
                    const days = c.lastOrderAt ? daysBetween(c.lastOrderAt) : null;
                    return (
                      <div key={c.id} className={`deal-card health-card-${col.key}`} onClick={() => navigate(`/accounts/${c.id}`)}>
                        <div className="dc-name">{c.name}</div>
                        <div className="dc-meta">
                          <span>{c.region}</span>
                          <span className="num">{fmtMoney(Math.round(c.spend365))}/yr</span>
                        </div>
                        <div className="dc-pace">
                          {days === null ? 'No orders yet' : `Last order ${fmtDuration(days)} ago`}
                          {c.avgOrderGapDays ? `, usually every ${fmtDuration(c.avgOrderGapDays)}` : ''}
                        </div>
                        {(c.openQuote || Math.abs(c.owing) > 0.005 || c.backordered) && (
                          <div className="dc-badges">
                            {c.openQuote && <span className="pill teal">Open quote</span>}
                            {c.owing > 0.005 && <span className="pill amber">Owes {fmtMoney(c.owing)}</span>}
                            {c.owing < -0.005 && <span className="pill neutral">In credit {fmtMoney(-c.owing)}</span>}
                            {c.backordered && <span className="pill rust">Backorder</span>}
                          </div>
                        )}
                        {c.repName && me?.role === 'manager' && <div className="dc-rep">{c.repName}</div>}
                      </div>
                    );
                  })}
                  {list.length > shown[col.key] && (
                    <button
                      className="btn secondary bay-more"
                      onClick={() => setShown(s => ({ ...s, [col.key]: s[col.key] + PAGE }))}
                    >
                      Show {Math.min(PAGE, list.length - shown[col.key])} more of {list.length - shown[col.key]}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}