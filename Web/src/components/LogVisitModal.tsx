import { useState, useEffect, useRef, FormEvent } from 'react';
import { apiGet, apiPost } from '../lib/api';
import { supabase } from '../lib/supabase';
import { Account } from '../lib/types';
import { useMe } from '../lib/useMe';
import AccountPicker, { AccountSelection, resolveSelection } from './AccountPicker';

type Props = {
  onCreated: () => void;
  onClose: () => void;
};

// Resizes to a max dimension and re-encodes as JPEG at reduced quality,
// client-side, before it ever reaches Supabase Storage — a typical phone
// photo (3-5MB) comes down to roughly 100-300KB this way, which matters
// on a 50MB bucket.
function compressImage(file: File, maxDim = 1280, quality = 0.7): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(objectUrl);

      let { width, height } = img;
      if (width > height && width > maxDim) {
        height = Math.round((height * maxDim) / width);
        width = maxDim;
      } else if (height >= width && height > maxDim) {
        width = Math.round((width * maxDim) / height);
        height = maxDim;
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return reject(new Error('Canvas not supported on this device'));
      ctx.drawImage(img, 0, 0, width, height);

      canvas.toBlob(
        blob => (blob ? resolve(blob) : reject(new Error('Image compression failed'))),
        'image/jpeg',
        quality
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Could not read that image file'));
    };
    img.src = objectUrl;
  });
}

export default function LogVisitModal({ onCreated, onClose }: Props) {
  const me = useMe();
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [selection, setSelection] = useState<AccountSelection>(null);
  // If a new store was saved but the next step failed, a retry reuses it
  // instead of creating the store twice.
  const savedStore = useRef<{ id: string; name: string } | null>(null);
  // Name shown on the "Visit logged" confirmation, including new stores.
  const [savedName, setSavedName] = useState('');
  const [note, setNote] = useState('');
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    apiGet('/accounts').then(setAccounts).catch(e => setError(e.message));
  }, []);

  useEffect(() => {
    return () => {
      if (photoPreview) URL.revokeObjectURL(photoPreview);
    };
  }, [photoPreview]);

  // Once the success message shows, close the modal and refresh the
  // underlying list shortly after — long enough to actually read it,
  // short enough not to feel stuck.
  useEffect(() => {
    if (!success) return;
    const t = setTimeout(() => {
      onCreated();
      onClose();
    }, 1200);
    return () => clearTimeout(t);
  }, [success, onCreated, onClose]);

  function handlePhotoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    if (photoPreview) URL.revokeObjectURL(photoPreview);
    setPhotoFile(file);
    setPhotoPreview(file ? URL.createObjectURL(file) : null);
  }

  function clearPhoto() {
    if (photoPreview) URL.revokeObjectURL(photoPreview);
    setPhotoFile(null);
    setPhotoPreview(null);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!selection || !me || !note.trim()) return;
    setSaving(true);
    setError(null);
    try {
      // A new store is saved as a new lead first, so the visit (and its
      // photo) can attach to it.
      const account = (selection.kind === 'new' && savedStore.current) || await resolveSelection(selection, me.id);
      if (selection.kind === 'new') savedStore.current = account;
      let photoUrl: string | undefined;

      if (photoFile) {
        const compressed = await compressImage(photoFile);
        const path = `${account.id}/${Date.now()}.jpg`;
        const { error: uploadError } = await supabase.storage
          .from('Photo')
          .upload(path, compressed, { contentType: 'image/jpeg' });
        if (uploadError) throw new Error(`Photo upload failed: ${uploadError.message}`);

        const { data } = supabase.storage.from('Photo').getPublicUrl(path);
        photoUrl = data.publicUrl;
      }

      await apiPost('/activity', {
        accountId: account.id,
        type: 'visit',
        note: note.trim(),
        ...(photoUrl ? { photoUrl } : {}),
      });
      setSavedName(account.name);
      setSuccess(true);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (success) {
    return (
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal-card" onClick={e => e.stopPropagation()} style={{ textAlign: 'center', padding: '32px 24px' }}>
          <div style={{ fontSize: 28, marginBottom: 8 }}>✓</div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>F2F visit logged</div>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>
            {savedName}{photoFile ? ', photo attached' : ''}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form className="modal-card" onClick={e => e.stopPropagation()} onSubmit={handleSubmit}>
        <h3 style={{ marginBottom: 16 }}>Log F2F visit</h3>

        <AccountPicker accounts={accounts} onChange={setSelection} autoFocus />

        <label className="modal-field">
          Notes
          <textarea
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="What happened at the F2F visit?"
            rows={3}
          />
        </label>

        <label className="modal-field">
          Photo (optional)
          {photoPreview ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <img
                src={photoPreview}
                alt="Selected visit photo"
                style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 5, border: '1px solid var(--line)' }}
              />
              <button
                type="button"
                onClick={clearPhoto}
                style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 12, textDecoration: 'underline' }}
              >
                Remove
              </button>
            </div>
          ) : (
            <input type="file" accept="image/*" onChange={handlePhotoChange} />
          )}
        </label>

        {error && <div className="login-error" style={{ marginBottom: 10 }}>{error}</div>}

        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
          <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn" disabled={saving || !selection || !me || !note.trim()}>
            {saving ? 'Saving…' : selection?.kind === 'new' ? 'Add store and log F2F visit' : 'Log F2F visit'}
          </button>
        </div>
      </form>
    </div>
  );
}