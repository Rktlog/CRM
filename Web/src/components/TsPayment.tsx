import { useEffect, useState, type CSSProperties } from 'react';
import { apiBlobUrl, apiPost } from '../lib/api';
import { $, errMsg, shortDay, type Handoff } from '../lib/tradeshow';
import CameraButton from './CameraCapture';

// How the customer pays, on a trade show order. Two choices: sales sends the payment details later (the default), or the customer paid at the show: say
// bank transfer or card, and add the screenshot. The amount is the order's total, so nobody types it. Confirming then emails sales@ everything in one go
// (the order, the DEAR file, the payment and the screenshot), so there is nothing left to send on WhatsApp.
export type Pay = { mode: 'later' | 'paid'; method: 'bank' | 'card'; file: Blob | null };
const box: CSSProperties = { display: 'grid', gap: 10 };
const choice: CSSProperties = { display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 14, cursor: 'pointer' };

/** A saved screenshot, fetched with the person's sign-in and shown in a window. */
export function ProofButton({ orderId, label = 'View screenshot' }: { orderId: string; label?: string }) {
  const [url, setUrl] = useState<string | null>(null), [err, setErr] = useState<string | null>(null), [busy, setBusy] = useState(false);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  async function open() { setBusy(true); setErr(null); try { setUrl(await apiBlobUrl(`/tradeshow/orders/${orderId}/proof`)); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); } }
  return (
    <>
      <button type="button" className="link-btn" disabled={busy} onClick={open}>{busy ? 'Opening…' : label}</button>
      {err && <span className="save-msg err" role="alert" style={{ marginLeft: 6 }}>{err}</span>}
      {url && (
        <div className="modal-overlay" onClick={() => setUrl(null)}>
          <div className="modal-card" role="dialog" aria-label="Payment screenshot" onClick={e => e.stopPropagation()} style={{ maxWidth: 720, width: '92vw' }}>
            <img src={url} alt="Payment screenshot" style={{ maxWidth: '100%', maxHeight: '75vh', display: 'block', margin: '0 auto', borderRadius: 6 }} />
            <div style={{ marginTop: 10 }}><button type="button" className="btn" onClick={() => setUrl(null)}>Close</button></div>
          </div>
        </div>
      )}
    </>
  );
}

export function PaymentPicker({ pay, onChange, total, savedProof, surchargePct, disabled }: { pay: Pay; onChange: (p: Pay) => void; total: number; savedProof: boolean; surchargePct: number | null; disabled?: boolean }) {
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => { if (!pay.file) { setPreview(null); return; } const u = URL.createObjectURL(pay.file); setPreview(u); return () => URL.revokeObjectURL(u); }, [pay.file]);
  const paid = pay.mode === 'paid';
  return (
    <div className="card" style={{ marginBottom: 0 }}>
      <div className="panel-title">Payment</div>
      <div style={box}>
        <label style={choice}><input type="radio" name="pay-mode" checked={!paid} disabled={disabled} onChange={() => onChange({ ...pay, mode: 'later' })} />
          <span><b>Sales will send the payment details</b><div className="acct-region" style={{ fontSize: 12.5 }}>Nothing is taken at the show. Sales sends the invoice or payment link.</div></span></label>
        <label style={choice}><input type="radio" name="pay-mode" checked={paid} disabled={disabled} onChange={() => onChange({ ...pay, mode: 'paid' })} />
          <span><b>Paid here</b><div className="acct-region" style={{ fontSize: 12.5 }}>The customer paid at the stand. Add the screenshot and sales reconciles it from the email.</div></span></label>
        {paid && (
          <div style={{ display: 'grid', gap: 10, paddingLeft: 24 }}>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              <label style={choice}><input type="radio" name="pay-method" checked={pay.method === 'bank'} disabled={disabled} onChange={() => onChange({ ...pay, method: 'bank' })} /> Bank transfer</label>
              <label style={choice}><input type="radio" name="pay-method" checked={pay.method === 'card'} disabled={disabled} onChange={() => onChange({ ...pay, method: 'card' })} /> Card{surchargePct ? ` (${surchargePct}% surcharge)` : ''}</label>
            </div>
            <div style={{ fontSize: 15 }}>Amount to take: <b>{$(total)}</b> <span className="acct-region">inc GST{pay.method === 'card' && surchargePct ? ', with the card surcharge' : ''}</span></div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <label className="btn secondary" style={{ cursor: 'pointer' }}>Choose screenshot
                <input type="file" accept="image/*" aria-label="Payment screenshot" style={{ display: 'none' }} disabled={disabled}
                  onChange={e => { const f = e.target.files?.[0]; if (f) onChange({ ...pay, file: f }); e.target.value = ''; }} /></label>
              <CameraButton disabled={disabled} label="Take photo" onCapture={f => onChange({ ...pay, file: f })} />
            </div>
            {preview ? <img src={preview} alt="Screenshot chosen" style={{ maxWidth: 180, maxHeight: 180, borderRadius: 6, border: '1px solid var(--line)', objectFit: 'contain' }} />
              : savedProof ? <div className="acct-region" style={{ fontSize: 13 }}>A screenshot is already saved for this order.</div>
              : <div className="acct-region" style={{ fontSize: 13, color: 'var(--amber)' }}>Add the screenshot to confirm.</div>}
          </div>
        )}
      </div>
    </div>
  );
}

/** After confirming: how it was paid, and whether sales has dealt with it. */
export function PaymentSummary({ orderId, h, onChange }: { orderId: string; h: Handoff; onChange: () => void }) {
  const [busy, setBusy] = useState(false), [err, setErr] = useState<string | null>(null);
  async function mark(done: boolean) { setBusy(true); setErr(null); try { await apiPost(`/tradeshow/orders/${orderId}/actioned`, { done }); onChange(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); } }
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="panel-title">Payment and sales</div>
      <div style={{ fontSize: 14.5 }}>
        {h.mode === 'paid' ? <>Paid at the show by <b>{h.method === 'card' ? 'card' : 'bank transfer'}</b>{h.amount != null && <>: <b>{$(h.amount)}</b> inc GST</>}. {h.hasProof && <ProofButton orderId={orderId} />}</> : 'Not paid yet. Sales sends the payment details.'}
      </div>
      <div style={{ marginTop: 8, fontSize: 14, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        {h.actionedAt ? <><span className="pill teal">Done</span><span>{h.actionedBy ? `${h.actionedBy}, ` : ''}{shortDay(h.actionedAt.slice(0, 10))}{h.actionNote ? `: ${h.actionNote}` : ''}</span><button type="button" className="link-btn" disabled={busy} onClick={() => mark(false)}>Put back on To action</button></>
          : <><span className="pill amber">To action</span><button type="button" className="btn secondary" disabled={busy} onClick={() => mark(true)}>{busy ? 'Saving…' : 'Mark done'}</button></>}
      </div>
      {err && <div className="save-msg err" role="alert">{err}</div>}
    </div>
  );
}
