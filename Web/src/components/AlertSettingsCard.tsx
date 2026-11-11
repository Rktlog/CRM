import { useEffect, useState, type CSSProperties } from 'react';
import { apiDelete, apiGet, apiPost, apiPut } from '../lib/api';
import { useAuth } from '../context/AuthContext';

// Settings (managers): who gets each email alert, the supplier contacts, and what was sent lately. Every list starts OFF; nothing is emailed until a manager turns it on.
// Alerts go out from the company mailbox, only to the addresses typed here.
type ListInfo = { kind: string; label: string; about: string; enabled: boolean; addresses: string[] };
type Contact = { id: string; supplier: string; emails: string[]; cc: string[]; notes: string | null };
type LogRow = { kind: string; to: string[]; subject: string; ok: boolean; error: string | null; at: string };
type State = { ready: boolean; sandbox: boolean; testAddress: string | null; mailbox: { email: string; ready: boolean; problem: string | null }; lists: ListInfo[]; contacts: Contact[]; recent: LogRow[] };

const input: CSSProperties = { padding: '5px 9px', border: '1px solid var(--line)', borderRadius: 3, font: 'inherit', fontSize: 13, width: '100%', maxWidth: 420 };
const small: CSSProperties = { padding: '4px 12px', fontSize: 12.5 };
const box: CSSProperties = { border: '1px solid var(--line)', borderRadius: 6, padding: '10px 12px', background: 'var(--panel)', display: 'grid', gap: 8 };
const when = (iso: string) => new Date(iso).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

function ListEditor({ list, onChange }: { list: ListInfo; onChange: (s: State) => void }) {
  const [enabled, setEnabled] = useState(list.enabled);
  const [text, setText] = useState(list.addresses.join('\n'));
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const changed = enabled !== list.enabled || text.split(/[\s,;]+/).filter(Boolean).join('\n') !== list.addresses.join('\n');
  async function save() {
    setBusy('save'); setMsg(null);
    try { onChange(await apiPut(`/alert-settings/lists/${list.kind}`, { enabled, addresses: text })); setMsg({ ok: true, text: 'Saved.' }); }
    catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
    finally { setBusy(null); }
  }
  async function test() {
    setBusy('test'); setMsg(null);
    try {
      const r: { sent: boolean; reason: string; to: string | null } = await apiPost(`/alert-settings/test/${list.kind}`, {});
      setMsg(r.sent ? { ok: true, text: `A test email was sent to ${r.to}. Check that inbox.` } : { ok: false, text: `The test was not sent: ${r.reason}` });
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
    finally { setBusy(null); }
  }
  return (
    <div style={box}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <b>{list.label}</b>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} /> On</label>
        <span className="acct-region">{list.about}</span>
      </div>
      <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>Send to (one address per line)
        <textarea value={text} onChange={e => setText(e.target.value)} rows={3} aria-label={`${list.label}: who it goes to`} style={input} />
      </label>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn" style={small} disabled={busy !== null || !changed} onClick={save}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
        <button type="button" className="btn secondary" style={small} disabled={busy !== null || changed} title={changed ? 'Save first' : undefined} onClick={test}>{busy === 'test' ? 'Sending…' : 'Send me a test'}</button>
      </div>
      {msg && <div className={msg.ok ? 'save-msg ok' : 'save-msg err'} role={msg.ok ? 'status' : 'alert'}>{msg.text}</div>}
    </div>
  );
}

