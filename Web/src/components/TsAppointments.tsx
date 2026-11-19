import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiDelete, apiGet, apiPatch, apiPost } from '../lib/api';
import { $, errMsg } from '../lib/tradeshow';
import { sel, tableBox, td, tdr, th, type Appointment } from '../lib/tsExtra';

// The appointment schedule that was kept by hand in the sheet: who is coming, when, what to talk about, the report to bring, the follow-up, and after the show whether they came and ordered.
const STATUS: Record<Appointment['status'], string> = { booked: 'Booked', came: 'Came', no_show: 'No show', cancelled: 'Cancelled' };
const TONE: Record<Appointment['status'], string> = { booked: 'amber', came: 'teal', no_show: 'rust', cancelled: 'neutral' };
type Draft = { id?: string; stockist: string; contact: string; state: string; dayText: string; timeText: string; who: string; comments: string; targetRange: string; reportRequest: string; reportLink: string; followUp: string; status: Appointment['status'] };
const blank: Draft = { stockist: '', contact: '', state: '', dayText: '', timeText: '', who: '', comments: '', targetRange: '', reportRequest: '', reportLink: '', followUp: '', status: 'booked' };
const draftOf = (a: Appointment): Draft => ({ id: a.id, stockist: a.stockist, contact: a.contact ?? '', state: a.state ?? '', dayText: a.dayText ?? '', timeText: a.timeText ?? '', who: a.who ?? '', comments: a.comments ?? '', targetRange: a.targetRange ?? '', reportRequest: a.reportRequest ?? '', reportLink: a.reportLink ?? '', followUp: a.followUp ?? '', status: a.status });

