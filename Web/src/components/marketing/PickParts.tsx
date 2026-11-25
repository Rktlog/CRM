import { useEffect, useRef, useState } from 'react';
import { apiGet, apiPost, apiPostFile } from '../../lib/api';

// Two helpers for the Email Builder: pick products by name, and upload a picture from the computer.

export type Pick = { sku: string; name: string; brand: string | null; imageUrl: string | null; wholesale: number | null; retail: number | null };
const money = (n: number | null) => (n == null ? 'no price' : '$' + n.toFixed(2));

/** Search by name, product code or brand, click to add. Chips show the names; the block still keeps product codes. */
export function ProductPicker({ skus, onChange }: { skus: string[]; onChange: (skus: string[]) => void }) {
  const [q, setQ] = useState(''); const [hits, setHits] = useState<Pick[] | null>(null); const [err, setErr] = useState<string | null>(null);
  const [known, setKnown] = useState<Record<string, Pick>>({});
  const key = skus.join('|');
  // names for the codes already in the block
  useEffect(() => {
    const need = skus.filter(s => !known[s]); if (!need.length) return;
    let live = true;
    apiPost('/marketing/products/lookup', { skus: need }).then((r: { products: Pick[] }) => { if (live) setKnown(k => ({ ...k, ...Object.fromEntries(r.products.map(p => [p.sku, p])) })); }).catch(() => undefined);
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  // search as they type, after a short pause
  useEffect(() => {
    const term = q.trim();
    if (term.replace(/\s/g, '').length < 2) { setHits(null); setErr(null); return; }
    let live = true;
    const t = setTimeout(() => {
      apiGet(`/marketing/products/search?q=${encodeURIComponent(term)}`, { fresh: true })
        .then((r: { products: Pick[] }) => { if (live) { setHits(r.products); setErr(null); setKnown(k => ({ ...k, ...Object.fromEntries(r.products.map(p => [p.sku, p])) })); } })
        .catch(e => { if (live) setErr(e instanceof Error ? e.message : 'The search did not work.'); });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [q]);
  const add = (p: Pick) => { if (!skus.includes(p.sku)) onChange([...skus, p.sku]); };
  return (
    <div className="eb-pick">
      {skus.length > 0 && (
        <div className="eb-picked">
          {skus.map(s => (
            <span key={s} className="eb-pill" data-sku={s}>
              {known[s]?.imageUrl && <img src={known[s]!.imageUrl!} alt="" />}
              <span>{known[s]?.name ?? s}<small>{s}</small></span>
              <button type="button" aria-label={`Remove ${known[s]?.name ?? s}`} onClick={() => onChange(skus.filter(x => x !== s))}>×</button>
            </span>
          ))}
        </div>
      )}
      <input className="eb-input" aria-label="Search products" value={q} onChange={e => setQ(e.target.value)} placeholder="Search products by name, brand or code" />
      {err && <div className="acct-region" role="alert" style={{ color: 'var(--rust)' }}>{err}</div>}
      {hits && hits.length === 0 && !err && <div className="acct-region">No products match that.</div>}
      {hits && hits.length > 0 && (
        <ul className="eb-hits" aria-label="Matching products">
          {hits.map(p => {
            const on = skus.includes(p.sku);
            return (
              <li key={p.sku}>
                <button type="button" disabled={on} onClick={() => add(p)}>
                  {p.imageUrl ? <img src={p.imageUrl} alt="" /> : <span className="eb-noimg" />}
                  <span className="eb-hit-text"><b>{p.name}</b><small>{p.sku}{p.brand ? ` · ${p.brand}` : ''} · Wholesale {money(p.wholesale)} · Retail {money(p.retail)} ex GST</small></span>
                  <span className="eb-hit-add">{on ? 'Added' : 'Add'}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

const MAX_SIDE = 1200;
/** Shrinks a picture to at most 1200 wide before it goes up (an email shows it about 550 wide), so a phone photo does not become a 6 MB email. */
async function shrink(file: File): Promise<Blob> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('Use a JPG, PNG or WebP picture.');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error('That picture could not be read.')); i.src = url; });
    const k = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * k)), h = Math.max(1, Math.round(img.naturalHeight * k));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d'); if (!g) throw new Error('This browser cannot resize pictures.');
    const png = file.type === 'image/png';
    if (!png) { g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h); }
    g.drawImage(img, 0, 0, w, h);
    const out = (type: string, q?: number) => new Promise<Blob | null>(ok => c.toBlob(ok, type, q));
    let b = png ? await out('image/png') : await out('image/jpeg', 0.86);
    if (b && b.size > 2_000_000) b = await out('image/jpeg', 0.8);   // a big PNG becomes a JPG
    if (!b) throw new Error('That picture could not be prepared.');
    if (b.size > 2_400_000) throw new Error('That picture is still too big after shrinking. Try a smaller one.');
    return b;
  } finally { URL.revokeObjectURL(url); }
}

export function PictureUpload({ onUploaded }: { onUploaded: (url: string) => void }) {
  const ref = useRef<HTMLInputElement>(null); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  async function pick(f: File | undefined) {
    if (!f) return; setErr(null); setBusy(true);
    try { const blob = await shrink(f); const r = await apiPostFile(`/marketing/images?name=${encodeURIComponent(f.name)}`, blob); onUploaded(r.url); }
    catch (e) { setErr(e instanceof Error ? e.message : 'The upload did not work.'); }
    finally { setBusy(false); if (ref.current) ref.current.value = ''; }
  }
  return (
    <div className="eb-upload">
      <input ref={ref} type="file" accept="image/jpeg,image/png,image/webp" hidden aria-label="Upload a picture" onChange={e => pick(e.target.files?.[0])} />
      <button type="button" className="btn" disabled={busy} onClick={() => ref.current?.click()}>{busy ? 'Uploading...' : 'Upload from your computer'}</button>
      {err && <span className="acct-region" role="alert" style={{ color: 'var(--rust)' }}>{err}</span>}
    </div>
  );
}
