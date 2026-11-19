import { useCallback, useEffect, useState } from 'react';
import { apiDelete, apiGet, apiPatch, apiPost } from '../lib/api';
import { $, errMsg, shortDay, type Show } from '../lib/tradeshow';
import type { Offer } from '../lib/tsOffers';
import { csvList, sel, td, th, tableBox } from '../lib/tsExtra';
import TsImport from './TsImport';
import TsFreightRates from './TsFreightRates';

// A show's offers: percent off (end of life and other discounts), bundles, and bonus packs. They are applied while orders are taken. Managers set them up;
// everyone can see what is on, so the stand knows the deals. The Excel reader loads them from the team's workbook.
type Draft = { id?: string; kind: Offer['kind']; name: string; pct: string; brands: string; skus: string; threshold: string; repeat: boolean; items: { sku: string; qty: string }[]; bundlePrice: string; payBy: string; notes: string; active: boolean };
const blank = (kind: Offer['kind']): Draft => ({ kind, name: '', pct: '', brands: '', skus: '', threshold: '', repeat: false, items: [{ sku: '', qty: '1' }], bundlePrice: '', payBy: '', notes: '', active: true });
const draftOf = (o: Offer): Draft => ({ id: o.id, kind: o.kind, name: o.name, pct: o.pct ? String(o.pct) : '', brands: o.brands.join(', '), skus: o.skus.join(', '), threshold: o.threshold ? String(o.threshold) : '', repeat: o.repeat,
  items: o.items.length ? o.items.map(i => ({ sku: i.sku, qty: String(i.qty) })) : [{ sku: '', qty: '1' }], bundlePrice: o.bundlePrice ? String(o.bundlePrice) : '', payBy: o.payBy ?? '', notes: o.notes ?? '', active: o.active });
const KIND: Record<Offer['kind'], string> = { pct: 'Percent off', bundle: 'Bundle', bonus: 'Bonus pack' };
const describe = (o: Offer) => o.kind === 'pct' ? `${o.pct}% off ${[...o.brands, ...(o.skus.length > 4 ? [`${o.skus.length} SKUs`] : o.skus)].join(', ')}`
  : o.kind === 'bundle' ? `${$(o.bundlePrice)} per pack: ${o.items.map(i => `${i.qty} x ${i.name ?? i.sku}`).join(', ')}`
  : `Spend ${$(o.threshold)}${o.brands.length || o.skus.length ? ` on ${[...o.brands, ...o.skus].join(', ')}` : ''}${o.repeat ? ' (again for each multiple)' : ''}, get ${o.items.map(i => `${i.qty} x ${i.name ?? i.sku}`).join(', ')} free`;

