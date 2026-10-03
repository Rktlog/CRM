import { FormEvent, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiGet } from '../lib/api';
import { fmtMoney, fmtDateWithYear, isHistoryOrder } from '../lib/types';

type OrderRow = {
  id: string;
  number: string;
  date: string;
  total: number;
  paid: boolean;
  paymentStatus: string | null;
  fulfillmentStatus: string | null;
  shippingStatus: string | null;
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

export function orderStatusPills(o: {
  paid: boolean; fulfillmentStatus: string | null; miscType: string | null; source?: string; number?: string;
}) {
  // Spreadsheet history: its old statuses mean nothing now, so show only
  // that it's history (plus marketing/warranty, which still matters).
  if (isHistoryOrder(o)) {
    return (
      <>
        {o.miscType === 'marketing' && <span className="pill marketing">Marketing order</span>}
        {o.miscType === 'warranty' && <span className="pill neutral">Warranty</span>}
        <span className="badge muted">History</span>
      </>
    );
  }
  const status = (o.fulfillmentStatus ?? '').toUpperCase();
  return (
    <>
      {o.miscType === 'marketing' && <span className="pill marketing">Marketing order</span>}
      {o.miscType === 'warranty' && <span className="pill neutral">Warranty</span>}
      {o.paid ? <span className="pill teal">Paid</span> : <span className="pill amber">Unpaid</span>}
      {status === 'BACKORDERED' && <span className="pill rust">Backordered</span>}
      {status === 'COMPLETED' && <span className="pill teal">Completed</span>}
      {status && status !== 'BACKORDERED' && status !== 'COMPLETED' && (
        <span className="pill neutral">{o.fulfillmentStatus}</span>
      )}
    </>
  );
}

export default function Orders() {
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
      <h1>Orders</h1>

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