import { useState, useEffect, FormEvent, useMemo } from 'react';
import { apiGet, apiPost } from '../lib/api';
import { supabase } from '../lib/supabase';
import { Account } from '../lib/types';

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
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Account | null>(null);
  const [note, setNote] = useState('');
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet('/accounts').then(setAccounts).catch(e => setError(e.message));
  }, []);

  // Revoke the preview object URL on unmount / when the photo changes,
  // so we don't leak memory across repeated opens of this modal.
  useEffect(() => {
    return () => {
      if (photoPreview) URL.revokeObjectURL(photoPreview);
    };
  }, [photoPreview]);

  const matches = useMemo(() => {
    if (!accounts || selected) return [];
    const q = search.trim().toLowerCase();
    if (q.length < 2) return [];
    return accounts.filter(a => a.name.toLowerCase().includes(q)).slice(0, 8);
  }, [accounts, search, selected]);

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
    if (!selected || !note.trim()) return;
    setSaving(true);
    setError(null);
    try {
      let photoUrl: string | undefined;

      if (photoFile) {
        const compressed = await compressImage(photoFile);
        const path = `${selected.id}/${Date.now()}.jpg`;
        const { error: uploadError } = await supabase.storage
          .from('Photo')
          .upload(path, compressed, { contentType: 'image/jpeg' });
        if (uploadError) throw new Error(`Photo upload failed: ${uploadError.message}`);

        const { data } = supabase.storage.from('Photo').getPublicUrl(path);
        photoUrl = data.publicUrl;
      }

      await apiPost('/activity', {
        accountId: selected.id,
        type: 'visit',
        note: note.trim(),
        ...(photoUrl ? { photoUrl } : {}),
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
          <button type="submit" className="btn" disabled={saving || !selected || !note.trim()}>
            {saving ? 'Saving…' : 'Log visit'}
          </button>
        </div>
      </form>
    </div>
  );
}