import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { supabase } from './supabase';
import { apiGet, apiPost } from './api';

// Photos and videos on accounts, kept in the company Dropbox (a manager connects it once in Settings).
// - A file goes up FIRST, and only then is the log entry made, so a failed upload can never leave a half-saved log. The file is tied to the log entry afterwards.
// - A big photo is made smaller before it is sent (2000 pixels on the long side), so a phone photo is hundreds of KB, not several MB. A video is sent as it is.
const API_URL = import.meta.env.VITE_API_URL;
export type MediaItem = { id: string; accountId: string; activityId: string | null; kind: 'photo' | 'video'; name: string; mime: string; size: number; createdAt: string; by: string | null; mine: boolean; canDelete: boolean; url: string | null; missing: boolean; fromOld?: boolean };
export type Capabilities = { enabled: boolean; reason: string | null; maxPhotoMb: number; maxVideoMb: number };
const UNAVAILABLE: Capabilities = { enabled: false, reason: 'Photos and videos are not available yet.', maxPhotoMb: 30, maxVideoMb: 250 };
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const isVideo = (f: { type: string; name: string }) => /^video\//i.test(f.type) || (!f.type && /\.(mp4|mov|m4v|webm|3gp|mpe?g)$/i.test(f.name));
export const isImage = (f: { type: string; name: string }) => /^image\//i.test(f.type) || (!f.type && /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(f.name));
export const sizeText = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(n >= 10485760 ? 0 : 1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

// ---------- can files be added right now? ----------
let capSnap: Capabilities | null = null, capAt = 0, capLoad: Promise<Capabilities> | null = null;
const capListeners = new Set<() => void>();
export function loadCapabilities(force = false): Promise<Capabilities> {
  if (!force && capSnap && Date.now() - capAt < 60_000) return Promise.resolve(capSnap);
  if (capLoad) return capLoad;
  capLoad = apiGet('/media/capabilities', { fresh: true }).then((c: Capabilities) => c, () => UNAVAILABLE).then(c => { capSnap = c; capAt = Date.now(); capLoad = null; capListeners.forEach(l => l()); return c; });
  return capLoad;
}
export function useCapabilities(): Capabilities | null {
  const c = useSyncExternalStore(cb => { capListeners.add(cb); return () => { capListeners.delete(cb); }; }, () => capSnap);
  useEffect(() => { if (!capSnap || Date.now() - capAt > 60_000) void loadCapabilities(); }, []);
  return c;
}

// ---------- making a photo smaller ----------
/** A big JPEG, PNG or WebP is shrunk to 2000 pixels on its long side as a JPEG. Anything else (a video, a GIF, a phone's HEIC that this browser cannot read) is sent as it is. */
export async function prepareFile(file: File): Promise<File> {
  if (!/^image\/(jpeg|png|webp)$/i.test(file.type)) return file;
  try {
    const bmp = await createImageBitmap(file);
    const long = Math.max(bmp.width, bmp.height);
    if (long <= 2000 && file.size <= 3 * 1048576) { bmp.close?.(); return file; }
    const scale = Math.min(1, 2000 / long), w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d'); if (!ctx) { bmp.close?.(); return file; }
    ctx.drawImage(bmp, 0, 0, w, h); bmp.close?.();
    const blob: Blob | null = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.85));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.[A-Za-z0-9]{1,5}$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch { return file; }
}
/** What to show for a chosen file before it is sent: the photo itself, or a plain "video" tile. */
export function previewUrl(file: File): string {
  if (!isVideo(file)) return URL.createObjectURL(file);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" rx="8" fill="#1f2937"/><polygon points="50,40 50,88 92,64" fill="#fff"/></svg>';
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

// ---------- sending a file ----------
/** Sends one file to Radar, which saves it in the customer's Dropbox folder. */
export async function uploadFile(file: File, o: { accountId: string; activityId?: string; onProgress?: (percent: number) => void }): Promise<MediaItem> {
  const token = (await supabase.auth.getSession()).data.session?.access_token;
  return new Promise<MediaItem>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_URL}/media/upload?${new URLSearchParams({ accountId: o.accountId, ...(o.activityId ? { activityId: o.activityId } : {}) })}`);
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
    xhr.setRequestHeader('X-File-Type', file.type || '');
    xhr.upload.onprogress = e => { if (e.lengthComputable) o.onProgress?.(Math.round((e.loaded / e.total) * 100)); };
    xhr.onload = () => {
      let b: any = {}; try { b = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300 && b.item) { mediaChanged(); resolve(b.item as MediaItem); }
      else reject(new Error(typeof b.error === 'string' ? b.error : `The upload failed (${xhr.status}).`));
    };
    xhr.onerror = () => reject(new Error('The upload was interrupted. Check your connection and try again.'));
    xhr.ontimeout = () => reject(new Error('The upload took too long. Check your connection and try again.'));
    xhr.send(file);
  });
}
/** Ties files that were just uploaded to the log entry just made. Never fails: if it cannot, the files are still on the account. */
export async function linkMedia(ids: string[], activityId: string | null | undefined): Promise<void> {
  try { if (ids.length && activityId) await apiPost('/media/link', { mediaIds: ids, activityId }); } catch { /* still shown on the account */ }
  mediaChanged();
}
/** For the Log a visit window: sends the chosen file to Dropbox when Dropbox is connected (true), or says it is not for a photo (false: the old way is used), or refuses a video that cannot be saved. */
export async function sendIfDropbox(file: File, accountId: string, ids: string[]): Promise<boolean> {
  const cap = await loadCapabilities();
  if (!cap.enabled) {
    if (isVideo(file)) throw new Error(`Videos are saved to Dropbox. ${cap.reason ?? 'Ask a manager to connect Dropbox in Settings.'}`);
    return false;
  }
  const f = await prepareFile(file);
  const limit = (isVideo(f) ? cap.maxVideoMb : cap.maxPhotoMb) * 1048576;
  if (f.size > limit) throw new Error(`That ${isVideo(f) ? 'video' : 'photo'} is too big (${isVideo(f) ? cap.maxVideoMb : cap.maxPhotoMb} MB at most).${isVideo(f) ? ' Trim it or record it at a lower quality.' : ''}`);
  ids.push((await uploadFile(f, { accountId })).id);
  return true;
}

// ---------- an account's files, shared by everything on the page ----------
let version = 0; const verListeners = new Set<() => void>();
/** Tells every part of the page showing files to look again. */
export function mediaChanged() { version++; verListeners.forEach(l => l()); }
type Data = { items: MediaItem[]; linksAvailable: boolean };
const shared = new Map<string, { v: number; p: Promise<Data> }>();
function loadShared(accountId: string, v: number): Promise<Data> {
  const hit = shared.get(accountId); if (hit && hit.v === v) return hit.p;
  const p = apiGet(`/media?accountId=${accountId}`, { fresh: true }).then((d: Data) => ({ items: d.items ?? [], linksAvailable: d.linksAvailable !== false }), () => ({ items: [], linksAvailable: true }));
  shared.set(accountId, { v, p }); return p;
}
/** The account's photos and videos. One request serves every part of the page that asks. */
export function useAccountMedia(accountId: string | undefined): Data & { loaded: boolean } {
  const v = useSyncExternalStore(cb => { verListeners.add(cb); return () => { verListeners.delete(cb); }; }, () => version);
  const [state, setState] = useState<Data & { loaded: boolean }>({ items: [], linksAvailable: true, loaded: false });
  useEffect(() => {
    if (!accountId) return; let live = true;
    void loadShared(accountId, v).then(d => { if (live) setState({ ...d, loaded: true }); });
    return () => { live = false; };
  }, [accountId, v]);
  return state;
}

// ---------- files chosen on the log form ----------
export type Attached = { id: string; file: File; preview: string; status: 'ready' | 'uploading' | 'done' | 'error'; progress: number; mediaId?: string; error?: string };
export const MAX_ATTACHED = 10;
let attachSeq = 0;
/** The files chosen on the log form. They are uploaded when the log is saved, before the log entry is made. */
export function useAttachments() {
  const cap = useCapabilities();
  const [files, setFiles] = useState<Attached[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const ref = useRef(files); ref.current = files;
  const patch = (id: string, p: Partial<Attached>) => setFiles(fs => fs.map(f => (f.id === id ? { ...f, ...p } : f)));
  function add(list: FileList | File[] | null) {
    const incoming = Array.from(list ?? []); if (!incoming.length) return;
    const problems: string[] = [], keep: Attached[] = [];
    for (const f of incoming) {
      const video = isVideo(f);
      if (!video && !isImage(f)) { problems.push(`"${f.name}" is not a photo or a video.`); continue; }
      const limitMb = video ? (cap?.maxVideoMb ?? 250) : (cap?.maxPhotoMb ?? 30);
      if (f.size > limitMb * 1048576) { problems.push(`"${f.name}" is too big (${limitMb} MB at most).${video ? ' Trim it or record it at a lower quality.' : ''}`); continue; }
      if (ref.current.length + keep.length >= MAX_ATTACHED) { problems.push(`Up to ${MAX_ATTACHED} files at a time.`); break; }
      keep.push({ id: `att-${++attachSeq}`, file: f, preview: previewUrl(f), status: 'ready', progress: 0 });
    }
    setProblem(problems.length ? problems.join(' ') : null);
    if (keep.length) setFiles(fs => [...fs, ...keep]);
  }
  const revoke = (a: Attached) => { if (a.preview.startsWith('blob:')) URL.revokeObjectURL(a.preview); };
  function remove(id: string) { const a = ref.current.find(f => f.id === id); if (a) revoke(a); setFiles(fs => fs.filter(f => f.id !== id)); setProblem(null); }
  function clear() { ref.current.forEach(revoke); setFiles([]); setProblem(null); }
  /** Sends the files that are not yet sent, one at a time. If one fails it returns null (the reason is shown with the files) and nothing should be logged; the ones already sent are kept, so trying again sends only the rest. */
  async function uploadAll(accountId: string): Promise<string[] | null> {
    const ids: string[] = []; setProblem(null);
    for (const a of [...ref.current]) {
      if (a.status === 'done' && a.mediaId) { ids.push(a.mediaId); continue; }
      patch(a.id, { status: 'uploading', progress: 0, error: undefined });
      try {
        const item = await uploadFile(await prepareFile(a.file), { accountId, onProgress: p => patch(a.id, { progress: p }) });
        patch(a.id, { status: 'done', progress: 100, mediaId: item.id }); ids.push(item.id);
      } catch (e) {
        patch(a.id, { status: 'error', error: msg(e) });
        setProblem(`"${a.file.name}" could not be uploaded: ${msg(e)} Nothing was logged. Remove it or try again.`);
        return null;
      }
    }
    return ids;
  }
  useEffect(() => () => { ref.current.forEach(revoke); }, []);
  return { files, problem, add, remove, clear, uploadAll, busy: files.some(f => f.status === 'uploading') };
}
export type Attachments = ReturnType<typeof useAttachments>;
