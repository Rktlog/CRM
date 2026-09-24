import { useState, useEffect, FormEvent, useMemo } from 'react';
import { apiGet, apiPost } from '../lib/api';
import { Account } from '../lib/types';

type Props = {
  onCreated: () => void;
  onClose: () => void;
};

export default function LogVisitModal({ onCreated, onClose }: Props) {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Account | null>(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet('/accounts').then(setAccounts).catch(e => setError(e.message));
  }, []);

  const matches = useMemo(() => {
    if (!accounts || selected) return [];
    const q = search.trim().toLowerCase();
    if (q.length < 2) return [];
    return accounts.filter(a => a.name.toLowerCase().includes(q)).slice(0, 8);
  }, [accounts, search, selected]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!selected || !note.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await apiPost('/activity', { accountId: selected.id, type: 'visit', note: note.trim() });
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
        <h3 style={{ marginBottom: 16 }}>Log a visit</h3>

        <label className="modal-field">
          Account
          {selected ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', border: '1px solid var(--line)', borderRadius: 5, padding: '8px 10px' }}>
              <span>{selected.name}</span>
              <button
                type="button"
                onClick={() => { setSelected(null); setSearch(''); }}
                style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 12, textDecoration: 'underline' }}
              >
                Change
              </button>
            </div>
          ) : (
            <>
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Start typing a business name…"
                autoFocus
              />
              {matches.length > 0 && (
                <div style={{ border: '1px solid var(--line)', borderRadius: 5, marginTop: 4, maxHeight: 180, overflowY: 'auto' }}>
                  {matches.map(a => (
                    <div
                      key={a.id}
                      onClick={() => { setSelected(a); setSearch(''); }}
                      style={{ padding: '8px 10px', cursor: 'pointer', fontSize: 13, borderBottom: '1px solid var(--line)' }}
                    >
                      {a.name}
                      <span style={{ color: 'var(--muted)', fontSize: 11.5, marginLeft: 6 }}>{a.region}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </label>

        <label className="modal-field">
          Notes
          <textarea
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="What happened at the visit?"
            rows={3}
          />
        </label>

        {error && <div className="login-error" style={{ marginBottom: 10 }}>{error}</div>}

        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
          <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn" disabled={saving || !selected || !note.trim()}>
            {saving ? 'Saving…' : 'Log visit'}
          </button>
        </div>
      </form>
    </div>
  );
}