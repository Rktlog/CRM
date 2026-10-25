import { FormEvent, useEffect, useState } from 'react';
import { apiGet, apiPost } from '../lib/api';
import DictationTextarea from './DictationTextarea';

// On an account: write an email and put it in MY Gmail Drafts. Nothing is sent from the CRM. The draft opens in Gmail, where I
// read it, change it and press Send myself. Needs Gmail connected, and drafts allowed (a separate permission, asked for here).
type Status = { configured: boolean; connected: boolean; canDraft: boolean; email: string | null };

export default function DraftEmailButton({ accountId, accountName, defaultTo, go = (url: string) => window.location.assign(url) }: {
  accountId: string; accountName: string; defaultTo?: string | null; go?: (url: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [to, setTo] = useState(defaultTo ?? '');
  const [cc, setCc] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null | undefined>(undefined);   // undefined = not made yet; null = made, no link

  const loadStatus = () => apiGet('/gmail/status').then((s: Status) => setStatus(s)).catch(e => setError(e instanceof Error ? e.message : String(e)));
  useEffect(() => { if (open) { setError(null); loadStatus(); } }, [open]);

  const close = () => { setOpen(false); setLink(undefined); setError(null); };
  async function allowDrafts() {
    setBusy(true); setError(null);
    try { const r = await apiGet('/gmail/connect?drafts=1'); go(r.url); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const r = await apiPost('/gmail/draft', { to, cc, subject, body, accountId });
      setLink(r?.link ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      loadStatus();   // if the permission was taken away, the page goes back to offering Allow drafts
    } finally { setBusy(false); }
  }
  const again = () => { setLink(undefined); setSubject(''); setBody(''); setCc(''); setTo(defaultTo ?? ''); };

  return (
    <>
      <div style={{ margin: '0 0 12px' }}>
        <button type="button" className="btn secondary" onClick={() => setOpen(true)}>Draft email</button>
      </div>
      {open && (
        <div className="modal-overlay" onClick={close}>
          <div className="modal-card" role="dialog" aria-label={`Draft an email to ${accountName}`} onClick={e => e.stopPropagation()} style={{ maxWidth: 560 }}>
            <h3 style={{ marginTop: 0 }}>Draft an email to {accountName}</h3>

            {!status && !error && <div className="acct-region">Checking your Gmail…</div>}
            {error && <div className="save-msg err" style={{ marginBottom: 10 }} role="alert">{error}</div>}

            {status && !status.configured && <div className="acct-region">Gmail is not set up on the server yet. Ask your admin to finish the Gmail setup.</div>}
            {status && status.configured && !status.connected && (
              <div className="acct-region">Connect your Gmail first: <a href="/settings" className="order-link">Settings</a>.</div>
            )}
            {status && status.configured && status.connected && !status.canDraft && (
              <>
                <div className="acct-region" style={{ marginBottom: 10 }}>
                  To put drafts in your Gmail, allow drafts once. Google will ask you to tick a box. The CRM only ever <b>creates drafts</b>: it never sends an email,
                  and you read and send each one yourself from Gmail.
                </div>
                <button type="button" className="btn" disabled={busy} onClick={allowDrafts}>{busy ? 'Opening Google…' : 'Allow drafts'}</button>
              </>
            )}

            {status && status.configured && status.connected && status.canDraft && link === undefined && (
              <form onSubmit={submit}>
                <label className="modal-field">To<input value={to} onChange={e => setTo(e.target.value)} placeholder="name@shop.com.au, separate several with commas" /></label>
                <label className="modal-field">Cc (optional)<input value={cc} onChange={e => setCc(e.target.value)} /></label>
                <label className="modal-field">Subject<input value={subject} onChange={e => setSubject(e.target.value)} maxLength={300} /></label>
                <label className="modal-field">Email
                  <DictationTextarea value={body} onChange={setBody} rows={8} placeholder="Write it, or press the microphone and say it" />
                </label>
                <div className="acct-region" style={{ margin: '4px 0 8px' }}>This goes into the Drafts folder of {status.email}. Nothing is sent.</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="submit" className="btn" disabled={busy || !to.trim() || !subject.trim() || !body.trim()}>{busy ? 'Creating…' : 'Create draft in Gmail'}</button>
                  <button type="button" className="btn secondary" onClick={close}>Cancel</button>
                </div>
              </form>
            )}

            {link !== undefined && (
              <>
                <div className="save-msg ok" style={{ marginBottom: 10 }} role="status">The draft is in your Gmail Drafts. Nothing has been sent: open it, check it and send it from there.</div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  {link && <a href={link} target="_blank" rel="noopener noreferrer" className="btn">Open draft in Gmail</a>}
                  <button type="button" className="btn secondary" onClick={again}>Draft another</button>
                  <button type="button" className="btn secondary" onClick={close}>Close</button>
                </div>
              </>
            )}

            {!(status?.configured && status.connected && status.canDraft && link === undefined) && link === undefined && (
              <div style={{ marginTop: 10 }}><button type="button" className="btn secondary" onClick={close}>Close</button></div>
            )}
          </div>
        </div>
      )}
    </>
  );
}