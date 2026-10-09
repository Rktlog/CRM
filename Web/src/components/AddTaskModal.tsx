import { useState, useEffect, useRef, FormEvent } from 'react';
import { apiGet, apiPost } from '../lib/api';
import { Account } from '../lib/types';
import { localISO } from '../lib/dates';
import { useMe } from '../lib/useMe';
import AccountPicker, { AccountSelection, resolveSelection } from './AccountPicker';

// initialDate: pre-fills the date, e.g. the day clicked on the calendar.
type Props = { onCreated: () => void; onClose: () => void; initialDate?: string };

export default function AddTaskModal({ onCreated, onClose, initialDate }: Props) {
  const me = useMe();
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [selection, setSelection] = useState<AccountSelection>(null);
  // If a new store was saved but the next step failed, a retry reuses it
  // instead of creating the store twice.
  const savedStore = useRef<{ id: string; name: string } | null>(null);
  const [type, setType] = useState<'cold_call' | 'visit'>('cold_call');
  const [date, setDate] = useState(initialDate ?? localISO());
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet('/accounts').then(setAccounts).catch(e => setError(e.message));
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!selection || !me) return;
    setSaving(true);
    setError(null);
    try {
      const account = (selection.kind === 'new' && savedStore.current) || await resolveSelection(selection, me.id);
      if (selection.kind === 'new') savedStore.current = account;
      await apiPost('/tasks', { accountId: account.id, type, scheduledDate: date, note: note || undefined });
      onCreated();
      onClose();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form className="modal-card" onClick={e => e.stopPropagation()} onSubmit={handleSubmit}>
        <h3 style={{ marginBottom: 16 }}>Schedule a task</h3>

        <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
          {(['cold_call', 'visit'] as const).map(t => (
            <button
              key={t}
              type="button"
              className="btn secondary"
              style={{ opacity: type === t ? 1 : 0.55, padding: '6px 12px', fontSize: 12.5 }}
              onClick={() => setType(t)}
            >
              {t === 'cold_call' ? 'Phone' : 'F2F visit'}
            </button>
          ))}
        </div>

        <AccountPicker accounts={accounts} onChange={setSelection} autoFocus />

        <label className="modal-field">
          Date
          <input type="date" value={date} onChange={e => setDate(e.target.value)} />
        </label>

        <label className="modal-field">
          Note (optional)
          <textarea value={note} onChange={e => setNote(e.target.value)} rows={2} placeholder="What's this about?" />
        </label>

        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 8 }}>
          If it isn't done on the day, it moves to the next day automatically.
        </div>

        {error && <div className="login-error" style={{ marginBottom: 10 }}>{error}</div>}

        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
          <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn" disabled={saving || !selection || !me}>
            {saving ? 'Saving…' : selection?.kind === 'new' ? 'Add store and schedule' : 'Schedule'}
          </button>
        </div>
      </form>
    </div>
  );
}