export default function TsOffers({ showId, isManager }: { showId: string; isManager: boolean }) {
  const [offers, setOffers] = useState<Offer[] | null>(null);
  const [d, setD] = useState<Draft | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shows, setShows] = useState<Show[]>([]);
  const [from, setFrom] = useState('');
  const load = useCallback(() => { apiGet(`/tradeshow/shows/${showId}/offers`, { fresh: true }).then((x: { offers: Offer[] }) => { setOffers(x.offers); setErr(null); }).catch(e => setErr(errMsg(e))); }, [showId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (isManager) apiGet('/tradeshow/shows').then((x: { shows: Show[] }) => setShows(x.shows.filter(s => s.id !== showId))).catch(() => {}); }, [isManager, showId]);

  async function save() {
    if (!d || busy) return;
    setBusy(true); setErr(null); setMsg(null);
    try {
      const body = { kind: d.kind, name: d.name, pct: d.pct, brands: csvList(d.brands), skus: csvList(d.skus), threshold: d.threshold, repeat: d.repeat, bundlePrice: d.bundlePrice, payBy: d.payBy || null, notes: d.notes, active: d.active,
        items: d.items.filter(i => i.sku.trim()).map(i => ({ sku: i.sku.trim(), qty: Number(i.qty) })) };
      if (d.id) await apiPatch(`/tradeshow/shows/${showId}/offers/${d.id}`, body); else await apiPost(`/tradeshow/shows/${showId}/offers`, body);
      setD(null); load();
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  }
  async function remove(o: Offer) { if (!window.confirm(`Delete "${o.name}"? Orders already written keep the price they have until they are saved again.`)) return; try { await apiDelete(`/tradeshow/shows/${showId}/offers/${o.id}`); load(); } catch (e) { setErr(errMsg(e)); } }
  async function toggle(o: Offer) { try { await apiPatch(`/tradeshow/shows/${showId}/offers/${o.id}`, { ...o, active: !o.active, items: o.items.map(i => ({ sku: i.sku, qty: i.qty })) }); load(); } catch (e) { setErr(errMsg(e)); } }
  async function copy() { if (!from) return; try { const r = await apiPost(`/tradeshow/shows/${showId}/offers/copy`, { fromShowId: from }); setMsg(`Copied ${r.copied} ${r.copied === 1 ? 'offer' : 'offers'}. Check the pay-by dates.`); setFrom(''); load(); } catch (e) { setErr(errMsg(e)); } }
  const up = (p: Partial<Draft>) => setD(x => (x ? { ...x, ...p } : x));

  return (
    <>
      <div className="acct-region" style={{ marginBottom: 12, maxWidth: 760 }}>Offers apply while an order is written: percent off a brand or SKUs, bundles added as packs, and free bonus products once the spend is reached. A pay-by date shows on the order and in the email to sales.</div>
      {err && <div className="save-msg err" role="alert">{err}</div>}
      {msg && <div className="save-msg ok" role="status">{msg}</div>}
      {isManager && !d && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14, alignItems: 'center' }}>
          {(['pct', 'bundle', 'bonus'] as const).map(k => <button key={k} type="button" className="btn secondary" onClick={() => { setD(blank(k)); setErr(null); }}>New {KIND[k].toLowerCase()}</button>)}
          {shows.length > 0 && <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}><select style={sel} value={from} onChange={e => setFrom(e.target.value)}><option value="">Copy offers from…</option>{shows.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select>{from && <button type="button" className="btn secondary" onClick={copy}>Copy</button>}</span>}
        </div>
      )}
      {d && (
        <div className="card" style={{ maxWidth: 760 }}>
          <div className="panel-title">{d.id ? 'Edit' : 'New'} {KIND[d.kind].toLowerCase()}</div>
          <div style={{ display: 'grid', gap: 10 }}>
            <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>Name (shown on the order and in the email)<input style={sel} value={d.name} onChange={e => up({ name: e.target.value })} placeholder={d.kind === 'pct' ? 'EOL Miffy 30%' : d.kind === 'bundle' ? 'Miffy Round Stand Bundle' : 'Miffy Bonus Pack'} /></label>
            {d.kind === 'pct' && <>
              <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>% off<input inputMode="decimal" style={{ ...sel, width: 110 }} value={d.pct} onChange={e => up({ pct: e.target.value })} /></label>
              <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>Brands (separate with commas)<input style={sel} value={d.brands} onChange={e => up({ brands: e.target.value })} placeholder="Miffy Plush, Mr Maria" /></label>
              <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>SKUs (separate with commas or new lines)<textarea style={{ ...sel, minHeight: 70 }} value={d.skus} onChange={e => up({ skus: e.target.value })} /></label>
            </>}
            {d.kind === 'bonus' && <>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'end' }}>
                <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>Spend (ex GST) that earns it<input inputMode="decimal" style={{ ...sel, width: 140 }} value={d.threshold} onChange={e => up({ threshold: e.target.value })} /></label>
                <label style={{ fontSize: 14, display: 'flex', gap: 6, alignItems: 'center', paddingBottom: 8 }}><input type="checkbox" checked={d.repeat} onChange={e => up({ repeat: e.target.checked })} /> Again for every multiple</label>
              </div>
              <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>Only spend on these brands (blank = the whole order)<input style={sel} value={d.brands} onChange={e => up({ brands: e.target.value })} placeholder="Miffy Plush" /></label>
              <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>or only on these SKUs<input style={sel} value={d.skus} onChange={e => up({ skus: e.target.value })} /></label>
            </>}
            {d.kind === 'bundle' && <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>Price per pack (ex GST)<input inputMode="decimal" style={{ ...sel, width: 140 }} value={d.bundlePrice} onChange={e => up({ bundlePrice: e.target.value })} /></label>}
            {d.kind !== 'pct' && (
              <div>
                <div style={{ fontSize: 13, marginBottom: 4 }}>{d.kind === 'bundle' ? 'Products in one pack' : 'Free products'}</div>
                {d.items.map((it, i) => (
                  <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
                    <input style={{ ...sel, flex: 1 }} placeholder="SKU" value={it.sku} onChange={e => up({ items: d.items.map((x, j) => (j === i ? { ...x, sku: e.target.value } : x)) })} />
                    <input inputMode="numeric" style={{ ...sel, width: 70 }} value={it.qty} onChange={e => up({ items: d.items.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)) })} />
                    {d.items.length > 1 && <button type="button" className="link-btn" onClick={() => up({ items: d.items.filter((_, j) => j !== i) })}>Remove</button>}
                  </div>
                ))}
                <button type="button" className="link-btn" onClick={() => up({ items: [...d.items, { sku: '', qty: '1' }] })}>Add a product</button>
              </div>
            )}
            <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>Only if paid by (optional)<input type="date" style={{ ...sel, width: 170 }} value={d.payBy} onChange={e => up({ payBy: e.target.value })} /></label>
            <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>Notes (optional)<input style={sel} value={d.notes} onChange={e => up({ notes: e.target.value })} /></label>
            <div style={{ display: 'flex', gap: 10 }}><button type="button" className="btn" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button><button type="button" className="btn secondary" onClick={() => { setD(null); setErr(null); }}>Cancel</button></div>
          </div>
        </div>
      )}
      {offers === null && !err && <div className="acct-region">Loading…</div>}
      {offers && !offers.length && !d && <div className="empty-state">No offers yet.{isManager ? ' Add one, or load them from the workbook below.' : ''}</div>}
      {offers && offers.length > 0 && (
        <div style={tableBox}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={th}>Offer</th><th style={th}>What it does</th><th style={th}>Pay by</th>{isManager && <th style={th} />}</tr></thead>
            <tbody>{offers.map(o => (
              <tr key={o.id} style={{ opacity: o.active ? 1 : 0.55 }}>
                <td style={td}><b>{o.name}</b><div className="acct-region" style={{ fontSize: 12.5 }}>{KIND[o.kind]}{o.active ? '' : ' · switched off'}</div></td>
                <td style={td}>{describe(o)}{o.notes && <div className="acct-region" style={{ fontSize: 12.5 }}>{o.notes}</div>}</td>
                <td style={{ ...td, whiteSpace: 'nowrap' }}>{o.payBy ? shortDay(o.payBy) : ''}</td>
                {isManager && <td style={{ ...td, whiteSpace: 'nowrap' }}><button type="button" className="link-btn" onClick={() => { setD(draftOf(o)); setErr(null); }}>Edit</button> · <button type="button" className="link-btn" onClick={() => toggle(o)}>{o.active ? 'Switch off' : 'Switch on'}</button> · <button type="button" className="link-btn" style={{ color: 'var(--rust)' }} onClick={() => remove(o)}>Delete</button></td>}
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {isManager && <TsImport showId={showId} onSaved={load} />}
      <TsFreightRates isManager={isManager} />
    </>
  );
}
