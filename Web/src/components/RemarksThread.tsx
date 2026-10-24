import { useEffect, useState } from 'react';
import { apiDelete, apiGet, apiPatch, apiPost } from '../lib/api';
import { fmtDate } from '../lib/types';
import DictationTextarea from './DictationTextarea';

// Remarks on one activity log, account or order: any comment or feedback, from anyone who can see it (a manager gives feedback, the rep
// replies). You can edit your own remarks; you or a manager can delete one. The API checks all of that. Used in the Activity Log's remarks
// window and as the Remarks card on the account and order pages.
export type RemarkKind = 'activity' | 'account' | 'order';
type Remark = { id: string; author: string; body: string; createdAt: string; updatedAt: string | null; mine: boolean; canEdit: boolean; canDelete: boolean };

const when = (iso: string) => `${fmtDate(iso)}, ${new Date(iso).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' })}`;

export default function RemarksThread({ kind, id, heading, onChanged }: { kind: RemarkKind; id: string; heading?: boolean; onChanged?: () => void }) {
  const [remarks, setRemarks] = useState<Remark[] | null>(null);
  const [ready, setReady] = useState(true);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState('');

  const load = () => apiGet(`/remarks/${kind}/${id}`)
    .then(d => { setRemarks(d.remarks); setReady(d.ready !== false); })
    .catch((e: any) => { setRemarks([]); setError(e.message); });
  useEffect(() => { setRemarks(null); setError(null); setEditing(null); setText(''); void load(); }, [kind, id]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try { await fn(); await load(); onChanged?.(); return true; }
    catch (e: any) { setError(e.message); return false; }
    finally { setBusy(false); }
  }
  const add = async () => { if (text.trim() && await run(() => apiPost(`/remarks/${kind}/${id}`, { body: text.trim() }))) setText(''); };
  const save = async (r: Remark) => { if (editText.trim() && await run(() => apiPatch(`/remarks/item/${r.id}`, { body: editText.trim() }))) setEditing(null); };
  const remove = async (r: Remark) => { if (window.confirm('Delete this remark?')) await run(() => apiDelete(`/remarks/item/${r.id}`)); };

  return (
    <div>
      {heading && <h3>Remarks{remarks && remarks.length > 0 ? ` (${remarks.length})` : ''}</h3>}
      {!ready && <div className="empty-state" role="status">Remarks aren't switched on yet. Run remarks.sql in the database first.</div>}
      {!remarks ? <div className="empty-state">Loading…</div> : (
        <div role="list" style={{ display: 'grid', gap: 10, marginBottom: 14 }}>
          {remarks.length === 0 && ready && <div style={{ color: 'var(--muted)', fontSize: 13 }}>No remarks yet. Add the first one below.</div>}
          {remarks.map(r => (
            <div key={r.id} role="listitem" style={{ borderLeft: `3px solid ${r.mine ? 'var(--teal)' : 'var(--line)'}`, paddingLeft: 10 }}>
              <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                <b style={{ color: 'var(--ink)' }}>{r.author}</b> · {when(r.createdAt)}{r.updatedAt && <span> · edited</span>}
              </div>
              {editing === r.id ? (
                <div style={{ marginTop: 4 }}>
                  <DictationTextarea value={editText} onChange={setEditText} rows={3} />
                  <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                    <button type="button" className="btn" disabled={busy || !editText.trim()} onClick={() => save(r)}>Save</button>
                    <button type="button" className="btn secondary" onClick={() => setEditing(null)}>Cancel</button>
                  </div>
                </div>
              ) : (
                <>
                  <div style={{ whiteSpace: 'pre-wrap', marginTop: 2 }}>{r.body}</div>
                  {(r.canEdit || r.canDelete) && (
                    <div style={{ display: 'flex', gap: 12, marginTop: 2 }}>
                      {r.canEdit && <button type="button" className="edit-link" onClick={() => { setEditing(r.id); setEditText(r.body); }}>Edit</button>}
                      {r.canDelete && <button type="button" className="edit-link" disabled={busy} onClick={() => remove(r)}>Delete</button>}
                    </div>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      )}
      <label className="modal-field">
        Add a remark
        <DictationTextarea value={text} onChange={setText} rows={3} />
      </label>
      {error && <div className="login-error" style={{ marginBottom: 10 }}>{error}</div>}
      <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
        <button type="button" className="btn" disabled={busy || !ready || !text.trim()} onClick={add}>{busy ? 'Saving…' : 'Add remark'}</button>
      </div>
    </div>
  );
}