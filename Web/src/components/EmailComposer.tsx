import { useEffect, useRef, useState } from 'react';
import { apiDelete, apiGet, apiPost, apiPut } from '../lib/api';
import { supabase } from '../lib/supabase';
import DictationTextarea from './DictationTextarea';

// Write an email to a customer and send it from Radar, in one place, with the log written for you.
// - It goes out from YOUR Gmail, after you press Send on a read-only review. Radar never sends anything else.
// - Nothing happens until you switch on "Let Radar send emails I write here" (once). Until then you can still save the email as a draft in your Gmail.
// - It can be about an account, an order or an abandoned cart, and it can be a reply in a conversation. Files can be attached, and your Gmail signature (with its logo) added.
// - On an account it is logged as an Email activity; about an order it is also tied to that order; on an abandoned cart it is logged as Emailed in that cart's log.
export type Target = { kind: 'account'; accountId: string } | { kind: 'cart'; cartKey: string } | { kind: 'order'; orderId: string };
export type CartLogEntry = { id: string; method: string; note: string; at: string; by: string | null; mine: boolean };
export type SendResult = { ok: boolean; duplicate: boolean; logged: boolean; messageId: string; activityId: string | null; cartLog: CartLogEntry | null; warning: string | null; attachments?: number };
type Status = { configured: boolean; connected: boolean; status: string | null; canCompose: boolean; allowSend: boolean; email: string | null; signature: string };
type Sig = { status: 'ok' | 'none' | 'needs_permission' | 'not_connected' | 'error'; html: string | null; text: string | null };
type SigMode = 'gmail' | 'saved' | 'none';
type FileRow = { key: string; name: string; size: number; state: 'uploading' | 'ready' | 'failed'; id?: string; error?: string };
type Step = 'compose' | 'review' | 'sent' | 'drafted';

