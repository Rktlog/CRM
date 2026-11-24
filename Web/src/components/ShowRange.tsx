import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiGet } from '../lib/api';
import { errMsg, type Product } from '../lib/tradeshow';
import { Thumb, Facts } from './ProductPic';

// "Show range": a catalogue of one brand's products with pictures, so a rep can show a customer what else there is, compare two or three items side by side,
// and add what they pick to the order. The window stays open, so several can be added one after another.
type Range = { brands: { brand: string; n: number }[]; stand: string[]; products: Product[] };
const MAX_COMPARE = 3;

export default function ShowRange({ showId, initialBrand, onAdd, onClose }: { showId: string | undefined; initialBrand: string; onAdd: (p: Product) => void; onClose: () => void }) {
  const [brand, setBrand] = useState(initialBrand);
  const [q, setQ] = useState('');
  const [data, setData] = useState<Range | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [picked, setPicked] = useState<Product[]>([]);
  const [comparing, setComparing] = useState(false);
  const [added, setAdded] = useState<Record<string, number>>({});

  useEffect(() => {
    let live = true; setLoading(true);
    const t = setTimeout(() => {
      apiGet(`/tradeshow/products/range?brand=${encodeURIComponent(brand)}&q=${encodeURIComponent(q.trim())}${showId ? `&showId=${showId}` : ''}`)
        .then((d: Range) => { if (live) { setData(d); setErr(null); } }).catch(e => { if (live) setErr(errMsg(e)); }).finally(() => { if (live) setLoading(false); });
    }, q ? 300 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [brand, q, showId]);
  useEffect(() => { const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); }, [onClose]);

  const stand = new Set((data?.stand ?? []).map(b => b.toLowerCase()));
  const onStand = (b: string | null) => !!b && stand.has(b.toLowerCase());
  const toggle = (p: Product) => setPicked(l => (l.some(x => x.sku === p.sku) ? l.filter(x => x.sku !== p.sku) : l.length >= MAX_COMPARE ? l : [...l, p]));
  const add = (p: Product) => { onAdd(p); setAdded(a => ({ ...a, [p.sku]: (a[p.sku] ?? 0) + 1 })); };
  const brands = data?.brands ?? [];
  const mine = brands.filter(b => stand.has(b.brand.toLowerCase())), rest = brands.filter(b => !stand.has(b.brand.toLowerCase()));

  const card = (p: Product) => (
    <div key={p.sku} style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 8, background: '#fff', display: 'grid', gap: 6, alignContent: 'start' }}>
      <div style={{ aspectRatio: '4 / 3', width: '100%' }}><BigPic p={p} /></div>
      <div style={{ fontSize: 13.5, lineHeight: 1.25 }}><b>{p.name}</b></div>
      <div className="acct-region" style={{ fontSize: 12 }}>{p.sku}{p.increment && p.increment > 1 ? ` · packs of ${p.increment}` : ''}</div>
      <Facts p={p} compact />
      {onStand(p.brand) && <span className="pill teal" style={{ justifySelf: 'start' }}>On the stand</span>}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" className="btn" style={{ padding: '4px 10px' }} disabled={p.price === null} onClick={() => add(p)}>Add</button>
        {added[p.sku] ? <span className="acct-region" style={{ fontSize: 12 }}>Added{added[p.sku]! > 1 ? ` ×${added[p.sku]}` : ''}</span> : null}
        <label style={{ fontSize: 12.5, display: 'inline-flex', gap: 4, alignItems: 'center', marginLeft: 'auto' }}>
          <input type="checkbox" checked={picked.some(x => x.sku === p.sku)} disabled={!picked.some(x => x.sku === p.sku) && picked.length >= MAX_COMPARE} onChange={() => toggle(p)} /> Compare
        </label>
      </div>
    </div>
  );

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" role="dialog" aria-label="Show range" onClick={e => e.stopPropagation()} style={{ maxWidth: 1040, width: '96vw', maxHeight: '92vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
          <b style={{ fontSize: 16 }}>Show range</b>
          <select aria-label="Brand" value={brand} onChange={e => { setBrand(e.target.value); setPicked([]); setComparing(false); }} style={{ minWidth: 160 }}>
            <option value="">Choose a brand…</option>
            {mine.length > 0 && <optgroup label="On the stand">{mine.map(b => <option key={b.brand} value={b.brand}>{b.brand} ({b.n})</option>)}</optgroup>}
            <optgroup label={mine.length ? 'Other brands' : 'Brands'}>{rest.map(b => <option key={b.brand} value={b.brand}>{b.brand} ({b.n})</option>)}</optgroup>
          </select>
          <input type="search" aria-label="Search the range" placeholder="Search by name or SKU" value={q} onChange={e => setQ(e.target.value)} style={{ flex: 1, minWidth: 140 }} />
          {picked.length >= 2 && <button type="button" className="btn secondary" onClick={() => setComparing(c => !c)}>{comparing ? 'Back to the range' : `Compare ${picked.length}`}</button>}
          <button type="button" className="btn" onClick={onClose}>Done</button>
        </div>
        {err && <div className="save-msg err" role="alert">{err}</div>}
        {comparing && picked.length >= 2 ? (
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${picked.length}, minmax(0, 1fr))`, gap: 12 }}>
            {picked.map(p => (
              <div key={p.sku} style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 10, background: '#fff', display: 'grid', gap: 6, alignContent: 'start' }}>
                <div style={{ aspectRatio: '4 / 3', width: '100%' }}><BigPic p={p} /></div>
                <b>{p.name}</b>
                <div className="acct-region">{p.sku}{p.increment && p.increment > 1 ? ` · packs of ${p.increment}` : ''}</div>
                <Facts p={p} />
                <div style={{ display: 'flex', gap: 6 }}><button type="button" className="btn" disabled={p.price === null} onClick={() => add(p)}>Add</button>{added[p.sku] ? <span className="acct-region">Added{added[p.sku]! > 1 ? ` ×${added[p.sku]}` : ''}</span> : null}</div>
              </div>
            ))}
          </div>
        ) : (
          <>
            {!brand && !q && <div className="acct-region">Choose a brand to show its range.</div>}
            {loading && !data?.products.length && <div className="acct-region">Loading…</div>}
            {data && (brand || q) && !loading && data.products.length === 0 && <div className="acct-region">Nothing found.</div>}
            {data && data.products.length > 0 && <>
              <div className="acct-region" style={{ margin: '0 0 8px', fontSize: 12.5 }}>{data.products.length === 60 ? 'The first 60. Search to narrow it down.' : `${data.products.length} products`}. Tick Compare on two or three to see them side by side.</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 10, opacity: loading ? 0.6 : 1 }}>{data.products.map(card)}</div>
            </>}
          </>
        )}
      </div>
    </div>, document.body);
}

function BigPic({ p }: { p: Product }) {
  return <div style={{ width: '100%', height: '100%' }}><Thumb src={p.image} name={p.name} size="fill" /></div>;
}
