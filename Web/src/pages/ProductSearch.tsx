import { FormEvent, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { apiGet } from '../lib/api';
import { fmtMoney, fmtDateWithYear } from '../lib/types';

type Location = { location: string; onHand: number; allocated: number; available: number; onOrder: number };
type OrderRef = { quoteId: string; number: string; date: string; accountId: string; accountName: string; qty: number; miscType?: string | null };
type Incoming = { number: string | null; supplier: string | null; orderDate: string | null; expected: string | null; status: string | null; ordered: number; outstanding: number };
type Received = { number: string | null; supplier: string | null; received: string | null; qty: number };
type Price = { tier: string; price: number } | null;
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
  wholesale: Price;
  retail: Price;
  prices: Record<string, number>;
  sales: { units12m: number; value12m: number; unitsAll: number; valueAll: number };
  allocatedOrders: OrderRef[];
  incoming: Incoming[];
  purchaseHistory: Received[];
  recentOrders: OrderRef[];
};

const COLS = '0.9fr 2fr 1fr 0.7fr 0.7fr 0.8fr 0.7fr';

const price = (n: number) => '$' + n.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qty = (n: number) => n.toLocaleString('en-AU', { maximumFractionDigits: 2 });

function availabilityPill(n: number) {
  const tone = n <= 0 ? 'rust' : n <= 5 ? 'amber' : 'teal';
  return <span className={`pill ${tone} num`}>{qty(n)}</span>;
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
      if (data.results.length === 1) setOpenSku(data.results[0].sku);
    } catch (err: any) {
      setError(`Search failed: ${err.message}`);
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
          placeholder="SKU, product name or brand, any words in any order"
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
                  <div className="num">{qty(p.onHand)}</div>
                  <div className="num hide-sm">{qty(p.allocated)}</div>
                  <div className="num">{availabilityPill(p.available)}</div>
                  <div className="num hide-sm">{qty(p.onOrder)}</div>
                </div>

                {open && <ProductDetail product={p} />}
              </div>
            );
          })}
        </div>
      )}

      {results && results.length === 25 && (
        <div style={{ marginTop: 12, fontSize: 12, color: 'var(--muted)' }}>
          Showing the top 25 matches. Add another word to narrow it down.
        </div>
      )}
    </>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: 13, color: 'var(--muted)' }}>{children}</div>;
}

function ProductDetail({ product: p }: { product: Product }) {
  const otherPrices = Object.entries(p.prices).filter(
    ([tier]) => tier !== p.wholesale?.tier && tier !== p.retail?.tier,
  );

  return (
    <div className="product-detail">
      <div className="card">
        <h3>Pricing</h3>
        <div className="spend-grid two">
          <div className="spend-cell">
            <div className="v num">{p.wholesale ? price(p.wholesale.price) : '—'}</div>
            <div className="l">Wholesale</div>
          </div>
          <div className="spend-cell">
            <div className="v num">{p.retail ? price(p.retail.price) : '—'}</div>
            <div className="l">Retail</div>
          </div>
        </div>
        {/* If DEAR's tier names don't say wholesale/retail, show them all. */}
        {otherPrices.length > 0 && !(p.wholesale && p.retail) && otherPrices.map(([tier, v]) => (
          <div className="kv" key={tier}><span className="k">{tier}</span><span className="num">{price(v)}</span></div>
        ))}
      </div>

      <div className="card">
        <h3>Stock</h3>
        <div className="kv"><span className="k">On hand</span><span className="num">{qty(p.onHand)}{p.uom ? ` ${p.uom}` : ''}</span></div>
        <div className="kv"><span className="k">Allocated</span><span className="num">{qty(p.allocated)}</span></div>
        <div className="kv"><span className="k">Available</span><span className="num">{qty(p.available)}</span></div>
        <div className="kv"><span className="k">On order</span><span className="num">{qty(p.onOrder)}</span></div>
        {p.locations.length > 1 && p.locations.map(l => (
          <div className="kv" key={l.location}>
            <span className="k">{l.location}</span>
            <span className="num">{qty(l.onHand)} on hand, {qty(l.available)} available</span>
          </div>
        ))}
      </div>

      <div className="card product-detail-wide">
        <h3>Total sales</h3>
        <div className="spend-grid four">
          <div className="spend-cell"><div className="v num">{qty(p.sales.units12m)}</div><div className="l">Units, 12 months</div></div>
          <div className="spend-cell"><div className="v num">{fmtMoney(p.sales.value12m)}</div><div className="l">Sales, 12 months</div></div>
          <div className="spend-cell"><div className="v num">{qty(p.sales.unitsAll)}</div><div className="l">Units, all time</div></div>
          <div className="spend-cell"><div className="v num">{fmtMoney(p.sales.valueAll)}</div><div className="l">Sales, all time</div></div>
        </div>
      </div>

      <div className="card product-detail-wide">
        <h3>Incoming POs</h3>
        {p.incoming.length ? p.incoming.map((po, i) => (
          <div className="kv" key={i}>
            <span>
              <span className="acct-name num">{po.number ?? 'PO'}</span>
              <span className="k">
                {po.supplier ? `, ${po.supplier}` : ''}
                {po.expected ? `, expected ${fmtDateWithYear(po.expected)}` : po.orderDate ? `, ordered ${fmtDateWithYear(po.orderDate)}` : ''}
              </span>
            </span>
            <span className="num">{qty(po.outstanding)} incoming</span>
          </div>
        )) : <Empty>No open purchase orders for this item.</Empty>}
      </div>

      <div className="card product-detail-wide">
        <h3>Allocated to orders</h3>
        {p.allocatedOrders.length ? p.allocatedOrders.map(o => (
          <div className="kv" key={o.quoteId}>
            <span>
              <Link to={`/accounts/${o.accountId}`} className="acct-name">{o.accountName}</Link>
              <span className="k"> </span>
              <Link to={`/orders/${o.quoteId}`} className="k order-link">#{o.number}</Link>
              <span className="k">, {fmtDateWithYear(o.date)}</span>
              {o.miscType === 'marketing' && <span className="pill marketing" style={{ marginLeft: 6 }}>Marketing</span>}
            </span>
            <span className="num">{qty(o.qty)}</span>
          </div>
        )) : <Empty>{p.allocated > 0 ? 'Allocated in DEAR, but not to any order in this app.' : 'Nothing allocated.'}</Empty>}
      </div>

      <div className="card product-detail-wide">
        <h3>Purchase history</h3>
        {p.purchaseHistory.length ? p.purchaseHistory.map((r, i) => (
          <div className="kv" key={i}>
            <span>
              <span className="acct-name num">{r.number ?? 'PO'}</span>
              <span className="k">
                {r.supplier ? `, ${r.supplier}` : ''}{r.received ? `, received ${fmtDateWithYear(r.received)}` : ''}
              </span>
            </span>
            <span className="num">{qty(r.qty)}</span>
          </div>
        )) : <Empty>No stock received in the last 12 months.</Empty>}
      </div>

      <div className="card product-detail-wide">
        <h3>Recent orders</h3>
        {p.recentOrders.length ? p.recentOrders.map(s => (
          <div className="kv" key={s.quoteId}>
            <span>
              <Link to={`/accounts/${s.accountId}`} className="acct-name">{s.accountName}</Link>
              <span className="k"> </span>
              <Link to={`/orders/${s.quoteId}`} className="k order-link">#{s.number}</Link>
              <span className="k">, {fmtDateWithYear(s.date)}</span>
            </span>
            <span className="num">{qty(s.qty)}</span>
          </div>
        )) : <Empty>No orders yet.</Empty>}
      </div>
    </div>
  );
}