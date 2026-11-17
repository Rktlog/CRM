import { useState, type CSSProperties } from 'react';
import { apiPatch, apiPost } from '../lib/api';
import { errMsg, type Show } from '../lib/tradeshow';

// Setting up a show (managers): name, the short name used in order references, dates, place, target, costs and the card surcharge.
const field: CSSProperties = { width: '100%', padding: '6px 9px', border: '1px solid var(--line)', borderRadius: 3, font: 'inherit', fontSize: 14 };
const label: CSSProperties = { display: 'grid', gap: 4, fontSize: 13 };
const s = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(v));

export default function TsShowForm({ show, onSaved, onCancel }: { show?: Show; onSaved: (id: string) => void; onCancel: () => void }) {
  const [f, setF] = useState({ name: show?.name ?? '', refName: show?.refName ?? '', startsOn: show?.startsOn ?? '', endsOn: show?.endsOn ?? '', venue: show?.venue ?? '', stand: show?.stand ?? '', staff: show?.staff ?? '', notes: show?.notes ?? '',
    target: s(show?.target), stand$: s(show?.costs.stand), travel: s(show?.costs.travel), samples: s(show?.costs.samples), other: s(show?.costs.other), card: s(show?.cardSurchargePct), archived: show?.archived ?? false });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  async function save() {
    setBusy(true); setErr(null);
    const body = { name: f.name, refName: f.refName, startsOn: f.startsOn, endsOn: f.endsOn || f.startsOn, venue: f.venue, stand: f.stand, staff: f.staff, notes: f.notes, target: f.target,
      costs: { stand: f.stand$, travel: f.travel, samples: f.samples, other: f.other }, cardSurchargePct: f.card, archived: f.archived };
    try { const r: { id: string } = show ? await apiPatch(`/tradeshow/shows/${show.id}`, body) : await apiPost('/tradeshow/shows', body); onSaved(r.id); }
    catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  }
  return (
    <div className="card" style={{ maxWidth: 760 }}>
      <div className="panel-title">{show ? 'Edit the show' : 'New show'}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
        <label style={{ ...label, gridColumn: '1 / -1' }}>Show name<input style={field} value={f.name} onChange={set('name')} placeholder="Reed Gift Fair Melbourne Feb 2026" /></label>
        <label style={label}>Short name for order references<input style={field} value={f.refName} onChange={set('refName')} placeholder="REED MEL FEB26" /></label>
        <label style={label}>First day<input type="date" style={field} value={f.startsOn} onChange={set('startsOn')} /></label>
        <label style={label}>Last day<input type="date" style={field} value={f.endsOn} onChange={set('endsOn')} /></label>
        <label style={label}>Venue<input style={field} value={f.venue} onChange={set('venue')} /></label>
        <label style={label}>Stand<input style={field} value={f.stand} onChange={set('stand')} /></label>
        <label style={label}>Who is working it<input style={field} value={f.staff} onChange={set('staff')} /></label>
        <label style={label}>Sales target (ex GST)<input inputMode="decimal" style={field} value={f.target} onChange={set('target')} /></label>
        <label style={label}>Card surcharge %<input inputMode="decimal" style={field} value={f.card} onChange={set('card')} placeholder="e.g. 1.5" /></label>
        <label style={label}>Stand cost<input inputMode="decimal" style={field} value={f.stand$} onChange={set('stand$')} /></label>
        <label style={label}>Travel cost<input inputMode="decimal" style={field} value={f.travel} onChange={set('travel')} /></label>
        <label style={label}>Samples cost<input inputMode="decimal" style={field} value={f.samples} onChange={set('samples')} /></label>
        <label style={label}>Other costs<input inputMode="decimal" style={field} value={f.other} onChange={set('other')} /></label>
        <label style={{ ...label, gridColumn: '1 / -1' }}>Notes<textarea style={{ ...field, minHeight: 50 }} value={f.notes} onChange={set('notes')} /></label>
        {show && <label style={{ fontSize: 13, display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={f.archived} onChange={e => setF({ ...f, archived: e.target.checked })} /> Closed (no new orders)</label>}
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 12 }}><button type="button" className="btn" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button><button type="button" className="link-btn" onClick={onCancel}>Cancel</button></div>
      {err && <div className="save-msg err" role="alert">{err}</div>}
    </div>
  );
}
