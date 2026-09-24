import { useState, FormEvent, useMemo } from 'react';
import { apiPost } from '../lib/api';
import { findLikelyDuplicates } from '../lib/types';

type Props = {
  repId: string;
  existingNames: string[];
  onCreated: () => void;
  onClose: () => void;
};

export default function NewLeadModal({ repId, existingNames, onCreated, onClose }: Props) {
  const [name, setName] = useState('');
  const [region, setRegion] = useState('NSW');
  const [credit, setCredit] = useState<'prepay' | 'account'>('account');
  const [contactName, setContactName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmedDespiteDuplicate, setConfirmedDespiteDuplicate] = useState(false);

  const possibleDuplicates = useMemo(() => findLikelyDuplicates(name, existingNames), [name, existingNames]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    if (possibleDuplicates.length > 0 && !confirmedDespiteDuplicate) return; // block until they acknowledge
    setSaving(true);
    setError(null);
    try {
      await apiPost('/accounts', {
        name: name.trim(),
        region,
        credit,
        repId,
        type: 'prospect',
        contactName: contactName.trim() || undefined,
        phone: phone.trim() || undefined,
        email: email.trim() || undefined,
      });
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
        <h3 style={{ marginBottom: 16 }}>New lead</h3>

        <label className="modal-field">
          Business name
          <input
            value={name}
            onChange={e => { setName(e.target.value); setConfirmedDespiteDuplicate(false); }}
            required
            autoFocus
          />
        </label>

        {possibleDuplicates.length > 0 && (
          <div style={{ background: 'var(--amber-bg)', border: '1px solid var(--amber)', borderRadius: 5, padding: '10px 12px', fontSize: 12.5 }}>
            <div style={{ fontWeight: 500, color: 'var(--amber)', marginBottom: 4 }}>
              This looks similar to an existing account:
            </div>
            <div style={{ color: 'var(--ink-soft)' }}>{possibleDuplicates.slice(0, 3).join(', ')}</div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={confirmedDespiteDuplicate} onChange={e => setConfirmedDespiteDuplicate(e.target.checked)} />
              This is genuinely a different, new account
            </label>
          </div>
        )}

        <div style={{ display: 'flex', gap: 10 }}>
          <label className="modal-field" style={{ flex: 1 }}>
            Region
            <select value={region} onChange={e => setRegion(e.target.value)}>
              <option value="NSW">NSW</option>
              <option value="ACT">ACT</option>
              <option value="VIC">VIC</option>
              <option value="QLD">QLD</option>
              <option value="WA">WA</option>
              <option value="SA">SA</option>
              <option value="TAS">TAS</option>
              <option value="NT">NT</option>
              <option value="NZ">NZ</option>
            </select>
          </label>
          <label className="modal-field" style={{ flex: 1 }}>
            Credit terms
            <select value={credit} onChange={e => setCredit(e.target.value as any)}>
              <option value="account">Credit account</option>
              <option value="prepay">Pay first</option>
            </select>
          </label>
        </div>

        <label className="modal-field">
          Contact name
          <input value={contactName} onChange={e => setContactName(e.target.value)} />
        </label>

        <div style={{ display: 'flex', gap: 10 }}>
          <label className="modal-field" style={{ flex: 1 }}>
            Phone
            <input value={phone} onChange={e => setPhone(e.target.value)} />
          </label>
          <label className="modal-field" style={{ flex: 1 }}>
            Email
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} />
          </label>
        </div>

        {error && <div className="login-error" style={{ marginBottom: 10 }}>{error}</div>}

        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
          <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
          <button
            type="submit"
            className="btn"
            disabled={saving || (possibleDuplicates.length > 0 && !confirmedDespiteDuplicate)}
          >
            {saving ? 'Creating…' : 'Create lead'}
          </button>
        </div>
      </form>
    </div>
  );
}