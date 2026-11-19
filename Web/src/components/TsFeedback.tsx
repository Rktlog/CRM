import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPut } from '../lib/api';
import { errMsg } from '../lib/tradeshow';
import { sel, type Feedback } from '../lib/tsExtra';

// How the show went: general notes, pros, cons and what to do better. What was written the last time we did this show is shown above, so it is read before the next one.
const BOXES: { k: 'general' | 'pros' | 'cons' | 'improvements'; label: string; hint: string }[] = [
  { k: 'general', label: 'General notes', hint: 'Traffic, the stand, the team, anything that stood out' },
  { k: 'pros', label: 'Pros', hint: 'What worked' },
  { k: 'cons', label: 'Cons', hint: 'What did not' },
  { k: 'improvements', label: 'Room for improvement', hint: 'What we will change next time' },
];
export default function TsFeedback({ showId }: { showId: string }) {
  const [f, setF] = useState<Feedback | null>(null);
  const [v, setV] = useState({ general: '', pros: '', cons: '', improvements: '' });
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { apiGet(`/tradeshow/shows/${showId}/feedback`, { fresh: true }).then((x: Feedback) => { setF(x); setV({ general: x.general, pros: x.pros, cons: x.cons, improvements: x.improvements }); setDirty(false); }).catch(e => setMsg({ ok: false, text: errMsg(e) })); }, [showId]);
  useEffect(() => { load(); }, [load]);
  async function save() { setBusy(true); setMsg(null); try { await apiPut(`/tradeshow/shows/${showId}/feedback`, v); setDirty(false); setMsg({ ok: true, text: 'Saved.' }); } catch (e) { setMsg({ ok: false, text: errMsg(e) }); } finally { setBusy(false); } }
  if (!f) return msg ? <div className="save-msg err" role="alert">{msg.text}</div> : <div className="acct-region">Loading…</div>;
  const p = f.previous;
  return (
    <>
      {p && (
        <div className="card" style={{ maxWidth: 820, background: 'var(--panel)' }}>
          <div className="panel-title">Last time: {p.showName}</div>
          {BOXES.filter(b => p[b.k]).map(b => <div key={b.k} style={{ marginBottom: 8 }}><div className="acct-region" style={{ fontSize: 12.5 }}>{b.label}</div><div style={{ whiteSpace: 'pre-wrap', fontSize: 14 }}>{p[b.k]}</div></div>)}
        </div>
      )}
      <div style={{ display: 'grid', gap: 12, maxWidth: 820 }}>
        {BOXES.map(b => <label key={b.k} style={{ display: 'grid', gap: 4, fontSize: 13 }}>{b.label}<textarea style={{ ...sel, minHeight: 90 }} placeholder={b.hint} value={v[b.k]} onChange={e => { setV({ ...v, [b.k]: e.target.value }); setDirty(true); }} /></label>)}
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}><button type="button" className="btn" disabled={busy || !dirty} onClick={save}>{busy ? 'Saving…' : 'Save feedback'}</button>{f.updatedAt && <span className="acct-region" style={{ fontSize: 12.5 }}>Last saved {new Date(f.updatedAt).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</span>}</div>
        {msg && <div className={msg.ok ? 'save-msg ok' : 'save-msg err'} role={msg.ok ? 'status' : 'alert'}>{msg.text}</div>}
      </div>
    </>
  );
}
