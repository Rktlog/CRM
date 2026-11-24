import { useCallback, useEffect, useRef, useState } from 'react';
import { AddLink, EmailPreview, FillButtons, type SavedLink } from '../components/LinkTools';
import { apiGet, apiPost, clearApiCache } from '../lib/api';
import { useAuth } from '../context/AuthContext';

// Sales Tools: saved links, and saved email templates. Write a link or an email once, and every draft uses it, so a change is made in one place.
// Nothing here sends an email.
type Link = { id: string; name: string; url: string; note: string | null; by: string | null; updatedAt: string };
type Tpl = { key: string; name: string; subject: string; body: string; builtIn: boolean; when: string | null; customised: boolean; locked: boolean; updatedAt: string | null };
type Help = { tag: string; means: string }[];
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const NOT_SET_UP = 'Sales Tools is not set up in the database yet. Ask whoever looks after Radar to run sales-tools.sql.';

export default function SalesTools() {
  const [tab, setTab] = useState<'links' | 'templates'>('links');
  return (
    <>
      <h1>Sales tools</h1>
      <p className="acct-region" style={{ marginTop: 0 }}>Save a link or an email once. Every email draft then uses it, so when something changes you change it in one place.</p>
      <div className="tab-bar">
        <button className={'tab' + (tab === 'links' ? ' active' : '')} onClick={() => setTab('links')}>Links</button>
        <button className={'tab' + (tab === 'templates' ? ' active' : '')} onClick={() => setTab('templates')}>Email templates</button>
      </div>
      {tab === 'links' ? <Links /> : <Templates />}
    </>
  );
}

