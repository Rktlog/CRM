import { useRef, useState, type CSSProperties } from 'react';
import { apiDelete } from '../lib/api';
import { mediaChanged, sizeText, useAccountMedia, useCapabilities, type Attachments, type MediaItem } from '../lib/media';

// Photos and videos on an account: the control for attaching them to a log entry, the thumbnails under each log entry, and a gallery of all of them.
// The files are in the company Dropbox; Radar shows them through links that last a few hours.
type Shown = { key: string; kind: 'photo' | 'video'; url: string | null; name: string; at: string; by: string | null; missing: boolean; item?: MediaItem };
const day = (iso: string) => new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
const toShown = (i: MediaItem): Shown => ({ key: i.id, kind: i.kind, url: i.url, name: i.name, at: i.createdAt, by: i.by, missing: i.missing, item: i });
const cover: CSSProperties = { width: '100%', height: '100%', objectFit: 'cover', display: 'block' };

function Tile({ s, size, onOpen }: { s: Shown; size: number; onOpen: () => void }) {
  return (
    <button type="button" aria-label={`${s.kind === 'video' ? 'Play video' : 'Open photo'} ${s.name}`} disabled={!s.url} onClick={onOpen}
      style={{ width: size, height: size, borderRadius: 6, border: '1px solid var(--line)', overflow: 'hidden', background: '#111', padding: 0, position: 'relative', cursor: s.url ? 'pointer' : 'default', flex: '0 0 auto' }}>
      {s.url && s.kind === 'photo' && <img src={s.url} alt={s.name} loading="lazy" style={cover} />}
      {s.url && s.kind === 'video' && (
        <>
          <video src={`${s.url}#t=0.1`} preload="metadata" muted playsInline style={cover} />
          <span aria-hidden="true" style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: '#fff', fontSize: size > 90 ? 30 : 20, textShadow: '0 1px 4px #000' }}>▶</span>
        </>
      )}
      {!s.url && <span style={{ color: '#9ca3af', fontSize: 11, padding: 4, display: 'block' }}>{s.missing ? 'Deleted in Dropbox' : 'No preview'}</span>}
    </button>
  );
}