const API_URL = import.meta.env.VITE_API_URL;
export const MAX_FILES = 8, MAX_FILE = 10 * 1024 * 1024, MAX_TOTAL = 15 * 1024 * 1024;
const BLOCKED = /\.(exe|bat|cmd|com|cpl|dll|js|jse|jar|msi|msp|scr|vbs|vbe|wsf|wsh|ps1|lnk|reg|sh|apk|iso|dmg|hta|pif|scf)$/i;   // what Gmail refuses to deliver
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const newId = () => String(globalThis.crypto?.randomUUID?.() ?? `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`).replace(/[^A-Za-z0-9_-]/g, '');
const sizeText = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Sends one file to wait for the email (it is never kept after the email is sent or the window is closed). */
async function uploadAttachment(file: File): Promise<{ id: string; name: string; size: number }> {
  const token = (await supabase.auth.getSession()).data.session?.access_token;
  const res = await fetch(`${API_URL}/email-send/attachments`, { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name), 'X-File-Type': file.type || '', ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  let b: any = {}; try { b = await res.json(); } catch { /* not JSON */ }
  if (!res.ok || !b.file) throw new Error(typeof b.error === 'string' ? b.error : `The file could not be added (${res.status}).`);
  return b.file;
}

/** A friendly starting email about the items left in an abandoned cart (used only if the team's template cannot be loaded). */
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

type ModalProps = { target: Target; name: string; defaultTo?: string | null; defaultSubject?: string; defaultBody?: string; replyThreadId?: string; onSent?: (r: SendResult) => void; go?: (url: string) => void };

export function EmailComposerModal({ open, onClose, target, name, defaultTo, defaultSubject = '', defaultBody = '', replyThreadId, onSent, go = (u: string) => window.location.assign(u) }: ModalProps & { open: boolean; onClose: () => void }) {
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
  const [sig, setSig] = useState<Sig | null>(null);
  const [sigMode, setSigMode] = useState<SigMode>('none');
  const [files, setFiles] = useState<FileRow[]>([]);
  const [fileNote, setFileNote] = useState<string | null>(null);
  const clientId = useRef(newId());   // one per email: pressing Send twice can only ever send it once
  const sending = useRef(false);      // locks the Send button the instant it is pressed, before the screen has had time to update
  const filesRef = useRef<FileRow[]>([]); filesRef.current = files;
  const targetBody = target.kind === 'account' ? { accountId: target.accountId } : target.kind === 'order' ? { orderId: target.orderId } : { cartKey: target.cartKey };
  const query = target.kind === 'account' ? `accountId=${target.accountId}` : target.kind === 'order' ? `orderId=${target.orderId}` : `cartKey=${encodeURIComponent(target.cartKey)}`;

  const loadStatus = () => apiGet('/email-send/status', { fresh: true }).then((s: Status) => setStatus(s)).catch((e: unknown) => setError(msg(e)));
  useEffect(() => {
    if (!open) return;
    setStep('compose'); setError(null); setUnknown([]); setConfirmed(false); setResult(null); setDraftLink(null); setEditingSig(false); setFiles([]); setFileNote(null); setSig(null);
    setTo(defaultTo ?? ''); setCc(''); setSubject(defaultSubject); setBody(defaultBody); clientId.current = newId();
    void loadStatus();
    if (!defaultTo) apiGet(`/email-send/known?${query}`, { fresh: true }).then((d: { known: string[] }) => setTo(prev => prev || (d.known[0] ?? ''))).catch(() => undefined);
    // the team's template for a cart, and the order number and a greeting for an order (not for a reply: that answers what they wrote)
    if (!replyThreadId && target.kind !== 'account') apiGet(`/email-send/template?${query}`, { fresh: true }).then((t: { subject: string; body: string }) => {
      if (t.subject) setSubject(prev => (prev === defaultSubject ? t.subject : prev));
      if (t.body) setBody(prev => (prev === defaultBody ? t.body : prev));
    }).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  // the signature: the one in Gmail (with its logo) when it can be read, otherwise the one saved here
  useEffect(() => {
    if (!open || !status?.connected || status.status !== 'ok' || !status.canCompose || sig) return;
    apiGet('/email-send/gmail-signature', { fresh: true }).then((g: Sig) => { setSig(g); setSigMode(g.status === 'ok' ? 'gmail' : status.signature ? 'saved' : 'none'); })
      .catch(() => { setSig({ status: 'error', html: null, text: null }); setSigMode(status.signature ? 'saved' : 'none'); });
  }, [open, status, sig]);
  if (!open) return null;

  const uploading = files.some(f => f.state === 'uploading');
  const readyIds = files.filter(f => f.state === 'ready' && f.id).map(f => f.id!);
  const total = files.filter(f => f.state !== 'failed').reduce((t, f) => t + f.size, 0);
  const forgetFiles = (list: FileRow[]) => { for (const f of list) if (f.id) void apiDelete(`/email-send/attachments/${f.id}`).catch(() => undefined); };
  const close = () => { if (busy) return; if (step === 'compose' || step === 'review') forgetFiles(filesRef.current); onClose(); };
  async function addFiles(list: FileList | null) {
    setFileNote(null);
    if (!list?.length) return;
    let running = total, count = files.filter(f => f.state !== 'failed').length; const notes: string[] = [];
    for (const file of Array.from(list)) {
      if (count >= MAX_FILES) { notes.push(`Up to ${MAX_FILES} files on one email.`); break; }
      if (BLOCKED.test(file.name)) { notes.push(`${file.name}: Gmail does not deliver that kind of file (programs and scripts). Zip it, or send it another way.`); continue; }
      if (!file.size) { notes.push(`${file.name} is empty.`); continue; }
      if (file.size > MAX_FILE) { notes.push(`${file.name} is bigger than 10 MB. Send it another way, or make it smaller.`); continue; }
      if (running + file.size > MAX_TOTAL) { notes.push(`${file.name}: together the files can be up to 15 MB.`); continue; }
      running += file.size; count++;
      const key = newId();
      setFiles(prev => [...prev, { key, name: file.name, size: file.size, state: 'uploading' }]);
      uploadAttachment(file).then(r => setFiles(prev => prev.map(f => (f.key === key ? { ...f, state: 'ready', id: r.id, name: r.name } : f))))
        .catch(e => setFiles(prev => prev.map(f => (f.key === key ? { ...f, state: 'failed', error: msg(e) } : f))));
    }
    if (notes.length) setFileNote(notes.join(' '));
  }
  function removeFile(key: string) { const f = files.find(x => x.key === key); if (f) forgetFiles([f]); setFiles(prev => prev.filter(x => x.key !== key)); }
  async function allowCompose() { setBusy(true); setError(null); try { const r = await apiGet('/gmail/connect?drafts=1'); go(r.url); } catch (e) { setError(msg(e)); setBusy(false); } }
  async function setAllow(allow: boolean) { setBusy(true); setError(null); try { setStatus(await apiPost('/email-send/allow', { allow })); } catch (e) { setError(msg(e)); } finally { setBusy(false); } }
  async function saveSig() {
    setBusy(true); setError(null);
    try { const r: { signature: string } = await apiPut('/email-send/signature', { signature: sigText }); setStatus(s => (s ? { ...s, signature: r.signature } : s)); setEditingSig(false); if (sigMode === 'none' && r.signature) setSigMode('saved'); }
    catch (e) { setError(msg(e)); } finally { setBusy(false); }
  }
  const ready = !!to.trim() && !!subject.trim() && !!body.trim() && !uploading;
  const payload = () => ({ ...targetBody, to, cc, subject, body, signatureMode: sigMode, attachmentIds: readyIds, ...(replyThreadId ? { replyThreadId } : {}) });
  async function review() {
    setBusy(true); setError(null);
    try { const r: { unknown: string[] } = await apiPost('/email-send/check', { ...targetBody, to, cc }); setUnknown(r.unknown); setConfirmed(false); setStep('review'); }
    catch (e) { setError(msg(e)); } finally { setBusy(false); }
  }
  async function send() {
    if (busy || sending.current) return;
    sending.current = true; setBusy(true); setError(null);
    try {
      const r: SendResult = await apiPost('/email-send/send', { ...payload(), clientId: clientId.current, ...(unknown.length ? { confirmUnknown: confirmed } : {}) });
      setResult(r); setStep('sent'); setFiles([]); onSent?.(r);
    } catch (e) { setError(msg(e)); void loadStatus(); }
    finally { sending.current = false; setBusy(false); }
  }
  async function saveDraft() {
    setBusy(true); setError(null);
    try { const r = await apiPost('/email-send/draft', payload()); setDraftLink(r?.link ?? null); setStep('drafted'); setFiles([]); }
    catch (e) { setError(msg(e)); void loadStatus(); } finally { setBusy(false); }
  }
  const again = () => { setStep('compose'); setSubject(defaultSubject); setBody(defaultBody); setCc(''); setTo(defaultTo ?? ''); setUnknown([]); setConfirmed(false); setResult(null); setError(null); setFiles([]); clientId.current = newId(); };

  const s = status;
  const where = target.kind === 'account' ? 'the activity log on this account' : target.kind === 'order' ? 'the log of this order and on the account' : 'the log on this cart';
  const sigBlock = (small?: boolean) => sigMode === 'gmail' && sig?.html
    ? <iframe title="Your Gmail signature" sandbox="" srcDoc={`<body style="margin:0;font-family:Arial,sans-serif;font-size:13px">${sig.html}</body>`} style={{ width: '100%', border: 0, height: small ? 90 : 110, background: '#fff' }} />
    : sigMode === 'saved' && s?.signature ? <div style={{ whiteSpace: 'pre-wrap' }}>{s.signature}</div> : null;
  return (
    <div className="modal-overlay" onClick={close}>
      <div className="modal-card" role="dialog" aria-label={`${replyThreadId ? 'Reply to' : 'Email'} ${name}`} onClick={e => e.stopPropagation()} style={{ maxWidth: 640 }}>
        <h3 style={{ marginTop: 0 }}>{replyThreadId ? 'Reply to' : 'Email'} {name}</h3>
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
              <DictationTextarea value={body} onChange={setBody} rows={10} placeholder="Write it, or press the microphone and say it" />
            </label>
            <div className="acct-region" style={{ margin: '-4px 0 8px', fontSize: 12 }}>To make a link, type the words in square brackets and the web address after them in round brackets, like [Rhino Rhino B2B Portal](https://rhinorhino.dearportal.com/).</div>

            <div style={{ margin: '4px 0 10px' }}>
              <label className="acct-region" style={{ display: 'inline-flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
                <span className="link-btn">Attach files</span>
                <input type="file" multiple aria-label="Attach files" style={{ display: 'none' }} disabled={busy} onChange={e => { void addFiles(e.target.files); e.target.value = ''; }} />
                <span style={{ fontSize: 12 }}>up to {MAX_FILES} files, 15 MB in all</span>
              </label>
              {files.length > 0 && (
                <ul style={{ listStyle: 'none', padding: 0, margin: '6px 0 0', display: 'grid', gap: 4 }} aria-label="Attached files">
                  {files.map(f => (
                    <li key={f.key} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 13 }}>
                      <span>📎 {f.name}</span><span className="acct-region">{sizeText(f.size)}</span>
                      {f.state === 'uploading' && <span className="acct-region">adding…</span>}
                      {f.state === 'failed' && <span className="save-msg err" role="alert">{f.error}</span>}
                      <button type="button" className="link-btn" aria-label={`Remove ${f.name}`} onClick={() => removeFile(f.key)}>Remove</button>
                    </li>
                  ))}
                </ul>
              )}
              {fileNote && <div className="save-msg err" role="alert" style={{ marginTop: 4 }}>{fileNote}</div>}
            </div>

            <div style={{ border: '1px solid var(--line)', borderRadius: 6, padding: '8px 10px', margin: '4px 0 8px' }}>
              <label className="acct-region">Signature{' '}
                <select aria-label="Signature" value={sigMode} onChange={e => setSigMode(e.target.value as SigMode)}>
                  {sig?.status === 'ok' && <option value="gmail">My Gmail signature (with its logo)</option>}
                  {s.signature && <option value="saved">My signature saved in Radar</option>}
                  <option value="none">No signature</option>
                </select>
              </label>
              {sig?.status === 'needs_permission' && <div className="acct-region" style={{ fontSize: 12, marginTop: 4 }}>Radar cannot read your Gmail signature yet. <button type="button" className="link-btn" onClick={allowCompose}>Allow it</button> (Google asks you to tick the boxes), or use a signature saved here.</div>}
              {sig?.status === 'none' && <div className="acct-region" style={{ fontSize: 12, marginTop: 4 }}>Your Gmail has no signature set up.</div>}
              <div style={{ marginTop: 6 }}>{sigBlock(true)}</div>
              {!editingSig && <button type="button" className="link-btn" style={{ fontSize: 12 }} onClick={() => { setSigText(s.signature); setEditingSig(true); }}>{s.signature ? 'Change the signature saved in Radar' : 'Save a plain signature in Radar'}</button>}
              {editingSig && (
                <div style={{ margin: '4px 0 0', display: 'grid', gap: 6 }}>
                  <textarea value={sigText} onChange={e => setSigText(e.target.value)} rows={4} maxLength={600} aria-label="Your signature" style={{ width: '100%', font: 'inherit' }} />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button type="button" className="btn secondary" disabled={busy} onClick={saveSig}>Save signature</button>
                    <button type="button" className="btn secondary" disabled={busy} onClick={() => setEditingSig(false)}>Cancel</button>
                  </div>
                </div>
              )}
            </div>
            <div className="acct-region" style={{ margin: '4px 0 8px' }}>
              {s.allowSend ? <>Sending goes out from {s.email} and is logged in {where} for you.</> : <>A draft goes into the Drafts folder of {s.email}. Nothing is sent.</>}
              {replyThreadId && <> It goes into the same conversation in Gmail.</>}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {s.allowSend && <button type="button" className="btn" disabled={busy || !ready} onClick={review}>{busy ? 'Checking…' : uploading ? 'Adding the files…' : 'Review and send'}</button>}
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
              <div style={{ whiteSpace: 'pre-wrap', borderTop: '1px solid var(--line)', paddingTop: 6, marginTop: 2 }}>{body}</div>
              {sigBlock()}
              {readyIds.length > 0 && <div className="acct-region" style={{ borderTop: '1px solid var(--line)', paddingTop: 6 }}>Attached: {files.filter(f => f.state === 'ready').map(f => f.name).join(', ')}</div>}
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
              {result.duplicate ? 'That email had already been sent. ' : `Sent from ${s?.email ?? 'your Gmail'}${result.attachments ? `, with ${result.attachments} file${result.attachments === 1 ? '' : 's'}` : ''}. `}
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

/** A button (or a small link) that opens the composer. "inline" is a button with no space around it, for a page heading. */
export default function EmailButton({ label = 'Email customer', variant = 'button', ...p }: ModalProps & { label?: string; variant?: 'button' | 'link' | 'inline' }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {variant === 'button'
        ? <div style={{ margin: '0 0 12px' }}><button type="button" className="btn secondary" onClick={() => setOpen(true)}>{label}</button></div>
        : variant === 'inline'
          ? <button type="button" className="btn secondary" onClick={() => setOpen(true)}>{label}</button>
          : <button type="button" className="link-btn" onClick={() => setOpen(true)}>{label}</button>}
      <EmailComposerModal open={open} onClose={() => setOpen(false)} {...p} />
    </>
  );
}
