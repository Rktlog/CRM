import { FormEvent, useEffect, useState } from 'react';
import { apiGet, apiPost } from '../lib/api';
import { ACTIVITY_ICON, ACTIVITY_KINDS, ACTIVITY_LABEL, ActivityKind } from '../lib/activityLabels';
import { todayLocal, dateInputValue, isoForDay } from '../lib/logDate';
import { fmtDate } from '../lib/types';
import EditActivityModal from './EditActivityModal';
import DeleteLogLink from './DeleteLogLink';
import DictationTextarea from './DictationTextarea';

// The team's log for ONE order: a call, email, visit or remark about it (chasing payment, a follow-up, any comment or feedback). Everyone who can see the
// account sees it, and every entry also shows in the account's own activity log (it is the same record, linked to the order).
type Entry = { id: string; type: ActivityKind; note: string; occurredAt: string; repName: string | null; mine: boolean; canEdit: boolean; edited: boolean };

const KINDS: ActivityKind[] = ACTIVITY_KINDS;
const PLACEHOLDER: Record<string, string> = {
  call: 'e.g. Rang accounts, they will pay on Friday',
  email: 'e.g. Emailed the invoice again, asked for a payment date',
  visit: 'What happened at the visit?',
  remark: 'Your remark, comment or feedback on this order',
};
// One tap to start the usual ones. "Follow up in 3 days" is read by the CRM and sets the reminder on the account.
const PHRASES = ['Chasing payment:', 'Customer promised to pay by', 'Waiting on stock:', 'Follow up in 3 days:'];
const ICON: Record<string, string> = ACTIVITY_ICON;

export default function OrderLog({ orderId, accountId, accountName, onChange }: { orderId: string; accountId: string; accountName: string; onChange?: () => void }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [type, setType] = useState<ActivityKind>('call');
  const [text, setText] = useState('');
  const [day, setDay] = useState(todayLocal());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Entry | null>(null);

  const load = () => apiGet(`/order-notes/${orderId}`).then(d => setEntries(d.notes)).catch(e => { setEntries([]); setError(e.message); });
  useEffect(() => { load(); }, [orderId]);

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!text.trim() || day > todayLocal()) return;
    setSaving(true); setError(null);
    try {
      await apiPost('/activity', { accountId, orderId, type, note: text.trim(), ...(day !== todayLocal() ? { occurredAt: isoForDay(day) } : {}) });
      setText(''); setDay(todayLocal()); await load(); onChange?.();
    } catch (err: any) { setError(err.message); }
    finally { setSaving(false); }
  }
  const phrase = (p: string) => setText(t => (t.trim() ? `${t.trim()} ${p} ` : `${p} `));

  return (
    <div className="card" id="order-log">
      <h3>Team log for this order</h3>
      <div className="acct-region" style={{ marginBottom: 10 }}>Log a call, email, visit or remark about this order, such as chasing payment, a follow-up or any comment or feedback. Everyone who can see this account sees it, and each one also shows in the account's activity log.</div>

      <form onSubmit={add}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }} role="group" aria-label="Kind of log">
          {KINDS.map(k => (
            <button key={k} type="button" className={'btn secondary' + (type === k ? ' active' : '')} aria-pressed={type === k}
              style={{ opacity: type === k ? 1 : 0.6, padding: '4px 12px', fontSize: 12.5 }} onClick={() => setType(k)}>{ACTIVITY_LABEL[k]}</button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
          {PHRASES.map(p => <button key={p} type="button" className="pill neutral" style={{ cursor: 'pointer', border: 'none' }} onClick={() => phrase(p)}>{p.replace(/:$/, '')}</button>)}
        </div>
        <DictationTextarea value={text} onChange={setText} placeholder={PLACEHOLDER[type]} rows={3} style={{ marginBottom: 8 }} aria-label="What happened" />
        <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn" type="submit" disabled={saving || !text.trim() || day > todayLocal()}>{saving ? 'Saving…' : 'Add to order log'}</button>
          <label className="acct-region" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            Date <input type="date" value={day} max={todayLocal()} onChange={e => setDay(e.target.value || todayLocal())} />
          </label>
        </div>
        {error && <div className="save-msg err" style={{ marginTop: 8 }}>{error}</div>}
      </form>

      <div style={{ marginTop: 14 }}>
        {entries === null && <div className="acct-region">Loading…</div>}
        {entries && entries.length === 0 && <div className="acct-region">Nothing logged on this order yet.</div>}
        {entries?.map(n => (
          <div className="timeline-item" key={n.id}>
            <div className="ti-icon">{ICON[n.type] ?? '✉'}</div>
            <div className="ti-body">
              <div className="ti-top">
                <span style={{ fontWeight: 500 }}>{ACTIVITY_LABEL[n.type] ?? n.type}</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className="num" style={{ color: 'var(--muted)' }}>{fmtDate(n.occurredAt)}</span>
                  {n.canEdit && <button className="edit-link" onClick={() => setEditing(n)}>Edit</button>}
                  {n.canEdit && <DeleteLogLink id={n.id} onDeleted={() => { load(); onChange?.(); }} />}
                </span>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{n.mine ? 'You' : n.repName ?? 'Someone'}{n.edited ? ', edited' : ''}</div>
              <div className="ti-note">{n.note}</div>
            </div>
          </div>
        ))}
      </div>

      {editing && <EditActivityModal activity={{ id: editing.id, accountName, type: editing.type, occurredAt: editing.occurredAt, note: editing.note }}
        onSaved={() => { load(); onChange?.(); }} onClose={() => setEditing(null)} />}
    </div>
  );
}