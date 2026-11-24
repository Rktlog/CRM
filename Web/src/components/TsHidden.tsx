import { useEffect, useState } from 'react';
import { apiGet, apiPut } from '../lib/api';
import { errMsg } from '../lib/tradeshow';

// "Hidden from trade shows" (managers): brands and single products that are left out of the trade show product list. They do not show in the order
// search, the Show range, the other-colours list or the assistant's order tool. Orders that already have them are not changed. Discontinued products are
// always left out, so they do not need adding here.
type Hidden = { ready: boolean; brands: string[]; skus: { sku: string; name: string | null; brand: string | null }[]; allBrands: string[] };

export default function TsHidden() {
  const [d, setD] = useState<Hidden | null>(null);
  const [open, setOpen] = useState(false);
  const [brands, setBrands] = useState<Set<string>>(new Set());
  const [skus, setSkus] = useState<string[]>([]);
  const [find, setFind] = useState(''), [sku, setSku] = useState('');
  const [busy, setBusy] = useState(false), [err, setErr] = useState<string | null>(null), [saved, setSaved] = useState(false);
  const load = () => apiGet('/tradeshow/hidden', { fresh: true }).then((x: Hidden) => { setD(x); setBrands(new Set(x.brands)); setSkus(x.skus.map(s => s.sku)); }).catch(() => setD(null));
  useEffect(() => { void load(); }, []);
  if (!d) return null;

  async function save() {
    setBusy(true); setErr(null); setSaved(false);
    try { const x: Hidden = await apiPut('/tradeshow/hidden', { brands: [...brands], skus }); setD(x); setBrands(new Set(x.brands)); setSkus(x.skus.map(s => s.sku)); setSaved(true); }
    catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  }
  const addSku = () => { const v = sku.trim().toUpperCase(); if (v && !skus.some(s => s.toUpperCase() === v)) setSkus(l => [...l, v]); setSku(''); setSaved(false); };
  const names = new Map(d.skus.map(s => [s.sku.toUpperCase(), s]));
  const shown = d.allBrands.filter(b => b.toLowerCase().includes(find.trim().toLowerCase()));
  const count = d.brands.length + d.skus.length;
  return (
    <div className="section" style={{ marginTop: 18 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
        <div className="panel-title" style={{ flex: 1 }}>Hidden from trade shows</div>
        <button type="button" className="link-btn" onClick={() => setOpen(o => !o)}>{open ? 'Close' : count ? `Change (${count} hidden)` : 'Set up'}</button>
      </div>
      <div className="acct-region" style={{ maxWidth: 700 }}>
        Brands and products listed here do not show in the trade show product list, the Show range or the assistant. Orders that already have them are not changed.
        Discontinued products are always left out.
      </div>
      {!d.ready && <div className="acct-region" style={{ marginTop: 6 }}>Not set up in the database yet. Ask whoever looks after Radar to run tradeshow-hidden-products.sql.</div>}
      {d.ready && !open && count > 0 && <div style={{ marginTop: 6, fontSize: 14 }}>{d.brands.length > 0 && <div><b>Brands:</b> {d.brands.join(', ')}</div>}{d.skus.length > 0 && <div><b>Products:</b> {d.skus.map(s => s.sku).join(', ')}</div>}</div>}
      {d.ready && open && (
        <div className="card" style={{ marginTop: 8, maxWidth: 640 }}>
          <b style={{ fontSize: 14 }}>Brands to hide</b>
          <input placeholder="Find a brand" aria-label="Find a brand" value={find} onChange={e => setFind(e.target.value)} style={{ width: '100%', padding: '6px 9px', border: '1px solid var(--line)', borderRadius: 3, font: 'inherit', margin: '6px 0' }} />
          <div style={{ maxHeight: 200, overflowY: 'auto', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 2 }}>
            {shown.map(b => <label key={b} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13.5 }}><input type="checkbox" checked={brands.has(b)} onChange={e => { setSaved(false); setBrands(p => { const n = new Set(p); if (e.target.checked) n.add(b); else n.delete(b); return n; }); }} /> {b}</label>)}
          </div>
          <div style={{ marginTop: 12 }}><b style={{ fontSize: 14 }}>Single products to hide</b></div>
          <div style={{ display: 'flex', gap: 8, margin: '6px 0' }}>
            <input placeholder="Type a SKU" aria-label="SKU to hide" value={sku} onChange={e => setSku(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addSku(); } }} style={{ flex: 1, padding: '6px 9px', border: '1px solid var(--line)', borderRadius: 3, font: 'inherit' }} />
            <button type="button" className="btn secondary" onClick={addSku} disabled={!sku.trim()}>Add</button>
          </div>
          {skus.length === 0 ? <div className="acct-region" style={{ fontSize: 13 }}>No single products hidden.</div> : (
            <div style={{ display: 'grid', gap: 2 }}>{skus.map(s => { const n = names.get(s.toUpperCase()); return (
              <div key={s} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13.5 }}><span style={{ flex: 1 }}><b>{s}</b>{n?.name ? ` · ${n.name}` : ''}</span><button type="button" className="link-btn" onClick={() => { setSkus(l => l.filter(x => x !== s)); setSaved(false); }}>Remove</button></div>); })}</div>
          )}
          {err && <div className="save-msg err" role="alert" style={{ marginTop: 8 }}>{err}</div>}
          {saved && <div className="save-msg" role="status" style={{ marginTop: 8 }}>Saved. It applies within about 30 seconds.</div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button type="button" className="btn" disabled={busy} onClick={save}>{busy ? 'Saving…' : `Save (${brands.size} brands, ${skus.length} products)`}</button>
            <button type="button" className="btn secondary" disabled={busy} onClick={() => { setOpen(false); void load(); }}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