function ContactEditor({ contact, onChange, onDone }: { contact: Contact | null; onChange: (s: State) => void; onDone: () => void }) {
  const [supplier, setSupplier] = useState(contact?.supplier ?? '');
  const [emails, setEmails] = useState((contact?.emails ?? []).join('\n'));
  const [cc, setCc] = useState((contact?.cc ?? []).join('\n'));
  const [notes, setNotes] = useState(contact?.notes ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function save() {
    setBusy(true); setErr(null);
    try { onChange(await apiPut('/alert-settings/contacts', { id: contact?.id, supplier, emails, cc, notes })); onDone(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }
  return (
    <div style={box}>
      <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>Supplier name (as it appears in DEAR) <input value={supplier} onChange={e => setSupplier(e.target.value)} maxLength={120} style={input} /></label>
      <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>Email addresses to write to (one per line) <textarea value={emails} onChange={e => setEmails(e.target.value)} rows={2} style={input} /></label>
      <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>Copy to (one per line, optional) <textarea value={cc} onChange={e => setCc(e.target.value)} rows={2} style={input} /></label>
      <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>Notes (optional) <input value={notes} onChange={e => setNotes(e.target.value)} maxLength={500} style={input} /></label>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="btn" style={small} disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save supplier'}</button>
        <button type="button" className="btn secondary" style={small} disabled={busy} onClick={onDone}>Cancel</button>
      </div>
      {err && <div className="save-msg err" role="alert">{err}</div>}
    </div>
  );
}

export default function AlertSettingsCard() {
  const { role } = useAuth();
  const [s, setS] = useState<State | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  useEffect(() => { if (role === 'manager') apiGet('/alert-settings', { fresh: true }).then(setS).catch((e: Error) => setErr(e.message)); }, [role]);
  if (role !== 'manager') return null;

  async function remove(c: Contact) {
    if (!window.confirm(`Remove ${c.supplier} from the supplier list?`)) return;
    try { setS(await apiDelete(`/alert-settings/contacts/${c.id}`)); } catch (e) { setErr((e as Error).message); }
  }
  return (
    <div className="section" id="email-alerts">
      <div className="panel-title">Email alerts and supplier contacts</div>
      <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 12, maxWidth: 640 }}>
        Radar can email the team when something needs their attention. Alerts go from the company mailbox and only to the addresses you type here, never to a customer. Every list starts off.
      </div>
      {err && <div className="save-msg err" role="alert">{err}</div>}
      {!s && !err && <div className="acct-region">Loading…</div>}
      {s && !s.ready && <div className="save-msg err" role="alert">{s.mailbox.problem}</div>}
      {s && s.ready && (
        <div style={{ display: 'grid', gap: 12, maxWidth: 720 }}>
          {s.sandbox && <div className="save-msg err" role="status">Sandbox test mode: every alert goes only to {s.testAddress ?? 'nobody (no test address is set, so nothing is sent)'}, never to the addresses below.</div>}
          <div className={s.mailbox.ready ? 'save-msg ok' : 'save-msg err'} role="status">
            {s.mailbox.ready ? `Sending from ${s.mailbox.email}: connected and able to send.` : s.mailbox.problem}
          </div>
          {s.lists.map(l => <ListEditor key={l.kind + l.enabled + l.addresses.join()} list={l} onChange={setS} />)}

          <div className="stat-label" style={{ marginTop: 6 }}>Supplier contacts</div>
          <div className="acct-region">Used for the draft email asking a supplier about availability and lead time.</div>
          {s.contacts.length === 0 && editing !== 'new' && <div className="acct-region">No suppliers yet.</div>}
          {s.contacts.map(c => editing === c.id
            ? <ContactEditor key={c.id} contact={c} onChange={setS} onDone={() => setEditing(null)} />
            : (
              <div key={c.id} style={{ ...box, gridTemplateColumns: '1fr auto', alignItems: 'center' }}>
                <div><b>{c.supplier}</b> <span className="acct-region">{c.emails.join(', ')}{c.cc.length ? ` (copy: ${c.cc.join(', ')})` : ''}{c.notes ? ` · ${c.notes}` : ''}</span></div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button type="button" className="btn secondary" style={small} onClick={() => setEditing(c.id)}>Edit</button>
                  <button type="button" className="btn secondary" style={small} onClick={() => remove(c)}>Remove</button>
                </div>
              </div>
            ))}
          {editing === 'new'
            ? <ContactEditor contact={null} onChange={setS} onDone={() => setEditing(null)} />
            : <div><button type="button" className="btn secondary" style={small} onClick={() => setEditing('new')}>Add a supplier</button></div>}

          <div className="stat-label" style={{ marginTop: 6 }}>Sent lately</div>
          {s.recent.length === 0 && <div className="acct-region">Nothing has been sent yet.</div>}
          {s.recent.map((r, i) => (
            <div key={i} style={{ fontSize: 13, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
              <span className={`pill ${r.ok ? 'teal' : 'rust'}`}>{r.ok ? 'Sent' : 'Not sent'}</span>
              <span>{r.subject}</span>
              <span className="acct-region">{when(r.at)} · to {r.to.join(', ') || 'nobody'}{r.error ? ` · ${r.error}` : ''}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