function Lightbox({ s, onClose }: { s: Shown; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function remove() {
    if (!s.item || !window.confirm(`Delete this ${s.kind} from Radar and from Dropbox?`)) return;
    setBusy(true); setError(null);
    try { await apiDelete(`/media/${s.item.id}`); mediaChanged(); onClose(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }
  }
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" role="dialog" aria-label={s.name} onClick={e => e.stopPropagation()} style={{ maxWidth: 920, width: '92vw' }}>
        {s.url && s.kind === 'photo' && <img src={s.url} alt={s.name} style={{ maxWidth: '100%', maxHeight: '70vh', display: 'block', margin: '0 auto', borderRadius: 6 }} />}
        {s.url && s.kind === 'video' && <video src={s.url} controls playsInline preload="metadata" style={{ maxWidth: '100%', maxHeight: '70vh', display: 'block', margin: '0 auto', borderRadius: 6, background: '#000' }} />}
        <div className="acct-region" style={{ marginTop: 8 }}>{s.name}{s.item ? ` · ${sizeText(s.item.size)}` : ''} · {day(s.at)}{s.by ? ` · ${s.by}` : ''}</div>
        {error && <div className="save-msg err" role="alert">{error}</div>}
        <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
          {s.url && <a className="order-link" href={s.url} target="_blank" rel="noopener noreferrer">Open in a new tab</a>}
          {s.item?.canDelete && <button type="button" className="btn secondary" disabled={busy} onClick={remove}>{busy ? 'Deleting…' : 'Delete'}</button>}
          <button type="button" className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

/** Under a log entry: the photos and videos that were attached to it. */
export function ActivityMedia({ accountId, activityId }: { accountId: string; activityId: string }) {
  const { items } = useAccountMedia(accountId);
  const [open, setOpen] = useState<Shown | null>(null);
  const mine = items.filter(i => i.activityId === activityId && !i.fromOld);   // a moved old photo is still shown by the log entry itself, so it is not shown twice
  if (!mine.length) return null;
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
      {mine.map(i => <Tile key={i.id} s={toShown(i)} size={84} onOpen={() => setOpen(toShown(i))} />)}
      {open && <Lightbox s={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

/** A card with every photo and video on the account (the older visit photos too). Not shown at all when there are none. */
export default function MediaGallery({ accountId, legacy = [] }: { accountId: string; legacy?: { id: string; url: string; at: string; by: string | null }[] }) {
  const { items, linksAvailable } = useAccountMedia(accountId);
  const [open, setOpen] = useState<Shown | null>(null);
  const moved = new Set(items.filter(i => i.fromOld && i.url && i.activityId).map(i => i.activityId));   // an old photo that now has a Dropbox copy is shown once, from Dropbox
  const all: Shown[] = [...items.map(toShown), ...legacy.filter(l => !moved.has(l.id)).map(l => ({ key: `old-${l.id}`, kind: 'photo' as const, url: l.url, name: 'Visit photo', at: l.at, by: l.by, missing: false }))].sort((a, b) => b.at.localeCompare(a.at));
  if (!all.length) return null;
  return (
    <div className="card">
      <h3>Photos and videos <span className="acct-region">{all.length}</span></h3>
      {!linksAvailable && <div className="acct-region" style={{ marginBottom: 8 }}>Dropbox is not connected, so the pictures cannot be shown until a manager reconnects it in Settings.</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 12 }}>
        {all.map(s => (
          <div key={s.key} style={{ display: 'grid', gap: 3, justifyItems: 'start' }}>
            <Tile s={s} size={120} onOpen={() => setOpen(s)} />
            <div className="acct-region" style={{ fontSize: 11.5 }}>{day(s.at)}{s.by ? `, ${s.by}` : ''}</div>
          </div>
        ))}
      </div>
      {open && <Lightbox s={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

/** On the log form: choose photos and videos to go with the entry. They are sent when the entry is saved. */
export function AttachmentPicker({ attach }: { attach: Attachments }) {
  const cap = useCapabilities();
  const input = useRef<HTMLInputElement>(null);
  if (!cap) return null;
  if (!cap.enabled) return <div className="acct-region" style={{ marginBottom: 8 }}>Photos and videos: {cap.reason}</div>;
  return (
    <div style={{ marginBottom: 8 }}>
      <input ref={input} type="file" multiple accept="image/*,video/*" aria-label="Choose photos or videos" style={{ display: 'none' }} onChange={e => { attach.add(e.target.files); e.target.value = ''; }} />
      <button type="button" className="btn secondary" disabled={attach.busy} onClick={() => input.current?.click()}>Attach photo or video</button>
      <span className="acct-region" style={{ marginLeft: 8 }}>Saved in the customer's Dropbox folder. Photos up to {cap.maxPhotoMb} MB, videos up to {cap.maxVideoMb} MB.</span>
      {attach.problem && <div className="save-msg err" role="alert" style={{ marginTop: 6 }}>{attach.problem}</div>}
      {attach.files.length > 0 && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8 }}>
          {attach.files.map(a => (
            <div key={a.id} style={{ width: 120, fontSize: 12 }}>
              <div style={{ position: 'relative', width: 120, height: 90 }}>
                <img src={a.preview} alt="" style={{ width: 120, height: 90, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--line)', display: 'block' }} />
                {a.status === 'uploading' && <div aria-label={`Uploading ${a.progress}%`} style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 6, background: 'rgba(0,0,0,.4)' }}><div style={{ width: `${a.progress}%`, height: '100%', background: 'var(--teal, #2a9d8f)' }} /></div>}
              </div>
              <div title={a.file.name} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.file.name}</div>
              <div className="acct-region">{sizeText(a.file.size)}{a.status === 'uploading' ? `, ${a.progress}%` : a.status === 'done' ? ', uploaded' : ''}</div>
              {a.error && <div style={{ color: 'var(--rust, #b3402a)' }}>{a.error}</div>}
              {a.status !== 'uploading' && <button type="button" className="link-btn" onClick={() => attach.remove(a.id)}>Remove</button>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
