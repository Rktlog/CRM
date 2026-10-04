import { FormEvent, useEffect, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { apiGet } from '../lib/api';

type Location = { location: string; onHand: number; allocated: number; available: number; onOrder: number };
type OrderRef = {
  quoteId: string; number: string; date: string; accountId: string; accountName: string; qty: number;
  miscType?: string | null; status?: string | null;
  paid?: boolean; partial?: boolean;
};
type PurchaseOrder = {
  number: string | null; supplier: string | null;
  orderDate: string | null; expected: string | null; receivedAt: string | null;
  ordered: number; received: number; outstanding: number;
  state: 'incoming' | 'partial' | 'received';
};
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
  purchaseOrders: PurchaseOrder[];
  // Completed stock adjustments: + stock added, - removed (write-offs, recounts, returns)
  adjustments?: { number: string | null; date: string | null; reference: string | null; quantity: number | null; location: string | null; kind: string }[];
  incomingRefs: string[];
  incomingQty: number;
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
    await runSearch(term);
  }

  // Arriving from a link like /products?q=SKU (e.g. Sales Data's top
  // products): search straight away. One match opens its detail.
  const [params] = useSearchParams();
  useEffect(() => {
    const q = params.get('q');
    if (q && q.trim().length >= 2) {
      setTerm(q);
      runSearch(q);
    }
  }, [params]);

  async function runSearch(raw: string) {
    const q = raw.trim();
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
  return <div className="pd-empty">{children}</div>;
}

const shortDate = (d: string | null) =>
  d ? new Date(d).toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '';

