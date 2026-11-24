import { useState } from 'react';
import { createPortal } from 'react-dom';
import type { Product } from '../lib/tradeshow';

// Product pictures for the trade show order page. A picture loads only when it scrolls into view, and a product with no picture (or one that will not load)
// shows a plain box with its first letters, so a row never jumps or breaks.
export function Thumb({ src, name, size = 44, onOpen }: { src: string | null | undefined; name: string; size?: number | 'fill'; onOpen?: () => void }) {
  const [bad, setBad] = useState(false);
  const px = size === 'fill' ? 48 : size;
  const box = { width: size === 'fill' ? '100%' : size, height: size === 'fill' ? '100%' : size, borderRadius: 6, border: '1px solid var(--line)', background: '#f3f3f1', flex: '0 0 auto', overflow: 'hidden', display: 'grid', placeItems: 'center', padding: 0, cursor: src && !bad && onOpen ? 'zoom-in' : 'default' } as const;
  const inner = src && !bad
    ? <img src={src} alt={name} loading="lazy" decoding="async" onError={() => setBad(true)} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
    : <span aria-hidden="true" style={{ fontSize: px > 40 ? 14 : 11, color: 'var(--muted)' }}>{name.replace(/[^A-Za-z0-9 ]/g, '').split(' ').filter(Boolean).slice(0, 2).map(w => w[0]!.toUpperCase()).join('')}</span>;
  // a span, not a button, because it sits inside rows that are buttons themselves
  return src && !bad && onOpen
    ? <span role="button" tabIndex={0} aria-label={`Show a bigger picture of ${name}`} style={box} onClick={e => { e.stopPropagation(); onOpen(); }} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onOpen(); } }}>{inner}</span>
    : <span style={box}>{inner}</span>;
}

const money = (n: number) => `$${n.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** One product, big, with its price and stock, and a button to add it. */
export function PicLightbox({ p, onClose, onAdd }: { p: Pick<Product, 'sku' | 'name' | 'brand' | 'price' | 'free' | 'image' | 'increment'>; onClose: () => void; onAdd?: () => void }) {
  const [bad, setBad] = useState(false);
  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" role="dialog" aria-label={p.name} onClick={e => e.stopPropagation()} style={{ maxWidth: 720, width: '94vw' }}>
        {p.image && !bad ? <img src={p.image} alt={p.name} onError={() => setBad(true)} style={{ maxWidth: '100%', maxHeight: '65vh', display: 'block', margin: '0 auto', borderRadius: 6 }} /> : <div className="acct-region" style={{ textAlign: 'center', padding: 30 }}>No picture for this product</div>}
        <div style={{ marginTop: 8 }}><b>{p.name}</b><div className="acct-region">{p.sku}{p.brand ? ` · ${p.brand}` : ''}{p.increment && p.increment > 1 ? ` · packs of ${p.increment}` : ''}</div>
          <div style={{ marginTop: 4 }}>{p.price === null ? <span style={{ color: 'var(--rust)' }}>No wholesale price</span> : money(p.price)} · <span style={{ color: p.free > 0 ? 'var(--teal)' : 'var(--rust)' }}>{Math.max(p.free, 0)} free</span></div></div>
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          {onAdd && <button type="button" className="btn" disabled={p.price === null} onClick={() => { onAdd(); onClose(); }}>Add to order</button>}
          <button type="button" className="btn secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>, document.body);
}
