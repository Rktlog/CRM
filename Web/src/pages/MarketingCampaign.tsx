import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { apiGet, apiPost, apiPut } from '../lib/api';
import { fmtDate } from '../lib/types';
import { AudienceFilter, Block, CAMPAIGN_STATUS, describeFilter, num } from '../lib/marketing';
import { MarketingNav, ManagersOnly, SendingBanner, Pill, Back, SendingStatus } from '../components/marketing/Ui';
import BlockEditor, { TagField, useMergeTags } from '../components/marketing/BlockEditor';
import AudiencePicker from '../components/marketing/AudiencePicker';

// One campaign: what it says, who gets it, then send it now or schedule it.
type Campaign = { id: string; name: string; subject: string; previewText: string; fromName: string | null; replyTo: string | null; blocks: Block[]; audience: AudienceFilter; status: string; scheduledAt: string | null; sentAt: string | null; audienceCount: number; problem: string | null };
type Template = { id: string; name: string; subject: string; previewText: string; blocks: Block[] };
const card = { background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 8, padding: '14px 16px', marginBottom: 14 } as const;
const h = { fontSize: 15, fontWeight: 700, margin: '0 0 10px' } as const;

export default function MarketingCampaign() {
  const { id } = useParams(); const navigate = useNavigate(); const tags = useMergeTags();
  const [c, setC] = useState<Campaign | null>(null); const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<SendingStatus | null>(null); const [templates, setTemplates] = useState<Template[]>([]);
  const [dirty, setDirty] = useState(false); const [busy, setBusy] = useState<string | null>(null); const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [testTo, setTestTo] = useState(''); const [when, setWhen] = useState('');
  const loaded = useRef(false);

  const load = () => apiGet(`/marketing/campaigns/${id}`).then((x: Campaign) => { setC(x); setDirty(false); loaded.current = true; }).catch(e => setError(e.message));
  useEffect(() => { load(); apiGet('/marketing/status').then(setStatus).catch(() => undefined); apiGet('/marketing/templates?kind=campaign').then(setTemplates).catch(() => undefined); }, [id]);
  const edit = (patch: Partial<Campaign>) => { setC(prev => (prev ? { ...prev, ...patch } : prev)); setDirty(true); setNote(null); };

  async function save(): Promise<boolean> {
    if (!c) return false; setBusy('save'); setNote(null);
    try { await apiPut(`/marketing/campaigns/${id}`, { name: c.name, subject: c.subject, previewText: c.previewText, fromName: c.fromName ?? '', replyTo: c.replyTo ?? '', blocks: c.blocks, audience: c.audience }); await load(); setNote({ ok: true, text: 'Saved.' }); return true; }
    catch (e: any) { setNote({ ok: false, text: e.message }); return false; } finally { setBusy(null); }
  }
  async function act(label: string, fn: () => Promise<void>) { setBusy(label); setNote(null); try { await fn(); } catch (e: any) { setNote({ ok: false, text: e.message }); } finally { setBusy(null); } }
  const useDesign = (tid: string) => {
    const t = templates.find(x => x.id === tid); if (!t) return;
    if (c && c.blocks.length > 1 && !confirm(`Replace what you have written with the "${t.name}" design?`)) return;
    edit({ blocks: t.blocks.map(b => ({ ...b })), subject: c?.subject || t.subject, previewText: c?.previewText || t.previewText });
  };
  const send = () => act('send', async () => { if (dirty && !(await save())) return; if (!confirm(`Send "${c!.subject}" to ${num(c!.audienceCount)} people now?`)) return; await apiPost(`/marketing/campaigns/${id}/send`, {}); navigate(`/marketing/campaigns/${id}/report`); });
  const schedule = () => act('schedule', async () => { if (dirty && !(await save())) return; await apiPost(`/marketing/campaigns/${id}/schedule`, { at: new Date(when).toISOString() }); await load(); setNote({ ok: true, text: 'Scheduled.' }); });
  const unschedule = () => act('unschedule', async () => { await apiPost(`/marketing/campaigns/${id}/unschedule`, {}); await load(); });
  const test = () => act('test', async () => { if (dirty && !(await save())) return; await apiPost(`/marketing/campaigns/${id}/test`, { to: testTo }); setNote({ ok: true, text: `A test email is on its way to ${testTo}.` }); });

  if (error) return <ManagersOnly><div className="empty-state">Couldn't load this campaign: {error}</div></ManagersOnly>;
  if (!c) return <div className="empty-state">Loading…</div>;
  const locked = !['draft', 'scheduled'].includes(c.status);
  const checks: { ok: boolean; text: string }[] = [
    { ok: !!c.subject.trim(), text: 'Has a subject line' }, { ok: c.blocks.some(b => b.type !== 'spacer' && b.type !== 'divider'), text: 'Has some content' },
    { ok: c.audienceCount > 0, text: `Goes to ${num(c.audienceCount)} ${c.audienceCount === 1 ? 'person' : 'people'}` },
    { ok: !!status?.ready || (!!status && status.missing.length === 0), text: status && status.missing.length ? `Sender details missing: ${status.missing.join(', ')}` : 'Sender email and business address are set' },
  ];
  const canSend = !locked && checks.every(k => k.ok) && !c.problem && !!status?.connected;

  return (
    <ManagersOnly>
      <Back to="/marketing/campaigns">Campaigns</Back>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0 }}>{c.name || 'Campaign'}</h1><Pill tone={CAMPAIGN_STATUS[c.status]?.tone}>{CAMPAIGN_STATUS[c.status]?.label}</Pill>
        {c.status === 'scheduled' && c.scheduledAt && <span className="acct-region">Goes {fmtDate(c.scheduledAt)} at {new Date(c.scheduledAt).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' })}</span>}
      </div>
      <MarketingNav />
      <SendingBanner status={status} />
      {locked && <div className="save-msg ok" style={{ marginBottom: 12 }}>This campaign has gone out and can't be changed. <Link to={`/marketing/campaigns/${id}/report`} className="order-link">See the report</Link></div>}

      <div style={card}><h2 style={h}>1. Details</h2>
        <div style={{ opacity: locked ? 0.65 : 1, pointerEvents: locked ? 'none' : 'auto' }}>
          <div className="stat-label" style={{ marginBottom: 3 }}>Campaign name (only you see this)</div>
          <input aria-label="Campaign name" value={c.name} onChange={e => edit({ name: e.target.value })} style={{ width: '100%', maxWidth: 420, padding: '7px 9px', border: '1px solid var(--line)', borderRadius: 6, font: 'inherit', marginBottom: 8 }} />
          <TagField tags={tags} label="Subject line" value={c.subject} onChange={v => edit({ subject: v })} placeholder="What the email is about" />
          <TagField tags={tags} label="Preview text (the grey line after the subject in an inbox)" value={c.previewText} onChange={v => edit({ previewText: v })} placeholder="Optional" />
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <div><div className="stat-label" style={{ marginBottom: 3 }}>From name (optional)</div><input aria-label="From name" value={c.fromName ?? ''} onChange={e => edit({ fromName: e.target.value })} placeholder="Rhino Rhino" style={{ padding: '6px 9px', border: '1px solid var(--line)', borderRadius: 6, font: 'inherit' }} /></div>
            <div><div className="stat-label" style={{ marginBottom: 3 }}>Replies go to (optional)</div><input aria-label="Reply to" value={c.replyTo ?? ''} onChange={e => edit({ replyTo: e.target.value })} placeholder="sales@rhinorhino.com.au" style={{ padding: '6px 9px', border: '1px solid var(--line)', borderRadius: 6, font: 'inherit', minWidth: 230 }} /></div>
          </div>
        </div>
      </div>

      <div style={card}><h2 style={h}>2. Who it goes to</h2><AudiencePicker value={c.audience ?? {}} onChange={f => edit({ audience: f })} disabled={locked} /></div>

      <div style={card}><h2 style={h}>3. Content</h2>
        {!locked && (
          <div style={{ marginBottom: 10 }}>
            <select aria-label="Use a design" value="" onChange={e => useDesign(e.target.value)}><option value="">Start from a design…</option>{templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select>{' '}
            <Link to="/marketing/templates" className="order-link" style={{ fontSize: 12.5 }}>Manage designs</Link>
          </div>
        )}
        <div style={{ opacity: locked ? 0.65 : 1, pointerEvents: locked ? 'none' : 'auto' }}>
          <BlockEditor blocks={c.blocks} onChange={b => edit({ blocks: b })} subject={c.subject} previewText={c.previewText} />
        </div>
      </div>

      {!locked && (
        <div style={card}><h2 style={h}>4. Review and send</h2>
          <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 10px' }}>
            {checks.map(k => <li key={k.text} style={{ fontSize: 13.5, padding: '2px 0' }}><span style={{ color: k.ok ? '#2f6b5e' : '#a2402a', fontWeight: 700 }}>{k.ok ? '✓' : '✗'}</span> {k.text}</li>)}
            {c.problem && <li style={{ fontSize: 13.5, color: '#a2402a' }}>✗ {c.problem}</li>}
          </ul>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
            <button className="btn secondary" disabled={!dirty || busy === 'save'} onClick={save}>{busy === 'save' ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}</button>
            <input aria-label="Send a test to" placeholder="Send a test to (email)" value={testTo} onChange={e => setTestTo(e.target.value)} style={{ padding: '6px 9px', border: '1px solid var(--line)', borderRadius: 6, font: 'inherit', fontSize: 13, minWidth: 200 }} />
            <button className="btn secondary" disabled={!testTo.includes('@') || !status?.connected || !!busy} title={status?.connected ? '' : 'Needs the email service to be connected'} onClick={test}>Send test</button>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input aria-label="Send at" type="datetime-local" value={when} onChange={e => setWhen(e.target.value)} style={{ padding: '6px 9px', border: '1px solid var(--line)', borderRadius: 6, font: 'inherit', fontSize: 13 }} />
            <button className="btn secondary" disabled={!when || !checks.every(k => k.ok) || !!busy} onClick={schedule}>{c.status === 'scheduled' ? 'Change time' : 'Schedule'}</button>
            {c.status === 'scheduled' && <button className="btn secondary" disabled={!!busy} onClick={unschedule}>Stop scheduling</button>}
            <button className="btn" style={{ marginLeft: 'auto' }} disabled={!canSend || !!busy} title={status?.connected ? '' : 'Needs the email service to be connected'} onClick={send}>{busy === 'send' ? 'Sending…' : 'Send now'}</button>
          </div>
          {!status?.connected && <div className="acct-region" style={{ marginTop: 8 }}>Sending and test emails switch on once the email service is connected. Scheduling works now: it goes out at that time once connected.</div>}
          {note && <div className={'save-msg ' + (note.ok ? 'ok' : 'err')} style={{ marginTop: 10 }}>{note.text}</div>}
        </div>
      )}
      <div className="acct-region">{describeFilter(c.audience)}.</div>
    </ManagersOnly>
  );
}