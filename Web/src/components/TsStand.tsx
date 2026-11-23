import { useEffect, useState } from 'react';
import { apiGet, apiPut } from '../lib/api';
import { errMsg, type Stand } from '../lib/tradeshow';

// The range on the stand: the brands that are physically at this show. Reps see which products the customer can touch ("On the stand" in the product
// search, and in the other-colours suggestions); a manager ticks the brands. Everything can still be ordered, whether it is on the stand or not.
export default function TsStand({ showId, isManager }: { showId: string; isManager: boolean }) {
  const [d, setD] = useState<Stand | null>(null);
  const [edit, setEdit] = useState(false), [pick, setPick] = useState<Set<string>>(new Set()), [find, setFind] = useState('');
  const [busy, setBusy] = useState(false), [err, setErr] = useState<string | null>(null);
  useEffect(() => { apiGet(`/tradeshow/shows/${showId}/stand`, { fresh: true }).then(setD).catch(() => setD(null)); }, [showId]);
  if (!d || !d.ready) return null;   // until the set-up step is run, nothing about the stand is shown
  async function save() {
    setBusy(true); setErr(null);
    try { setD(await apiPut(`/tradeshow/shows/${showId}/stand`, { brands: [...pick] })); setEdit(false); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  }
  const shown = d.allBrands.filter(b => b.toLowerCase().includes(find.trim().toLowerCase()));
  return (
    <div style={{ margin: '0 0 14px', fontSize: 14 }}>
      <b>Range on the stand:</b>{' '}
      {d.brands.length ? d.brands.join(', ') : <span className="acct-region">not set yet</span>}
      {isManager && !edit && <> · <button type="button" className="link-btn" onClick={() => { setPick(new Set(d.brands)); setFind(''); setEdit(true); }}>{d.brands.length ? 'Change' : 'Set it'}</button></>}
      {edit && (
        <div className="card" style={{ marginTop: 8, maxWidth: 560 }}>
          <input placeholder="Find a brand" value={find} onChange={e => setFind(e.target.value)} style={{ width: '100%', padding: '6px 9px', border: '1px solid var(--line)', borderRadius: 3, font: 'inherit', marginBottom: 8 }} />
          <div style={{ maxHeight: 220, overflowY: 'auto', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 2 }}>
            {shown.map(b => <label key={b} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13.5 }}><input type="checkbox" checked={pick.has(b)} onChange={e => setPick(p => { const n = new Set(p); if (e.target.checked) n.add(b); else n.delete(b); return n; })} /> {b}</label>)}
          </div>
          {err && <div className="save-msg err" role="alert">{err}</div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button type="button" className="btn" disabled={busy} onClick={save}>{busy ? 'Saving…' : `Save (${pick.size} brands)`}</button>
            <button type="button" className="btn secondary" disabled={busy} onClick={() => setEdit(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
