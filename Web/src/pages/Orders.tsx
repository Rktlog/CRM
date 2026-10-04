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

function AllOrders() {
  const [term, setTerm] = useState('');
  const [searched, setSearched] = useState('');
  const [rows, setRows] = useState<OrderRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  async function load(q: string) {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet(`/orders/search?q=${encodeURIComponent(q)}`);
      setRows(data.results);
      setSearched(q);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

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

      <div className="stock-as-of">
        {searched ? `Results for "${searched}"` : 'Most recent orders'}
      </div>

      {error && <div className="empty-state">Couldn't load orders: {error}</div>}

      {!error && !rows && <div className="empty-state">Loading…</div>}

      {!error && rows && !rows.length && (
        <div className="empty-state">No orders match "{searched}".</div>
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

      {rows && rows.length === 50 && (
        <div style={{ marginTop: 12, fontSize: 12, color: 'var(--muted)' }}>
          Showing the 50 most recent matches. Narrow the search to find older ones.
        </div>
      )}
    </>
  );
}