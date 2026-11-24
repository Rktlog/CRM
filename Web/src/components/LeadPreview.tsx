import { useState } from 'react';
import { Link } from 'react-router-dom';
import { apiPost } from '../lib/api';
import type { AppointmentProposal, LeadProposal } from '../lib/aiStream';

// The cards the assistant shows for a trade show LEAD and an APPOINTMENT. Nothing is saved until the Save button is pressed, and each only adds one new lead
// or one new appointment. A new customer is only made when Save lead is pressed on a lead that says "New customer". If Radar already has something that
// looks the same, the rep has to say it is a different business first.
const box = { marginTop: 10, border: '1px solid var(--line)', borderRadius: 6, background: '#fff', color: '#111' } as const;
const row = (k: string, v: string | null | undefined) => (v ? <div style={{ display: 'flex', gap: 8, fontSize: 13.5, padding: '2px 10px' }}><span style={{ color: 'var(--muted)', minWidth: 96 }}>{k}</span><span>{v}</span></div> : null);

export default function LeadPreview({ proposal: p }: { proposal: LeadProposal }) {
  const [state, setState] = useState<'idle' | 'saving' | 'done' | 'cancelled'>('idle');
  const [diff, setDiff] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ leadId: string } | null>(null);
  const needsTick = p.isNew && p.similar.length > 0;
  async function save() {
    setState('saving'); setError(null);
    try {
      setMade(await apiPost('/ai/show-lead/confirm', { showId: p.showId, accountId: p.accountId, customer: p.customer, region: p.region, address: p.address, contact: p.contact, brands: p.brands, notes: p.notes, confirmNew: diff }));
      setState('done');
    } catch (e) { setError((e as Error).message); setState('idle'); }   // nothing was saved, so it can be pressed again
  }
  return (
    <div style={box}>
      <div style={{ padding: '8px 10px', fontWeight: 600 }}>Lead: {p.customer}{p.region ? ` (${p.region})` : ''} <span style={{ fontWeight: 400, color: 'var(--muted)' }}>at {p.showName}</span></div>
      {p.isNew && <div style={{ padding: '0 10px 4px', fontSize: 13, color: 'var(--amber)' }}>New customer. It is only added when you press Save lead.</div>}
      {row('Contact', p.contact.name)}{row('Phone', p.contact.phone)}{row('Email', p.contact.email)}{row('Address', p.address)}{row('Liked', p.brands)}{row('Notes', p.notes)}
      {needsTick && (
        <div style={{ margin: '6px 10px', padding: '6px 8px', border: '1px solid var(--amber)', background: 'var(--amber-bg)', borderRadius: 5, fontSize: 13 }}>
          Radar already has: {p.similar.map(s => s.label).join(', ')}. Ask the assistant to use that one, or:
          <label style={{ display: 'flex', gap: 6, marginTop: 4 }}><input type="checkbox" checked={diff} disabled={state !== 'idle'} onChange={e => setDiff(e.target.checked)} /> This is a different business</label>
        </div>
      )}
      {p.problems.length > 0 && <div style={{ padding: '4px 10px', fontSize: 13, color: 'var(--rust)' }}>{p.problems.map((x, i) => <div key={i}><b>{x.what}</b>: {x.reason}</div>)}</div>}
      {error && <div className="save-msg err" role="alert" style={{ margin: '4px 10px' }}>{error}</div>}
      <div style={{ padding: '8px 10px', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {state === 'done' && made ? <span role="status">Lead saved. <Link to={`/trade-shows/leads/${made.leadId}`}>Open it</Link></span>
          : state === 'cancelled' ? <span style={{ color: 'var(--muted)' }}>Cancelled. Nothing was saved.</span>
          : <>
              <button type="button" className="btn" disabled={state === 'saving' || (needsTick && !diff)} onClick={save}>{state === 'saving' ? 'Saving…' : 'Save lead'}</button>
              <button type="button" className="btn secondary" disabled={state === 'saving'} onClick={() => setState('cancelled')}>Cancel</button>
            </>}
      </div>
    </div>
  );
}

export function AppointmentPreview({ proposal: p }: { proposal: AppointmentProposal }) {
  const [state, setState] = useState<'idle' | 'saving' | 'done' | 'cancelled'>('idle');
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setState('saving'); setError(null);
    try { await apiPost('/ai/show-appointment/confirm', { showId: p.showId, stockist: p.stockist, accountId: p.accountId, contact: p.contact, state: p.state, day: p.day, time: p.time, who: p.who, comments: p.comments, targetRange: p.targetRange }); setState('done'); }
    catch (e) { setError((e as Error).message); setState('idle'); }
  }
  return (
    <div style={box}>
      <div style={{ padding: '8px 10px', fontWeight: 600 }}>Appointment: {p.stockist} <span style={{ fontWeight: 400, color: 'var(--muted)' }}>at {p.showName}</span></div>
      {row('When', [p.day, p.time].filter(Boolean).join(' ') || 'Not set')}{row('Customer', p.linkedTo ? `Linked to ${p.linkedTo}` : null)}{row('Contact', p.contact)}{row('State', p.state)}{row('Our person', p.who)}{row('Wants to see', p.targetRange)}{row('Comments', p.comments)}
      {p.warnings.length > 0 && <div style={{ padding: '4px 10px', fontSize: 13, color: 'var(--amber)' }}>{p.warnings.map((w, i) => <div key={i}>{w}</div>)}</div>}
      {error && <div className="save-msg err" role="alert" style={{ margin: '4px 10px' }}>{error}</div>}
      <div style={{ padding: '8px 10px', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {state === 'done' ? <span role="status">Appointment saved on the show's Appointments tab.</span>
          : state === 'cancelled' ? <span style={{ color: 'var(--muted)' }}>Cancelled. Nothing was saved.</span>
          : <>
              <button type="button" className="btn" disabled={state === 'saving'} onClick={save}>{state === 'saving' ? 'Saving…' : 'Save appointment'}</button>
              <button type="button" className="btn secondary" disabled={state === 'saving'} onClick={() => setState('cancelled')}>Cancel</button>
              <span style={{ color: 'var(--muted)', fontSize: 12.5 }}>Goes on the Appointments tab, not Google Calendar.</span>
            </>}
      </div>
    </div>
  );
}
