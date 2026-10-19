import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { apiGet, apiPatch, apiPost } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { fmtDate } from '../lib/types';

// Settings: connect MY Gmail so emails to and from customers are logged on their accounts.
// Read only, and only the emails with an address already in the CRM. Never the message itself.
type Status = {
  configured: boolean; missing: string[]; connected: boolean; email: string | null; status: 'ok' | 'needs_reconnect' | 'error' | null; error: string | null;
  connectedAt: string | null; lastSyncAt: string | null; loggingEnabled: boolean; savePreview: boolean; emailsLogged: number;
};
type Teammate = { name: string; email: string; status: string; error: string | null; lastSyncAt: string | null; loggingEnabled: boolean; emailsLogged: number };

// What Google's page sent the rep back with, in words.
const REASONS: Record<string, string> = {
  access_denied: 'You cancelled on Google\'s page, so nothing was connected.',
  expired: 'That sign-in link had expired. Press Connect Gmail and try again.',
  no_scope: 'Gmail was not connected: the box that allows reading email was not ticked on Google\'s page. Press Connect Gmail and tick it.',
  no_refresh: 'Google did not give a lasting sign-in. Press Connect Gmail and try again.',
  wrong_domain: 'Please connect your company Google account, not a personal one.',
  no_code: 'Google did not send anything back. Press Connect Gmail and try again.',
  failed: 'Something went wrong connecting Gmail. Try again, and if it keeps happening tell a manager.',
};