function Links() {
  const { role } = useAuth();
  const manager = role === 'manager';
  const [links, setLinks] = useState<Link[] | null>(null);
  const [ready, setReady] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [f, setF] = useState({ name: '', url: '', note: '' });
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(() => { apiGet('/sales-tools/links', { fresh: true }).then((d: { ready: boolean; links: Link[] }) => { setReady(d.ready); setLinks(d.links); setError(null); }).catch(e => setError(msg(e))); }, []);
  useEffect(load, [load]);

  const open = (l?: Link) => { setEditing(l ? l.id : 'new'); setF(l ? { name: l.name, url: l.url, note: l.note ?? '' } : { name: '', url: '', note: '' }); setError(null); };
  async function save() {
    setBusy(true); setError(null);
    try { await apiPost(editing === 'new' ? '/sales-tools/links' : `/sales-tools/links/${editing}`, f); clearApiCache(); setEditing(null); load(); }
    catch (e) { setError(msg(e)); } finally { setBusy(false); }
  }
  async function remove(l: Link) {
    if (!window.confirm(`Delete the link "${l.name}"?`)) return;
    setError(null);
    try { await apiPost(`/sales-tools/links/${l.id}/delete`, {}); clearApiCache(); load(); } catch (e) { setError(msg(e)); }
  }
  // "Copy as link" puts the name on the clipboard as a clickable link, so pasting into Gmail shows the name and not the long address.
  async function copy(l: Link, as: 'url' | 'link') {
    try {
      if (as === 'link' && typeof ClipboardItem !== 'undefined') {
        const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
        await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([`<a href="${esc(l.url)}">${esc(l.name)}</a>`], { type: 'text/html' }), 'text/plain': new Blob([l.url], { type: 'text/plain' }) })]);
      } else await navigator.clipboard.writeText(l.url);
      setCopied(l.id + as); setTimeout(() => setCopied(c => (c === l.id + as ? null : c)), 1800);
    } catch { setError('Could not copy. Select the link and copy it by hand.'); }
  }

  if (links === null && !error) return <div className="empty-state">Loading…</div>;
  return (
    <div className="card">
      {!ready && <div className="save-msg err" role="alert">{NOT_SET_UP}</div>}
      {error && <div className="save-msg err" role="alert">{error}</div>}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <h3 style={{ margin: 0 }}>Saved links</h3>
        {ready && editing === null && <button className="btn" onClick={() => open()}>+ Add a link</button>}
      </div>
      <p className="acct-region">Give a link a name, like "Engelite preorder". In an email, pick it from "Add a saved link" and it shows as that name. Make sure a Google Doc is shared as "Anyone with the link can view", or customers will be asked for access.</p>
      {editing !== null && (
        <div style={{ display: 'grid', gap: 8, maxWidth: 620, margin: '8px 0 14px' }}>
          <label className="modal-field">Name<input value={f.name} maxLength={60} onChange={e => setF({ ...f, name: e.target.value })} placeholder="Engelite preorder" /></label>
          <label className="modal-field">Link<input value={f.url} onChange={e => setF({ ...f, url: e.target.value })} placeholder="https://docs.google.com/document/d/..." /></label>
          <label className="modal-field">Note (optional)<input value={f.note} maxLength={300} onChange={e => setF({ ...f, note: e.target.value })} placeholder="Where it is used, or when it expires" /></label>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" disabled={busy || !f.name.trim() || !f.url.trim()} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
            <button className="btn secondary" disabled={busy} onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </div>
      )}
      {ready && links && links.length === 0 && editing === null && <div className="acct-region">No links saved yet.</div>}
      {links && links.length > 0 && (
        <div className="ledger-table-scroll" style={{ overflowX: 'auto' }}>
          <table className="ledger" style={{ width: '100%' }}>
            <thead><tr><th>Name</th><th>Link</th><th>Note</th><th /></tr></thead>
            <tbody>
              {links.map(l => (
                <tr key={l.id}>
                  <td style={{ fontWeight: 500 }}>{l.name}</td>
                  <td style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><a className="order-link" href={l.url} target="_blank" rel="noopener noreferrer" title={l.url}>{l.url}</a></td>
                  <td className="acct-region">{l.note ?? ''}</td>
                  <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                    <button className="link-btn" onClick={() => copy(l, 'link')}>{copied === l.id + 'link' ? 'Copied' : 'Copy as link'}</button>{' '}
                    <button className="link-btn" onClick={() => copy(l, 'url')}>{copied === l.id + 'url' ? 'Copied' : 'Copy address'}</button>{' '}
                    <button className="link-btn" onClick={() => open(l)}>Edit</button>
                    {manager && <>{' '}<button className="link-btn" onClick={() => remove(l)}>Delete</button></>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Templates() {
  const { role } = useAuth();
  const manager = role === 'manager';
  const [data, setData] = useState<{ ready: boolean; templates: Tpl[]; help: Help } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);   // a key, or 'new'
  const [f, setF] = useState({ name: '', subject: '', body: '' });
  const [prev, setPrev] = useState<{ subject: string; body: string; problems: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const [links, setLinks] = useState<SavedLink[]>([]);
  useEffect(() => { apiGet('/sales-tools/links', { fresh: true }).then((d: { links: SavedLink[] }) => setLinks(d.links ?? [])).catch(() => undefined); }, []);

  const load = useCallback(() => { apiGet('/sales-tools/templates', { fresh: true }).then(setData).catch(e => setError(msg(e))); }, []);
  useEffect(load, [load]);

  const cur = data?.templates.find(t => t.key === sel) ?? null;
  const locked = !!cur?.locked && !manager;   // the emails that go out by themselves can only be changed by a manager
  function pick(t: Tpl | 'new') {
    setError(null); setPrev(null); setSaved(false);
    if (t === 'new') { setSel('new'); setF({ name: '', subject: '', body: '' }); } else { setSel(t.key); setF({ name: t.name, subject: t.subject, body: t.body }); }
  }
  useEffect(() => {
    if (sel === null) return;
    const h = setTimeout(() => { apiPost('/sales-tools/templates/preview', { subject: f.subject, body: f.body }).then(setPrev).catch(() => setPrev(null)); }, 350);
    return () => clearTimeout(h);
  }, [sel, f.subject, f.body]);

  async function save() {
    setBusy(true); setError(null); setSaved(false);
    try {
      if (sel === 'new') { const r: { key: string } = await apiPost('/sales-tools/templates', f); setSel(r.key); }
      else await apiPost(`/sales-tools/templates/${sel}`, f);
      clearApiCache(); setSaved(true); load();
    } catch (e) { setError(msg(e)); } finally { setBusy(false); }
  }
  async function remove() {
    if (!cur) return;
    const what = cur.builtIn ? `Go back to the original wording of "${cur.name}"?` : `Delete the template "${cur.name}"?`;
    if (!window.confirm(what)) return;
    setBusy(true); setError(null);
    try { await apiPost(`/sales-tools/templates/${cur.key}/delete`, {}); clearApiCache(); setSel(null); load(); } catch (e) { setError(msg(e)); } finally { setBusy(false); }
  }

  if (!data && !error) return <div className="empty-state">Loading…</div>;
  if (!data) return <div className="save-msg err" role="alert">{error}</div>;
  if (!data.ready) return <div className="card"><div className="save-msg err" role="alert">{NOT_SET_UP}</div></div>;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 280px) 1fr', gap: 16, alignItems: 'start' }} className="tpl-grid">
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Emails</h3>
        <div style={{ display: 'grid', gap: 4 }}>
          {data.templates.map(t => (
            <button key={t.key} className={'btn secondary' + (sel === t.key ? ' active' : '')} style={{ textAlign: 'left', fontWeight: sel === t.key ? 600 : 400 }} onClick={() => pick(t)}>
              {t.name}{t.builtIn && <span className="acct-region" style={{ display: 'block', fontSize: 11.5 }}>{t.customised ? 'Changed by your team' : 'Original wording'}</span>}
            </button>
          ))}
        </div>
        <button className="btn" style={{ marginTop: 10 }} onClick={() => pick('new')}>+ New template</button>
      </div>

      <div className="card">
        {sel === null && <div className="acct-region">Choose an email on the left. The first three are sent by Radar for you (a payment reminder draft, an abandoned cart email, an order email), so they follow the template every time. Add your own, like "Engelite preorder", and pick it from "Start from a saved email" in any email window.</div>}
        {sel !== null && (
          <>
            {cur?.when && <div className="acct-region" style={{ marginBottom: 6 }}>Used for: {cur.when}{locked ? ' Only a manager can change this one.' : ''}</div>}
            {error && <div className="save-msg err" role="alert">{error}</div>}
            {saved && <div className="save-msg" role="status">Saved. New emails follow it from now on.</div>}
            {(sel === 'new' || !cur?.builtIn) && <label className="modal-field">Name<input value={f.name} maxLength={60} disabled={locked} onChange={e => setF({ ...f, name: e.target.value })} placeholder="Engelite preorder" /></label>}
            <label className="modal-field">Subject<input value={f.subject} maxLength={200} disabled={locked} onChange={e => setF({ ...f, subject: e.target.value })} /></label>
            {!locked && (
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', margin: '4px 0 6px' }}>
                <FillButtons getBox={() => box.current} value={f.body} onChange={v => setF(x => ({ ...x, body: v }))} />
                <AddLink getBox={() => box.current} value={f.body} onChange={v => setF(x => ({ ...x, body: v }))} links={links} mode="template" />
              </div>
            )}
            <label className="modal-field">Email<textarea ref={box} value={f.body} rows={14} maxLength={8000} disabled={locked} onChange={e => setF({ ...f, body: e.target.value })} style={{ width: '100%', font: 'inherit' }} /></label>
            <div className="acct-region" style={{ fontSize: 12.5, margin: '2px 0 8px' }}>
              Use the buttons above to put in the customer's name or a link. Select some words first and press Add link to make them the link. Radar fills in the details for each customer.
            </div>
            {prev && prev.problems.length > 0 && <div className="save-msg err" role="alert">{prev.problems.join(' ')}</div>}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
              <button className="btn" disabled={busy || locked || (prev?.problems.length ?? 0) > 0 || !f.subject.trim() || !f.body.trim() || (sel === 'new' && !f.name.trim())} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
              {manager && cur && (!cur.builtIn || cur.customised) && <button className="btn secondary" disabled={busy} onClick={remove}>{cur.builtIn ? 'Go back to original wording' : 'Delete'}</button>}
            </div>
            {prev && (
              <div>
                <div className="acct-region">How it looks (made-up customer: Morgana, SQ10001, brands Engelite and Miffy)</div>
                <div style={{ border: '1px solid var(--line)', borderRadius: 6, padding: 10, marginTop: 4 }}>
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>{prev.subject}</div>
                  <EmailPreview text={prev.body} />
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
