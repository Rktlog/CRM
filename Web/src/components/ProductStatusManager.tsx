import { useEffect, useState } from 'react';
import { apiDelete, apiGet, apiPatch, apiPost } from '../lib/api';
import { setStatuses, type StatusInfo } from '../lib/productStatus';

// Managers: add, edit and remove the statuses a product can have. EOL and Discontinued stay, because the automatic EOL rule uses them.
// Removing one that products have asks first, and says how many: they can have their status cleared, or be moved to another status.
const COLOURS = [{ key: 'neutral', label: 'Grey' }, { key: 'teal', label: 'Green' }, { key: 'amber', label: 'Amber' }, { key: 'rust', label: 'Red' }];

export default function ProductStatusManager({ onClose, onChanged }: { onClose: () => void; onChanged?: () => void }) {
  const [list, setList] = useState<StatusInfo[] | null>(null);
  const [ready, setReady] = useState(true);
  const [label, setLabel] = useState('');
  const [meaning, setMeaning] = useState('');
  const [tone, setTone] = useState('neutral');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirm, setConfirm] = useState<StatusInfo | null>(null);
  const [mode, setMode] = useState<'clear' | 'move'>('clear');   // what to do with the products that have the status being removed
  const [target, setTarget] = useState('');                      // the status to move them to
  const [editing, setEditing] = useState<StatusInfo | null>(null);   // the status being edited: its name, description and colour (never its key)
  const [eLabel, setELabel] = useState('');
  const [eMeaning, setEMeaning] = useState('');
  const [eTone, setETone] = useState('neutral');

  useEffect(() => {
    apiGet('/products/statuses', { fresh: true })
      .then(d => { setList(d.statuses); setReady(d.tableReady !== false); })
      .catch((e: any) => setMsg({ ok: false, text: e.message }));
  }, []);

  const apply = (d: any) => { setList(d.statuses); setStatuses(d.statuses); onChanged?.(); };

  async function add() {
    if (!label.trim() || busy) return;
    setBusy(true); setMsg(null);
    try {
      const d = await apiPost('/products/statuses', { label: label.trim(), ...(meaning.trim() ? { meaning: meaning.trim() } : {}), tone });
      apply(d);
      setMsg({ ok: true, text: `Added "${d.statuses.find((s: StatusInfo) => s.key === d.added)?.label ?? label.trim()}".` });
      setLabel(''); setMeaning(''); setTone('neutral');
    } catch (e: any) { setMsg({ ok: false, text: e.message }); }
    finally { setBusy(false); }
  }

  function startEdit(s: StatusInfo) {
    setEditing(s); setConfirm(null); setMsg(null);
    setELabel(s.label); setEMeaning(s.meaning ?? ''); setETone(s.tone);
  }

  async function saveEdit() {
    if (!editing || !eLabel.trim() || busy) return;
    setBusy(true); setMsg(null);
    try {
      const d = await apiPatch(`/products/statuses/${encodeURIComponent(editing.key)}`, { label: eLabel.trim(), meaning: eMeaning.trim(), tone: eTone });
      apply(d);
      setMsg({ ok: true, text: d.changed === false ? 'Nothing was changed.' : `Saved "${(d.statuses as StatusInfo[]).find(x => x.key === d.updated)?.label ?? eLabel.trim()}".` });
      setEditing(null);
    } catch (e: any) { setMsg({ ok: false, text: e.message }); }
    finally { setBusy(false); }
  }

  async function remove(s: StatusInfo, confirmed = false) {
    if (s.count > 0 && !confirmed) {
      setConfirm(s); setMsg(null); setMode('clear'); setEditing(null);
      const others = (list ?? []).filter(x => x.key !== s.key);
      setTarget((others.find(x => !x.system) ?? others[0])?.key ?? '');
      return;
    }
    setBusy(true); setMsg(null); setConfirm(null);
    try {
      const moving = s.count > 0 && mode === 'move' && !!target;
      const d = await apiDelete(`/products/statuses/${encodeURIComponent(s.key)}${s.count > 0 ? (moving ? `?moveTo=${encodeURIComponent(target)}` : '?clear=1') : ''}`);
      apply(d);
      const to = (d.statuses as StatusInfo[]).find(x => x.key === d.movedTo)?.label;
      setMsg({ ok: true, text: `Removed "${s.label}"${d.moved ? `, and moved its ${d.moved} product${d.moved === 1 ? '' : 's'} to "${to ?? target}"` : d.cleared ? `, and cleared it on ${d.cleared} product${d.cleared === 1 ? '' : 's'}` : ''}.` });
    } catch (e: any) { setMsg({ ok: false, text: e.message }); }
    finally { setBusy(false); }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" role="dialog" aria-label="Product statuses" style={{ maxWidth: 660, width: '94vw', maxHeight: '90vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>Product statuses</h3>
        <p className="acct-region" style={{ marginTop: -4 }}>Add, edit or remove the statuses a product can have. EOL and Discontinued can be renamed but not removed: the automatic EOL rule uses them.</p>
        {!ready && <div className="empty-state" role="status">Statuses can't be added or removed yet. Run product-statuses.sql in the database first.</div>}
        {!list ? <div className="empty-state">Loading...</div> : (
          <div className="manifest">
            {list.map(s => (
              <div className="m-row" key={s.key} style={{ gridTemplateColumns: '1.4fr 1.8fr 0.8fr 1.6fr', cursor: 'default' }}>
                <div><span className={`pill ${s.tone}`}>{s.label}</span></div>
                <div className="acct-region">{s.meaning ?? ''}</div>
                <div className="num">{s.count} {s.count === 1 ? 'product' : 'products'}</div>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                  <button type="button" className="link-btn" disabled={busy || !ready} onClick={() => startEdit(s)} aria-label={`Edit ${s.label}`}>Edit</button>
                  {s.system
                    ? <span className="acct-region">Used by the EOL rule</span>
                    : <button type="button" className="link-btn" disabled={busy || !ready} onClick={() => remove(s)} aria-label={`Remove ${s.label}`}>Remove</button>}
                </div>
              </div>
            ))}
          </div>
        )}
        {editing && (
          <div className="pd-box" role="group" aria-label={`Edit ${editing.label}`} style={{ marginTop: 10 }}>
            <div className="pd-box-title">Edit "{editing.label}"</div>
            {editing.system && <div className="acct-region" style={{ marginBottom: 6 }}>The EOL rule goes by this status itself, not by its name, so renaming it is safe.</div>}
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <label className="modal-field" style={{ flex: '1 1 160px' }}>
                Name
                <input aria-label="Edit name" value={eLabel} maxLength={40} onChange={e => setELabel(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void saveEdit(); }} />
              </label>
              <label className="modal-field" style={{ flex: '2 1 220px' }}>
                What it means (optional)
                <input aria-label="Edit description" value={eMeaning} maxLength={120} onChange={e => setEMeaning(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void saveEdit(); }} />
              </label>
              <label className="modal-field" style={{ minWidth: 100 }}>
                Colour
                <select aria-label="Edit colour" value={eTone} onChange={e => setETone(e.target.value)}>
                  {COLOURS.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
                </select>
              </label>
              <span className={`pill ${eTone}`} aria-hidden="true" style={{ marginBottom: 8 }}>{eLabel.trim() || 'Preview'}</span>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button type="button" className="btn" disabled={!eLabel.trim() || busy} onClick={() => void saveEdit()}>Save changes</button>
              <button type="button" className="btn secondary" onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </div>
        )}
        {confirm && (
          <div className="empty-state" role="alert" style={{ marginTop: 10, textAlign: 'left' }}>
            <b>{confirm.count} product{confirm.count === 1 ? ' has' : 's have'}</b> the status "{confirm.label}". What should happen to {confirm.count === 1 ? 'it' : 'them'}?
            <label className="pl-check" style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
              <input type="radio" name="what-to-do" checked={mode === 'clear'} onChange={() => setMode('clear')} />
              <span>Clear {confirm.count === 1 ? 'its' : 'their'} status</span>
            </label>
            <label className="pl-check" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="radio" name="what-to-do" checked={mode === 'move'} onChange={() => setMode('move')} />
              <span>Move {confirm.count === 1 ? 'it' : 'them'} to</span>
              <select aria-label="Move to" value={target} disabled={mode !== 'move'} onChange={e => setTarget(e.target.value)}>
                {(list ?? []).filter(x => x.key !== confirm.key).map(x => <option key={x.key} value={x.key}>{x.label}</option>)}
              </select>
            </label>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button type="button" className="btn" disabled={busy || (mode === 'move' && !target)} onClick={() => remove(confirm, true)}>Remove "{confirm.label}"</button>
              <button type="button" className="btn secondary" onClick={() => setConfirm(null)}>Keep it</button>
            </div>
          </div>
        )}
        <div className="pd-box" style={{ marginTop: 14 }}>
          <div className="pd-box-title">Add a status</div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <label className="modal-field" style={{ flex: '1 1 160px' }}>
              Name
              <input value={label} maxLength={40} placeholder="For example Seasonal Lines" disabled={!ready} onChange={e => setLabel(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void add(); }} />
            </label>
            <label className="modal-field" style={{ flex: '2 1 220px' }}>
              What it means (optional)
              <input value={meaning} maxLength={120} disabled={!ready} onChange={e => setMeaning(e.target.value)} />
            </label>
            <label className="modal-field" style={{ minWidth: 100 }}>
              Colour
              <select value={tone} disabled={!ready} onChange={e => setTone(e.target.value)}>
                {COLOURS.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
              </select>
            </label>
            <span className={`pill ${tone}`} aria-hidden="true" style={{ marginBottom: 8 }}>{label.trim() || 'Preview'}</span>
          </div>
          <div style={{ marginTop: 10 }}>
            <button type="button" className="btn" disabled={!label.trim() || busy || !ready} onClick={() => void add()}>Add status</button>
          </div>
        </div>
        {msg && <div className="empty-state" role="status" style={{ marginTop: 10, color: msg.ok ? undefined : 'var(--rust)' }}>{msg.text}</div>}
        <div className="modal-actions" style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <button type="button" className="btn secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}