import { useState } from 'react';
import { $, shortDay } from '../lib/tradeshow';
import { REGION_TYPES, type Applied, type FreightCfg, type Offer, type Prompt } from '../lib/tsOffers';
import { sel } from '../lib/tsExtra';

// On the order page: the show's offers while the order is written (what applied, what is close, bundles to add), and the freight set-up.

/** What is on at this show, what has applied to this order, and how far the order is from a bonus pack. Bundles are added as packs. */
export function OffersPanel({ offers, applied, prompts, payBy, payByOverdue, canEdit, onAddBundle }: {
  offers: Offer[]; applied: Applied[]; prompts: Prompt[]; payBy: string | null; payByOverdue: boolean; canEdit: boolean; onAddBundle: (o: Offer, packs: number) => void;
}) {
  const [packs, setPacks] = useState<Record<string, string>>({});
  const bundles = offers.filter(o => o.kind === 'bundle');
  if (!offers.length) return null;
  return (
    <div className="card" style={{ maxWidth: 760, marginBottom: 14 }}>
      <div className="panel-title">Offers at this show</div>
      {applied.length > 0 && <div style={{ marginBottom: 8 }}>{applied.map(a => <div key={a.offerId} style={{ fontSize: 14 }}><span className="pill teal">Applied</span> {a.text}</div>)}</div>}
      {prompts.map(p => <div key={p.offerId} style={{ fontSize: 14, color: 'var(--amber)', marginBottom: 4 }}>{p.text}</div>)}
      {payBy && <div style={{ fontSize: 13.5, marginBottom: 8, color: payByOverdue ? 'var(--rust)' : undefined }}>{payByOverdue ? 'The pay-by date has passed: ' : ''}These offers only hold if the order is paid by {shortDay(payBy)}.</div>}
      {canEdit && bundles.length > 0 && (
        <div style={{ display: 'grid', gap: 6 }}>
          {bundles.map(b => (
            <div key={b.id} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 14 }}>
              <span style={{ flex: 1, minWidth: 220 }}><b>{b.name}</b> <span className="acct-region">{$(b.bundlePrice)} a pack: {b.items.map(i => `${i.qty} x ${i.name ?? i.sku}`).join(', ')}</span></span>
              <input inputMode="numeric" aria-label={`Packs of ${b.name}`} style={{ ...sel, width: 60, padding: '4px 6px' }} value={packs[b.id] ?? '1'} onChange={e => setPacks({ ...packs, [b.id]: e.target.value })} />
              <button type="button" className="btn secondary" onClick={() => onAddBundle(b, Math.max(1, Math.floor(Number(packs[b.id] ?? 1)) || 1))}>Add pack</button>
            </div>
          ))}
        </div>
      )}
      {offers.filter(o => o.kind !== 'bundle').length > 0 && (
        <details style={{ marginTop: 8 }}><summary className="acct-region" style={{ cursor: 'pointer', fontSize: 13 }}>All offers at this show</summary>
          {offers.filter(o => o.kind !== 'bundle').map(o => <div key={o.id} style={{ fontSize: 13.5, padding: '2px 0' }}><b>{o.name}</b> <span className="acct-region">{o.kind === 'pct' ? `${o.pct}% off ${[...o.brands, ...(o.skus.length > 3 ? [`${o.skus.length} SKUs`] : o.skus)].join(', ')}` : `spend ${$(o.threshold)}${o.brands.length ? ` on ${o.brands.join(', ')}` : ''}, get ${o.items.map(i => `${i.qty} x ${i.name ?? i.sku}`).join(', ')} free`}</span></div>)}
        </details>
      )}
    </div>
  );
}

/** Freight: worked out from the state and the order (the team's calculator), or Australia Post for New Zealand. Change it by hand, or work it out again. */
export function FreightPanel({ state, regionType, largeItems, pantone, manual, note, cfg, canEdit, onChange, onReset, onQuoteNz }: {
  state: string | null; regionType: string; largeItems: boolean; pantone: boolean; manual: boolean; note: string | null; cfg: FreightCfg; canEdit: boolean;
  onChange: (p: { regionType?: string; largeItems?: boolean; pantone?: boolean }) => void; onReset: () => void; onQuoteNz: () => void;
}) {
  const nz = String(state ?? '').toUpperCase() === 'NZ', overseas = nz || String(state ?? '').toUpperCase() === 'INTL';
  void cfg;
  return (
    <div style={{ fontSize: 13.5, display: 'grid', gap: 6 }}>
      {!overseas && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <select style={{ ...sel, fontSize: 13, padding: '3px 6px' }} value={regionType} disabled={!canEdit} onChange={e => onChange({ regionType: e.target.value })} aria-label="Metro, regional or rural">{REGION_TYPES.map(r => <option key={r}>{r}</option>)}</select>
          <label style={{ display: 'flex', gap: 5, alignItems: 'center' }}><input type="checkbox" checked={largeItems} disabled={!canEdit} onChange={e => onChange({ largeItems: e.target.checked })} /> Large items</label>
          <label style={{ display: 'flex', gap: 5, alignItems: 'center' }}><input type="checkbox" checked={pantone} disabled={!canEdit} onChange={e => onChange({ pantone: e.target.checked })} /> Pantone Living</label>
        </div>
      )}
      {note && <div className="acct-region" style={{ fontSize: 12.5 }}>{manual ? 'Typed in by hand.' : note}</div>}
      <div style={{ display: 'flex', gap: 10 }}>
        {canEdit && manual && !nz && <button type="button" className="link-btn" onClick={onReset}>Work it out again</button>}
        {canEdit && nz && <button type="button" className="link-btn" onClick={onQuoteNz}>{manual ? 'Get the Australia Post price again' : 'Get the Australia Post price'}</button>}
      </div>
    </div>
  );
}
