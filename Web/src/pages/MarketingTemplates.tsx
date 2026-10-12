import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { apiGet, apiPost, apiPut, apiDelete } from '../lib/api';
import { Block } from '../lib/marketing';
import { MarketingNav, ManagersOnly, Pill } from '../components/marketing/Ui';
import BlockEditor, { TagField, useMergeTags } from '../components/marketing/BlockEditor';

// Email designs: reusable layouts for campaigns, and the wording of each automatic email.
type Template = { id: string; name: string; kind: 'campaign' | 'automation'; subject: string; previewText: string; blocks: Block[]; builtin: boolean };

export default function MarketingTemplates() {
  const [params, setParams] = useSearchParams(); const navigate = useNavigate(); const tags = useMergeTags();
  const kind = params.get('kind') === 'automation' ? 'automation' : 'campaign'; const editId = params.get('edit');
  const [list, setList] = useState<Template[] | null>(null); const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Template | null>(null); const [saving, setSaving] = useState(false); const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const load = () => apiGet(`/marketing/templates?kind=${kind}`).then(setList).catch(e => setError(e.message));
  useEffect(() => { setList(null); load(); }, [kind]);
  useEffect(() => { if (!editId) { setDraft(null); return; } apiGet(`/marketing/templates/${editId}`).then(setDraft).catch(e => setError(e.message)); setMsg(null); }, [editId]);

  const go = (p: Record<string, string>) => setParams(p);
  async function create() { try { const r = await apiPost('/marketing/templates', { name: 'New design', kind, subject: '', previewText: '', blocks: [{ id: 'b1', type: 'text', text: 'Hi {{first_name}},\n\n' }] }); await load(); go({ kind, edit: r.id }); } catch (e: any) { alert(e.message); } }
  async function save() { if (!draft) return; setSaving(true); setMsg(null); try { await apiPut(`/marketing/templates/${draft.id}`, draft); setMsg({ ok: true, text: 'Saved.' }); load(); } catch (e: any) { setMsg({ ok: false, text: e.message }); } finally { setSaving(false); } }
  async function duplicate(t: Template) { try { const r = await apiPost(`/marketing/templates/${t.id}/duplicate`, {}); await load(); go({ kind, edit: r.id }); } catch (e: any) { alert(e.message); } }
  async function remove(t: Template) { if (!confirm(`Delete the design "${t.name}"?`)) return; try { await apiDelete(`/marketing/templates/${t.id}`); load(); } catch (e: any) { alert(e.message); } }
  async function useIt(t: Template) { try { const r = await apiPost('/marketing/campaigns', { name: t.name, templateId: t.id }); navigate(`/marketing/campaigns/${r.id}`); } catch (e: any) { alert(e.message); } }

  if (draft && editId) {
    return (
      <ManagersOnly>
        <button className="order-link" style={{ background: 'none', border: 0, cursor: 'pointer', padding: 0 }} onClick={() => go({ kind })}>← All designs</button>
        <h1 style={{ marginTop: 6 }}>{draft.name}</h1><MarketingNav />
        {draft.builtin && draft.kind === 'automation' && <div className="save-msg ok" style={{ marginBottom: 10 }}>This is the wording of an automatic email. Changes apply to every email that uses it from now on.</div>}
        <div style={{ maxWidth: 560, marginBottom: 12 }}>
          <div className="stat-label" style={{ marginBottom: 3 }}>Design name</div>
          <input aria-label="Design name" value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} style={{ width: '100%', padding: '7px 9px', border: '1px solid var(--line)', borderRadius: 6, font: 'inherit', marginBottom: 8 }} />
          <TagField tags={tags} label="Subject line" value={draft.subject} onChange={v => setDraft({ ...draft, subject: v })} />
          <TagField tags={tags} label="Preview text" value={draft.previewText} onChange={v => setDraft({ ...draft, previewText: v })} />
        </div>
        <BlockEditor blocks={draft.blocks} onChange={b => setDraft({ ...draft, blocks: b })} subject={draft.subject} previewText={draft.previewText} kind={draft.kind} />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 14 }}>
          <button className="btn" disabled={saving || !draft.name.trim()} onClick={save}>{saving ? 'Saving…' : 'Save design'}</button>
          {msg && <span className={'save-msg ' + (msg.ok ? 'ok' : 'err')}>{msg.text}</span>}
        </div>
      </ManagersOnly>
    );
  }
  return (
    <ManagersOnly>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}><h1>Templates</h1><button className="btn" onClick={create}>New design</button></div>
      <MarketingNav />
      <div className="tab-bar" style={{ marginBottom: 10 }}>
        <button className={'tab' + (kind === 'campaign' ? ' active' : '')} onClick={() => go({ kind: 'campaign' })}>Campaign designs</button>
        <button className={'tab' + (kind === 'automation' ? ' active' : '')} onClick={() => go({ kind: 'automation' })}>Automatic email designs</button>
      </div>
      {error && <div className="empty-state">Couldn't load designs: {error}</div>}
      {!error && !list && <div className="empty-state">Loading…</div>}
      {list && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: 12 }}>
          {list.map(t => (
            <div key={t.id} style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 8, padding: '12px 14px' }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}><b>{t.name}</b>{t.builtin && <Pill tone="muted">Starter</Pill>}</div>
              <div className="acct-region" style={{ margin: '4px 0 10px', minHeight: 32 }}>{t.subject || 'No subject'}<br />{t.blocks.length} blocks</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => go({ kind, edit: t.id })}>Edit</button>
                {t.kind === 'campaign' && <button className="btn" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => useIt(t)}>Use for a campaign</button>}
                <button className="edit-link" onClick={() => duplicate(t)}>Duplicate</button>
                {!t.builtin && <button className="edit-link" onClick={() => remove(t)}>Delete</button>}
              </div>
            </div>
          ))}
        </div>
      )}
    </ManagersOnly>
  );
}