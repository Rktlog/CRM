import { useState } from 'react';
import { apiPostText } from '../lib/api';
import { $, errMsg, shortDay } from '../lib/tradeshow';
import { fileToBase64, type Proposal } from '../lib/tsExtra';

// Load the team's trade show workbook. Claude finds the tabs with offers, appointments, the checklist, feedback and old show sales, and shows what it found.
// Nothing is saved until the manager has looked and pressed Save. The checkboxes leave out anything that looks wrong.
export default function TsImport({ showId, onSaved }: { showId: string; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<'read' | 'save' | null>(null);
  const [p, setP] = useState<Proposal | null>(null);
  const [off, setOff] = useState<Record<string, boolean>>({});   // things unticked in the preview
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const key = (g: string, i: number) => `${g}${i}`;
  const on = (g: string, i: number) => off[key(g, i)] !== true;

  async function pick(f: File | undefined) {
    if (!f) return;
    setBusy('read'); setErr(null); setDone(null); setP(null); setOff({});
    try { setP(await apiPostText(`/tradeshow/shows/${showId}/import/read`, JSON.stringify({ file: { name: f.name, data: await fileToBase64(f) } }), 'text/plain')); }
    catch (e) { setErr(errMsg(e)); } finally { setBusy(null); }
  }
  async function save() {
    if (!p) return;
    setBusy('save'); setErr(null);
    try {
      const keep = <T,>(g: string, a: T[]) => a.filter((_, i) => on(g, i));
      const r = await apiPostText(`/tradeshow/shows/${showId}/import/save`, JSON.stringify({ offers: keep('o', p.offers), appointments: keep('a', p.appointments), checklist: on('c', 0) ? p.checklist : [], feedback: on('f', 0) ? p.feedback : null, oldShows: keep('s', p.oldShows) }), 'text/plain');
      setDone(`Saved: ${r.offers} offers, ${r.appointments} appointments, ${r.checklist} checklist items, ${r.feedback ? 'feedback' : 'no feedback'}, ${r.oldShows} old shows.`); setP(null); onSaved();
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(null); }
  }
  const Box = ({ g, i }: { g: string; i: number }) => <input type="checkbox" checked={on(g, i)} onChange={e => setOff(o => ({ ...o, [key(g, i)]: !e.target.checked }))} style={{ marginRight: 8 }} />;
  const none = p && !p.offers.length && !p.appointments.length && !p.checklist.length && !p.feedback && !p.oldShows.length;

  return (
    <div className="section" style={{ marginTop: 22 }}>
      <button type="button" className="link-btn" onClick={() => setOpen(o => !o)}>{open ? 'Hide' : 'Load from the Excel workbook'}</button>
      {open && (
        <div className="card" style={{ maxWidth: 820, marginTop: 8 }}>
          <div className="acct-region" style={{ fontSize: 13, marginBottom: 8 }}>Choose the trade show workbook. Claude finds the tabs it needs and shows you what it found before anything is saved. It skips rows that look like logins or bank details, and never keeps them.</div>
          <input type="file" accept=".xlsx,.xlsm,.xls,.csv" disabled={busy !== null} onChange={e => { pick(e.target.files?.[0]); e.target.value = ''; }} />
          {busy === 'read' && <div className="acct-region" style={{ marginTop: 8 }}>Claude is reading the workbook. This takes a minute or two.</div>}
          {err && <div className="save-msg err" role="alert">{err}</div>}
          {done && <div className="save-msg ok" role="status">{done}</div>}
          {p && (
            <div style={{ marginTop: 12 }}>
              <div className="acct-region" style={{ fontSize: 13 }}>Tabs read: {p.sheetsRead.join(', ') || 'none'}{p.skippedRows ? ` · ${p.skippedRows} rows with logins or bank details were skipped` : ''}</div>
              {none && <div className="empty-state">Nothing to load was found.</div>}
              {p.warnings.length > 0 && <div className="save-msg err" style={{ marginTop: 8 }}>{p.warnings.map((w, i) => <div key={i}>{w}</div>)}</div>}
              {p.notes.length > 0 && <div style={{ margin: '8px 0', fontSize: 13.5 }}><b>Claude's notes</b>{p.notes.map((n, i) => <div key={i}>{n}</div>)}</div>}
              {p.offers.length > 0 && <><div className="panel-title" style={{ marginTop: 12 }}>Offers ({p.offers.length})</div>{p.offers.map((o, i) => <div key={i} style={{ padding: '4px 0', fontSize: 14 }}><Box g="o" i={i} /><b>{o.name}</b> <span className="acct-region">{o.kind === 'pct' ? `${o.pct}% off, ${[...o.brands, ...o.skus.slice(0, 3)].join(', ')}${o.skus.length > 3 ? ` +${o.skus.length - 3} SKUs` : ''}` : o.kind === 'bundle' ? `${$(o.bundlePrice)}: ${o.items.map(x => `${x.qty} x ${x.sku}`).join(', ')}` : `spend ${$(o.threshold)}, get ${o.items.map(x => `${x.qty} x ${x.sku}`).join(', ')}`}{o.payBy ? ` · pay by ${shortDay(o.payBy)}` : ''}</span></div>)}</>}
              {p.appointments.length > 0 && <><div className="panel-title" style={{ marginTop: 12 }}>Appointments ({p.appointments.length})</div>{p.appointments.map((a, i) => <div key={i} style={{ padding: '3px 0', fontSize: 14 }}><Box g="a" i={i} /><b>{a.stockist}</b> <span className="acct-region">{[a.contact, a.state, a.dayText, a.timeText, a.who].filter(Boolean).join(' · ')}</span></div>)}</>}
              {p.checklist.length > 0 && <><div className="panel-title" style={{ marginTop: 12 }}>Checklist ({p.checklist.length} items)</div><div style={{ fontSize: 14 }}><Box g="c" i={0} />Add these to this show's checklist (ones already there are skipped)</div><div className="acct-region" style={{ fontSize: 13, marginLeft: 24 }}>{p.checklist.slice(0, 6).map(c => c.item).join(' · ')}{p.checklist.length > 6 ? ' …' : ''}</div></>}
              {p.feedback && <><div className="panel-title" style={{ marginTop: 12 }}>Feedback</div><div style={{ fontSize: 14 }}><Box g="f" i={0} />Fill the empty feedback boxes with what the sheet says</div></>}
              {p.oldShows.length > 0 && <><div className="panel-title" style={{ marginTop: 12 }}>Old shows for the comparison ({p.oldShows.length})</div>{p.oldShows.map((s, i) => <div key={i} style={{ padding: '3px 0', fontSize: 14 }}><Box g="s" i={i} /><b>{s.name}</b> <span className="acct-region">{shortDay(s.startsOn)} · {s.days.length} days · {$(s.days.reduce((a, d) => a + d.sales, 0))} sales ex GST{s.bundles.length ? ` · ${s.bundles.length} bundles` : ''}</span></div>)}</>}
              {!none && <div style={{ display: 'flex', gap: 10, marginTop: 14 }}><button type="button" className="btn" disabled={busy !== null} onClick={save}>{busy === 'save' ? 'Saving…' : 'Save what is ticked'}</button><button type="button" className="btn secondary" onClick={() => setP(null)}>Cancel</button></div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
