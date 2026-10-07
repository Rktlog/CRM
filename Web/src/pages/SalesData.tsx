import { useEffect, useMemo, useState } from 'react';
import StateFilter from '../components/StateFilter';
import { stateOptionsFor } from '../lib/useMe';
import { Link } from 'react-router-dom';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { apiGet } from '../lib/api';
import { fmtMoney } from '../lib/types';
import SalesComparisonCard from '../components/SalesComparisonCard';

type Quarter = {
  quarter: string; months: string[]; budget: number; pctToBudget: number | null;
  invoicedCurrent: number; invoicedPrior: number; varianceDollar: number; variancePct: number | null;
  newBusinessCount: number; newBusinessValue: number;
};
type UnpaidQuote = { id: string; accountId: string; order: string; date: string; stockist: string; amount: number; due: number; status: string };
type TopAccount = { accountId: string; customer: string; region: string; type: string; fyPrior: number; fyCurrent: number };
type BreakdownRow = { type?: string; region?: string; category?: string; brand?: string; count?: number; total: number };
type SkuRow = { sku: string; productName: string; quantity: number; total: number };
type RecentInvoice = { id: string; accountId: string; invoice: string; date: string; customer: string; region: string; amount: number; paid: boolean; history?: boolean };
type LedgerData = {
  totalValue: number; totalOrders: number; accountsTracked: number; accountsWithActivity: number;
  newCustomerCount: number; newCustomerValue: number;
  period: 'calendar' | 'fiscal'; periodLabel: string; priorPeriodLabel: string;
  monthlyTrend: { label: string; total: number }[];
  quarters: Quarter[]; unpaidQuotes: UnpaidQuote[]; topAccounts: TopAccount[];
  typeBreakdown: BreakdownRow[]; regionBreakdown: BreakdownRow[]; categoryBreakdown: BreakdownRow[];
  categories?: string[]; category?: string[] | null;
  skuBreakdown: SkuRow[]; brandBreakdown: BreakdownRow[]; recentInvoices: RecentInvoice[];
};
type Rep = { id: string; name: string; role: string };

type Me = { role: 'rep' | 'manager'; regions: string[] };

