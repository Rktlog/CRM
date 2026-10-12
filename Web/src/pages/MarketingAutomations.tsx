import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiGet, apiPost, apiPut } from '../lib/api';
import { fmtDate } from '../lib/types';
import { num } from '../lib/marketing';
import { MarketingNav, ManagersOnly, SendingBanner, Pill, SendingStatus } from '../components/marketing/Ui';

// The automatic emails: unpaid quote, unpaid invoice, sales invoice, tracking number, abandoned cart.
// Each can be previewed (who would get one right now) before it is switched on.
type Auto = { key: string; name: string; blurb: string; marketing: boolean; waitFrom: string; enabled: boolean; templateId: string | null; templateName: string | null; delayHours: number; repeatDays: number; maxSends: number; sent30: number; waiting: number; failed30: number; lastSent: string | null };
type Template = { id: string; name: string };
type Preview = { willSend: number; skipped: Record<string, number>; rows: { entity: string; to: string | null; name: string; account: string | null; summary: string; reminder: number; skip: string | null }[] };
const inp = { padding: '5px 8px', border: '1px solid var(--line)', borderRadius: 6, font: 'inherit', fontSize: 13, width: 70 } as const;

function AutoCard({ a, templates, status, onSaved }: { a: Auto; templates: Template[]; status: SendingStatus | null; onSaved: () => void }) {
  const [f, setF] = useState({ templateId: a.templateId ?? '', delayHours: String(a.delayHours), repeatDays: String(a.repeatDays), maxSends: String(a.maxSends) });
  const [prev, setPrev] = useState<Preview | null>(null); const [busy, setBusy] = useState<string | null>(null); const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const changed = f.templateId !== (a.templateId ?? '') || f.delayHours !== String(a.delayHours) || f.repeatDays !== String(a.repeatDays) || f.maxSends !== String(a.maxSends);
  const body = () => ({ templateId: f.templateId || undefined, delayHours: Number(f.delayHours), repeatDays: Number(f.repeatDays), maxSends: Number(f.maxSends) });
  async function run(label: string, fn: () => Promise<void>) { setBusy(label); setMsg(null); try { await fn(); } catch (e: any) { setMsg({ ok: false, text: e.message }); } finally { setBusy(null); } }
  const save = () => run('save', async () => { await apiPut(`/marketing/automations/${a.key}`, body()); setMsg({ ok: true, text: 'Saved.' }); onSaved(); });
  const preview = () => run('preview', async () => { if (changed) await apiPut(`/marketing/automations/${a.key}`, body()); setPrev(await apiGet(`/marketing/automations/${a.key}/preview`)); onSaved(); });
  const toggle = () => run('toggle', async () => {
    if (!a.enabled) {
      const p: Preview = await apiGet(`/marketing/automations/${a.key}/preview`); setPrev(p);
      const when = status?.connected ? 'They go out within minutes.' : 'They will go out as soon as email sending is connected.';
      if (!confirm(`Switch on "${a.name}"? ${p.willSend} email${p.willSend === 1 ? ' is' : 's are'} due right now. ${when}`)) return;
    }
    await apiPut(`/marketing/automations/${a.key}`, { ...(changed ? body() : {}), enabled: !a.enabled }); onSaved();
  });
  const days = Number(f.delayHours) >= 48 ? ` (about ${Math.round(Number(f.delayHours) / 24)} days)` : '';
  return (
    <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderLeft: `4px solid ${a.enabled ? '#2f6b5e' : '#cfd3c8'}`, borderRadius: 8, padding: '14px 16px', marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <b style={{ fontSize: 15 }}>{a.name}</b><Pill tone={a.enabled ? 'ok' : 'muted'}>{a.enabled ? 'On' : 'Off'}</Pill>{a.marketing && <Pill tone="muted">Marketing: stops if they unsubscribe</Pill>}
        <button className={a.enabled ? 'btn secondary' : 'btn'} style={{ marginLeft: 'auto' }} disabled={!!busy} onClick={toggle}>{a.enabled ? 'Switch off' : 'Switch on'}</button>
      </div>
      <div className="acct-region" style={{ margin: '4px 0 10px' }}>{a.blurb}</div>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center', fontSize: 13, marginBottom: 8 }}>
        <label>Wait <input aria-label={`${a.name}: wait in hours`} type="number" min={0} value={f.delayHours} onChange={e => setF({ ...f, delayHours: e.target.value })} style={inp} /> hours after {a.waitFrom}{days}</label>
        <label>Send up to <input aria-label={`${a.name}: most emails`} type="number" min={1} max={10} value={f.maxSends} onChange={e => setF({ ...f, maxSends: e.target.value })} style={{ ...inp, width: 56 }} /> {Number(f.maxSends) === 1 ? 'email' : 'emails'}</label>
        {Number(f.maxSends) > 1 && <label>repeating every <input aria-label={`${a.name}: repeat days`} type="number" min={0} value={f.repeatDays} onChange={e => setF({ ...f, repeatDays: e.target.value })} style={{ ...inp, width: 56 }} /> days</label>}
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8, fontSize: 13 }}>
        <label>Design <select aria-label={`${a.name}: design`} value={f.templateId} onChange={e => setF({ ...f, templateId: e.target.value })}>{templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
        <Link to={`/marketing/templates?kind=automation&edit=${f.templateId}`} className="order-link">Edit the wording</Link>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn secondary" disabled={!changed || !!busy} onClick={save}>{busy === 'save' ? 'Saving…' : 'Save changes'}</button>
        <button className="btn secondary" disabled={!!busy} onClick={preview}>{busy === 'preview' ? 'Checking…' : 'Who would get one now?'}</button>
        <span className="acct-region">Last 30 days: <b>{num(a.sent30)}</b> sent{a.waiting > 0 ? `, ${num(a.waiting)} waiting` : ''}{a.failed30 > 0 ? `, ${num(a.failed30)} failed` : ''}{a.lastSent ? `. Last sent ${fmtDate(a.lastSent)}` : ''}</span>
      </div>
      {msg && <div className={'save-msg ' + (msg.ok ? 'ok' : 'err')} style={{ marginTop: 8 }}>{msg.text}</div>}
      {prev && (
        <div style={{ marginTop: 10, borderTop: '1px solid var(--line)', paddingTop: 10 }} aria-label={`${a.name} preview`}>
          <div style={{ fontSize: 13.5, marginBottom: 6 }}><b className="num">{num(prev.willSend)}</b> would get an email right now.
            {Object.entries(prev.skipped).map(([why, n]) => <span key={why} className="acct-region"> {n} skipped: {why}.</span>)}</div>
          {!prev.rows.length ? <div className="acct-region">Nobody is due one right now.</div> : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}><tbody>
              {prev.rows.slice(0, 15).map(r => (
                <tr key={r.entity} style={{ borderTop: '1px solid var(--line)', opacity: r.skip ? 0.6 : 1 }}>
                  <td style={{ padding: '5px 6px' }}>{r.account ?? r.name ?? '—'}</td><td style={{ padding: '5px 6px' }}>{r.to ?? <span className="acct-region">no email</span>}</td><td style={{ padding: '5px 6px' }}>{r.summary}{r.reminder > 1 ? <span className="acct-region"> (reminder {r.reminder})</span> : null}</td>
                  <td style={{ padding: '5px 6px' }}>{r.skip ? <span className="acct-region">Skipped: {r.skip}</span> : <Pill tone="ok">Would send</Pill>}</td></tr>
              ))}</tbody></table>
          )}
          {prev.rows.length > 15 && <div className="acct-region" style={{ marginTop: 4 }}>and {prev.rows.length - 15} more. The first 100 are checked.</div>}
        </div>
      )}
    </div>
  );
}

