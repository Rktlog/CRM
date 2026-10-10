import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { directImageUrl } from '../lib/productImage';

// A product photo from the team's sheet. Small on the page, loaded only when it
// scrolls into view, straight from where it is stored (nothing passes through our
// servers). Click it to see it large. No link, or a link that doesn't load, shows a
// plain grey box.

type Props = {
  url: string | null | undefined;
  name: string;
  sku?: string;
  size?: number | 'fill'; // a square of this many pixels, or 'fill' to fill its container as a square
  enlarge?: boolean;      // click to see it large (default yes)
  fit?: 'contain' | 'cover';
};

export default function ProductPhoto({ url, name, sku, size = 44, enlarge = true, fit = 'contain' }: Props) {
  const src = directImageUrl(url);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => setFailed(false), [src]);

  const shown = !!src && !failed;
  const fill = size === 'fill';
  const px = fill ? 160 : size;
  const box: React.CSSProperties = {
    ...(fill ? { width: '100%', aspectRatio: '1 / 1' } : { width: size, height: size }),
    flexShrink: 0, borderRadius: 6, overflow: 'hidden', padding: 0,
    background: 'var(--paper, #f3f4ef)', border: '1px solid var(--line, #dfe2d8)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  };

  if (!shown) {
    return (
      <div style={{ ...box, color: 'var(--muted, #8a8f85)' }} aria-hidden="true" title="No photo">
        <svg width={Math.max(14, px * 0.38)} height={Math.max(14, px * 0.38)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="M21 16l-5-5-8 8" />
        </svg>
      </div>
    );
  }

  const img = (
    <img
      src={src!} alt={name} {...(fill ? {} : { width: px, height: px })} loading="lazy" decoding="async" referrerPolicy="no-referrer"
      style={{ width: '100%', height: '100%', objectFit: fit, display: 'block' }}
      onError={() => setFailed(true)}
    />
  );

  if (!enlarge) return <div style={box}>{img}</div>;
  return (
    <>
      <button
        type="button" aria-label={`Enlarge photo of ${name}`} title="Click to enlarge"
        style={{ ...box, cursor: 'zoom-in', font: 'inherit' }}
        onClick={e => { e.stopPropagation(); setOpen(true); }}
      >
        {img}
      </button>
      {open && <Viewer src={src!} original={url!} name={name} sku={sku} onClose={() => setOpen(false)} />}
    </>
  );
}

function Viewer({ src, original, name, sku, onClose }: { src: string; original: string; name: string; sku?: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Drawn on the page itself, not inside the row that was clicked.
  return createPortal(
    <div
      role="dialog" aria-modal="true" aria-label={name}
      onClick={e => { e.stopPropagation(); onClose(); }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(15,20,25,0.78)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ background: 'var(--panel, #fff)', borderRadius: 10, padding: 14, maxWidth: 'min(94vw, 880px)', boxShadow: '0 12px 40px rgba(0,0,0,.35)' }}
      >
        <img src={src} alt={name} referrerPolicy="no-referrer" style={{ display: 'block', maxWidth: '100%', maxHeight: '70vh', margin: '0 auto', objectFit: 'contain' }} />
        <div style={{ marginTop: 10, display: 'flex', gap: 12, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontWeight: 600 }}>{name}</div>
            {sku && <div style={{ fontSize: 12, color: 'var(--muted, #8a8f85)' }}>{sku}</div>}
          </div>
          <a href={original} target="_blank" rel="noopener noreferrer" style={{ marginLeft: 'auto', fontSize: 13 }}>Open original</a>
          <button type="button" className="btn secondary" style={{ padding: '5px 14px' }} onClick={onClose}>Close</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}