export default function SalesData() {
  const [data, setData] = useState<LedgerData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  // States ticked in the filter ('' = all of this person's states).
  const [regionsCsv, setRegionsCsv] = useState('');
  // Defaults to the current FY: in Feb 2027 that's FY 2026/27, not 2027.
  const [year, setYear] = useState(() => {
    const d = new Date();
    return d.getMonth() >= 6 ? d.getFullYear() : d.getFullYear() - 1;
  });
  const [period, setPeriod] = useState<'calendar' | 'fiscal' | 'alltime'>('fiscal');
  const [reps, setReps] = useState<Rep[]>([]);
  const [repId, setRepId] = useState<string>('');
  // Customer category filter: the categories ticked (none ticked = all).
  // Options stay the full list for this rep/state scope.
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [categoryOptions, setCategoryOptions] = useState<string[]>([]);
  const categoryParam = [...picked].sort().join('|');
  const toggleCategory = (c: string) => setPicked(prev => {
    const next = new Set(prev);
    next.has(c) ? next.delete(c) : next.add(c);
    return next;
  });
  const [topSortKey, setTopSortKey] = useState<'fyCurrent' | 'fyPrior'>('fyCurrent');
  const [topSortDir, setTopSortDir] = useState<1 | -1>(-1);
  const [invSearch, setInvSearch] = useState('');
  const [invPage, setInvPage] = useState(0);
  const PAGE_SIZE = 25;

  const stateOptions = stateOptionsFor(me as any);
  // What the page is showing: the ticked states, or everything this person covers.
  const activeGroup = me ? {
    label: regionsCsv
      ? regionsCsv.replace('Unknown,INTL', 'Others').split(',').join(' / ')
      : me.role === 'manager' ? 'All regions' : (me.regions.join(' / ') || 'No states assigned'),
    regions: regionsCsv ? regionsCsv.split(',') : (me.role === 'manager' ? null : me.regions),
  } : null;
  const isManager = me?.role === 'manager';

  useEffect(() => {
    apiGet('/me')
      .then((m: any) => {
        const loaded: Me = { role: m.role, regions: m.regions ?? [] };
        setMe(loaded);
        // Managers open on NSW + ACT (as before); reps on all their states.
        setRegionsCsv(loaded.role === 'manager' ? 'NSW,ACT' : '');
        if (loaded.role === 'manager') apiGet('/reports/reps').then(setReps).catch(() => {});
      })
      .catch(e => setError(e.message));
  }, []);

  useEffect(() => {
    if (!me || !activeGroup) return; // wait until we know which states this person covers
    setData(null);
    const params = new URLSearchParams();
    if (activeGroup.regions) params.set('region', activeGroup.regions.join(','));
    params.set('year', String(year));
    params.set('period', period);
    if (repId && isManager) params.set('repId', repId);
    if (categoryParam) params.set('category', categoryParam);
    apiGet(`/reports/ledger?${params.toString()}`)
      .then(d => { setData(d); if (d.categories) setCategoryOptions(d.categories); })
      .catch(e => setError(e.message));
  }, [me, regionsCsv, year, period, repId, categoryParam]);

  const topAccounts = useMemo(() => {
    if (!data) return [];
    return [...data.topAccounts].sort((a, b) => (a[topSortKey] - b[topSortKey]) * topSortDir);
  }, [data, topSortKey, topSortDir]);

  const filteredInvoices = useMemo(() => {
    if (!data) return [];
    const q = invSearch.trim().toLowerCase();
    return data.recentInvoices.filter(i => !q || i.customer.toLowerCase().includes(q));
  }, [data, invSearch]);

  if (error) return <div className="empty-state">Couldn't load sales data: {error}</div>;

  function toggleSort(key: 'fyCurrent' | 'fyPrior') {
    if (key === topSortKey) setTopSortDir(d => (d === -1 ? 1 : -1));
    else { setTopSortKey(key); setTopSortDir(-1); }
  }

  const totalPages = data ? Math.max(1, Math.ceil(filteredInvoices.length / PAGE_SIZE)) : 1;
  const invoicePage = filteredInvoices.slice(invPage * PAGE_SIZE, (invPage + 1) * PAGE_SIZE);

  return (
    <div className="ledger">
      <div className="ledger-head">
        <div>
          <div className="ledger-tag">{activeGroup?.label ?? ''}</div>
          <h1 className="ledger-title">Sales Ledger</h1>
          <div className="ledger-sub">Live from synced DEAR orders and your own budget targets — updates with every sync</div>
        </div>
        <div className="ledger-controls">
          {isManager && (
            <select value={repId} onChange={e => setRepId(e.target.value)}>
              <option value="">All reps</option>
              {reps.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          )}
          <StateFilter value={regionsCsv} onChange={setRegionsCsv} options={stateOptions}
            allLabel={me?.role === 'manager' ? 'All regions' : 'All my states'} />
          {categoryOptions.length > 1 && (
            <details className="terms-filter">
              <summary>
                {picked.size === 0 ? 'All categories'
                  : picked.size === 1 ? [...picked][0]
                  : `${picked.size} categories`}
              </summary>
              <div className="terms-menu">
                <div className="terms-menu-tools">
                  <button type="button" className="link-btn" onClick={() => setPicked(new Set())}>All categories</button>
                  <button type="button" className="link-btn" onClick={() => setPicked(new Set(categoryOptions))}>Tick all</button>
                </div>
                {categoryOptions.map(c => (
                  <label key={c} className="pl-check">
                    <input type="checkbox" checked={picked.has(c)} onChange={() => toggleCategory(c)} />
                    <span>{c}</span>
                  </label>
                ))}
              </div>
            </details>
          )}
          <select value={year} onChange={e => setYear(Number(e.target.value))}>
            {Array.from({ length: new Date().getFullYear() - 2019 }, (_, i) => 2021 + i).reverse().map(y => <option key={y} value={y}>{period === 'fiscal' ? `FY ${y}/${String(y + 1).slice(2)}` : y}</option>)}
          </select>
          <select value={period} onChange={e => setPeriod(e.target.value as 'calendar' | 'fiscal' | 'alltime')}>
            <option value="fiscal">Fiscal year (Jul–Jun)</option>
            <option value="calendar">Calendar year (Jan–Dec)</option>
            <option value="alltime">All time (to date)</option>
          </select>
        </div>
      </div>

      {!data ? (
        <div className="empty-state">Loading…</div>
      ) : (
        <>
          <div className="ledger-stats">
            <div className="ledger-stat accent">
              <div className="label">Total invoiced — {data.periodLabel}</div>
              <div className="val">{fmtMoney(data.totalValue)}</div>
            </div>
            <div className="ledger-stat">
              <div className="label">Orders — {data.periodLabel}</div>
              <div className="val">{data.totalOrders.toLocaleString()}</div>
            </div>
            <div className="ledger-stat">
              <div className="label">Active accounts — {data.periodLabel}</div>
              <div className="val">{data.accountsWithActivity.toLocaleString()}</div>
            </div>
            {period !== 'alltime' && (
              <div className="ledger-stat">
                <div className="label">New customers in {data.periodLabel}</div>
                <div className="val">{data.newCustomerCount.toLocaleString()}</div>
              </div>
            )}
            <div className="ledger-stat">
              <div className="label">Accounts tracked ({activeGroup?.label})</div>
              <div className="val">{data.accountsTracked.toLocaleString()}</div>
            </div>
          </div>

          <hr className="ledger-rule" />

          <div className="ledger-section-head"><h2>Compare periods</h2></div>
          <div className="ledger-chart">
            <SalesComparisonCard region={activeGroup?.regions?.join(',')} />
          </div>

          <hr className="ledger-rule" />

          <div className="ledger-section-head">
            <h2>Monthly invoiced total</h2>
            <span className="ledger-note">{data.periodLabel}</span>
          </div>
          <div className="ledger-chart">
            {data.monthlyTrend.length === 0 ? (
              <div className="empty-state">No paid orders synced yet for {activeGroup?.label}.</div>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={data.monthlyTrend} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <XAxis dataKey="label" tick={{ fontSize: 10.5, fill: 'var(--muted)' }} axisLine={{ stroke: 'var(--line)' }} tickLine={false} interval="preserveStartEnd" />
                  <YAxis tick={{ fontSize: 11, fill: 'var(--muted)' }} axisLine={false} tickLine={false} tickFormatter={v => `$${(v / 1000).toFixed(0)}k`} />
                  <Tooltip formatter={(v: number) => fmtMoney(v)} contentStyle={{ fontSize: 12, borderRadius: 4 }} />
                  <Bar dataKey="total" radius={[2, 2, 0, 0]}>
                    {data.monthlyTrend.map((_, i) => (
                      <Cell key={i} fill={i >= data.monthlyTrend.length - 6 ? 'var(--teal)' : 'var(--line)'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>

          <hr className="ledger-rule" />

          <div className="ledger-section-head">
            <h2>Quarterly budget, FY {year}/{String(year + 1).slice(2)}</h2>
            <span className="ledger-note">Set in Settings</span>
          </div>
          <div className="qcards">
            {data.quarters.map(q => {
              const up = q.varianceDollar >= 0;
              const pct = q.pctToBudget ?? 0;
              return (
                <div className={'qcard ' + (up ? 'up' : 'down')} key={q.quarter}>
                  <div className="qname">{q.quarter} · {q.months.join('/')}</div>
                  <div className="qmain num">{fmtMoney(q.invoicedCurrent)}</div>
                  {q.budget > 0 ? (
                    <>
                      <div className="qbudget">of {fmtMoney(q.budget)} target ({(pct * 100).toFixed(0)}%)</div>
                      <div className="qbar-track"><div className="qbar-fill" style={{ width: `${Math.min(pct * 100, 100)}%` }} /></div>
                    </>
                  ) : (
                    <div className="qbudget">No target set</div>
                  )}
                  <div className="qvariance num" style={{ color: up ? 'var(--teal)' : 'var(--rust)' }}>
                    {fmtMoney(q.varianceDollar)} YoY {q.variancePct !== null ? `(${(q.variancePct * 100).toFixed(0)}%)` : ''}
                  </div>
                  <div className="qnew">{q.newBusinessCount} new {q.newBusinessCount === 1 ? 'customer' : 'customers'}, {fmtMoney(q.newBusinessValue)}</div>
                </div>
              );
            })}
          </div>

          <hr className="ledger-rule" />

          <div className="ledger-section-head">
            <h2>Unpaid quotes to chase</h2>
            <span className="ledger-note">{data.unpaidQuotes.length} quotes · {fmtMoney(data.unpaidQuotes.reduce((s, q) => s + q.due, 0))} due</span>
          </div>
          <div className="ledger-table-scroll tall" style={{ maxHeight: 420 }}>
            {data.unpaidQuotes.length === 0 ? (
              <div className="empty-state">Nothing unpaid right now.</div>
            ) : (
              <table>
                <thead><tr><th>Order</th><th>Date</th><th>Stockist</th><th className="num-col">Due</th><th>Status</th></tr></thead>
                <tbody>
                  {data.unpaidQuotes.map(q => {
                    const lower = q.status.toLowerCase();
                    let cls = 'amber';
                    if (lower.includes('void')) cls = 'muted';
                    else if (lower.includes('backorder')) cls = 'rust';
                    return (
                      <tr key={q.order}>
                        <td className="num"><Link to={`/orders/${q.id}`} className="order-link">{q.order}</Link></td>
                        <td>{q.date}</td>
                        <td><Link to={`/accounts/${q.accountId}`} className="ledger-link">{q.stockist}</Link></td>
                        <td className="num-col num">
                          {fmtMoney(q.due)}
                          {q.due < q.amount - 0.005 && <div className="cust-meta">of {fmtMoney(q.amount)}</div>}
                        </td>
                        <td><span className={`badge ${cls}`}>{q.status}</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          <hr className="ledger-rule" />

          <div className="ledger-section-head">
            <h2>Top accounts</h2>
            <span className="ledger-note">{data.priorPeriodLabel} vs {data.periodLabel} · {activeGroup?.label}</span>
          </div>
          <div className="ledger-table-scroll tall">
            <table>
              <thead>
                <tr>
                  <th>Account</th><th>Region</th>
                  <th className="sortable num-col" onClick={() => toggleSort('fyPrior')}>{data.priorPeriodLabel} {topSortKey === 'fyPrior' && (topSortDir === -1 ? '↓' : '↑')}</th>
                  <th className="sortable num-col" onClick={() => toggleSort('fyCurrent')}>{data.periodLabel} {topSortKey === 'fyCurrent' && (topSortDir === -1 ? '↓' : '↑')}</th>
                </tr>
              </thead>
              <tbody>
                {topAccounts.map(a => (
                  <tr key={a.accountId}>
                    <td><Link to={`/accounts/${a.accountId}`} className="cust-name ledger-link">{a.customer}</Link><div className="cust-meta">{a.type}</div></td>
                    <td>{a.region}</td>
                    <td className="num-col num">{fmtMoney(a.fyPrior)}</td>
                    <td className="num-col num">{fmtMoney(a.fyCurrent)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <hr className="ledger-rule" />

          <div className="ledger-section-head"><h2>Mix breakdown</h2></div>
          <div className="bd-grid">
            <div>
              <div className="bd-title">
                By category — {data.periodLabel}
                {picked.size > 0
                  ? <> · <button className="link-btn" onClick={() => setPicked(new Set())}>Show all categories</button></>
                  : <span className="acct-region"> · click to add or remove from the filter</span>}
              </div>
              <BarRows items={data.categoryBreakdown} labelKey="category" onPick={toggleCategory} active={picked} />
            </div>
            <div>
              <div className="bd-title">New in {data.periodLabel} vs existing customers</div>
              <BarRows items={data.typeBreakdown.map(t => ({ ...t, label: t.type, sub: `${t.count} ${t.count === 1 ? 'customer' : 'customers'}` }))} labelKey="label" />
            </div>
          </div>

          <hr className="ledger-rule" />

          <div className="ledger-section-head">
            <h2>Top products, by revenue</h2>
            <span className="ledger-note">{data.periodLabel} · from real order line items</span>
          </div>
          {data.skuBreakdown.length === 0 ? (
            <div className="empty-state">No line-item data yet — run the product line backfill.</div>
          ) : (
            <div className="ledger-table-scroll tall">
              <table>
                <thead><tr><th>SKU</th><th>Product</th><th className="num-col">Qty</th><th className="num-col">Revenue</th></tr></thead>
                <tbody>
                  {data.skuBreakdown.map(s => (
                    <tr key={s.sku}>
                      <td className="num"><Link to={`/products?q=${encodeURIComponent(s.sku)}`} className="order-link">{s.sku}</Link></td>
                      <td><Link to={`/products?q=${encodeURIComponent(s.sku)}`} className="ledger-link">{s.productName}</Link></td>
                      <td className="num-col num">{s.quantity.toLocaleString()}</td>
                      <td className="num-col num">{fmtMoney(s.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <hr className="ledger-rule" />

          <div className="ledger-section-head"><h2>By brand — {data.periodLabel}</h2></div>
          {data.brandBreakdown.length === 0 ? (
            <div className="empty-state">No line-item data yet — run the product line backfill.</div>
          ) : (
            <BarRows items={data.brandBreakdown} labelKey="brand" />
          )}

          <hr className="ledger-rule" />

          <div className="ledger-section-head">
            <h2>Recent invoices</h2>
            <span className="ledger-note">{filteredInvoices.length} of {data.recentInvoices.length} loaded</span>
          </div>
          <div className="ledger-controls-row">
            <input placeholder="Search customer…" value={invSearch} onChange={e => { setInvSearch(e.target.value); setInvPage(0); }} />
          </div>
          <div className="ledger-table-scroll">
            <table>
              <thead><tr><th>Invoice</th><th>Date</th><th>Customer</th><th>Region</th><th>Status</th><th className="num-col">Total</th></tr></thead>
              <tbody>
                {invoicePage.map(inv => (
                  <tr key={inv.id}>
                    <td className="num"><Link to={`/orders/${inv.id}`} className="order-link">{inv.invoice}</Link></td>
                    <td>{inv.date}</td>
                    <td><Link to={`/accounts/${inv.accountId}`} className="ledger-link">{inv.customer}</Link></td>
                    <td>{inv.region}</td>
                    <td>{inv.history
                      ? <span className="badge muted">History</span>
                      : <span className={`badge ${inv.paid ? 'teal' : 'amber'}`}>{inv.paid ? 'Paid' : 'Unpaid'}</span>}</td>
                    <td className="num-col num">{fmtMoney(inv.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="ledger-pagination">
            <span>Page {invPage + 1} of {totalPages}</span>
            <div>
              <button className="btn secondary" disabled={invPage === 0} onClick={() => setInvPage(p => p - 1)}>&larr; Prev</button>
              <button className="btn secondary" disabled={invPage >= totalPages - 1} onClick={() => setInvPage(p => p + 1)}>Next &rarr;</button>
            </div>
          </div>

          <div className="ledger-footnote">
            Category now comes from DEAR's own customer record. Anything showing "Uncategorized" was synced before that field was found — run backfill-region-and-category.ts to fill it in.
          </div>
        </>
      )}
    </div>
  );
}

// sub: optional second line under the label (e.g. a customer count), so
// it never gets cut off by the fixed-width label column.
function BarRows({ items, labelKey, onPick, active }: {
  items: (BreakdownRow & { label?: string; sub?: string })[]; labelKey: string;
  onPick?: (label: string) => void; active?: Set<string>;
}) {
  const max = Math.max(...items.map(i => i.total), 1);
  return (
    <>
      {items.map((i: any, idx) => (
        <div
          className={'bd-row' + (onPick ? ' clickable' : '') + (active?.has(i[labelKey]) ? ' active' : '')}
          key={idx}
          onClick={onPick ? () => onPick(i[labelKey]) : undefined}
          title={onPick ? (active?.has(i[labelKey]) ? `Remove ${i[labelKey]} from the filter` : `Add ${i[labelKey]} to the filter`) : undefined}
        >
          <div className="bd-label">
            {i[labelKey]}
            {i.sub && <div className="bd-sub">{i.sub}</div>}
          </div>
          <div className="bd-track"><div className="bd-fill" style={{ width: `${(i.total / max) * 100}%` }} /></div>
          <div className="bd-val num">{fmtMoney(i.total)}</div>
        </div>
      ))}
    </>
  );
}