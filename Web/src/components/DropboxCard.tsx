import { useEffect, useState, type CSSProperties } from 'react';
import { apiGet, apiPost } from '../lib/api';
import { useAuth } from '../context/AuthContext';

// Settings (managers): connect the company's Dropbox once. Photos and videos reps add to a visit or an activity are then saved in each customer's own folder.
type Status = { configured: boolean; missing: string[]; redirectUri: string | null; connected: boolean; status: string | null; email: string | null; name: string | null; lastError: string | null; folders: number; waiting: number; photos: number; videos: number };
type Run = { created: number; failed: number; remaining: number; stopped: string | null };
const box: CSSProperties = { border: '1px solid var(--line)', borderRadius: 6, padding: '10px 12px', display: 'grid', gap: 8 };
const small: CSSProperties = { padding: '4px 11px', fontSize: 12.5 };
const REASON: Record<string, string> = {
  access_denied: 'Dropbox access was not allowed, so nothing was connected.', expired: 'That took too long. Press Connect Dropbox again.', not_manager: 'Only a manager can connect Dropbox.',
  no_refresh: 'Dropbox did not give Radar a lasting sign-in. Try again.', no_code: 'Dropbox did not send the approval back. Try again.', failed: 'Something went wrong while connecting. Try again.',
};
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function DropboxCard() {
  const { role } = useAuth();
  const [s, setS] = useState<Status | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const manager = role === 'manager';
  const load = () => apiGet('/dropbox/status', { fresh: true }).then((d: Status) => { if (!d || typeof d.configured !== 'boolean') throw new Error('The Dropbox settings are not available yet.'); setS(d); setProblem(null); }).catch((e: unknown) => setProblem(msg(e)));
  useEffect(() => {
    if (!manager) return;
    const q = new URLSearchParams(window.location.search), back = q.get('dropbox');
    if (back === 'connected') setNote({ ok: true, text: 'Dropbox is connected.' });
    else if (back === 'error') setNote({ ok: false, text: REASON[q.get('reason') ?? ''] ?? 'Dropbox was not connected.' });
    if (back) window.history.replaceState(null, '', window.location.pathname);
    void load();
  }, [manager]);
  if (!manager) return null;

  async function connect() { setBusy('connect'); setNote(null); try { const r: { url: string } = await apiGet('/dropbox/connect', { fresh: true }); window.location.assign(r.url); } catch (e) { setNote({ ok: false, text: msg(e) }); setBusy(null); } }
  async function folders() {
    setBusy('folders'); setNote(null);
    try { const r: Run = await apiPost('/dropbox/folders/run', {}); setNote({ ok: !r.stopped, text: `Made ${r.created} folder${r.created === 1 ? '' : 's'}${r.failed ? `, ${r.failed} failed` : ''}${r.remaining ? `, ${r.remaining} still to do` : ''}.${r.stopped ? ` ${r.stopped}.` : ''}` }); await load(); }
    catch (e) { setNote({ ok: false, text: msg(e) }); } finally { setBusy(null); }
  }
  async function disconnect() {
    if (!window.confirm('Disconnect Dropbox? Photos and videos already saved stay in Dropbox, but nobody can add or see them in Radar until it is connected again.')) return;
    setBusy('disconnect'); setNote(null);
    try { setS(await apiPost('/dropbox/disconnect', {})); setNote({ ok: true, text: 'Dropbox is disconnected.' }); } catch (e) { setNote({ ok: false, text: msg(e) }); } finally { setBusy(null); }
  }

  return (
    <div className="card" id="dropbox">
      <h3>Dropbox: photos and videos</h3>
      <div className="acct-region" style={{ maxWidth: 760, marginBottom: 10 }}>
        Photos and videos that reps add to a visit or an activity are saved in your company Dropbox, in a folder for each customer (Customers, then the customer's name), and shown on the customer's account.
        Radar can only see its own app folder in Dropbox, nothing else.
      </div>
      {problem && <div className="save-msg err" role="alert">{problem}</div>}
      {!s && !problem && <div className="acct-region">Loading…</div>}
      {s && (
        <div style={box}>
          {!s.configured && (
            <>
              <div><span className="pill neutral">Not set up</span> Dropbox is not set up on the server yet.</div>
              <div className="acct-region">Create a Dropbox app (Scoped access, App folder) and add these settings to the API: <b>{(s.missing ?? []).join(', ') || 'DROPBOX_APP_KEY, DROPBOX_APP_SECRET'}</b>.</div>
              {s.redirectUri && <div className="acct-region">In the Dropbox app, add this as a Redirect URI exactly as written: <b style={{ wordBreak: 'break-all' }}>{s.redirectUri}</b></div>}
            </>
          )}
          {s.configured && !s.connected && (
            <>
              <div><span className="pill neutral">Not connected</span> Sign in to the company Dropbox once. Use the Dropbox user that should own the files (for example the sales@ user).</div>
              {s.redirectUri && <div className="acct-region">The Dropbox app must have this Redirect URI: <b style={{ wordBreak: 'break-all' }}>{s.redirectUri}</b></div>}
              <div><button type="button" className="btn" style={small} disabled={busy !== null} onClick={connect}>{busy === 'connect' ? 'Opening Dropbox…' : 'Connect Dropbox'}</button></div>
            </>
          )}
          {s.configured && s.connected && (
            <>
              <div>
                <span className={`pill ${s.status === 'ok' ? 'teal' : 'amber'}`}>{s.status === 'ok' ? 'Connected' : 'Needs reconnecting'}</span>{' '}
                {s.status === 'ok' ? <>Connected to {s.email ?? s.name ?? 'Dropbox'}.</> : <>Dropbox no longer accepts Radar's sign-in{s.lastError ? ` (${s.lastError})` : ''}. Connect again to carry on.</>}
              </div>
              <div className="acct-region">{s.folders.toLocaleString('en-AU')} customer folders made{s.waiting > 0 ? `, ${s.waiting.toLocaleString('en-AU')} DEAR customers still waiting for one` : ''}. {s.photos.toLocaleString('en-AU')} photos and {s.videos.toLocaleString('en-AU')} videos saved.</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {s.status !== 'ok' && <button type="button" className="btn" style={small} disabled={busy !== null} onClick={connect}>{busy === 'connect' ? 'Opening Dropbox…' : 'Connect again'}</button>}
                {s.status === 'ok' && <button type="button" className="btn secondary" style={small} disabled={busy !== null || s.waiting === 0} title={s.waiting === 0 ? 'Every DEAR customer already has a folder' : undefined} onClick={folders}>{busy === 'folders' ? 'Making folders…' : 'Make folders now'}</button>}
                <button type="button" className="btn secondary" style={small} disabled={busy !== null} onClick={disconnect}>{busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}</button>
              </div>
              <div className="acct-region">Folders are also made by themselves for each new DEAR customer when the schedule is set up (schedule-dropbox-folders.sql), and the first time a file is added for any other customer.</div>
            </>
          )}
          {note && <div className={note.ok ? 'save-msg ok' : 'save-msg err'} role={note.ok ? 'status' : 'alert'}>{note.text}</div>}
        </div>
      )}
    </div>
  );
}
