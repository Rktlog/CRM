import { FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiGet } from '../lib/api';
import { fmtDateWithYear } from '../lib/types';

type Location = { location: string; onHand: number; allocated: number; available: number; onOrder: number };
type Sale = { quoteId: string; number: string; date: string; accountId: string; accountName: string; qty: number };
type Product = {
  sku: string;
  name: string;
  brand: string | null;
  category: string | null;
  uom: string | null;
  onHand: number;
  allocated: number;
  available: number;
  onOrder: number;
  locations: Location[];
  units12m: number;
  monthlyAvg: number;
  customers12m: number;
  recentSales: Sale[];
};

const COLS = '0.9fr 2fr 1fr 0.7fr 0.7fr 0.8fr 0.7fr';

function availabilityPill(n: number) {
  const tone = n <= 0 ? 'rust' : n <= 5 ? 'amber' : 'teal';
  return <span className={`pill ${tone} num`}>{n}</span>;
}

export default function ProductSearch() {
  const [term, setTerm] = useState('');
  const [searched, setSearched] = useState<string | null>(null);
  const [results, setResults] = useState<Product[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openSku, setOpenSku] = useState<string | null>(null);
  const [stockAsOf, setStockAsOf] = useState<string | null>(null);

  async function search(e: FormEvent) {
    e.preventDefault();
    const q = term.trim();
    if (q.length < 2) return;
    setLoading(true);
    setError(null);
    setOpenSku(null);
    try {
      const data = await apiGet(`/products/search?q=${encodeURIComponent(q)}`);
      setResults(data.results);
      setStockAsOf(data.stockSyncedAt);
      setSearched(q);
    } catch (err: any) {
      setError(String(err.message).includes('503')
        ? 'DEAR is busy right now. Try again in a minute.'
        : `Search failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <h1>Products</h1>

      <form className="product-search-form" onSubmit={search}>
        <input
          type="text"
          value={term}
          onChange={e => setTerm(e.target.value)}
          placeholder="SKU or product name"
          autoFocus
        />
        <button className="btn" type="submit" disabled={loading || term.trim().length < 2}>
          {loading ? 'Searching…' : 'Search'}
        </button>
      </form>

      {stockAsOf && (
        <div className="stock-as-of">
          Stock as of {new Date(stockAsOf).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}
        </div>
      )}

      {error && <div className="empty-state">{error}</div>}

      {!error && loading && !results && <div className="empty-state">Searching…</div>}

      {!error && !loading && results && !results.length && (
        <div className="empty-state">Nothing matches "{searched}".</div>
      )}

      {!error && results && results.length > 0 && (
        <div className="manifest">
          <div className="m-row head product-row" style={{ gridTemplateColumns: COLS }}>
            <div>SKU</div>
            <div>Product</div>
            <div className="hide-sm">Brand</div>
            <div className="num">On hand</div>
            <div className="num hide-sm">Allocated</div>
            <div className="num">Available</div>
            <div className="num hide-sm">On order</div>
          </div>

          {results.map(p => {
            const open = openSku === p.sku;
            return (
              <div key={p.sku}>
                <div
                  className={'m-row product-row' + (open ? ' open' : '')}
                  style={{ gridTemplateColumns: COLS }}
                  onClick={() => setOpenSku(open ? null : p.sku)}
                  aria-expanded={open}
                >
                  <div className="num">{p.sku}</div>
                  <div>
                    <div className="acct-name">{p.name}</div>
                    {p.category && <div className="acct-region">{p.category}</div>}
                  </div>
                  <div className="hide-sm" style={{ color: 'var(--ink-soft)' }}>{p.brand ?? '—'}</div>
                  <div className="num">{p.onHand}</div>
                  <div className="num hide-sm">{p.allocated}</div>
                  <div className="num">{availabilityPill(p.available)}</div>
                  <div className="num hide-sm">{p.onOrder}</div>
                </div>

                {open && <ProductDetail product={p} />}
              </div>
            );
          })}
        </div>
      )}

      {results && results.length === 25 && (
        <div style={{ marginTop: 12, fontSize: 12, color: 'var(--muted)' }}>
          Showing the top 25 matches. Narrow the search to see others.
        </div>
      )}
    </>
  );
}

function ProductDetail({ product: p }: { product: Product }) {
  return (
    <div className="product-detail">
      <div className="card">
        <h3>Last 12 months</h3>
        <div className="spend-grid">
          <div className="spend-cell">
            <div className="v num">{p.units12m}</div>
            <div className="l">Units sold{p.uom ? ` (${p.uom})` : ''}</div>
          </div>
          <div className="spend-cell">
            <div className="v num">{p.monthlyAvg}</div>
            <div className="l">Per month</div>
          </div>
          <div className="spend-cell">
            <div className="v num">{p.customers12m}</div>
            <div className="l">Customers</div>
          </div>
        </div>
      </div>

      <div className="card">
        <h3>Stock by location</h3>
        {p.locations.length ? p.locations.map(l => (
          <div className="kv" key={l.location}>
            <span className="k">{l.location}</span>
            <span className="num">{l.onHand} on hand, {l.available} available</span>
          </div>
        )) : (
          <div style={{ fontSize: 13, color: 'var(--muted)' }}>No stock held in any location.</div>
        )}
      </div>

      <div className="card product-detail-wide">
        <h3>Recent orders</h3>
        {p.recentSales.length ? p.recentSales.map(s => (
          <div className="kv" key={s.number}>
            <span>
              <Link to={`/accounts/${s.accountId}`} className="acct-name">{s.accountName}</Link>
              <span className="k"> </span>
              <Link to={`/orders/${s.quoteId}`} className="k order-link">#{s.number}</Link>
              <span className="k">, {fmtDateWithYear(s.date)}</span>
            </span>
            <span className="num">{s.qty}</span>
          </div>
        )) : (
          <div style={{ fontSize: 13, color: 'var(--muted)' }}>No orders in the last 12 months.</div>
        )}
      </div>
    </div>
  );
}