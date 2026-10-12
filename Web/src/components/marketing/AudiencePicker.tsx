import { useEffect, useState } from 'react';
import { apiGet, apiPost } from '../../lib/api';
import { AudienceFilter, CONTACT_TYPES, SOURCES, describeFilter, num } from '../../lib/marketing';

// Who a campaign goes to: tags, states, kinds of customer, where they came from. Always only people who
// are subscribed. The number updates as you choose.
type Summary = { tags: { tag: string; n: number }[]; regions: { region: string; n: number }[] };
type Segment = { id: string; name: string; filter: AudienceFilter; count: number };

export default function AudiencePicker({ value, onChange, disabled }: { value: AudienceFilter; onChange: (f: AudienceFilter) => void; disabled?: boolean }) {
  const [sum, setSum] = useState<Summary>({ tags: [], regions: [] }); const [segments, setSegments] = useState<Segment[]>([]);
  const [count, setCount] = useState<number | null>(null); const [segName, setSegName] = useState(''); const [msg, setMsg] = useState<string | null>(null);
  const loadSegments = () => apiGet('/marketing/segments').then(setSegments).catch(() => undefined);
  useEffect(() => { apiGet('/marketing/audience/summary').then(setSum).catch(() => undefined); loadSegments(); }, []);
  const key = JSON.stringify(value);
  useEffect(() => { setCount(null); const t = setTimeout(() => apiPost('/marketing/audience/count', { filter: value }).then(r => setCount(r.count)).catch(() => undefined), 300); return () => clearTimeout(t); }, [key]);

  const toggle = (field: keyof AudienceFilter, v: string) => { const cur = value[field] ?? []; onChange({ ...value, [field]: cur.includes(v) ? cur.filter(x => x !== v) : [...cur, v] }); };
  const chip = (on: boolean) => ({ padding: '3px 10px', borderRadius: 12, border: '1px solid ' + (on ? '#2f6b5e' : 'var(--line)'), background: on ? '#e3efe9' : 'var(--panel)', color: on ? '#2f6b5e' : 'inherit', fontSize: 12.5, cursor: disabled ? 'default' : 'pointer', fontWeight: on ? 600 : 400 } as const);
  async function saveSegment() { setMsg(null); try { await apiPost('/marketing/segments', { name: segName, filter: value }); setSegName(''); setMsg('Saved. You can reuse it from the list above.'); loadSegments(); } catch (e: any) { setMsg(e.message); } }
  const exclude = value.excludeTags ?? [];

  return (
    <div style={{ pointerEvents: disabled ? 'none' : 'auto', opacity: disabled ? 0.65 : 1 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <select aria-label="Saved segment" value="" onChange={e => { const s = segments.find(x => x.id === e.target.value); if (s) onChange(s.filter); }}>
          <option value="">Use a saved segment…</option>{segments.map(s => <option key={s.id} value={s.id}>{s.name} ({num(s.count)})</option>)}
        </select>
        <button type="button" className="edit-link" onClick={() => onChange({})}>Everyone</button>
      </div>
      <div className="stat-label" style={{ marginBottom: 4 }}>Tagged with any of</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
        {sum.tags.length === 0 && <span className="acct-region">No tags yet. Add tags on the Audience page.</span>}
        {sum.tags.slice(0, 40).map(t => <button type="button" key={t.tag} style={chip((value.tags ?? []).includes(t.tag))} onClick={() => toggle('tags', t.tag)}>{t.tag} <span style={{ opacity: 0.6 }}>{t.n}</span></button>)}
      </div>
      <div className="stat-label" style={{ marginBottom: 4 }}>Leave out anyone tagged</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10, alignItems: 'center' }}>
        {exclude.map(t => <button type="button" key={t} style={chip(true)} onClick={() => toggle('excludeTags', t)}>{t} ✕</button>)}
        <select aria-label="Leave out a tag" value="" onChange={e => e.target.value && toggle('excludeTags', e.target.value)}><option value="">+ leave out…</option>{sum.tags.filter(t => !exclude.includes(t.tag)).map(t => <option key={t.tag} value={t.tag}>{t.tag}</option>)}</select>
      </div>
      <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap', marginBottom: 10 }}>
        <div><div className="stat-label" style={{ marginBottom: 4 }}>State</div><div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{sum.regions.map(r => <button type="button" key={r.region} style={chip((value.regions ?? []).includes(r.region))} onClick={() => toggle('regions', r.region)}>{r.region}</button>)}</div></div>
        <div><div className="stat-label" style={{ marginBottom: 4 }}>Kind of contact</div><div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{CONTACT_TYPES.map(t => <button type="button" key={t.value} style={chip((value.types ?? []).includes(t.value))} onClick={() => toggle('types', t.value)}>{t.label}</button>)}</div></div>
        <div><div className="stat-label" style={{ marginBottom: 4 }}>Where they came from</div><div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{SOURCES.map(t => <button type="button" key={t.value} style={chip((value.sources ?? []).includes(t.value))} onClick={() => toggle('sources', t.value)}>{t.label}</button>)}</div></div>
      </div>
      <div style={{ background: '#e3efe9', borderRadius: 6, padding: '9px 13px', fontSize: 13.5 }} aria-live="polite">
        <b className="num" style={{ fontSize: 17 }}>{count == null ? '…' : num(count)}</b> people will get this. <span className="acct-region">{describeFilter(value)}. Anyone unsubscribed, bounced or waiting for a consent check is never included.</span>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input placeholder="Name this segment to reuse it" value={segName} onChange={e => setSegName(e.target.value)} style={{ padding: '6px 9px', border: '1px solid var(--line)', borderRadius: 6, font: 'inherit', fontSize: 13 }} />
        <button type="button" className="btn secondary" style={{ padding: '5px 12px', fontSize: 12 }} disabled={!segName.trim()} onClick={saveSegment}>Save segment</button>
        {msg && <span className="acct-region">{msg}</span>}
      </div>
    </div>
  );
}