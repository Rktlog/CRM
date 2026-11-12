import { useEffect, useRef, useState } from 'react';
import { apiGet, apiPost, apiPut } from '../lib/api';
import DictationTextarea from './DictationTextarea';

// Write an email to a customer and send it from Radar, in one place, with the log written for you.
// - It goes out from YOUR Gmail, after you press Send on a read-only review. Radar never sends anything else.
// - Nothing happens until you switch on "Let Radar send emails I write here" (once). Until then you can still save the email as a draft in your Gmail, as before.
// - On an account it is logged as an Email activity; on an abandoned cart it is logged as Emailed in that cart's log. You do not enter anything by hand.
export type Target = { kind: 'account'; accountId: string } | { kind: 'cart'; cartKey: string };
export type CartLogEntry = { id: string; method: string; note: string; at: string; by: string | null; mine: boolean };
export type SendResult = { ok: boolean; duplicate: boolean; logged: boolean; messageId: string; activityId: string | null; cartLog: CartLogEntry | null; warning: string | null };
type Status = { configured: boolean; connected: boolean; status: string | null; canCompose: boolean; allowSend: boolean; email: string | null; signature: string };
type Step = 'compose' | 'review' | 'sent' | 'drafted';

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const newId = () => String(globalThis.crypto?.randomUUID?.() ?? `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`).replace(/[^A-Za-z0-9_-]/g, '');
const withSig = (body: string, sig: string) => (sig.trim() ? `${body.replace(/\s+$/, '')}\n\n${sig.trim()}` : body);

