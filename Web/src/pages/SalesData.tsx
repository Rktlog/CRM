import { useEffect, useMemo, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { apiGet } from '../lib/api';
import { fmtMoney } from '../lib/types';
import SalesComparisonCard from '../components/SalesComparisonCard';

type Quarter = {
  quarter: string; months: string[]; budget: number; pctToBudget: number | null;
  invoicedCurrent: number; invoicedPrior: number; varianceDollar: number; variancePct: number | null;
  newBusinessCount: number; newBusinessValue: number;
};
type UnpaidQuote = { order: string; date: string; stockist: string; amount: number; status: string };
type TopAccount = { customer: string; region: string; type: string; fyPrior: number; fyCurrent: number };
type BreakdownRow = { type?: string; region?: string; category?: string; brand?: string; count?: number; total: number };
type SkuRow = { sku: string; productName: string; quantity: number; total: number };
type RecentInvoice = { invoice: string; date: string; customer: string; region: string; amount: number; paid: boolean };
type LedgerData = {
  totalValue: number; totalOrders: number; accountsTracked: number; accountsWithActivity: number;
  period: 'calendar' | 'fiscal'; periodLabel: string; priorPeriodLabel: string;
  monthlyTrend: { label: string; total: number }[];
  quarters: Quarter[]; unpaidQuotes: UnpaidQuote[]; topAccounts: TopAccount[];
  typeBreakdown: BreakdownRow[]; regionBreakdown: BreakdownRow[]; categoryBreakdown: BreakdownRow[];
  skuBreakdown: SkuRow[]; brandBreakdown: BreakdownRow[]; recentInvoices: RecentInvoice[];
};
type Rep = { id: string; name: string; role: string };

const REGION_GROUPS: { key: string; label: string; regions: string[] | null }[] = [
  { key: 'all', label: 'All regions', regions: null },
  { key: 'nsw-act', label: 'NSW / ACT', regions: ['NSW', 'ACT'] },
  { key: 'VIC', label: 'VIC', regions: ['VIC'] },
  { key: 'QLD', label: 'QLD', regions: ['QLD'] },
  { key: 'WA', label: 'WA', regions: ['WA'] },
  { key: 'SA', label: 'SA', regions: ['SA'] },
  { key: 'TAS', label: 'TAS', regions: ['TAS'] },
  { key: 'NT', label: 'NT', regions: ['NT'] },
  { key: 'NZ', label: 'NZ', regions: ['NZ'] },
];

export default function SalesData() {
  const [data, setData] = useState<LedgerData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [regionKey, setRegionKey] = useState('nsw-act');
  const [year, setYear] = useState(new Date().getFullYear());
  const [period, setPeriod] = useState<'calendar' | 'fiscal' | 'alltime'>('fiscal');
  const [reps, setReps] = useState<Rep[]>([]);
  const [repId, setRepId] = useState<string>('');
  const [topSortKey, setTopSortKey] = useState<'fyCurrent' | 'fyPrior'>('fyCurrent');
  const [topSortDir, setTopSortDir] = useState<1 | -1>(-1);
  const [invSearch, setInvSearch] = useState('');
  const [invPage, setInvPage] = useState(0);
  const PAGE_SIZE = 25;

  const activeGroup = REGION_GROUPS.find(g => g.key === regionKey)!;

  useEffect(() => {
    apiGet('/reports/reps').then(setReps).catch(() => {});
  }, []);

  useEffect(() => {
    setData(null);
    const params = new URLSearchParams();
    if (activeGroup.regions) params.set('region', activeGroup.regions.join(','));
    params.set('year', String(year));
    params.set('period', period);
    if (repId) params.set('repId', repId);
    apiGet(`/reports/ledger?${params.toString()}`).then(setData).catch(e => setError(e.message));
  }, [regionKey, year, period, repId]);

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
          <div className="ledger-tag">{activeGroup.label}</div>
          <h1 className="ledger-title">Sales Ledger</h1>
          <div className="ledger-sub">Live from synced DEAR orders and your own budget targets — updates with every sync</div>
        </div>
        <div className="ledger-controls">
          <select value={repId} onChange={e => setRepId(e.target.value)}>
            <option value="">All reps</option>
            {reps.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <select value={regionKey} onChange={e => setRegionKey(e.target.value)}>
            {REGION_GROUPS.map(g => <option key={g.key} value={g.key}>{g.label}</option>)}
          </select>
          <select value={year} onChange={e => setYear(Number(e.target.value))}>
            {Array.from({ length: new Date().getFullYear() - 2019 }, (_, i) => 2021 + i).reverse().map(y => <option key={y} value={y}>{y}</option>)}
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
            <div className="ledger-stat">
              <div className="label">Accounts tracked ({activeGroup.label})</div>
              <div className="val">{data.accountsTracked.toLocaleString()}</div>
            </div>
          </div>

          <hr className="ledger-rule" />

          <div className="ledger-section-head"><h2>Compare periods</h2></div>
          <div className="ledger-chart">
            <SalesComparisonCard />
          </div>

          <hr className="ledger-rule" />

          <div className="ledger-section-head">
            <h2>Monthly invoiced total</h2>
            <span className="ledger-note">{data.periodLabel}</span>
          </div>
          <div className="ledger-chart">
            {data.monthlyTrend.length === 0 ? (
              <div className="empty-state">No paid orders synced yet for {activeGroup.label}.</div>
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
            <h2>Quarterly budget — {year}</h2>
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
                  <div className="qnew">{q.newBusinessCount} new · {fmtMoney(q.newBusinessValue)}</div>
                </div>
              );
            })}
          </div>

          <hr className="ledger-rule" />

          <div className="ledger-section-head">
            <h2>Unpaid quotes to chase</h2>
            <span className="ledger-note">{data.unpaidQuotes.length} quotes · {fmtMoney(data.unpaidQuotes.reduce((s, q) => s + q.amount, 0))}</span>
          </div>
          <div className="ledger-table-scroll tall" style={{ maxHeight: 420 }}>
            {data.unpaidQuotes.length === 0 ? (
              <div className="empty-state">Nothing unpaid right now.</div>
            ) : (
              <table>
                <thead><tr><th>Order</th><th>Date</th><th>Stockist</th><th className="num-col">Amount</th><th>Status</th></tr></thead>
                <tbody>
                  {data.unpaidQuotes.map(q => {
                    const lower = q.status.toLowerCase();
                    let cls = 'amber';
                    if (lower.includes('void')) cls = 'muted';
                    else if (lower.includes('backorder')) cls = 'rust';
                    return (
                      <tr key={q.order}>
                        <td className="num">{q.order}</td>
                        <td>{q.date}</td>
                        <td>{q.stockist}</td>
                        <td className="num-col num">{fmtMoney(q.amount)}</td>
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
            <span className="ledger-note">{data.priorPeriodLabel} vs {data.periodLabel} · {activeGroup.label}</span>
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
                  <tr key={a.customer}>
                    <td><div className="cust-name">{a.customer}</div><div className="cust-meta">{a.type}</div></td>
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
              <div className="bd-title">By category — {data.periodLabel}</div>
              <BarRows items={data.categoryBreakdown} labelKey="category" />
            </div>
            <div>
              <div className="bd-title">New in {data.periodLabel} vs existing customers</div>
              <BarRows items={data.typeBreakdown.map(t => ({ ...t, label: `${t.type} (${t.count})` }))} labelKey="label" />
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
                      <td className="num">{s.sku}</td>
                      <td>{s.productName}</td>
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
                  <tr key={inv.invoice}>
                    <td className="num">{inv.invoice}</td>
                    <td>{inv.date}</td>
                    <td>{inv.customer}</td>
                    <td>{inv.region}</td>
                    <td><span className={`badge ${inv.paid ? 'teal' : 'amber'}`}>{inv.paid ? 'Paid' : 'Unpaid'}</span></td>
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

function BarRows({ items, labelKey }: { items: (BreakdownRow & { label?: string })[]; labelKey: string }) {
  const max = Math.max(...items.map(i => i.total), 1);
  return (
    <>
      {items.map((i: any, idx) => (
        <div className="bd-row" key={idx}>
          <div className="bd-label">{i[labelKey]}</div>
          <div className="bd-track"><div className="bd-fill" style={{ width: `${(i.total / max) * 100}%` }} /></div>
          <div className="bd-val num">{fmtMoney(i.total)}</div>
        </div>
      ))}
    </>
  );
}