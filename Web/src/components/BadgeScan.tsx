import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { apiPost, apiPostText } from '../lib/api';
import { errMsg, STATES, type Customer } from '../lib/tradeshow';

// Scan a visitor's badge: the rep takes a photo, Claude reads the printed words, and they appear in a form to check and fix. NOTHING is saved until "Save lead"
// is pressed. The photo is shrunk in the browser, sent once to be read, and then thrown away: it is never stored. QR codes are not read, only the printed words.
const field: CSSProperties = { width: '100%', padding: '7px 10px', border: '1px solid var(--line)', borderRadius: 3, font: 'inherit', fontSize: 16 };
const label: CSSProperties = { display: 'grid', gap: 4, fontSize: 13 };
type Reading = { company: string | null; contact: string | null; email: string | null; phone: string | null; address: string | null; state: string | null; stateFrom: 'badge' | 'postcode' | null; note: string | null; readable: boolean };

/** Shrinks a photo to about 1400 px on the long side as a JPEG, so a phone photo is a few hundred KB instead of several MB. */
export async function shrinkPhoto(file: File, max = 1400): Promise<{ base64: string; mime: 'image/jpeg' }> {
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) throw new Error('That photo could not be opened. Try another one.');
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height); bmp.close?.();
  const url = c.toDataURL('image/jpeg', 0.85);
  return { base64: url.slice(url.indexOf(',') + 1), mime: 'image/jpeg' };
}