function ProductDetail({ product: p }: { product: Product }) {
  const unit = p.uom ? ` ${p.uom}` : '';
  const otherPrices = Object.entries(p.prices).filter(
    ([tier]) => tier !== p.wholesale?.tier && tier !== p.retail?.tier,
  );

  return (
    <div className="pd">
      {/* ---- Stock tiles ---- */}
      <div className="pd-tiles">
        <div className="pd-tile">
          <div className="pd-tile-label">On hand</div>
          <div className="pd-tile-value num">{qty(p.onHand)}{unit}</div>
        </div>
        <div className="pd-tile amber">
          <div className="pd-tile-label">Allocated</div>
          <div className="pd-tile-value num">{qty(p.allocated)}{unit}</div>
        </div>
        <div className="pd-tile teal">
          <div className="pd-tile-label">Available</div>
          <div className="pd-tile-value num">{qty(p.available)}{unit}</div>
        </div>
        <div className="pd-tile">
          <div className="pd-tile-label">On order</div>
          <div className="pd-tile-value num">{qty(p.onOrder)}{unit}</div>
          {p.incomingRefs.length > 0 && (
            <>
              <div className="pd-tile-sub">PO ref</div>
              <div className="pd-chips">
                {p.incomingRefs.map(ref => <span className="pd-chip num" key={ref}>{ref}</span>)}
              </div>
            </>
          )}
        </div>
      </div>

      {/* ---- Pricing and sales totals ---- */}
      <div className="pd-row">
        <div className="pd-box">
          <div className="pd-box-title">Pricing</div>
          <div className="pd-stats">
            <div><div className="pd-stat-v num">{p.wholesale ? price(p.wholesale.price) : '—'}</div><div className="pd-stat-l">Wholesale</div></div>
            <div><div className="pd-stat-v num">{p.retail ? price(p.retail.price) : '—'}</div><div className="pd-stat-l">Retail</div></div>
          </div>
          {/* If DEAR's tier names don't say wholesale/retail, list them all. */}
          {otherPrices.length > 0 && !(p.wholesale && p.retail) && otherPrices.map(([tier, v]) => (
            <div className="kv" key={tier}><span className="k">{tier}</span><span className="num">{price(v)}</span></div>
          ))}
        </div>
        <div className="pd-box">
          <div className="pd-box-title">Total sales</div>
          <div className="pd-stats four">
            <div><div className="pd-stat-v num">{qty(p.sales.units12m)}</div><div className="pd-stat-l">Units, 12 mo</div></div>
            <div><div className="pd-stat-v num">{price(p.sales.value12m)}</div><div className="pd-stat-l">Sales, 12 mo</div></div>
            <div><div className="pd-stat-v num">{qty(p.sales.unitsAll)}</div><div className="pd-stat-l">Units, all time</div></div>
            <div><div className="pd-stat-v num">{price(p.sales.valueAll)}</div><div className="pd-stat-l">Sales, all time</div></div>
          </div>
        </div>
      </div>

      {/* ---- Allocated: on an order and not shipped yet ---- */}
      <div className="pd-section amber">
        <div className="pd-section-title">Allocated sales orders ({p.allocatedOrders.length})</div>
        {p.allocatedOrders.length > 0 && (
          <div className="pd-note">On these orders and not shipped yet, so it can't go to another customer.</div>
        )}
        {p.allocatedOrders.length ? (
          <div className="pd-cards">
            {p.allocatedOrders.map(o => (
              <Link to={`/orders/${o.quoteId}`} className="pd-card" key={o.quoteId}>
                <div className="pd-card-top">
                  <span className="pd-ref num">#{o.number}</span>
                  <span className="pd-qty amber num">{qty(o.qty)}{unit}</span>
                </div>
                <div className="pd-card-bottom">
                  <span className="pd-sub">{o.accountName}</span>
                  <span className="pd-sub num">{shortDate(o.date)}</span>
                </div>
                <div className="pd-card-tags">
                  {o.miscType === 'marketing' && <span className="pill marketing">Marketing</span>}
                  {o.paid === false && <span className="pill amber">Unpaid</span>}
                  {o.status && o.status.toUpperCase() === 'BACKORDERED' && <span className="pill rust">Backordered</span>}
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <Empty>{p.allocated > 0 ? 'DEAR shows stock allocated, but not to an order in this app (customer not in the CRM yet).' : 'Nothing allocated.'}</Empty>
        )}
      </div>

      {/* ---- Locations, only when there's more than one ---- */}
      {p.locations.length > 1 && (
        <div className="pd-section">
          <div className="pd-section-title">Stock locations ({p.locations.length})</div>
          {p.locations.map(l => (
            <div className="pd-list-row" key={l.location}>
              <span>{l.location}</span>
              <span className="num">On hand: <b>{qty(l.onHand)}</b> | Avail: <b className="teal-text">{qty(l.available)}</b></span>
            </div>
          ))}
        </div>
      )}

      {/* ---- Sales and purchases side by side ---- */}
      <div className="pd-two">
        <div>
          <div className="pd-col-title">Recent sales (shipped)</div>
          {p.recentOrders.length ? p.recentOrders.map(s => (
            <Link to={`/orders/${s.quoteId}`} className="pd-list-card" key={s.quoteId}>
              <div>
                <div className="pd-ref-lg">Order #{s.number}</div>
                <div className="pd-sub">{s.accountName}</div>
              </div>
              <div className="pd-right">
                <div className="pd-qty rust num">−{qty(s.qty)}{unit}{s.partial && <span className="pill neutral">Part shipped</span>}</div>
                <div className="pd-sub num">{shortDate(s.date)}</div>
              </div>
            </Link>
          )) : <Empty>No sales yet.</Empty>}
        </div>

        <div>
          <div className="pd-col-title">Recent purchase orders</div>
          {p.purchaseOrders.length ? p.purchaseOrders.map((po, i) => (
            <div className="pd-list-card static" key={i}>
              <div>
                <div className="pd-ref-lg">PO #{po.number ?? '—'}</div>
                <div className="pd-sub">{po.supplier ?? ''}</div>
              </div>
              <div className="pd-right">
                {po.state === 'received' ? (
                  <>
                    <div className="pd-qty teal num">+{qty(po.received || po.ordered)}{unit}</div>
                    <div className="pd-sub num">{shortDate(po.receivedAt ?? po.orderDate)}</div>
                  </>
                ) : (
                  <>
                    <div className="pd-qty num">
                      +{qty(po.outstanding)}{unit} <span className="pill amber">{po.state === 'partial' ? 'Part received' : 'Incoming'}</span>
                    </div>
                    <div className="pd-sub num">{po.expected ? `Due ${shortDate(po.expected)}` : shortDate(po.orderDate)}</div>
                  </>
                )}
              </div>
            </div>
          )) : <Empty>No purchase orders on record.</Empty>}

          {(p.adjustments?.length ?? 0) > 0 && (
            <>
              <div className="pd-col-title" style={{ marginTop: 16 }}>Stock adjustments</div>
              {p.adjustments!.map((a, i) => (
                <div className="pd-list-card static" key={`adj-${i}`}>
                  <div>
                    <div className="pd-ref-lg">{a.number ?? 'Adjustment'}</div>
                    <div className="pd-sub">{a.reference || (a.kind === 'new' ? 'Stock added' : 'Stock count')}{a.location ? `, ${a.location}` : ''}</div>
                  </div>
                  <div className="pd-right">
                    <div className={`pd-qty num${(a.quantity ?? 0) < 0 ? ' rust' : ' teal'}`}>
                      {a.quantity == null ? '—' : `${a.quantity > 0 ? '+' : ''}${qty(a.quantity)}`}{unit}
                    </div>
                    <div className="pd-sub num">{a.date ? shortDate(a.date) : ''}</div>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}