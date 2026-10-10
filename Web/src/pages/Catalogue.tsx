import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiGet } from '../lib/api';
import ProductPhoto from '../components/ProductPhoto';

// Catalogue: product photos by brand, with stock and price. Built for scrolling on a
// phone during a visit. Tap a photo to see it large; tap the SKU for the full stock
// detail on the Products page. Photos come from the team's Google Sheet.

type Item = {
  sku: string; name: string; brand: string | null; category: string | null; uom: string | null; imageUrl: string | null;
  available: number; onHand: number; onOrder: number; wholesale: number | null; retail: number | null;
};
type Facet = { name: string; count: number };
const PAGE = 48;
const money = (n: number) => '$' + n.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qty = (n: number) => n.toLocaleString('en-AU', { maximumFractionDigits: 2 });

export default function Catalogue() {
  const [search, setSearch] = useState('');
  const [brand, setBrand] = useState('');
  const [category, setCategory] = useState('');
  const [inStock, setInStock] = useState(false);
  const [withPhoto, setWithPhoto] = useState(true);

  const [items, setItems] = useState<Item[]>([]);
  const [total, setTotal] = useState(0);
  const [brands, setBrands] = useState<Facet[]>([]);
  const [categories, setCategories] = useState<Facet[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);   // ignore an answer that arrives after a newer request

  function query(offset: number) {
    const p = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
    if (search.trim()) p.set('q', search.trim());
    if (brand) p.set('brand', brand);
    if (category) p.set('category', category);
    if (inStock) p.set('inStock', '1');
    if (withPhoto) p.set('withPhoto', '1');
    return p.toString();
  }

  async function load(offset: number, append: boolean) {
    const id = ++latest.current;
    setLoading(true);
    setError(null);
    try {
      const d = await apiGet(`/products/catalogue?${query(offset)}`);
      if (id !== latest.current) return;
      setItems(prev => (append ? [...prev, ...d.items] : d.items));
      setTotal(d.total);
      setBrands(d.brands);
      setCategories(d.categories);
    } catch (e: any) {
      if (id === latest.current) setError(e.message);
    } finally {
      if (id === latest.current) setLoading(false);
    }
  }

  // First page now, and again (after a short pause while typing) when a filter changes.
  useEffect(() => {
    const t = setTimeout(() => load(0, false), search ? 300 : 0);
    return () => clearTimeout(t);
  }, [search, brand, category, inStock, withPhoto]);

  const control: React.CSSProperties = { padding: '7px 10px', border: '1px solid var(--line)', borderRadius: 6, font: 'inherit', fontSize: 13, background: 'var(--panel)' };

  return (
    <>
      <h1>Catalogue</h1>
      <div className="stock-as-of">
        Product photos by brand, with stock and price. Tap a photo to see it large, or the SKU for the full stock detail.
      </div>

      <div className="controls" style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', margin: '12px 0' }}>
        <input type="search" placeholder="Search name, SKU or brand" value={search} onChange={e => setSearch(e.target.value)} style={{ ...control, flex: '1 1 220px', minWidth: 180 }} />
        <select value={brand} onChange={e => setBrand(e.target.value)} aria-label="Brand" style={control}>
          <option value="">All brands</option>
          {brands.map(b => <option key={b.name} value={b.name}>{b.name} ({b.count})</option>)}
        </select>
        <select value={category} onChange={e => setCategory(e.target.value)} aria-label="Category" style={control}>
          <option value="">All categories</option>
          {categories.map(c => <option key={c.name} value={c.name}>{c.name} ({c.count})</option>)}
        </select>
        <label className="acct-region" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={withPhoto} onChange={e => setWithPhoto(e.target.checked)} /> With photo only
        </label>
        <label className="acct-region" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={inStock} onChange={e => setInStock(e.target.checked)} /> In stock only
        </label>
      </div>

      {error && <div className="empty-state">Couldn't load the catalogue: {error}</div>}
      {!error && loading && !items.length && <div className="empty-state">Loading…</div>}
      {!error && !loading && !items.length && (
        <div className="empty-state">
          Nothing matches.{withPhoto ? ' Untick "With photo only" to include products that have no photo yet.' : ''}
        </div>
      )}

      {!error && items.length > 0 && (
        <>
          <div className="acct-region" style={{ marginBottom: 8 }}>{total.toLocaleString('en-AU')} {total === 1 ? 'product' : 'products'}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(168px, 1fr))', gap: 14 }}>
            {items.map((it, i) => (
              <Fragment key={it.sku} item={it} showBrand={i === 0 || (items[i - 1].brand ?? '') !== (it.brand ?? '')} />
            ))}
          </div>
        </>
      )}

      {items.length > 0 && items.length < total && (
        <button className="btn secondary" style={{ marginTop: 16 }} disabled={loading} onClick={() => load(items.length, true)}>
          {loading ? 'Loading…' : `Show ${Math.min(PAGE, total - items.length)} more (${(total - items.length).toLocaleString('en-AU')} left)`}
        </button>
      )}
    </>
  );
}

// One product, with a brand heading above it where the brand changes.
function Fragment({ item: it, showBrand }: { item: Item; showBrand: boolean }) {
  const tone = it.available <= 0 ? 'rust' : it.available <= 5 ? 'amber' : 'teal';
  return (
    <>
      {showBrand && <h2 style={{ gridColumn: '1 / -1', margin: '14px 0 0', fontSize: 15 }}>{it.brand ?? 'Other'}</h2>}
      <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 8, padding: 10, display: 'flex', flexDirection: 'column', gap: 7 }}>
        <ProductPhoto url={it.imageUrl} name={it.name} sku={it.sku} size="fill" />
        <div
          title={it.name}
          style={{ fontWeight: 600, fontSize: 13, lineHeight: 1.25, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', minHeight: 32 }}
        >
          {it.name}
        </div>
        <div>
          <Link to={`/products?q=${encodeURIComponent(it.sku)}`} className="order-link" style={{ fontSize: 11.5 }}>{it.sku}</Link>
          {it.category && <div className="acct-region">{it.category}</div>}
        </div>
        <div>
          <span className={`pill ${tone} num`}>{qty(it.available)} available</span>
          {it.available <= 0 && it.onOrder > 0 && <div className="acct-region" style={{ marginTop: 3 }}>{qty(it.onOrder)} on order</div>}
        </div>
        {(it.wholesale != null || it.retail != null) && (
          <div className="acct-region" style={{ lineHeight: 1.5 }}>
            {it.wholesale != null && <div>Wholesale <b className="num">{money(it.wholesale)}</b></div>}
            {it.retail != null && <div>RRP <b className="num">{money(it.retail)}</b></div>}
          </div>
        )}
      </div>
    </>
  );
}