export default function BadgeScan({ showId, onSaved, onClose }: { showId: string; onSaved: (leadId: string) => void; onClose: () => void }) {
  const [step, setStep] = useState<'photo' | 'reading' | 'check' | 'saving'>('photo');
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [f, setF] = useState({ company: '', contact: '', email: '', phone: '', address: '', state: '', brands: '', notes: '' });
  const [stateNote, setStateNote] = useState<string | null>(null);
  const [matches, setMatches] = useState<Customer[]>([]);
  const [use, setUse] = useState<string>('new');   // an existing account's id, or 'new'
  const [diff, setDiff] = useState(false);   // "this really is a different, new customer", needed when a look-alike exists
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && step !== 'saving') onClose(); }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); }, [onClose, step]);

  async function picked(file: File | undefined) {
    if (!file) return;
    setErr(null); setStep('reading');
    try {
      const img = await shrinkPhoto(file);
      const d: { reading: Reading; matches: Customer[] } = await apiPostText('/tradeshow/badge/read', JSON.stringify({ image: img.base64, mime: img.mime }), 'text/plain');
      if (!d.reading.readable) { setErr('I could not read a badge in that photo. Take it again, closer and in better light, with the words flat to the camera.'); setStep('photo'); return; }
      const r = d.reading;
      setF({ company: r.company ?? '', contact: r.contact ?? '', email: r.email ?? '', phone: r.phone ?? '', address: r.address ?? '', state: r.state ?? '', brands: '', notes: '' });
      setStateNote(r.state ? (r.stateFrom === 'postcode' ? 'Worked out from the postcode. Check it.' : null) : 'Not on the badge. Choose it.');
      setNote(r.note); setMatches(d.matches); setUse(d.matches.length === 1 ? d.matches[0]!.id : 'new'); setDiff(false); setStep('check');
    } catch (e) { setErr(errMsg(e)); setStep('photo'); }
    finally { if (input.current) input.current.value = ''; }   // the photo is not kept anywhere, and the same one can be chosen again
  }

  const isNew = use === 'new';
  const needState = isNew && !f.state;
  const blocked = (isNew && !f.company.trim()) || needState || (isNew && matches.length > 0 && !diff);
  async function save() {
    setErr(null); setStep('saving');
    try {
      const base = { showId, contactName: f.contact.trim() || null, contactEmail: f.email.trim() || null, contactPhone: f.phone.trim() || null, brands: f.brands.trim() || null, notes: f.notes.trim() || null };
      const body = isNew ? { ...base, newCustomer: { name: f.company.trim(), contact: f.contact.trim(), email: f.email.trim(), phone: f.phone.trim(), address: f.address.trim(), region: f.state, category: '', confirmNew: matches.length > 0 && diff } } : { ...base, accountId: use };
      const r: { id: string } = await apiPost('/tradeshow/leads', body);
      onSaved(r.id);
    } catch (e) { setErr(errMsg(e)); setStep('check'); }   // nothing was saved, so it can be pressed again
  }
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF(v => ({ ...v, [k]: e.target.value }));

  return createPortal(
    <div className="modal-overlay" onClick={() => step !== 'saving' && onClose()}>
      <div className="modal-card" role="dialog" aria-label="Scan badge" onClick={e => e.stopPropagation()} style={{ maxWidth: 560, width: '94vw', maxHeight: '92vh', overflowY: 'auto' }}>
        <h3 style={{ marginBottom: 6 }}>Scan badge</h3>
        {(step === 'photo' || step === 'reading') && (
          <div style={{ display: 'grid', gap: 10 }}>
            <div className="acct-region">Take a photo of the visitor's badge. Keep the words flat to the camera and fill the frame. The photo is read once and not kept. Nothing is saved until you press Save lead.</div>
            <input ref={input} type="file" accept="image/*" capture="environment" aria-label="Badge photo" style={{ display: 'none' }} onChange={e => void picked(e.target.files?.[0])} />
            <button type="button" className="btn" disabled={step === 'reading'} onClick={() => input.current?.click()}>{step === 'reading' ? 'Reading the badge…' : 'Take a photo'}</button>
            {err && <div className="save-msg err" role="alert">{err}</div>}
            <div><button type="button" className="btn secondary" onClick={onClose}>Cancel</button></div>
          </div>
        )}
        {(step === 'check' || step === 'saving') && (
          <div style={{ display: 'grid', gap: 10 }}>
            <div className="acct-region">Check what was read and fix anything wrong. Then press Save lead.</div>
            {note && <div className="save-msg" role="status" style={{ color: 'var(--amber)' }}>{note}</div>}
            {matches.length > 0 && (
              <div style={{ border: '1px solid var(--amber)', background: 'var(--amber-bg)', borderRadius: 5, padding: '8px 10px', fontSize: 13 }}>
                <b>Radar already has {matches.length === 1 ? 'a customer' : 'customers'} like this.</b> Use one, so there is not a second account:
                {matches.map(m => <label key={m.id} style={{ display: 'flex', gap: 6, marginTop: 4 }}><input type="radio" name="use" checked={use === m.id} onChange={() => setUse(m.id)} /> {m.name} ({m.region}){m.contact ? `, ${m.contact}` : ''}</label>)}
                <label style={{ display: 'flex', gap: 6, marginTop: 4 }}><input type="radio" name="use" checked={isNew} onChange={() => setUse('new')} /> No, this is a new customer</label>
                {isNew && <label style={{ display: 'flex', gap: 6, marginTop: 4, marginLeft: 22 }}><input type="checkbox" checked={diff} onChange={e => setDiff(e.target.checked)} /> Yes, it is a different business</label>}
              </div>
            )}
            <label style={label}>Business<input style={field} value={f.company} onChange={set('company')} disabled={!isNew} /></label>
            <label style={label}>Contact name<input style={field} value={f.contact} onChange={set('contact')} /></label>
            <div style={{ display: 'flex', gap: 10 }}>
              <label style={{ ...label, flex: 1 }}>Phone<input style={field} inputMode="tel" value={f.phone} onChange={set('phone')} /></label>
              <label style={{ ...label, flex: 1 }}>Email<input style={field} type="email" value={f.email} onChange={set('email')} /></label>
            </div>
            {isNew && <>
              <label style={label}>Address<input style={field} value={f.address} onChange={set('address')} /></label>
              <label style={label}>State{stateNote && <span className="acct-region" style={{ fontSize: 12 }}> {stateNote}</span>}
                <select style={field} value={f.state} onChange={set('state')} aria-label="State"><option value="">Choose…</option>{STATES.map(s => <option key={s} value={s}>{s}</option>)}</select></label>
            </>}
            <label style={label}>Brands they liked<input style={field} value={f.brands} onChange={set('brands')} placeholder="Miffy, Liewood…" /></label>
            <label style={label}>Notes<textarea style={{ ...field, minHeight: 50 }} value={f.notes} onChange={set('notes')} /></label>
            {err && <div className="save-msg err" role="alert">{err}</div>}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="btn" disabled={step === 'saving' || blocked} onClick={save}>{step === 'saving' ? 'Saving…' : 'Save lead'}</button>
              <button type="button" className="btn secondary" disabled={step === 'saving'} onClick={() => { setStep('photo'); setErr(null); }}>Take another photo</button>
              <button type="button" className="btn secondary" disabled={step === 'saving'} onClick={onClose}>Cancel</button>
            </div>
            {blocked && <div className="acct-region" style={{ fontSize: 12.5 }}>{!isNew ? '' : !f.company.trim() ? 'Type the business name.' : needState ? 'Choose the state.' : 'Tick that it is a different business, or pick the customer above.'}</div>}
          </div>
        )}
      </div>
    </div>, document.body);
}
