import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { apiGet, apiPost, apiDelete } from '../lib/api';
import { fmtDate } from '../lib/types';
import { CAMPAIGN_STATUS, num, pct } from '../lib/marketing';
import { MarketingNav, ManagersOnly, Pill } from '../components/marketing/Ui';

type Row = { id: string; name: string; subject: string; status: string; scheduledAt: string | null; sentAt: string | null; updatedAt: string; sent: number; delivered: number; openRate: number; clickRate: number; waiting: number };
type Template = { id: string; name: string; subject: string };

export default function MarketingCampaigns() {
  const [params, setParams] = useSearchParams(); const navigate = useNavigate();
  const [rows, setRows] = useState<Row[] | null>(null); const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'all' | 'draft' | 'scheduled' | 'sent'>('all');
  const [templates, setTemplates] = useState<Template[]>([]);
  const [name, setName] = useState(''); const [templateId, setTemplateId] = useState(''); const [creating, setCreating] = useState(false); const [formError, setFormError] = useState<string | null>(null);
  const showNew = params.get('new') === '1';
  const load = () => apiGet('/marketing/campaigns').then(setRows).catch(e => setError(e.message));
  useEffect(() => { load(); apiGet('/marketing/templates?kind=campaign').then(setTemplates).catch(() => undefined); }, []);

  async function create() {
    setCreating(true); setFormError(null);
    try { const r = await apiPost('/marketing/campaigns', { name, templateId: templateId || undefined }); navigate(`/marketing/campaigns/${r.id}`); }
    catch (e: any) { setFormError(e.message); setCreating(false); }
  }
  async function duplicate(id: string) { try { const r = await apiPost(`/marketing/campaigns/${id}/duplicate`, {}); navigate(`/marketing/campaigns/${r.id}`); } catch (e: any) { alert(e.message); } }
  async function remove(r: Row) { if (!confirm(`Delete the draft "${r.name}"?`)) return; try { await apiDelete(`/marketing/campaigns/${r.id}`); load(); } catch (e: any) { alert(e.message); } }

  const shown = (rows ?? []).filter(r => tab === 'all' || (tab === 'sent' ? ['sent', 'sending'].includes(r.status) : r.status === tab));
  const th = { fontWeight: 600, fontSize: 12, color: 'var(--muted)', textAlign: 'left' as const, padding: '6px 8px' }; const td = { padding: '8px', fontSize: 13, borderTop: '1px solid var(--line)' };
  return (
    <ManagersOnly>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}><h1>Campaigns</h1><button className="btn" onClick={() => setParams({ new: '1' })}>Create campaign</button></div>
      <MarketingNav />
      {showNew && (
        <div className="section" style={{ maxWidth: 560 }}>
          <div className="panel-title">New campaign</div>
          <label className="modal-field">Name (only you see this)<input value={name} onChange={e => setName(e.target.value)} placeholder="Spring arrivals" autoFocus /></label>
          <label className="modal-field">Start from a design
            <select value={templateId} onChange={e => setTemplateId(e.target.value)}><option value="">A blank email</option>{templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
          {formError && <div className="login-error" style={{ marginBottom: 8 }}>{formError}</div>}
          <div style={{ display: 'flex', gap: 8 }}><button className="btn secondary" onClick={() => setParams({})}>Cancel</button><button className="btn" disabled={creating || !name.trim()} onClick={create}>{creating ? 'Creating…' : 'Create and open'}</button></div>
        </div>
      )}
      <div className="tab-bar" style={{ marginBottom: 10 }}>
        {([['all', 'All'], ['draft', 'Drafts'], ['scheduled', 'Scheduled'], ['sent', 'Sent']] as const).map(([k, l]) => <button key={k} className={'tab' + (tab === k ? ' active' : '')} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {error && <div className="empty-state">Couldn't load campaigns: {error}</div>}
      {!error && !rows && <div className="empty-state">Loading…</div>}
      {rows && !shown.length && <div className="empty-state">{rows.length ? 'Nothing here.' : 'No campaigns yet. Create your first one.'}</div>}
      {shown.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}><thead><tr><th style={th}>Campaign</th><th style={th}>Status</th><th style={th}>Date</th><th style={th}>Emails</th><th style={th}>Opened</th><th style={th}>Clicked</th><th style={th}></th></tr></thead>
          <tbody>{shown.map(r => {
            const done = ['sent', 'sending'].includes(r.status);
            return (
              <tr key={r.id}>
                <td style={td}><Link to={done ? `/marketing/campaigns/${r.id}/report` : `/marketing/campaigns/${r.id}`} className="order-link"><b>{r.name}</b></Link><div className="acct-region">{r.subject || 'No subject yet'}</div></td>
                <td style={td}><Pill tone={CAMPAIGN_STATUS[r.status]?.tone}>{CAMPAIGN_STATUS[r.status]?.label ?? r.status}</Pill>{r.waiting > 0 && <div className="acct-region">{num(r.waiting)} waiting</div>}</td>
                <td style={td}>{r.status === 'scheduled' && r.scheduledAt ? `Goes ${fmtDate(r.scheduledAt)}` : r.sentAt ? fmtDate(r.sentAt) : `Edited ${fmtDate(r.updatedAt)}`}</td>
                <td style={td}>{done ? num(r.sent) : '—'}</td><td style={td}>{done ? pct(r.openRate) : '—'}</td><td style={td}>{done ? pct(r.clickRate) : '—'}</td>
                <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button className="edit-link" onClick={() => duplicate(r.id)}>Duplicate</button>{' '}
                  {(r.status === 'draft' || r.status === 'cancelled') && <button className="edit-link" onClick={() => remove(r)}>Delete</button>}
                </td>
              </tr>
            );
          })}</tbody></table>
      )}
    </ManagersOnly>
  );
}