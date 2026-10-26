import { useEffect, useState } from 'react';
import { apiGet, apiPatch, apiPost } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { fmtDate, fmtMoney } from '../lib/types';

// Settings (managers): payment reminder drafts. On the first follow-up day of an unpaid prepayment quote, the CRM makes a DRAFT reminder in the sales
// mailbox. It never sends anything and never marks the follow-up done: a person opens the draft, attaches the quote, checks it and sends it.
type Recent = { id: string; number: string; customer: string; to: string | null; status: 'creating' | 'created' | 'failed'; error: string | null; createdAt: string; link: string | null };
type Status = {
  enabled: boolean; mailbox: string; ready: boolean; problem: string | null; graceDays: number; sample: { subject: string; body: string };
  madeLast7Days: number; failedNow: number; recent: Recent[];
};
type Preview = { quoteId: string; number: string; customer: string; to: string | null; name: string | null; dueOn: string; daysOver: number; remaining: number };
type Result = { created: number; failed: number; eligible: number; alreadyDone: number; stopped: string | null; preview: Preview[]; today: string };

export default function FollowUpDraftsCard() {
  const { role } = useAuth();
  const [st, setSt] = useState<Status | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [preview, setPreview] = useState<Result | null>(null);
  const isManager = role === 'manager';

  const load = () => apiGet('/followup-drafts/settings', { fresh: true }).then((s: Status) => setSt(s)).catch((e: Error) => setMsg({ ok: false, text: e.message }));
  useEffect(() => { if (isManager) load(); }, [isManager]);
  if (!isManager) return null;
  if (!st) return <div className="section"><div className="panel-title">Payment reminder drafts</div>{msg ? <div className="save-msg err" role="alert">Could not load: {msg.text}</div> : <div className="acct-region">Loading…</div>}</div>;

  async function act(key: string, fn: () => Promise<void>) {
    setBusy(key); setMsg(null);
    try { await fn(); await load(); } catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }); } finally { setBusy(null); }
  }
  const toggle = (on: boolean) => {
    if (on && !window.confirm(`Switch on payment reminder drafts? Each morning, a prepayment quote that reaches its first follow-up day gets a draft reminder in ${st.mailbox}. Nothing is ever sent: someone opens the draft, attaches the quote and sends it. Use Preview first to see what today's would be.`)) return;
    act('toggle', async () => { await apiPatch('/followup-drafts/settings', { enabled: on }); setMsg({ ok: true, text: on ? 'Switched on. The next drafts are made early tomorrow morning, or press Make today\'s drafts now.' : 'Switched off. No more drafts will be made.' }); });
  };
  const doPreview = () => act('preview', async () => { setPreview(await apiPost('/followup-drafts/preview', {})); });
  const runNow = () => {
    if (!window.confirm(`Make today's reminder drafts in ${st.mailbox} now? Nothing is sent.`)) return;
    act('run', async () => {
      const r: Result = await apiPost('/followup-drafts/run', {});
      setPreview(null);
      setMsg({ ok: !r.stopped || r.created > 0, text: r.stopped && !r.created ? r.stopped : `${r.created} draft${r.created === 1 ? '' : 's'} made${r.failed ? `, ${r.failed} failed` : ''}${r.alreadyDone ? `, ${r.alreadyDone} already done` : ''}.${r.stopped ? ' ' + r.stopped + '.' : ''}` });
    });
  };
  const over = (n: number) => (n === 0 ? 'due today' : `${n} day${n === 1 ? '' : 's'} over`);

  return (
    <div className="section">
      <div className="panel-title">Payment reminder drafts</div>
      <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 12, maxWidth: 640 }}>
        On the first follow-up day of an unpaid or part-paid <b>prepayment</b> quote, the CRM makes a draft reminder in the <b>{st.mailbox}</b> Gmail, using the team's template.
        It never sends anything and never marks the follow-up done. Someone opens the draft, attaches the quote PDF, checks it and sends it. A quote is only drafted once,
        and one that fell due more than {st.graceDays} days ago is left alone.
      </div>

      <label className="pl-check" style={{ marginBottom: 8 }}>
        <input type="checkbox" checked={st.enabled} disabled={!!busy} onChange={e => toggle(e.target.checked)} />
        <span><b>Make a reminder draft on the first follow-up day</b></span>
      </label>
      <div style={{ marginBottom: 10, fontSize: 13 }}>
        {st.ready
          ? <span className="pill teal">{st.mailbox} is ready</span>
          : <span style={{ color: 'var(--rust)' }} role="alert">{st.problem}</span>}
        {' '}<span className="acct-region">{st.madeLast7Days} draft{st.madeLast7Days === 1 ? '' : 's'} made in the last 7 days{st.failedNow ? `, ${st.failedNow} failed (they are tried again tomorrow)` : ''}.</span>
      </div>

      <details style={{ marginBottom: 12 }}>
        <summary className="acct-region" style={{ cursor: 'pointer' }}>See the email as it will read</summary>
        <div style={{ marginTop: 6, padding: '10px 12px', background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 6, maxWidth: 640, fontSize: 13 }}>
          <div><b>Subject:</b> {st.sample.subject}</div>
          <div style={{ whiteSpace: 'pre-wrap', marginTop: 8 }}>{st.sample.body}</div>
          <div className="acct-region" style={{ marginTop: 8 }}>The name is the order's contact's first name (or "there"). The quote PDF is not attached automatically, and Gmail's own signature is not added to drafts the CRM makes.</div>
        </div>
      </details>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <button className="btn secondary" disabled={!!busy} onClick={doPreview}>{busy === 'preview' ? 'Checking…' : 'Preview today'}</button>
        <button className="btn secondary" disabled={!!busy || !st.enabled || !st.ready} onClick={runNow}>{busy === 'run' ? 'Making drafts…' : "Make today's drafts now"}</button>
      </div>
      {msg && <div className={'save-msg ' + (msg.ok ? 'ok' : 'err')} role={msg.ok ? 'status' : 'alert'} style={{ marginBottom: 10 }}>{msg.text}</div>}

      {preview && (
        <div style={{ marginBottom: 14 }}>
          <div className="stat-label">{preview.eligible === 0 ? 'No drafts would be made today.' : `${preview.eligible} draft${preview.eligible === 1 ? '' : 's'} would be made today (${fmtDate(preview.today)})`}{preview.alreadyDone ? `, ${preview.alreadyDone} already done` : ''}</div>
          {preview.preview.map(p => (
            <div key={p.quoteId} style={{ padding: '5px 0', borderTop: '1px solid var(--line)', fontSize: 13 }}>
              <b>{p.number}</b> · {p.customer} · {fmtMoney(p.remaining)} to pay · <span className="acct-region">{over(p.daysOver)}</span><br />
              <span className="acct-region">{p.to ? <>to {p.to}, "Hi {p.name ?? 'there'},"</> : <span style={{ color: 'var(--rust)' }}>no email address on the order or the account: the draft will have no recipient</span>}</span>
            </div>
          ))}
        </div>
      )}

      {st.recent.length > 0 && (
        <div>
          <div className="stat-label">Latest drafts</div>
          {st.recent.map(r => (
            <div key={r.id} style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '5px 0', borderTop: '1px solid var(--line)', fontSize: 13, flexWrap: 'wrap' }}>
              <span className="acct-region" style={{ minWidth: 70 }}>{fmtDate(r.createdAt)}</span>
              <b>{r.number}</b><span>{r.customer}</span>
              <span className="acct-region">{r.to ?? 'no recipient'}</span>
              {r.status === 'created' && <span className="pill teal">Draft made</span>}
              {r.status === 'creating' && <span className="pill neutral">Being made</span>}
              {r.status === 'failed' && <span className="pill rust" title={r.error ?? ''}>Failed{r.error ? `: ${r.error}` : ''}</span>}
              {r.link && <a href={r.link} target="_blank" rel="noopener noreferrer" className="order-link">Open draft</a>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}