export default function TsAppointments({ showId }: { showId: string }) {
  const [rows, setRows] = useState<Appointment[] | null>(null);
  const [d, setD] = useState<Draft | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');
  const load = useCallback(() => { apiGet(`/tradeshow/shows/${showId}/appointments`, { fresh: true }).then((x: { appointments: Appointment[] }) => { setRows(x.appointments); setErr(null); }).catch(e => setErr(errMsg(e))); }, [showId]);
  useEffect(() => { load(); }, [load]);
  const up = (p: Partial<Draft>) => setD(x => (x ? { ...x, ...p } : x));
  async function save() {
    if (!d || busy) return;
    setBusy(true); setErr(null);
    try { const { id, ...body } = d; if (id) await apiPatch(`/tradeshow/shows/${showId}/appointments/${id}`, body); else await apiPost(`/tradeshow/shows/${showId}/appointments`, body); setD(null); load(); }
    catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  }
  async function setStatus(a: Appointment, status: Appointment['status']) { try { await apiPatch(`/tradeshow/shows/${showId}/appointments/${a.id}`, { ...draftOf(a), status }); load(); } catch (e) { setErr(errMsg(e)); } }
  async function remove(a: Appointment) { if (window.confirm(`Remove the appointment with ${a.stockist}?`)) { try { await apiDelete(`/tradeshow/shows/${showId}/appointments/${a.id}`); load(); } catch (e) { setErr(errMsg(e)); } } }
  const shown = (rows ?? []).filter(a => !filter.trim() || [a.stockist, a.contact, a.state, a.dayText, a.comments].join(' ').toLowerCase().includes(filter.trim().toLowerCase()));
  const came = (rows ?? []).filter(a => a.status === 'came').length, ordered = (rows ?? []).filter(a => a.orders > 0).length;
  const f = (label: string, k: keyof Draft, w?: number) => <label style={{ display: 'grid', gap: 3, fontSize: 13, ...(w ? { width: w } : { flex: 1, minWidth: 160 }) }}>{label}<input style={sel} value={String(d![k] ?? '')} onChange={e => up({ [k]: e.target.value } as Partial<Draft>)} /></label>;
  return (
    <>
      {err && <div className="save-msg err" role="alert">{err}</div>}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        {!d && <button type="button" className="btn" onClick={() => setD({ ...blank })}>New appointment</button>}
        <input style={{ ...sel, width: 220 }} placeholder="Search the schedule" value={filter} onChange={e => setFilter(e.target.value)} />
        {rows && rows.length > 0 && <span className="acct-region" style={{ fontSize: 13 }}>{rows.length} booked · {came} came · {ordered} ordered</span>}
      </div>
      {d && (
        <div className="card" style={{ maxWidth: 820 }}>
          <div className="panel-title">{d.id ? 'Edit' : 'New'} appointment</div>
          <div style={{ display: 'grid', gap: 10 }}>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>{f('Stockist', 'stockist')}{f('Contact', 'contact')}{f('State', 'state', 90)}</div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>{f('Day', 'dayText', 160)}{f('Time', 'timeText', 140)}{f('Buyer or owner', 'who', 160)}
              <label style={{ display: 'grid', gap: 3, fontSize: 13 }}>Status<select style={sel} value={d.status} onChange={e => up({ status: e.target.value as Appointment['status'] })}>{Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label></div>
            <label style={{ display: 'grid', gap: 3, fontSize: 13 }}>Comments (what to talk about)<textarea style={{ ...sel, minHeight: 54 }} value={d.comments} onChange={e => up({ comments: e.target.value })} /></label>
            <label style={{ display: 'grid', gap: 3, fontSize: 13 }}>Target range (what to show them)<textarea style={{ ...sel, minHeight: 44 }} value={d.targetRange} onChange={e => up({ targetRange: e.target.value })} /></label>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>{f('Report to bring', 'reportRequest')}{f('Report link (web address)', 'reportLink')}</div>
            <label style={{ display: 'grid', gap: 3, fontSize: 13 }}>Follow-up<textarea style={{ ...sel, minHeight: 44 }} value={d.followUp} onChange={e => up({ followUp: e.target.value })} /></label>
            <div style={{ display: 'flex', gap: 10 }}><button type="button" className="btn" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button><button type="button" className="btn secondary" onClick={() => setD(null)}>Cancel</button></div>
          </div>
        </div>
      )}
      {rows === null && !err && <div className="acct-region">Loading…</div>}
      {rows && !rows.length && !d && <div className="empty-state">No appointments yet. Add them here, or load the schedule from the workbook on the Offers tab.</div>}
      {shown.length > 0 && (
        <div style={tableBox}><table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr><th style={th}>Stockist</th><th style={th}>When</th><th style={th}>Notes</th><th style={th}>Follow-up</th><th style={th}>Status</th><th style={{ ...th, textAlign: 'right' }}>Ordered</th><th style={th} /></tr></thead>
          <tbody>{shown.map(a => (
            <tr key={a.id}>
              <td style={td}>{a.accountId ? <Link to={`/accounts/${a.accountId}`}><b>{a.stockist}</b></Link> : <b>{a.stockist}</b>} <span className="acct-region">{a.state}</span><div className="acct-region" style={{ fontSize: 12.5 }}>{[a.contact, a.who].filter(Boolean).join(' · ')}</div></td>
              <td style={td}>{[a.dayText, a.timeText].filter(Boolean).join(' ')}</td>
              <td style={{ ...td, maxWidth: 320 }}>{a.comments}{a.targetRange && <div className="acct-region" style={{ fontSize: 12.5 }}>Range: {a.targetRange}</div>}{a.reportRequest && <div className="acct-region" style={{ fontSize: 12.5 }}>Report: {a.reportLink ? <a href={a.reportLink} target="_blank" rel="noreferrer">{a.reportRequest}</a> : a.reportRequest}</div>}</td>
              <td style={{ ...td, maxWidth: 260 }}>{a.followUp}</td>
              <td style={td}><select style={{ ...sel, fontSize: 13, padding: '3px 6px' }} value={a.status} onChange={e => setStatus(a, e.target.value as Appointment['status'])}>{Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select> <span className={`pill ${TONE[a.status]}`}>{STATUS[a.status]}</span></td>
              <td style={tdr}>{a.orders > 0 ? $(a.ordered) : a.accountId ? 'No order' : ''}</td>
              <td style={{ ...td, whiteSpace: 'nowrap' }}><button type="button" className="link-btn" onClick={() => setD(draftOf(a))}>Edit</button> · <button type="button" className="link-btn" style={{ color: 'var(--rust)' }} onClick={() => remove(a)}>Remove</button></td>
            </tr>
          ))}</tbody></table></div>
      )}
    </>
  );
}
