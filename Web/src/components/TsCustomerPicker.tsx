import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { apiGet } from '../lib/api';
import { STATES, type Customer } from '../lib/tradeshow';

// Pick the customer: search existing accounts, or add a new one. If the "new" one looks like an account Radar already has, the matches
// are shown and the person picks one of them or confirms it really is new.
const field: CSSProperties = { width: '100%', padding: '7px 10px', border: '1px solid var(--line)', borderRadius: 3, font: 'inherit', fontSize: 15 };
const label: CSSProperties = { display: 'grid', gap: 4, fontSize: 13 };
export type Picked = { accountId: string } | { newCustomer: { name: string; contact: string; email: string; phone: string; address: string; region: string; category: string; confirmNew?: boolean } };

export default function TsCustomerPicker({ busy, matches, onPick }: { busy: boolean; matches: Customer[] | null; onPick: (p: Picked) => void }) {
  const [mode, setMode] = useState<'find' | 'new'>('find');
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Customer[]>([]);
  const [nc, setNc] = useState({ name: '', contact: '', email: '', phone: '', address: '', region: '', category: '' });
  const latest = useRef(0);
  useEffect(() => {
    const term = q.trim(); if (mode !== 'find' || term.length < 2) { setHits([]); return; }
    const mine = ++latest.current;
    const t = setTimeout(() => apiGet(`/tradeshow/customers?q=${encodeURIComponent(term)}`).then((d: { customers: Customer[] }) => { if (latest.current === mine) setHits(d.customers); }).catch(() => {}), 250);
    return () => clearTimeout(t);
  }, [q, mode]);
  const set = (k: keyof typeof nc) => (e: { target: { value: string } }) => setNc({ ...nc, [k]: e.target.value });
  return (
    <div>
      <div role="radiogroup" style={{ display: 'flex', gap: 18, fontSize: 14, marginBottom: 10 }}>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="radio" checked={mode === 'find'} onChange={() => setMode('find')} /> Existing customer</label>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="radio" checked={mode === 'new'} onChange={() => setMode('new')} /> New customer</label>
      </div>
      {mode === 'find' ? (
        <div>
          <input autoFocus style={field} placeholder="Shop name, email, contact or phone" value={q} onChange={e => setQ(e.target.value)} />
          <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
            {hits.map(c => (
              <button key={c.id} type="button" disabled={busy} onClick={() => onPick({ accountId: c.id })} style={{ textAlign: 'left', border: '1px solid var(--line)', borderRadius: 6, padding: '8px 12px', background: 'var(--panel)', cursor: 'pointer', font: 'inherit' }}>
                <b>{c.name}</b> <span className="acct-region">{c.region}{c.archived ? ' · archived' : ''}</span>
                <div className="acct-region" style={{ fontSize: 13 }}>{[c.contact, c.email, c.phone].filter(Boolean).join(' · ')}</div>
              </button>
            ))}
            {q.trim().length >= 2 && !hits.length && <div className="acct-region">No match. Try another word, or add them as a new customer.</div>}
          </div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
          <label style={{ ...label, gridColumn: '1 / -1' }}>Business name (as it should be in DEAR)<input autoFocus style={field} value={nc.name} onChange={set('name')} /></label>
          <label style={label}>Contact<input style={field} value={nc.contact} onChange={set('contact')} /></label>
          <label style={label}>Email<input type="email" style={field} value={nc.email} onChange={set('email')} /></label>
          <label style={label}>Phone<input type="tel" style={field} value={nc.phone} onChange={set('phone')} /></label>
          <label style={label}>State<select style={field} value={nc.region} onChange={set('region')}><option value="">Choose…</option>{STATES.map(s => <option key={s}>{s}</option>)}</select></label>
          <label style={{ ...label, gridColumn: '1 / -1' }}>Delivery address<input style={field} value={nc.address} onChange={set('address')} /></label>
          <label style={label}>Type of shop<input style={field} value={nc.category} onChange={set('category')} placeholder="Gift shop, Toy, Pharmacy…" /></label>
          <div style={{ gridColumn: '1 / -1' }}><button type="button" className="btn" disabled={busy} onClick={() => onPick({ newCustomer: nc })}>{busy ? 'Saving…' : 'Next'}</button></div>
          {matches && matches.length > 0 && (
            <div style={{ gridColumn: '1 / -1', border: '1px solid var(--amber)', background: 'var(--amber-bg)', borderRadius: 6, padding: '10px 12px', display: 'grid', gap: 6 }}>
              <b style={{ fontSize: 14 }}>Radar may already have this customer:</b>
              {matches.map(c => <button key={c.id} type="button" className="btn secondary" style={{ textAlign: 'left' }} disabled={busy} onClick={() => onPick({ accountId: c.id })}>Use {c.name} ({c.region}{c.email ? `, ${c.email}` : ''})</button>)}
              <button type="button" className="link-btn" disabled={busy} onClick={() => onPick({ newCustomer: { ...nc, confirmNew: true } })}>No, it is a new customer</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
