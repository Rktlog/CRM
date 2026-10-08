import { useEffect, useMemo, useState } from 'react';
import StateFilter from './StateFilter';
import { Link, useNavigate } from 'react-router-dom';
import { apiGet, apiDownload } from '../lib/api';
import { fmtMoney, fmtDateWithYear, fmtDuration, fmtPayDate } from '../lib/types';
import { useMe, stateOptionsFor } from '../lib/useMe';

// Order tracking views on the Orders page. Each loads from
// /orders/views/<view>, can be narrowed to a state, and downloads exactly
// what's on screen. Reps see only their states (the API enforces it).

export type ViewKey = 'quotes' | 'to-ship' | 'unpaid' | 'balances';

const AGE_BUCKETS = [
  { key: 'current', label: 'Not yet due' },
  { key: 'd30', label: 'Up to 1 month' },
  { key: 'd60', label: '1–2 months' },
  { key: 'd90', label: '2–3 months' },
  { key: 'd90plus', label: 'Over 3 months' },
] as const;

const PAGE = 100;

export default function OrderViews({ view }: { view: ViewKey }) {
  const [data, setData] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [region, setRegion] = useState('');
  // Payment terms filter (unpaid, balances): the terms NOT ticked. Empty =
  // everything shown. Stored as excluded so new terms show up by default.
  const [excludedTerms, setExcludedTerms] = useState<Set<string>>(new Set());
  const [termOptions, setTermOptions] = useState<string[]>([]);
  const included = termOptions.filter(t => !excludedTerms.has(t));
  const termsParam = excludedTerms.size && (view === 'unpaid' || view === 'balances')
    ? (included.length ? included.join('|') : '(none)') // all unticked: show nothing
    : '';
  const [search, setSearch] = useState('');
  const [shown, setShown] = useState(PAGE);
  const [downloading, setDownloading] = useState(false);
  const me = useMe();
  const stateOptions = stateOptionsFor(me);
  const navigate = useNavigate();

  useEffect(() => {
    setData(null);
    setError(null);
    setShown(PAGE);
    const p = new URLSearchParams();
    if (region) p.set('region', region);
    if (termsParam) p.set('terms', termsParam);
    apiGet(`/orders/views/${view}${p.toString() ? `?${p.toString()}` : ''}`)
      .then(d => {
        setData(d);
        // Remember every terms wording seen, so the list doesn't shrink once filtered.
        if (!termsParam) setTermOptions([...new Set<string>((d.rows ?? []).map((r: any) => r.terms).filter(Boolean))].sort());
      })
      .catch(e => setError(e.message));
  }, [view, region, termsParam]);

  const rows: any[] = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!data) return [];
    return q
      ? data.rows.filter((r: any) => [r.customer, r.number, r.invoice, r.reference].some(v => v && String(v).toLowerCase().includes(q)))
      : data.rows;
  }, [data, search]);

  async function download() {
    setDownloading(true);
    try {
      const params = new URLSearchParams({ format: 'xlsx' });
      if (region) params.set('region', region);
      if (termsParam) params.set('terms', termsParam);
      await apiDownload(`/orders/views/${view}?${params.toString()}`, `${view}-${new Date().toISOString().slice(0, 10)}.xlsx`);
    } finally {
      setDownloading(false);
    }
  }

  const summary = !data ? null
    : view === 'quotes' ? `${data.count} open ${data.count === 1 ? 'quote' : 'quotes'}, ${fmtMoney(data.total)}`
    : view === 'to-ship' ? `${data.count} ${data.count === 1 ? 'order' : 'orders'} to ship, ${fmtMoney(data.total)}`
    : view === 'unpaid' ? `${data.count} unpaid ${data.count === 1 ? 'invoice' : 'invoices'}, ${fmtMoney(data.total)} due, ${fmtMoney(data.overdue)} overdue`
    : `${data.count} ${data.count === 1 ? 'customer' : 'customers'}, ${fmtMoney(data.totals.balance)} net balance, ${fmtMoney(data.totals.over60)} more than 2 months overdue`;

  return (
    <>
      <div className="ov-toolbar">
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Filter by customer, order or invoice" />
        {stateOptions.length > 1 && (
          <StateFilter value={region} onChange={setRegion} options={stateOptions}
            allLabel={me?.role === 'manager' ? 'All states' : 'All my states'} />
        )}
        {(view === 'unpaid' || view === 'balances') && termOptions.length > 1 && (
          <details className="terms-filter">
            <summary>
              {excludedTerms.size === 0 ? 'All payment terms'
                : included.length === 0 ? 'No payment terms'
                : excludedTerms.size === 1 ? `All terms except ${[...excludedTerms][0]}`
                : `${included.length} of ${termOptions.length} payment terms`}
            </summary>
            <div className="terms-menu">
              <div className="terms-menu-tools">
                <button type="button" className="link-btn" onClick={() => setExcludedTerms(new Set())}>Tick all</button>
                <button type="button" className="link-btn" onClick={() => setExcludedTerms(new Set(termOptions))}>Untick all</button>
              </div>
              {termOptions.map(t => (
                <label key={t} className="pl-check">
                  <input
                    type="checkbox"
                    checked={!excludedTerms.has(t)}
                    onChange={() => setExcludedTerms(prev => {
                      const next = new Set(prev);
                      next.has(t) ? next.delete(t) : next.add(t);
                      return next;
                    })}
                  />
                  <span>{t}</span>
                </label>
              ))}
            </div>
          </details>
        )}
        <button className="btn secondary" onClick={download} disabled={downloading || !data}>
          {downloading ? 'Downloading…' : '⬇ Excel'}
        </button>
      </div>
      {summary && <div className="ov-summary">{summary}</div>}

      {error && <div className="empty-state">Couldn't load: {error}</div>}
      {!error && !data && <div className="empty-state">Loading…</div>}
      {data && rows.length === 0 && <div className="empty-state">Nothing here{search ? ` matching "${search}"` : ''}.</div>}

      {data && rows.length > 0 && view === 'balances' && (
        <>
          <div className="ov-ageing">
            {AGE_BUCKETS.map(b => (
              <div key={b.key} className={`ov-age ov-age-${b.key}`}>
                <div className="stat-label">{b.key === 'current' ? b.label : `${b.label} overdue`}</div>
                <div className="num">{fmtMoney(data.totals[b.key])}</div>
              </div>
            ))}
          </div>
          <div className="ledger-table-scroll tall">
            <table className="ov-table">
              <thead>
                <tr>
                  <th>Customer</th>
                  {AGE_BUCKETS.map(b => <th key={b.key} className="num-col">{b.label}</th>)}
                  <th className="num-col">Credit</th>
                  <th className="num-col">Balance</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, shown).map(r => (
                  <tr key={r.accountId} onClick={() => navigate(`/accounts/${r.accountId}`)} className="ov-click">
                    <td>
                      <div className="cust-name">{r.customer}</div>
                      <div className="cust-meta">{r.region}, {r.terms}{r.invoices ? `, ${r.invoices} unpaid` : ''}{me?.role === 'manager' && r.repName ? `, ${r.repName}` : ''}</div>
                    </td>
                    {AGE_BUCKETS.map(b => (
                      <td key={b.key} className={`num-col num${r[b.key] > 0.005 && b.key !== 'current' ? ` ov-late-${b.key}` : ''}`}>
                        {r[b.key] > 0.005 ? fmtMoney(r[b.key]) : '–'}
                      </td>
                    ))}
                    <td className="num-col num">{r.credit > 0.005 ? `−${fmtMoney(r.credit)}` : '–'}</td>
                    <td className={`num-col num ov-balance${r.balance < -0.005 ? ' in-credit' : ''}`}>
                      {r.balance < -0.005 ? `In credit ${fmtMoney(-r.balance)}` : fmtMoney(r.balance)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {data && rows.length > 0 && view === 'unpaid' && (
        <div className="ledger-table-scroll tall">
          <table className="ov-table">
            <thead>
              <tr>
                <th>Invoice</th><th>Customer</th><th>Invoiced</th><th>Due date</th>
                <th className="num-col">Total</th><th className="num-col">Paid / credited</th><th className="num-col">Due</th><th className="num-col">Overdue</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, shown).map((r, i) => (
                <tr key={`${r.orderId}-${r.invoice}-${i}`}>
                  <td>
                    <Link to={`/orders/${r.orderId}`} className="order-link num">{r.invoice || r.number}</Link>
                    <div className="cust-meta">{r.number}{r.type !== 'Sale' ? `, ${r.type}` : ''}</div>
                  </td>
                  <td>
                    <Link to={`/accounts/${r.accountId}`} className="ledger-link">{r.customer}</Link>
                    <div className="cust-meta">{r.region}, {r.terms}</div>
                  </td>
                  <td>{fmtDateWithYear(r.invoiceDate)}</td>
                  <td>{fmtDateWithYear(r.dueDate)}</td>
                  <td className="num-col num">{fmtMoney(r.total)}</td>
                  <td className="num-col num">
                    {r.paid + r.credited > 0.005 ? <>{fmtMoney(r.paid + r.credited)}{r.paidAt && <div className="acct-region">{fmtPayDate(r.paidAt)}</div>}</> : '–'}
                  </td>
                  <td className="num-col num"><b>{fmtMoney(r.due)}</b></td>
                  <td className={`num-col num${r.daysOverdue > 60 ? ' ov-late-d90' : r.daysOverdue > 30 ? ' ov-late-d60' : r.daysOverdue > 0 ? ' ov-late-d30' : ''}`}>
                    {r.daysOverdue > 0 ? fmtDuration(r.daysOverdue) : 'Not yet due'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && rows.length > 0 && (view === 'quotes' || view === 'to-ship') && (
        <div className="ledger-table-scroll tall">
          <table className="ov-table">
            <thead>
              <tr>
                <th>Order</th><th>Customer</th><th>Date</th><th className="num-col">Age</th>
                <th>{view === 'quotes' ? 'Stage' : 'Status'}</th><th className="num-col">Amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, shown).map(r => (
                <tr key={r.id}>
                  <td>
                    <Link to={`/orders/${r.id}`} className="order-link num">{r.number}</Link>
                    {r.reference && <div className="cust-meta">{r.reference}</div>}
                    {r.type && r.type !== 'Sale' && <div className="cust-meta">{r.type}</div>}
                  </td>
                  <td>
                    <Link to={`/accounts/${r.accountId}`} className="ledger-link">{r.customer}</Link>
                    <div className="cust-meta">{r.region}{me?.role === 'manager' && r.repName ? `, ${r.repName}` : ''}</div>
                  </td>
                  <td>{fmtDateWithYear(r.date)}</td>
                  <td className={`num-col num${r.ageDays > 60 ? ' ov-late-d90' : r.ageDays > 30 ? ' ov-late-d60' : ''}`}>{fmtDuration(r.ageDays)}</td>
                  <td>
                    <span className={`pill ${r.backordered ? 'rust' : view === 'quotes' ? 'neutral' : 'amber'}`}>{r.stage}</span>
                  </td>
                  <td className="num-col num">{fmtMoney(r.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && rows.length > shown && (
        <button className="btn secondary" style={{ marginTop: 10 }} onClick={() => setShown(s => s + PAGE)}>
          Show {Math.min(PAGE, rows.length - shown)} more of {rows.length - shown}
        </button>
      )}
    </>
  );
}