export function timeAgo(iso: string | null, now = Date.now()): string {
  if (!iso) return 'not yet';
  const mins = Math.round((now - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hrs = Math.round(mins / 60);
  return hrs < 48 ? `${hrs} hour${hrs === 1 ? '' : 's'} ago` : fmtDate(iso);
}

export default function GmailCard({ go = (url: string) => window.location.assign(url) }: { go?: (url: string) => void }) {
  const { role } = useAuth();
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState<Status | null>(null);
  const [team, setTeam] = useState<Teammate[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [deleteEmails, setDeleteEmails] = useState(false);

  const load = () => {
    apiGet('/gmail/status').then(setStatus).catch(() => undefined);
    if (role === 'manager') apiGet('/gmail/team').then(setTeam).catch(() => undefined);
  };
  useEffect(() => { load(); }, [role]);

  // Coming back from Google: say what happened, then tidy the address.
  useEffect(() => {
    const g = params.get('gmail'); if (!g) return;
    setMsg(g === 'connected'
      ? { ok: true, text: 'Gmail is connected. It is looking through your last 30 days of email now. Emails with customers will appear on their accounts in a minute or two.' }
      : { ok: false, text: REASONS[params.get('reason') ?? ''] ?? REASONS.failed });
    const next = new URLSearchParams(params); next.delete('gmail'); next.delete('reason'); setParams(next, { replace: true });
  }, []);

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label); setMsg(null);
    try { await fn(); } catch (e: any) { setMsg({ ok: false, text: e.message }); } finally { setBusy(null); load(); }
  }
  const connect = () => run('connect', async () => { const r = await apiGet('/gmail/connect'); go(r.url); });
  const syncNow = () => run('sync', async () => {
    const r = await apiPost('/gmail/sync', {});
    setMsg(r.status === 'ok' ? { ok: true, text: `Checked. ${r.saved === 1 ? '1 new email' : `${r.saved} new emails`} logged${r.removed ? `, ${r.removed === 1 ? '1 email' : `${r.removed} emails`} removed because you marked ${r.removed === 1 ? 'it' : 'them'} Private` : ''}${r.failed ? `, ${r.failed} could not be saved and ${r.failed === 1 ? 'was' : 'were'} skipped` : ''}${r.remaining ? `, ${r.remaining} more still to look through` : ''}.` }
      : r.status === 'paused' ? { ok: false, text: 'Logging is paused. Switch it on first.' } : { ok: false, text: r.error ?? 'Could not check your email just now.' });
  });
  const setLogging = (on: boolean) => run('logging', async () => { await apiPatch('/gmail/settings', { loggingEnabled: on }); setMsg({ ok: true, text: on ? 'Logging is on.' : 'Logging is paused. Nothing new will be logged until you switch it back on.' }); });
  const setPreview = (on: boolean) => {
    if (!on && !window.confirm('Turn off previews? The short previews already kept will be deleted. Subjects stay.')) return;
    run('preview', async () => { await apiPatch('/gmail/settings', { savePreview: on }); setMsg({ ok: true, text: on ? 'Previews are on.' : 'Previews are off, and the ones kept have been deleted.' }); });
  };
  const disconnect = () => run('disconnect', async () => { await apiPost('/gmail/disconnect', { deleteEmails }); setLeaving(false); setDeleteEmails(false); setMsg({ ok: true, text: deleteEmails ? 'Disconnected, and your logged emails were deleted.' : 'Disconnected. The emails already logged stay on the accounts.' }); });

  if (!status) return null;
  const problem = status.connected && status.status !== 'ok';
  const connectLabel = busy === 'connect' ? 'Opening Google…' : problem ? 'Connect Gmail again' : 'Connect Gmail';

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h3>Gmail</h3>
      {msg && <div className={'save-msg ' + (msg.ok ? 'ok' : 'err')} style={{ marginBottom: 10 }} role="status">{msg.text}</div>}

      {!status.configured ? (
        <div className="acct-region">
          Gmail is not set up on the server yet. Ask your admin to finish the Gmail setup.
          {role === 'manager' && status.missing.length > 0 && <> Still missing on the server: <b>{status.missing.join(', ')}</b>.</>}
        </div>
      ) : !status.connected ? (
        <>
          <div className="acct-region" style={{ marginBottom: 10, maxWidth: 640 }}>
            Connect your Gmail so emails to and from your customers are logged on their accounts. The CRM can only <b>read</b> your email, and it keeps
            only emails to or from an address already in the CRM: who it was between, the subject, the date and a short preview. It never keeps the
            message itself, and it ignores everything else, including newsletters. Anyone who can see that customer's account in the CRM (the team for
            that state, and managers) will see those emails' subjects and previews. You can pause it or disconnect at any time. To keep any email or
            conversation out, give it the Gmail label <b>Private</b>: it is never saved.
          </div>
          <button className="btn" disabled={!!busy} onClick={connect}>{connectLabel}</button>
        </>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
            <b>{status.email}</b>
            <span className={'pill ' + (problem ? 'rust' : 'teal')}>{status.status === 'ok' ? 'Working' : status.status === 'needs_reconnect' ? 'Needs reconnecting' : 'Problem'}</span>
          </div>
          <div className="acct-region" style={{ marginBottom: 8 }}>
            Last checked {timeAgo(status.lastSyncAt)}. {status.emailsLogged.toLocaleString('en-AU')} {status.emailsLogged === 1 ? 'email' : 'emails'} logged so far.
          </div>
          {problem && status.error && <div className="save-msg err" style={{ marginBottom: 8 }}>{status.error}</div>}
          {problem && <div style={{ marginBottom: 10 }}><button className="btn" disabled={!!busy} onClick={connect}>{connectLabel}</button></div>}

          <label className="pl-check" style={{ marginBottom: 2 }}>
            <input type="checkbox" checked={status.loggingEnabled} disabled={!!busy} onChange={e => setLogging(e.target.checked)} />
            <span><b>Log my emails with customers</b></span>
          </label>
          <div className="acct-region" style={{ margin: '0 0 8px 24px' }}>Switch off to pause. Nothing new is logged while it is off.</div>
          <label className="pl-check" style={{ marginBottom: 2 }}>
            <input type="checkbox" checked={status.savePreview} disabled={!!busy} onChange={e => setPreview(e.target.checked)} />
            <span><b>Keep a short preview of each email</b></span>
          </label>
          <div className="acct-region" style={{ margin: '0 0 10px 24px' }}>The first line or two, so the account page shows what it was about. Off keeps only the subject.</div>
          <div className="acct-region" style={{ margin: '0 0 12px', maxWidth: 640 }}>
            <b>Keep an email out.</b> In Gmail, make a label called <b>Private</b> and put it on the email, or on the whole conversation. It is never saved here,
            and if it was saved before it is removed the next time the CRM checks (within about 15 minutes). Nobody else can see which emails you marked.
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn secondary" disabled={!!busy || problem} onClick={syncNow}>{busy === 'sync' ? 'Checking…' : 'Check for new emails now'}</button>
            {!leaving && <button className="btn secondary" disabled={!!busy} onClick={() => setLeaving(true)}>Disconnect</button>}
          </div>
          {leaving && (
            <div style={{ marginTop: 10, padding: '10px 12px', background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 6 }}>
              <div style={{ marginBottom: 6 }}>Disconnect Gmail? The CRM stops reading your email and the access is removed from your Google account.</div>
              <label className="pl-check"><input type="checkbox" checked={deleteEmails} onChange={e => setDeleteEmails(e.target.checked)} /><span>Also delete the emails already logged from my mailbox</span></label>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button className="btn" disabled={!!busy} onClick={disconnect}>{busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}</button>
                <button className="btn secondary" disabled={!!busy} onClick={() => { setLeaving(false); setDeleteEmails(false); }}>Keep it connected</button>
              </div>
            </div>
          )}
        </>
      )}

      {role === 'manager' && team.length > 0 && (
        <div style={{ marginTop: 16, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
          <div className="stat-label" style={{ marginBottom: 6 }}>Who has connected Gmail</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <tbody>{team.map(t => (
              <tr key={t.email} style={{ borderTop: '1px solid var(--line)' }}>
                <td style={{ padding: '5px 6px' }}>{t.name}</td><td style={{ padding: '5px 6px' }}>{t.email}</td>
                <td style={{ padding: '5px 6px' }}>{t.status === 'ok' ? (t.loggingEnabled ? 'Working' : 'Paused') : t.status === 'needs_reconnect' ? 'Needs reconnecting' : 'Problem'}</td>
                <td style={{ padding: '5px 6px' }} className="acct-region">checked {timeAgo(t.lastSyncAt)}</td><td style={{ padding: '5px 6px', textAlign: 'right' }}>{t.emailsLogged.toLocaleString('en-AU')}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}