import { useState } from 'react';
import { apiPatch } from '../lib/api';
import { ACTIVITY_KINDS, ACTIVITY_LABEL, ActivityKind } from '../lib/activityLabels';
import { todayLocal, dateInputValue, isoForDay } from '../lib/logDate';
import DictationTextarea from './DictationTextarea';

// Edit a log that was already saved: its kind, its date and its note. Only what was changed is
// sent. (The rep who logged it, or a manager, can edit it; the API enforces that.)

type Props = {
  activity: { id: string; accountName: string; type: ActivityKind; occurredAt: string; note: string };
  onSaved: () => void;
  onClose: () => void;
};

export default function EditActivityModal({ activity, onSaved, onClose }: Props) {
  const [type, setType] = useState<ActivityKind>(activity.type);
  const [day, setDay] = useState(dateInputValue(activity.occurredAt));
  const [note, setNote] = useState(activity.note);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const today = todayLocal();
  const dayChanged = day !== dateInputValue(activity.occurredAt);
  const future = day > today;
  const body = {
    ...(type !== activity.type ? { type } : {}),
    ...(note.trim() !== activity.note ? { note: note.trim() } : {}),
    ...(dayChanged ? { occurredAt: isoForDay(day) } : {}),
  };
  const changed = Object.keys(body).length > 0;

  async function save() {
    if (!changed) return onClose();
    setSaving(true);
    setError(null);
    try {
      await apiPatch(`/activity/${activity.id}`, body);
      onSaved();
      onClose();
    } catch (e: any) {
      setError(e.message);
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form className="modal-card" onClick={e => e.stopPropagation()} onSubmit={e => { e.preventDefault(); save(); }}>
        <h3 style={{ marginBottom: 4 }}>Edit log</h3>
        <div className="acct-region" style={{ marginBottom: 12 }}>{activity.accountName}</div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }} role="group" aria-label="Kind of activity">
          {ACTIVITY_KINDS.map(k => (
            <button key={k} type="button" className="btn secondary" aria-pressed={type === k}
              style={{ fontWeight: type === k ? 700 : 400, opacity: type === k ? 1 : 0.65 }} onClick={() => setType(k)}>
              {ACTIVITY_LABEL[k]}
            </button>
          ))}
        </div>

        <label className="modal-field">
          Date
          <input type="date" value={day} max={today} onChange={e => setDay(e.target.value)} />
        </label>
        {future && <div className="login-error" style={{ marginBottom: 10 }}>A log can't be dated in the future. Pick today or an earlier date.</div>}

        <label className="modal-field">
          Notes
          <DictationTextarea value={note} onChange={setNote} rows={4} />
        </label>

        {error && <div className="login-error" style={{ marginBottom: 10 }}>{error}</div>}
        <div className="modal-actions" style={{ display: 'flex', gap: 8, marginTop: 6 }}>
          <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn" disabled={saving || !note.trim() || !day || future || !changed}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}