import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { apiGet, apiPost } from '../lib/api';
import { useAuth } from '../context/AuthContext';

// Settings: Google Calendar and the Planner, all in one app. Each rep connects THEIR OWN calendar.
//   1. Show my Google Calendar in the Planner (on by default once connected): meetings and
//      appointments appear next to visits and calls. Read only.
//   2. Optional: also put my visits and calls into Google Calendar, for the phone's calendar app.

type Status = {
  configured: boolean; missing: string[]; connected: boolean; connectionOk: boolean; connectionError: string | null; email: string | null;
  enabled: boolean; show: boolean; syncedAt: string | null; error: string | null;
};

// What Google's page sent the rep back with, in words.
const REASONS: Record<string, string> = {
  access_denied: 'You cancelled on Google\'s page, so nothing was connected.',
  expired: 'That sign-in link had expired. Press Connect Google Calendar and try again.',
  no_scope: 'Google Calendar was not connected: the box that allows managing events was not ticked on Google\'s page. Press Connect Google Calendar and tick it.',
  no_refresh: 'Google did not give a lasting sign-in. Press Connect Google Calendar and try again.',
  wrong_domain: 'Please connect your company Google account, not a personal one.',
  no_code: 'Google did not send anything back. Press Connect Google Calendar and try again.',
  failed: 'Something went wrong connecting Google Calendar. Try again, and if it keeps happening tell a manager.',
};

export default function CalendarSyncCard({ go = (url: string) => window.location.assign(url) }: { go?: (url: string) => void }) {
  const { role } = useAuth();
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [leaving, setLeaving] = useState(false);

  const load = () => apiGet('/calendar/status').then(setStatus).catch(() => {});
  useEffect(() => { load(); }, []);

  // Coming back from Google: say what happened, then tidy the address.
  useEffect(() => {
    const g = params.get('calendar'); if (!g) return;
    setMsg(g === 'connected'
      ? { ok: true, text: 'Google Calendar is connected. Your meetings now show in the Planner.' }
      : { ok: false, text: REASONS[params.get('reason') ?? ''] ?? REASONS.failed });
    const next = new URLSearchParams(params); next.delete('calendar'); next.delete('reason'); setParams(next, { replace: true });
  }, []);

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label); setMsg(null);
    try { await fn(); } catch (e: any) { setMsg({ ok: false, text: e.message }); } finally { setBusy(null); load(); }
  }
  const connect = () => run('connect', async () => { const r = await apiGet('/calendar/connect'); go(r.url); });
  const toggle = (enabled: boolean) => run('toggle', async () => {
    const r = await apiPost('/calendar/enable', { enabled });
    const res = r?.result;
    setMsg(res?.skipped ? { ok: false, text: res.skipped } : { ok: true, text: enabled ? `Connected. ${res?.created ?? 0} events added to your calendar.` : 'Turned off. The CRM events have been removed from your calendar.' });
  });
  const setShow = (enabled: boolean) => run('show', async () => {
    await apiPost('/calendar/show', { enabled });
    setMsg({ ok: true, text: enabled ? 'Your Google Calendar events now show in the Planner.' : 'Google Calendar events are hidden from the Planner.' });
  });
  const syncNow = () => run('sync', async () => {
    const r = await apiPost('/calendar/sync', {});
    setMsg(r?.skipped ? { ok: false, text: r.skipped } : { ok: true, text: `Up to date: ${r.created} added, ${r.updated} updated, ${r.deleted} removed.` });
  });
  const disconnect = () => run('disconnect', async () => {
    await apiPost('/calendar/disconnect', {}); setLeaving(false);
    setMsg({ ok: true, text: 'Disconnected. The visits and calls the CRM added to your calendar were removed.' });
  });

  if (!status) return null;
  const problem = status.connected && !status.connectionOk;
  const connectLabel = busy === 'connect' ? 'Opening Google…' : problem ? 'Connect Google Calendar again' : 'Connect Google Calendar';

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h3>Google Calendar</h3>
      {msg && <div className={'save-msg ' + (msg.ok ? 'ok' : 'err')} style={{ marginBottom: 10 }} role="status">{msg.text}</div>}

      {!status.configured ? (
        <div className="acct-region">
          Google Calendar is not set up on the server yet. Ask your admin to finish the Google Calendar setup.
          {role === 'manager' && status.missing.length > 0 && <> Still missing on the server: <b>{status.missing.join(', ')}</b>.</>}
        </div>
      ) : !status.connected ? (
        <>
          <div className="acct-region" style={{ marginBottom: 10, maxWidth: 640 }}>
            Connect your Google Calendar to see your meetings next to your visits and calls in the Planner, and, if you want, to put your visits and
            calls into your calendar for your phone. Google words the permission as "view and edit events on all your calendars". The CRM only uses
            your main calendar, and only your own. You can disconnect at any time.
          </div>
          <button className="btn" disabled={!!busy} onClick={connect}>{connectLabel}</button>
        </>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
            <b>{status.email}</b>
            <span className={'pill ' + (problem ? 'rust' : 'teal')}>{problem ? 'Needs reconnecting' : 'Connected'}</span>
          </div>
          {problem && status.connectionError && <div className="save-msg err" style={{ marginBottom: 8 }}>{status.connectionError}</div>}
          {problem && <div style={{ marginBottom: 10 }}><button className="btn" disabled={!!busy} onClick={connect}>{connectLabel}</button></div>}

          <label className="pl-check" style={{ marginBottom: 2 }}>
            <input type="checkbox" checked={status.show} disabled={!!busy || problem} onChange={e => setShow(e.target.checked)} />
            <span><b>Show my Google Calendar in the Planner</b></span>
          </label>
          <div className="acct-region" style={{ margin: '0 0 12px 24px' }}>
            Your meetings and appointments from {status.email ? <b>{status.email}</b> : 'your Google calendar'} appear next to
            your visits and calls, so your whole day is in one place. Only you see them. Edit them in Google.
          </div>

          <label className="pl-check" style={{ marginBottom: 2 }}>
            <input type="checkbox" checked={status.enabled} disabled={!!busy || problem} onChange={e => toggle(e.target.checked)} />
            <span>Also add my visits and calls to Google Calendar <span className="acct-region">(optional)</span></span>
          </label>
          <div className="acct-region" style={{ margin: '0 0 8px 24px' }}>
            For your phone's calendar app: each visit as its own event with the store's address, and each day's calls as one event.
          </div>
          {status.enabled && !problem && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
              <button className="btn secondary" style={{ padding: '6px 14px', fontSize: 12.5 }} disabled={!!busy} onClick={syncNow}>
                {busy === 'sync' ? 'Syncing…' : 'Sync now'}
              </button>
              <span className="acct-region">
                {status.syncedAt ? `Last synced ${new Date(status.syncedAt).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}` : 'Not synced yet'}
              </span>
            </div>
          )}
          {status.error && <div className="save-msg err" style={{ marginTop: 8 }}>Last sync problem: {status.error}</div>}

          <div style={{ marginTop: 10 }}>
            {!leaving ? (
              <button className="btn secondary" disabled={!!busy} onClick={() => setLeaving(true)}>Disconnect</button>
            ) : (
              <div style={{ padding: '10px 12px', background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 6 }}>
                <div style={{ marginBottom: 8 }}>Disconnect Google Calendar? The visits and calls the CRM added to your calendar are removed, and the CRM stops reading your calendar. Your own events are not touched.</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn" disabled={!!busy} onClick={disconnect}>{busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}</button>
                  <button className="btn secondary" disabled={!!busy} onClick={() => setLeaving(false)}>Keep it connected</button>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}