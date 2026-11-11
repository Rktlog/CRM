import { useEffect, useState, type CSSProperties } from 'react';
import { apiGet, apiPatch, apiPost } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { requestsChanged, type RequestItem } from '../lib/productRequests';
import { enquiriesChanged, useEnquiries } from '../lib/supplierEnquiries';

// On each request card (managers): ask the supplier about availability and lead time.
// - "Email supplier" makes a DRAFT in the manager's own Gmail, to the supplier's address from Settings. Radar never sends it: the manager checks it and presses send in Gmail.
// - Radar then looks at that one email thread to see when it was sent and when the supplier replied. If the manager has switched on "Summarise emails with Claude", Claude
//   proposes what the supplier said; the manager confirms or corrects it, and only then does the person who asked see it. Otherwise the manager types the answer.
type Options = { contacts: { supplier: string; emails: number }[]; suggested: string | null; others: { id: string; itemName: string; sku: string | null; qty: number | null; suggested: string | null }[] };
const small: CSSProperties = { padding: '4px 11px', fontSize: 12.5 };
const input: CSSProperties = { padding: '5px 9px', border: '1px solid var(--line)', borderRadius: 3, font: 'inherit', fontSize: 13 };
const norm = (s: string | null | undefined) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const day = (iso: string) => new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });

function EnquiryForm({ item, onDone }: { item: RequestItem; onDone: () => void }) {
  const [opts, setOpts] = useState<Options | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [supplier, setSupplier] = useState('');
  const [extra, setExtra] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ link: string | null; duplicate: boolean } | null>(null);
  useEffect(() => {
    apiGet(`/supplier-enquiries/options?requestId=${item.id}`, { fresh: true }).then((o: Options) => {
      setOpts(o);
      const guess = o.contacts.filter(c => c.emails > 0).find(c => norm(c.supplier) === norm(o.suggested));
      setSupplier(guess?.supplier ?? '');
      setExtra(new Set(o.others.filter(x => guess && norm(x.suggested) === norm(guess.supplier)).map(x => x.id)));
    }).catch((e: Error) => setErr(e.message));
  }, [item.id]);
  const withEmail = opts?.contacts.filter(c => c.emails > 0) ?? [];
  const same = (opts?.others ?? []).filter(o => supplier && norm(o.suggested) === norm(supplier));
  const pick = (s: string) => { setSupplier(s); setExtra(new Set((opts?.others ?? []).filter(o => s && norm(o.suggested) === norm(s)).map(o => o.id))); };
  async function create() {
    setBusy(true); setErr(null);
    try {
      const r: { link: string | null; duplicate: boolean } = await apiPost('/supplier-enquiries', { supplier, requestIds: [item.id, ...same.filter(o => extra.has(o.id)).map(o => o.id)] });
      setDone({ link: r.link, duplicate: r.duplicate }); enquiriesChanged();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }
  if (done) return (
    <div className="save-msg ok" role="status">
      {done.duplicate ? 'You already have a draft for exactly these. ' : 'The draft is ready in your Gmail. '}Check it and press send there: Radar never sends it.{' '}
      {done.link && <a href={done.link} target="_blank" rel="noopener noreferrer">Open the draft in Gmail</a>}{' '}
      <button type="button" className="link-btn" onClick={onDone}>Close</button>
    </div>
  );
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 6, padding: '8px 10px', display: 'grid', gap: 8, background: 'var(--bg)' }}>
      {!opts && !err && <div className="acct-region">Loading…</div>}
      {opts && withEmail.length === 0 && <div className="acct-region">No supplier has an email address yet. Add one in Settings, under Email alerts and supplier contacts.</div>}
      {opts && withEmail.length > 0 && (
        <>
          <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>Which supplier?
            <select aria-label="Supplier" value={supplier} onChange={e => pick(e.target.value)} style={{ ...input, maxWidth: 320 }}>
              <option value="">Choose a supplier</option>
              {withEmail.map(c => <option key={c.supplier} value={c.supplier}>{c.supplier}</option>)}
            </select>
          </label>
          {!supplier && opts.suggested && <div className="acct-region">This looks like it is from {opts.suggested}, which is not in your supplier list yet (Settings, Email alerts and supplier contacts).</div>}
          {same.length > 0 && (
            <div style={{ display: 'grid', gap: 3, fontSize: 13 }}>
              <span>Also ask about these open requests for the same supplier:</span>
              {same.map(o => (
                <label key={o.id} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input type="checkbox" checked={extra.has(o.id)} onChange={e => setExtra(prev => { const n = new Set(prev); if (e.target.checked) n.add(o.id); else n.delete(o.id); return n; })} />
                  {o.itemName}{o.sku ? ` (${o.sku})` : ''}{o.qty ? `, ${o.qty.toLocaleString('en-AU')} units` : ''}
                </label>
              ))}
            </div>
          )}
        </>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        {withEmail.length > 0 && <button type="button" className="btn" style={small} disabled={busy || !supplier} onClick={create}>{busy ? 'Making the draft…' : 'Create draft in my Gmail'}</button>}
        <button type="button" className="btn secondary" style={small} disabled={busy} onClick={onDone}>Cancel</button>
      </div>
      {err && <div className="save-msg err" role="alert">{err}</div>}
    </div>
  );
}

