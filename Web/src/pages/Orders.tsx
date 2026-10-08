import { FormEvent, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import OrderViews, { ViewKey } from '../components/OrderViews';
import { apiGet } from '../lib/api';
import { fmtMoney, fmtDateWithYear } from '../lib/types';
import { orderStatusPills } from '../lib/orderStatus';

type OrderRow = {
  id: string;
  number: string;
  date: string;
  total: number;
  paid: boolean;
  paymentStatus: string | null;
  paidAt: string | null;
  fulfillmentStatus: string | null;
  shippingStatus: string | null;
  pickingStatus: string | null;
  shipTo: string | null;
  reference: string | null;
  invoiceNumber: string | null;
  miscType: string | null;
  source: string;
  accountId: string;
  accountName: string;
  region: string;
  itemCount: number;
};

const COLS = '1fr 1.8fr 0.9fr 0.8fr 1.1fr';

// Re-exported so the order page keeps importing it from here.
export { orderStatusPills };

// Orders: every order-related list in one place. "All orders" is the search;
// the other tabs track what needs doing (quotes to chase, orders to ship,
// invoices to collect, balances per customer). ?tab= opens a tab directly,
// e.g. from the Dashboard's "Owed to us" card.
const TABS: { key: 'all' | ViewKey; label: string }[] = [
  { key: 'all', label: 'All orders' },
  { key: 'quotes', label: 'Open quotes' },
  { key: 'to-ship', label: 'To ship' },
  { key: 'unpaid', label: 'Unpaid invoices' },
  { key: 'balances', label: 'Balances' },
];

export default function Orders() {
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find(t => t.key === params.get('tab'))?.key ?? 'all');

  return (
    <>
      <h1>Orders</h1>
      <div className="tab-bar">
        {TABS.map(t => (
          <button
            key={t.key}
            className={'tab' + (tab === t.key ? ' active' : '')}
            onClick={() => setParams(t.key === 'all' ? {} : { tab: t.key })}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'all' ? <AllOrders /> : <OrderViews view={tab} />}
    </>
  );
}

// Quick filters for the combinations the team checks most.
const PRESETS: { label: string; status: string[]; billing: string[] }[] = [
  { label: 'Shipped, not invoiced', status: ['Shipped', 'Part shipped'], billing: ['Not invoiced'] },
  { label: 'Backordered', status: ['Backordered'], billing: [] },
  { label: 'Ready to ship', status: ['Confirmed', 'Picked'], billing: [] },
  { label: 'Invoiced, unpaid', status: [], billing: ['Invoiced, unpaid', 'Part paid'] },
  { label: 'Draft orders', status: ['Draft order'], billing: [] },
];

function AllOrders() {
  const [term, setTerm] = useState('');
  const [searched, setSearched] = useState('');
  const [rows, setRows] = useState<OrderRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Filters: within one, any ticked option; across the two, both must hold.
  const [statuses, setStatuses] = useState<Set<string>>(new Set());
  const [billing, setBilling] = useState<Set<string>>(new Set());
  const [statusOptions, setStatusOptions] = useState<string[]>([]);
  const [billingOptions, setBillingOptions] = useState<string[]>([]);
  const [limit, setLimit] = useState(50);
  const navigate = useNavigate();

  async function load(q: string, st = statuses, bi = billing) {
    setLoading(true);
    setError(null);
    try {
      const p = new URLSearchParams({ q });
      if (st.size) p.set('status', [...st].join('|'));
      if (bi.size) p.set('billing', [...bi].join('|'));
      const data = await apiGet(`/orders/search?${p.toString()}`);
      setRows(data.results);
      setSearched(q);
      if (data.statusOptions) setStatusOptions(data.statusOptions);
      if (data.billingOptions) setBillingOptions(data.billingOptions);
      setLimit(data.limit ?? 50);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function apply(st: Set<string>, bi: Set<string>) {
    setStatuses(st);
    setBilling(bi);
    load(searched, st, bi);
  }
  const toggle = (set: Set<string>, v: string) => {
    const n = new Set(set);
    n.has(v) ? n.delete(v) : n.add(v);
    return n;
  };
  const sameSet = (a: Set<string>, b: string[]) => a.size === b.length && b.every(x => a.has(x));
  const activePreset = PRESETS.find(p => sameSet(statuses, p.status) && sameSet(billing, p.billing));
  const filtered = statuses.size > 0 || billing.size > 0;
  const describe = () => [
    statuses.size ? [...statuses].join(' or ') : '',
    billing.size ? [...billing].join(' or ') : '',
  ].filter(Boolean).join(' + ');

  useEffect(() => { load(''); }, []);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    load(term.trim());
  }

  return (
    <>
      <form className="product-search-form" onSubmit={onSubmit}>
        <input
          type="text"
          value={term}
          onChange={e => setTerm(e.target.value)}
          placeholder="Order no., invoice no., customer, reference, SKU or product"
          autoFocus
        />
        <button className="btn" type="submit" disabled={loading}>
          {loading ? 'Searching…' : 'Search'}
        </button>
      </form>

      <div className="order-filters">
        <TickFilter label="Order status" all="All statuses" options={statusOptions} picked={statuses}
          onToggle={v => apply(toggle(statuses, v), billing)} onClear={() => apply(new Set(), billing)} />
        <TickFilter label="Invoice & payment" all="Any invoice/payment" options={billingOptions} picked={billing}
          onToggle={v => apply(statuses, toggle(billing, v))} onClear={() => apply(statuses, new Set())} />
        {filtered && <button className="link-btn" onClick={() => apply(new Set(), new Set())}>Clear filters</button>}
      </div>
      <div className="order-presets">
        {PRESETS.map(p => (
          <button key={p.label} className={'chip' + (activePreset === p ? ' on' : '')}
            onClick={() => (activePreset === p ? apply(new Set(), new Set()) : apply(new Set(p.status), new Set(p.billing)))}>
            {p.label}
          </button>
        ))}
      </div>

      <div className="stock-as-of">
        {searched ? `Results for "${searched}"` : filtered ? 'Most recent matching orders' : 'Most recent orders'}
        {filtered && <> · {describe()}</>}
      </div>

      {error && <div className="empty-state">Couldn't load orders: {error}</div>}

      {!error && !rows && <div className="empty-state">Loading…</div>}

      {!error && rows && !rows.length && (
        <div className="empty-state">No orders match{searched ? ` "${searched}"` : ''}{filtered ? ` (${describe()})` : ''}.</div>
      )}

      {!error && rows && rows.length > 0 && (
        <div className="manifest">
          <div className="m-row head" style={{ gridTemplateColumns: COLS }}>
            <div>Order</div>
            <div>Customer</div>
            <div>Date</div>
            <div className="num">Total</div>
            <div>Status</div>
          </div>
          {rows.map(o => (
            <div
              className="m-row"
              key={o.id}
              style={{ gridTemplateColumns: COLS }}
              onClick={() => navigate(`/orders/${o.id}`)}
            >
              <div>
                <div className="acct-name num">{o.number}</div>
                <div className="acct-region">
                  {o.itemCount} {o.itemCount === 1 ? 'item' : 'items'}
                  {o.invoiceNumber ? `, inv ${o.invoiceNumber}` : ''}
                </div>
              </div>
              <div>
                <div className="acct-name">{o.accountName}</div>
                <div className="acct-region">
                  {o.shipTo && o.shipTo !== o.accountName ? `Ship to ${o.shipTo}, ` : ''}{o.region}
                </div>
              </div>
              <div>{fmtDateWithYear(o.date)}</div>
              <div className="num">{fmtMoney(Math.round(o.total * 100) / 100)}</div>
              <div className="order-pills">{orderStatusPills(o)}</div>
            </div>
          ))}
        </div>
      )}

      {rows && rows.length >= limit && (
        <div style={{ marginTop: 12, fontSize: 12, color: 'var(--muted)' }}>
          Showing the {limit} most recent matches. Narrow the search or filters to find older ones.
        </div>
      )}
    </>
  );
}

// Tick-box dropdown (same style as the payment terms and category filters).
function TickFilter({ label, all, options, picked, onToggle, onClear }: {
  label: string; all: string; options: string[]; picked: Set<string>;
  onToggle: (v: string) => void; onClear: () => void;
}) {
  if (!options.length) return null;
  return (
    <details className="terms-filter">
      <summary aria-label={label}>
        {picked.size === 0 ? all : picked.size === 1 ? [...picked][0] : `${label}: ${picked.size} ticked`}
      </summary>
      <div className="terms-menu">
        <div className="terms-menu-tools">
          <button type="button" className="link-btn" onClick={onClear}>{all}</button>
        </div>
        {options.map(o => (
          <label key={o} className="pl-check">
            <input type="checkbox" checked={picked.has(o)} onChange={() => onToggle(o)} />
            <span>{o}</span>
          </label>
        ))}
      </div>
    </details>
  );
}