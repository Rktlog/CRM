import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiGet, apiPost, apiPatch, apiPostText } from '../lib/api';
import { fmtDate } from '../lib/types';
import { CONTACT_STATUS, SOURCES, CONTACT_TYPES, num } from '../lib/marketing';
import { MarketingNav, ManagersOnly, Pill } from '../components/marketing/Ui';

// The audience: everyone who can be emailed, where they came from, and their tags.
type Contact = { id: string; email: string; firstName: string | null; lastName: string | null; company: string | null; accountId: string | null; source: string; status: string; tags: string[]; region: string | null; contactType: string | null; consentNote: string | null; createdAt: string };
type Summary = { total: number; subscribed: number; pending: number; unsubscribed: number; bounced: number; tags: { tag: string; n: number }[]; regions: { region: string; n: number }[] };
const PAGE = 50;

export default function MarketingAudience() {
  const [sum, setSum] = useState<Summary | null>(null); const [rows, setRows] = useState<Contact[]>([]); const [total, setTotal] = useState(0); const [loading, setLoading] = useState(true);
  const [q, setQ] = useState(''); const [status, setStatus] = useState(''); const [tag, setTag] = useState(''); const [region, setRegion] = useState(''); const [source, setSource] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set()); const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null); const [busy, setBusy] = useState<string | null>(null);
  const [panel, setPanel] = useState<'' | 'import' | 'add'>(''); const [bulkTag, setBulkTag] = useState('');
  // import form
  const [file, setFile] = useState<File | null>(null); const [as, setAs] = useState<'subscribed' | 'unsubscribed' | 'bounced'>('subscribed'); const [consent, setConsent] = useState(false); const [impTag, setImpTag] = useState('');
  // add form
  const [add, setAdd] = useState({ email: '', firstName: '', lastName: '', company: '', tags: '', consent: false });

  const query = useMemo(() => new URLSearchParams({ ...(q && { q }), ...(status && { status }), ...(tag && { tag }), ...(region && { region }), ...(source && { source }) }).toString(), [q, status, tag, region, source]);
  const loadSummary = () => apiGet('/marketing/audience/summary').then(setSum).catch(() => undefined);
  async function loadRows(more = false) {
    setLoading(true);
    try { const r = await apiGet(`/marketing/contacts?${query}${query ? '&' : ''}limit=${PAGE}&offset=${more ? rows.length : 0}`); setRows(more ? [...rows, ...r.rows] : r.rows); setTotal(r.total); if (!more) setPicked(new Set()); }
    catch (e: any) { setMsg({ ok: false, text: e.message }); } finally { setLoading(false); }
  }
  useEffect(() => { loadSummary(); }, []);
  useEffect(() => { const t = setTimeout(() => loadRows(), q ? 300 : 0); return () => clearTimeout(t); }, [query]);
  const refresh = () => { loadSummary(); loadRows(); };

  async function run(label: string, fn: () => Promise<string>) { setBusy(label); setMsg(null); try { setMsg({ ok: true, text: await fn() }); refresh(); } catch (e: any) { setMsg({ ok: false, text: e.message }); } finally { setBusy(null); } }
  const sync = () => run('sync', async () => { const r = await apiPost('/marketing/contacts/sync', {}); return `Checked ${num(r.accountsWithEmail)} CRM accounts with an email. Added ${num(r.added)} (${num(r.addedSubscribed)} customers subscribed, ${num(r.addedPending)} leads waiting for a consent check). Updated ${num(r.updated)}.${r.skippedInvalid ? ` ${r.skippedInvalid} had an invalid address.` : ''}`; });
  const doImport = () => run('import', async () => {
    const text = await file!.text(); const p = new URLSearchParams({ as, ...(as === 'subscribed' && consent ? { consent: '1' } : {}), ...(impTag.trim() ? { tag: impTag.trim() } : {}) });
    const r = await apiPostText(`/marketing/contacts/import?${p}`, text); setFile(null); setConsent(false); setPanel('');
    return `Imported: ${num(r.added)} added, ${num(r.updated)} already there.${r.skippedInvalid ? ` ${r.skippedInvalid} skipped (not an email).` : ''}${r.skippedDuplicateInFile ? ` ${r.skippedDuplicateInFile} repeated in the file.` : ''}${r.unsubscribed ? ` ${r.unsubscribed} marked unsubscribed.` : ''}`;
  });
  const addOne = () => run('add', async () => { await apiPost('/marketing/contacts', { email: add.email, firstName: add.firstName, lastName: add.lastName, company: add.company, tags: add.tags.split(','), consent: add.consent }); setAdd({ email: '', firstName: '', lastName: '', company: '', tags: '', consent: false }); setPanel(''); return 'Added.'; });
  const bulk = (action: string, extra: object = {}, done = 'Done.') => run(action, async () => { const r = await apiPost('/marketing/contacts/bulk', { ids: [...picked], action, ...extra }); setPicked(new Set()); return `${done} (${num(r.changed)} changed)`; });
  const confirmConsent = (ids?: string[]) => { if (!confirm('Confirm that these people agreed to receive your emails (for example they asked to be on your list, or are existing customers you deal with)?')) return; run('confirm_consent', async () => { const r = await apiPost('/marketing/contacts/bulk', { ids: ids ?? [...picked], action: 'confirm_consent', confirm: true }); setPicked(new Set()); return `Confirmed. ${num(r.changed)} can now be emailed.`; }); };
  const unsub = async (c: Contact) => { if (!confirm(`Unsubscribe ${c.email}?`)) return; run('unsub', async () => { await apiPatch(`/marketing/contacts/${c.id}`, { status: 'unsubscribed' }); return 'Unsubscribed.'; }); };

  const allPicked = rows.length > 0 && rows.every(r => picked.has(r.id));
  const pendingPicked = rows.filter(r => picked.has(r.id) && r.status === 'pending').length;
  const th = { fontWeight: 600, fontSize: 12, color: 'var(--muted)', textAlign: 'left' as const, padding: '6px 8px' }; const td = { padding: '7px 8px', fontSize: 13, borderTop: '1px solid var(--line)', verticalAlign: 'top' as const };
  const Tile = ({ label, value, onClick, active }: { label: string; value: number | undefined; onClick?: () => void; active?: boolean }) => (
    <button type="button" onClick={onClick} style={{ textAlign: 'left', background: active ? '#e3efe9' : 'var(--panel)', border: '1px solid var(--line)', borderRadius: 6, padding: '9px 13px', cursor: onClick ? 'pointer' : 'default', font: 'inherit' }}>
      <div className="stat-label">{label}</div><div className="num" style={{ fontSize: 21, fontWeight: 700 }}>{value == null ? '…' : num(value)}</div></button>
  );

  return (
    <ManagersOnly>
      <h1>Audience</h1><MarketingNav />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, marginBottom: 12 }}>
        <Tile label="All contacts" value={sum?.total} onClick={() => setStatus('')} active={status === ''} /><Tile label="Subscribed" value={sum?.subscribed} onClick={() => setStatus('subscribed')} active={status === 'subscribed'} />
        <Tile label="Need a consent check" value={sum?.pending} onClick={() => setStatus('pending')} active={status === 'pending'} /><Tile label="Unsubscribed" value={sum?.unsubscribed} onClick={() => setStatus('unsubscribed')} active={status === 'unsubscribed'} />
        <Tile label="Bounced or spam" value={sum?.bounced} onClick={() => setStatus('bounced')} active={status === 'bounced'} />
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <button className="btn" disabled={!!busy} onClick={sync}>{busy === 'sync' ? 'Updating…' : 'Update from the CRM'}</button>
        <button className="btn secondary" onClick={() => setPanel(panel === 'import' ? '' : 'import')}>Import a list</button>
        <button className="btn secondary" onClick={() => setPanel(panel === 'add' ? '' : 'add')}>Add a contact</button>
      </div>
      <div className="acct-region" style={{ marginBottom: 10 }}>"Update from the CRM" brings in every account with an email. Customers can be emailed straight away. Leads wait until you confirm they agreed to hear from you. Anyone who has unsubscribed stays unsubscribed.</div>
      {msg && <div className={'save-msg ' + (msg.ok ? 'ok' : 'err')} style={{ marginBottom: 10 }} role="status">{msg.text}</div>}

      {panel === 'import' && (
        <div className="section" style={{ maxWidth: 620 }}><div className="panel-title">Import a list</div>
          <div className="acct-region" style={{ marginBottom: 8 }}>A CSV file with an "Email" column. A Mailchimp export works as it is. Import your Mailchimp "unsubscribed" and "cleaned" files too, so those people are never emailed.</div>
          <input type="file" accept=".csv,text/csv" aria-label="List file" onChange={e => setFile(e.target.files?.[0] ?? null)} style={{ marginBottom: 8 }} />
          <div style={{ display: 'flex', gap: 14, fontSize: 13, marginBottom: 8, flexWrap: 'wrap' }}>
            {([['subscribed', 'These people agreed to emails'], ['unsubscribed', 'These people unsubscribed'], ['bounced', 'These addresses bounced (cleaned)']] as const).map(([v, l]) => <label key={v}><input type="radio" name="as" checked={as === v} onChange={() => setAs(v)} /> {l}</label>)}
          </div>
          {as === 'subscribed' && <label style={{ display: 'block', fontSize: 13, marginBottom: 8 }}><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} /> I confirm everyone in this file agreed to receive our emails</label>}
          <input placeholder="Add a tag to all of them (optional)" value={impTag} onChange={e => setImpTag(e.target.value)} style={{ padding: '6px 9px', border: '1px solid var(--line)', borderRadius: 6, font: 'inherit', fontSize: 13, marginBottom: 8, width: 260 }} />
          <div><button className="btn" disabled={!file || (as === 'subscribed' && !consent) || !!busy} onClick={doImport}>{busy === 'import' ? 'Importing…' : 'Import'}</button></div>
        </div>
      )}
      {panel === 'add' && (
        <div className="section" style={{ maxWidth: 520 }}><div className="panel-title">Add a contact</div>
          {(['email', 'firstName', 'lastName', 'company', 'tags'] as const).map(k => <input key={k} aria-label={k} placeholder={{ email: 'Email', firstName: 'First name', lastName: 'Last name', company: 'Store', tags: 'Tags, separated by commas' }[k]} value={add[k]} onChange={e => setAdd({ ...add, [k]: e.target.value })} style={{ display: 'block', width: '100%', padding: '6px 9px', border: '1px solid var(--line)', borderRadius: 6, font: 'inherit', fontSize: 13, marginBottom: 6 }} />)}
          <label style={{ display: 'block', fontSize: 13, marginBottom: 8 }}><input type="checkbox" checked={add.consent} onChange={e => setAdd({ ...add, consent: e.target.checked })} /> This person agreed to receive our emails</label>
          <button className="btn" disabled={!add.email.includes('@') || !add.consent || !!busy} onClick={addOne}>Add</button>
        </div>
      )}

      <div className="controls" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '8px 0' }}>
        <input type="search" placeholder="Search email, name or store" value={q} onChange={e => setQ(e.target.value)} style={{ padding: '7px 10px', border: '1px solid var(--line)', borderRadius: 6, font: 'inherit', fontSize: 13, minWidth: 230 }} />
        <select aria-label="Status" value={status} onChange={e => setStatus(e.target.value)}><option value="">Any status</option>{Object.entries(CONTACT_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
        <select aria-label="Tag" value={tag} onChange={e => setTag(e.target.value)}><option value="">Any tag</option>{(sum?.tags ?? []).map(t => <option key={t.tag} value={t.tag}>{t.tag} ({t.n})</option>)}</select>
        <select aria-label="State" value={region} onChange={e => setRegion(e.target.value)}><option value="">Any state</option>{(sum?.regions ?? []).map(r => <option key={r.region} value={r.region}>{r.region} ({r.n})</option>)}</select>
        <select aria-label="Source" value={source} onChange={e => setSource(e.target.value)}><option value="">Any source</option>{SOURCES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}</select>
      </div>

      {picked.size > 0 && (
        <div style={{ background: '#e3efe9', borderRadius: 6, padding: '8px 12px', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }} role="toolbar" aria-label="Selected contacts">
          <b>{picked.size} selected</b>
          <input aria-label="Tag name" placeholder="Tag" value={bulkTag} onChange={e => setBulkTag(e.target.value)} style={{ padding: '4px 8px', border: '1px solid var(--line)', borderRadius: 6, font: 'inherit', fontSize: 13, width: 130 }} />
          <button className="btn secondary" style={{ padding: '4px 10px', fontSize: 12 }} disabled={!bulkTag.trim() || !!busy} onClick={() => bulk('add_tag', { tags: [bulkTag] }, `Tagged "${bulkTag}".`)}>Add tag</button>
          <button className="btn secondary" style={{ padding: '4px 10px', fontSize: 12 }} disabled={!bulkTag.trim() || !!busy} onClick={() => bulk('remove_tag', { tags: [bulkTag] }, `Removed "${bulkTag}".`)}>Remove tag</button>
          {pendingPicked > 0 && <button className="btn" style={{ padding: '4px 10px', fontSize: 12 }} disabled={!!busy} onClick={() => confirmConsent()}>Confirm consent ({pendingPicked})</button>}
          <button className="btn secondary" style={{ padding: '4px 10px', fontSize: 12 }} disabled={!!busy} onClick={() => confirm(`Unsubscribe ${picked.size} people?`) && bulk('unsubscribe', {}, 'Unsubscribed.')}>Unsubscribe</button>
          <button className="edit-link" onClick={() => setPicked(new Set())}>Clear</button>
        </div>
      )}

      {!loading && !rows.length ? <div className="empty-state">{sum?.total ? 'Nobody matches.' : 'No contacts yet. Press "Update from the CRM" to bring in your customers and leads.'}</div> : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr><th style={th}><input type="checkbox" aria-label="Select all shown" checked={allPicked} onChange={e => setPicked(e.target.checked ? new Set(rows.map(r => r.id)) : new Set())} /></th><th style={th}>Contact</th><th style={th}>Store</th><th style={th}>State</th><th style={th}>Tags</th><th style={th}>Status</th><th style={th}></th></tr></thead>
          <tbody>{rows.map(c => (
            <tr key={c.id}>
              <td style={td}><input type="checkbox" aria-label={`Select ${c.email}`} checked={picked.has(c.id)} onChange={e => { const n = new Set(picked); e.target.checked ? n.add(c.id) : n.delete(c.id); setPicked(n); }} /></td>
              <td style={td}>{c.email}<div className="acct-region">{[c.firstName, c.lastName].filter(Boolean).join(' ') || '—'} · {SOURCES.find(s => s.value === c.source)?.label ?? c.source}</div></td>
              <td style={td}>{c.accountId ? <Link to={`/accounts/${c.accountId}`} className="order-link">{c.company}</Link> : (c.company ?? '')}{c.contactType && <div className="acct-region">{CONTACT_TYPES.find(t => t.value === c.contactType)?.label ?? c.contactType}</div>}</td>
              <td style={td}>{c.region ?? ''}</td>
              <td style={td}>{c.tags.map(t => <button key={t} type="button" className="edit-link" style={{ marginRight: 6 }} onClick={() => setTag(t)}>{t}</button>)}</td>
              <td style={td}><Pill tone={CONTACT_STATUS[c.status]?.tone}>{CONTACT_STATUS[c.status]?.label ?? c.status}</Pill>{c.status === 'pending' && <div><button className="edit-link" onClick={() => confirmConsent([c.id])}>Confirm consent</button></div>}</td>
              <td style={{ ...td, textAlign: 'right' }}>{['subscribed', 'pending'].includes(c.status) && <button className="edit-link" onClick={() => unsub(c)}>Unsubscribe</button>}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {loading && <div className="acct-region" style={{ margin: '8px 0' }}>Loading…</div>}
      {rows.length > 0 && <div className="acct-region" style={{ marginTop: 8 }}>{num(rows.length)} of {num(total)} shown. {rows.length < total && <button className="edit-link" onClick={() => loadRows(true)}>Show {Math.min(PAGE, total - rows.length)} more</button>}</div>}
    </ManagersOnly>
  );
}