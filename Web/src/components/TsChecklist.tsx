import { useCallback, useEffect, useState } from 'react';
import { apiDelete, apiGet, apiPatch, apiPost, apiPut } from '../lib/api';
import { errMsg } from '../lib/tradeshow';
import { sel, type ChecklistItem } from '../lib/tsExtra';

// The checklist for a show: before, during and after. It starts from a template (managers can change the template), and each item has an owner and a tick that shows who did it and when.
type Rep = { id: string; name: string };
export default function TsChecklist({ showId, isManager }: { showId: string; isManager: boolean }) {
  const [items, setItems] = useState<ChecklistItem[] | null>(null);
  const [reps, setReps] = useState<Rep[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [section, setSection] = useState('Before the show');
  const [editT, setEditT] = useState<string | null>(null);   // the template, as text, while a manager edits it
  const load = useCallback(() => { apiGet(`/tradeshow/shows/${showId}/checklist`, { fresh: true }).then((x: { items: ChecklistItem[] }) => { setItems(x.items); setErr(null); }).catch(e => setErr(errMsg(e))); }, [showId]);
  useEffect(() => { load(); apiGet('/tradeshow/reps').then((x: { reps: Rep[] }) => setReps(x.reps)).catch(() => {}); }, [load]);
  const run = async (f: () => Promise<unknown>) => { try { await f(); load(); } catch (e) { setErr(errMsg(e)); } };
  const sections = [...new Set((items ?? []).map(i => i.section))];
  const done = (items ?? []).filter(i => i.done).length;
  async function openTemplate() { try { const x = await apiGet('/tradeshow/checklist-template', { fresh: true }); setEditT((x.items as { section: string; item: string }[]).map(i => `${i.section} | ${i.item}`).join('\n')); } catch (e) { setErr(errMsg(e)); } }
  async function saveTemplate() {
    const rows = (editT ?? '').split('\n').map(l => l.trim()).filter(Boolean).map(l => { const [s, ...r] = l.split('|'); return r.length ? { section: s!.trim(), item: r.join('|').trim() } : { section: 'General', item: s!.trim() }; });
    await run(async () => { await apiPut('/tradeshow/checklist-template', { items: rows }); setEditT(null); });
  }
  return (
    <>
      {err && <div className="save-msg err" role="alert">{err}</div>}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        <button type="button" className="btn secondary" onClick={() => run(() => apiPost(`/tradeshow/shows/${showId}/checklist/load`, {}))}>{items && items.length ? 'Add missing items from the template' : 'Start from the template'}</button>
        {isManager && editT === null && <button type="button" className="link-btn" onClick={openTemplate}>Change the template</button>}
        {items && items.length > 0 && <span className="acct-region" style={{ fontSize: 13 }}>{done} of {items.length} done</span>}
      </div>
      {editT !== null && (
        <div className="card" style={{ maxWidth: 760 }}>
          <div className="panel-title">Template</div>
          <div className="acct-region" style={{ fontSize: 13, marginBottom: 6 }}>One item per line, as "Section | Item". This list is copied into each new show.</div>
          <textarea style={{ ...sel, width: '100%', minHeight: 220 }} value={editT} onChange={e => setEditT(e.target.value)} />
          <div style={{ display: 'flex', gap: 10, marginTop: 8 }}><button type="button" className="btn" onClick={saveTemplate}>Save template</button><button type="button" className="btn secondary" onClick={() => setEditT(null)}>Cancel</button></div>
        </div>
      )}
      {items === null && !err && <div className="acct-region">Loading…</div>}
      {items && !items.length && <div className="empty-state">Nothing on the checklist yet. Start from the template.</div>}
      {sections.map(sec => (
        <div key={sec} className="card" style={{ maxWidth: 820 }}>
          <div className="panel-title">{sec}</div>
          {items!.filter(i => i.section === sec).map(i => (
            <div key={i.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--line)', flexWrap: 'wrap' }}>
              <input type="checkbox" checked={i.done} onChange={e => run(() => apiPatch(`/tradeshow/shows/${showId}/checklist/${i.id}`, { done: e.target.checked }))} />
              <span style={{ flex: 1, minWidth: 200, textDecoration: i.done ? 'line-through' : undefined, color: i.done ? 'var(--muted)' : undefined }}>{i.item}{i.done && i.doneBy && <span className="acct-region" style={{ fontSize: 12.5 }}> · {i.doneBy}{i.doneAt ? `, ${new Date(i.doneAt).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}` : ''}</span>}</span>
              <select style={{ ...sel, fontSize: 13, padding: '3px 6px' }} value={i.owner?.id ?? ''} onChange={e => run(() => apiPatch(`/tradeshow/shows/${showId}/checklist/${i.id}`, { ownerId: e.target.value || null }))}><option value="">No owner</option>{reps.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
              <button type="button" className="link-btn" style={{ color: 'var(--rust)' }} onClick={() => run(() => apiDelete(`/tradeshow/shows/${showId}/checklist/${i.id}`))}>Remove</button>
            </div>
          ))}
        </div>
      ))}
      <form style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }} onSubmit={e => { e.preventDefault(); if (text.trim()) run(async () => { await apiPost(`/tradeshow/shows/${showId}/checklist`, { section, item: text }); setText(''); }); }}>
        <select style={sel} value={section} onChange={e => setSection(e.target.value)}>{[...new Set(['Before the show', 'At the show', 'After the show', ...sections])].map(s => <option key={s}>{s}</option>)}</select>
        <input style={{ ...sel, flex: 1, minWidth: 220 }} placeholder="Add an item" value={text} onChange={e => setText(e.target.value)} />
        <button type="submit" className="btn secondary" disabled={!text.trim()}>Add</button>
      </form>
    </>
  );
}