/** A friendly starting email about the items left in an abandoned cart. */
export function cartDefaults(contact: string | null | undefined, items: { productName: string; quantity: number }[]): { defaultSubject: string; defaultBody: string } {
  const first = String(contact ?? '').trim().split(/\s+/)[0] ?? '';
  const hello = /^[A-Za-z][A-Za-z'-]{1,24}$/.test(first) ? first : 'there';
  const list = items.slice(0, 8).map(i => `- ${i.quantity} x ${i.productName}`);
  if (items.length > 8) list.push(`- and ${items.length - 8} more`);
  return {
    defaultSubject: 'Your cart at Rhino Rhino',
    defaultBody: `Hi ${hello},\n\nI noticed you left these in your cart:\n\n${list.join('\n')}\n\nWould you like a hand finishing the order, or do you have any questions about the products? Just reply to this email.\n`,
  };
}

type ModalProps = { target: Target; name: string; defaultTo?: string | null; defaultSubject?: string; defaultBody?: string; onSent?: (r: SendResult) => void; go?: (url: string) => void };

export function EmailComposerModal({ open, onClose, target, name, defaultTo, defaultSubject = '', defaultBody = '', onSent, go = (u: string) => window.location.assign(u) }: ModalProps & { open: boolean; onClose: () => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [step, setStep] = useState<Step>('compose');
  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unknown, setUnknown] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [result, setResult] = useState<SendResult | null>(null);
  const [draftLink, setDraftLink] = useState<string | null>(null);
  const [editingSig, setEditingSig] = useState(false);
  const [sigText, setSigText] = useState('');
  const clientId = useRef(newId());   // one per email: pressing Send twice can only ever send it once
  const sending = useRef(false);      // locks the Send button the instant it is pressed, before the screen has had time to update
  const targetBody = target.kind === 'account' ? { accountId: target.accountId } : { cartKey: target.cartKey };
  const knownQuery = target.kind === 'account' ? `accountId=${target.accountId}` : `cartKey=${encodeURIComponent(target.cartKey)}`;

  const loadStatus = () => apiGet('/email-send/status', { fresh: true }).then((s: Status) => setStatus(s)).catch((e: unknown) => setError(msg(e)));
  useEffect(() => {
    if (!open) return;
    setStep('compose'); setError(null); setUnknown([]); setConfirmed(false); setResult(null); setDraftLink(null); setEditingSig(false);
    setTo(defaultTo ?? ''); setCc(''); setSubject(defaultSubject); setBody(defaultBody); clientId.current = newId();
    void loadStatus();
    if (!defaultTo) apiGet(`/email-send/known?${knownQuery}`, { fresh: true }).then((d: { known: string[] }) => setTo(prev => prev || (d.known[0] ?? ''))).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  if (!open) return null;

  const close = () => { if (!busy) onClose(); };
  async function allowCompose() { setBusy(true); setError(null); try { const r = await apiGet('/gmail/connect?drafts=1'); go(r.url); } catch (e) { setError(msg(e)); setBusy(false); } }
  async function setAllow(allow: boolean) { setBusy(true); setError(null); try { setStatus(await apiPost('/email-send/allow', { allow })); } catch (e) { setError(msg(e)); } finally { setBusy(false); } }
  async function saveSig() {
    setBusy(true); setError(null);
    try { const r: { signature: string } = await apiPut('/email-send/signature', { signature: sigText }); setStatus(s => (s ? { ...s, signature: r.signature } : s)); setEditingSig(false); }
    catch (e) { setError(msg(e)); } finally { setBusy(false); }
  }
  const ready = !!to.trim() && !!subject.trim() && !!body.trim();
  async function review() {
    setBusy(true); setError(null);
    try { const r: { unknown: string[] } = await apiPost('/email-send/check', { ...targetBody, to, cc }); setUnknown(r.unknown); setConfirmed(false); setStep('review'); }
    catch (e) { setError(msg(e)); } finally { setBusy(false); }
  }
  async function send() {
    if (busy || sending.current) return;
    sending.current = true; setBusy(true); setError(null);
    try {
      const r: SendResult = await apiPost('/email-send/send', { ...targetBody, to, cc, subject, body, clientId: clientId.current, ...(unknown.length ? { confirmUnknown: confirmed } : {}) });
      setResult(r); setStep('sent'); onSent?.(r);
    } catch (e) { setError(msg(e)); void loadStatus(); }
    finally { sending.current = false; setBusy(false); }
  }
  async function saveDraft() {
    setBusy(true); setError(null);
    try { const r = await apiPost('/gmail/draft', { to, cc, subject, body: withSig(body, status?.signature ?? ''), ...(target.kind === 'account' ? { accountId: target.accountId } : {}) }); setDraftLink(r?.link ?? null); setStep('drafted'); }
    catch (e) { setError(msg(e)); void loadStatus(); } finally { setBusy(false); }
  }
  const again = () => { setStep('compose'); setSubject(defaultSubject); setBody(defaultBody); setCc(''); setTo(defaultTo ?? ''); setUnknown([]); setConfirmed(false); setResult(null); setError(null); clientId.current = newId(); };

  const s = status;
  const where = target.kind === 'account' ? 'the activity log on this account' : 'the log on this cart';
  return (
    <div className="modal-overlay" onClick={close}>
      <div className="modal-card" role="dialog" aria-label={`Email ${name}`} onClick={e => e.stopPropagation()} style={{ maxWidth: 600 }}>
        <h3 style={{ marginTop: 0 }}>Email {name}</h3>
        {!s && !error && <div className="acct-region">Checking your Gmail…</div>}
        {error && <div className="save-msg err" style={{ marginBottom: 10 }} role="alert">{error}</div>}
        {s && !s.configured && <div className="acct-region">Gmail is not set up on the server yet. Ask your admin to finish the Gmail setup.</div>}
        {s && s.configured && (!s.connected || s.status !== 'ok') && <div className="acct-region">{s.connected ? 'Your Gmail needs to be connected again' : 'Connect your Gmail first'}: <a href="/settings" className="order-link">Settings</a>.</div>}
        {s && s.configured && s.connected && s.status === 'ok' && !s.canCompose && (
          <>
            <div className="acct-region" style={{ marginBottom: 10 }}>To write emails here, allow it once. Google will ask you to tick a box. After that you choose whether Radar may send for you.</div>
            <button type="button" className="btn" disabled={busy} onClick={allowCompose}>{busy ? 'Opening Google…' : 'Allow'}</button>
          </>
        )}

        {s && s.configured && s.connected && s.status === 'ok' && s.canCompose && step === 'compose' && (
          <>
            {!s.allowSend && (
              <div style={{ border: '1px solid var(--line)', borderRadius: 6, padding: '8px 10px', marginBottom: 10, background: 'var(--bg)' }}>
                <div className="acct-region" style={{ marginBottom: 6 }}>
                  Radar can send this email from your Gmail ({s.email}) and write the log for you, so you do not have to log it by hand. It only sends when you press Send on an email you have reviewed.
                  You can switch it off again at any time.
                </div>
                <button type="button" className="btn" disabled={busy} onClick={() => setAllow(true)}>Let Radar send emails I write here</button>
              </div>
            )}
            <label className="modal-field">To<input value={to} onChange={e => setTo(e.target.value)} placeholder="name@shop.com.au, separate several with commas" /></label>
            <label className="modal-field">Cc (optional)<input value={cc} onChange={e => setCc(e.target.value)} /></label>
            <label className="modal-field">Subject<input value={subject} onChange={e => setSubject(e.target.value)} maxLength={300} /></label>
            <label className="modal-field">Email
              <DictationTextarea value={body} onChange={setBody} rows={8} placeholder="Write it, or press the microphone and say it" />
            </label>
            {!editingSig && (
              <div className="acct-region" style={{ margin: '4px 0 8px', whiteSpace: 'pre-wrap' }}>
                {s.signature ? <>Your signature, added to every email:{'\n'}{s.signature}{' '}</> : 'Emails sent from Radar do not get your Gmail signature. '}
                <button type="button" className="link-btn" onClick={() => { setSigText(s.signature); setEditingSig(true); }}>{s.signature ? 'Change' : 'Add your signature'}</button>
              </div>
            )}
            {editingSig && (
              <div style={{ margin: '4px 0 8px', display: 'grid', gap: 6 }}>
                <textarea value={sigText} onChange={e => setSigText(e.target.value)} rows={4} maxLength={600} aria-label="Your signature" style={{ width: '100%', font: 'inherit' }} />
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" className="btn secondary" disabled={busy} onClick={saveSig}>Save signature</button>
                  <button type="button" className="btn secondary" disabled={busy} onClick={() => setEditingSig(false)}>Cancel</button>
                </div>
              </div>
            )}
            <div className="acct-region" style={{ margin: '4px 0 8px' }}>
              {s.allowSend ? <>Sending goes out from {s.email} and is logged in {where} for you.</> : <>A draft goes into the Drafts folder of {s.email}. Nothing is sent.</>}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {s.allowSend && <button type="button" className="btn" disabled={busy || !ready} onClick={review}>{busy ? 'Checking…' : 'Review and send'}</button>}
              <button type="button" className={s.allowSend ? 'btn secondary' : 'btn'} disabled={busy || !ready} onClick={saveDraft}>Save as draft in Gmail instead</button>
              <button type="button" className="btn secondary" disabled={busy} onClick={close}>Cancel</button>
            </div>
            {s.allowSend && <div style={{ marginTop: 8 }}><button type="button" className="link-btn" style={{ fontSize: 12 }} disabled={busy} onClick={() => setAllow(false)}>Stop Radar sending emails for me</button></div>}
          </>
        )}

        {s && step === 'review' && (
          <>
            <div className="acct-region" style={{ marginBottom: 8 }}>Read it through. This goes straight to the customer and cannot be taken back.</div>
            <div style={{ border: '1px solid var(--line)', borderRadius: 6, padding: '8px 10px', display: 'grid', gap: 4, fontSize: 14 }}>
              <div><b>From:</b> {s.email}</div>
              <div><b>To:</b> {to}</div>
              {cc.trim() && <div><b>Cc:</b> {cc}</div>}
              <div><b>Subject:</b> {subject}</div>
              <div style={{ whiteSpace: 'pre-wrap', borderTop: '1px solid var(--line)', paddingTop: 6, marginTop: 2 }}>{withSig(body, s.signature)}</div>
            </div>
            {unknown.length > 0 && (
              <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', margin: '10px 0 0', fontSize: 13 }}>
                <input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} style={{ marginTop: 3 }} />
                <span>Radar has not seen {unknown.join(', ')} for this customer. I have checked {unknown.length === 1 ? 'that address' : 'those addresses'} and they are right.</span>
              </label>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button type="button" className="btn" disabled={busy || (unknown.length > 0 && !confirmed)} onClick={send}>{busy ? 'Sending…' : 'Send email'}</button>
              <button type="button" className="btn secondary" disabled={busy} onClick={() => setStep('compose')}>Back to edit</button>
            </div>
          </>
        )}

        {step === 'sent' && result && (
          <>
            <div className="save-msg ok" style={{ marginBottom: 10 }} role="status">
              {result.duplicate ? 'That email had already been sent. ' : `Sent from ${s?.email ?? 'your Gmail'}. `}
              {result.logged ? `It is logged in ${where}.` : (result.warning ?? 'It was sent, but the log could not be saved. Add it by hand.')}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="btn secondary" onClick={again}>Write another</button>
              <button type="button" className="btn" onClick={onClose}>Done</button>
            </div>
          </>
        )}

        {step === 'drafted' && (
          <>
            <div className="save-msg ok" style={{ marginBottom: 10 }} role="status">
              The draft is in your Gmail Drafts. Nothing has been sent: open it, check it and send it from there. Because it is sent from Gmail, it is not logged here: log it by hand once sent.
              {draftLink && <> <a href={draftLink} target="_blank" rel="noopener noreferrer">Open the draft in Gmail</a></>}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="btn secondary" onClick={again}>Write another</button>
              <button type="button" className="btn" onClick={onClose}>Done</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** A button (or a small link) that opens the composer. */
export default function EmailButton({ label = 'Email customer', variant = 'button', ...p }: ModalProps & { label?: string; variant?: 'button' | 'link' }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {variant === 'button'
        ? <div style={{ margin: '0 0 12px' }}><button type="button" className="btn secondary" onClick={() => setOpen(true)}>{label}</button></div>
        : <button type="button" className="link-btn" onClick={() => setOpen(true)}>{label}</button>}
      <EmailComposerModal open={open} onClose={() => setOpen(false)} {...p} />
    </>
  );
}