export default function MarketingAutomations() {
  const [list, setList] = useState<Auto[] | null>(null); const [templates, setTemplates] = useState<Template[]>([]); const [status, setStatus] = useState<SendingStatus | null>(null);
  const [error, setError] = useState<string | null>(null); const [run, setRun] = useState<string | null>(null); const [running, setRunning] = useState(false);
  const load = () => apiGet('/marketing/automations').then(setList).catch(e => setError(e.message));
  useEffect(() => { load(); apiGet('/marketing/templates?kind=automation').then(setTemplates).catch(() => undefined); apiGet('/marketing/status').then(setStatus).catch(() => undefined); }, []);
  async function runNow() {
    setRunning(true); setRun(null);
    try { const r = await apiPost('/marketing/run', {}); const queued = Object.values(r.queued as Record<string, number>).reduce((a, b) => a + b, 0) + (r.campaigns ?? 0);
      setRun(r.connected ? `Checked now. ${num(queued)} queued, ${num(r.sent)} sent.` : `Checked now. ${num(queued)} queued. They will be sent once email sending is connected.`); load(); }
    catch (e: any) { setRun(e.message); } finally { setRunning(false); }
  }
  return (
    <ManagersOnly>
      <h1>Automatic emails</h1><MarketingNav /><SendingBanner status={status} />
      <div className="acct-region" style={{ maxWidth: 780, marginBottom: 12 }}>These send themselves when an order or cart needs one. Each is off until you switch it on, and you can see exactly who would get an email first. Order emails (quote, invoice, tracking) have no unsubscribe link, because they are about the customer's own order. The abandoned cart email is marketing, so it only goes to opted-in contacts and stops if they unsubscribe.</div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
        <button className="btn secondary" disabled={running} onClick={runNow}>{running ? 'Checking…' : 'Check and send now'}</button>
        <span className="acct-region">This also runs by itself every few minutes once sending is connected.</span>{run && <span className="save-msg ok">{run}</span>}
      </div>
      {error && <div className="empty-state">Couldn't load: {error}</div>}
      {!error && !list && <div className="empty-state">Loading…</div>}
      {list?.map(a => <AutoCard key={a.key + a.enabled} a={a} templates={templates} status={status} onSaved={load} />)}
    </ManagersOnly>
  );
}