function ProposedAnswer({ item, enquiryId, text, onBusy }: { item: RequestItem; enquiryId: string; text: string; onBusy: (b: boolean) => void }) {
  const [t, setT] = useState(text);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function act(action: 'confirm' | 'dismiss') {
    setBusy(true); onBusy(true); setErr(null);
    try { await apiPost(`/supplier-enquiries/${enquiryId}/answers/${item.id}`, { action, text: action === 'confirm' ? t : undefined }); enquiriesChanged(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); onBusy(false); }
  }
  return (
    <div style={{ display: 'grid', gap: 6, border: '1px solid var(--line)', borderRadius: 6, padding: '8px 10px', background: 'var(--bg)' }}>
      <div style={{ fontSize: 13 }}><b>Radar read the supplier's reply and suggests this answer.</b> Check it against the email, change it if it is wrong, then confirm it. {item.requestedBy.name ?? 'The person who asked'} only sees it once you do.</div>
      <input value={t} onChange={e => setT(e.target.value)} maxLength={300} aria-label="What the supplier said" style={{ ...input, width: '100%' }} />
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="btn" style={small} disabled={busy || !t.trim()} onClick={() => act('confirm')}>{busy ? 'Saving…' : `Confirm and show to ${item.requestedBy.name ?? 'the requester'}`}</button>
        <button type="button" className="btn secondary" style={small} disabled={busy} onClick={() => act('dismiss')}>Not right</button>
      </div>
      {err && <div className="save-msg err" role="alert">{err}</div>}
    </div>
  );
}

export default function SupplierEmail({ item }: { item: RequestItem }) {
  const { role } = useAuth();
  const s = useEnquiries(role === 'manager');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [typed, setTyped] = useState(item.supplierAnswer ?? '');
  if (role !== 'manager') return null;
  const enq = s.byRequest.get(item.id);
  const mine = enq?.items.find(i => i.requestId === item.id);
  const showTyped = !!enq || item.status === 'asked_supplier' || item.status === 'supplier_replied' || !!item.supplierAnswer;

  async function check() {
    if (!enq) return;
    setBusy('check'); setErr(null);
    try { await apiPost(`/supplier-enquiries/${enq.id}/check`, {}); enquiriesChanged(); } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  }
  async function saveTyped() {
    setBusy('typed'); setErr(null);
    try { await apiPatch(`/product-requests/${item.id}`, { supplierAnswer: typed.trim() || null }); requestsChanged(); } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  }
  return (
    <div style={{ display: 'grid', gap: 6, borderTop: '1px dashed var(--line)', paddingTop: 8 }}>
      {s.loaded && !s.ready && <div className="acct-region">Supplier emails are not set up in the database yet. Ask whoever looks after Radar to run supplier-enquiries.sql.</div>}
      {enq && (
        <div style={{ display: 'grid', gap: 4, fontSize: 13 }}>
          <div>
            <span className={`pill ${enq.status === 'replied' ? 'teal' : 'neutral'}`}>{enq.status === 'drafted' ? 'Draft made' : enq.status === 'sent' ? 'Sent' : 'Supplier replied'}</span>{' '}
            {enq.status === 'drafted' && <>Supplier email drafted for {enq.supplier}. Radar never sends it: check it and press send in Gmail. {enq.draftLink && <a href={enq.draftLink} target="_blank" rel="noopener noreferrer">Open the draft in Gmail</a>}</>}
            {enq.status === 'sent' && <>Sent to {enq.supplier}{enq.sentAt ? ` on ${day(enq.sentAt)}` : ''}. Waiting for a reply.</>}
            {enq.status === 'replied' && <>{enq.supplier} replied{enq.replyAt ? ` on ${day(enq.replyAt)}` : ''}{enq.replyFrom ? ` (${enq.replyFrom})` : ''}.</>}
          </div>
          {enq.checkNote && <div className="acct-region">{enq.checkNote}</div>}
          {enq.status !== 'replied' && <div><button type="button" className="btn secondary" style={small} disabled={busy !== null} onClick={check}>{busy === 'check' ? 'Looking…' : 'Check for a reply'}</button></div>}
          {mine?.answerStatus === 'proposed' && mine.proposedText && <ProposedAnswer key={mine.proposedText} item={item} enquiryId={enq.id} text={mine.proposedText} onBusy={b => setBusy(b ? 'answer' : null)} />}
          {mine?.answerStatus === 'confirmed' && <div className="acct-region">The answer was confirmed, and {item.requestedBy.name ?? 'the requester'} can see it.</div>}
          {mine?.answerStatus === 'dismissed' && <div className="acct-region">The suggested answer was dismissed.</div>}
        </div>
      )}
      {open
        ? <EnquiryForm item={item} onDone={() => setOpen(false)} />
        : (s.ready || !s.loaded) && <div><button type="button" className="btn secondary" style={small} disabled={busy !== null} onClick={() => setOpen(true)}>{enq ? 'Email another supplier…' : 'Email supplier…'}</button></div>}
      {showTyped && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <input value={typed} onChange={e => setTyped(e.target.value)} maxLength={300} placeholder="What the supplier said (the person who asked will see it)" aria-label="What the supplier said, typed by hand"
            style={{ ...input, flex: '1 1 280px' }} />
          {typed.trim() !== (item.supplierAnswer ?? '') && <button type="button" className="btn secondary" style={small} disabled={busy !== null} onClick={saveTyped}>{busy === 'typed' ? 'Saving…' : 'Save'}</button>}
        </div>
      )}
      {err && <div className="save-msg err" role="alert">{err}</div>}
    </div>
  );
}
