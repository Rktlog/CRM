import { CSSProperties, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiGet, apiPost } from '../lib/api';

// The customer's promos: give a promo to the customer (with how many, when there is a set number), then allocate it to the customer's orders (SQ numbers).
// Nothing shows while no promos are set up at all.
type Alloc = { orderId: string; number: string; date: string; qty: number };
type Promo = {
  id: string; name: string; active: boolean; startsOn: string | null; endsOn: string | null;
  isGiven: boolean; given: number | null; allocations: Alloc[]; allocated: number; left: number | null;
};
type Order = { id: string; number: string; date: string; status: string };
type Data = { promos: Promo[]; orders: Order[]; available: { id: string; name: string }[] };

const dayText = (d: string | null) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const nice = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : '');
const small: CSSProperties = { padding: '5px 8px', border: '1px solid var(--line)', borderRadius: 3, font: 'inherit', fontSize: 14 };

export default function AccountPromos({ accountId }: { accountId: string }) {
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [give, setGive] = useState({ promoId: '', qty: '' });

  const load = () => apiGet(`/promos/account/${accountId}`, { fresh: true }).then((x: Data) => setD(x)).catch(e => setErr(e.message));
  useEffect(() => { setD(null); setErr(null); setGive({ promoId: '', qty: '' }); load(); }, [accountId]);

  async function send(path: string, body: unknown): Promise<boolean> {
    setBusy(true); setErr(null);
    try { await apiPost(`/promos/account/${accountId}${path}`, body); await load(); return true; }
    catch (e: any) { setErr(e?.message ?? 'Could not save.'); return false; }
    finally { setBusy(false); }
  }

  if (!d) return err ? <div className="card" id="promos"><h3>Promos</h3><div className="save-msg err" role="alert">{err}</div></div> : null;
  if (d.promos.length === 0 && d.available.length === 0) return null;

  return (
    <div className="card" id="promos">
      <h3>Promos</h3>
      <div className="acct-region" style={{ marginBottom: 10 }}>Give this customer a promo, then allocate it to the order (SQ) it was used on. Leave the quantity empty when there is no set number.</div>

      {d.promos.length === 0 && <div className="acct-region" style={{ marginBottom: 10 }}>No promos given to this customer yet.</div>}
      <div style={{ display: 'grid', gap: 12 }}>
        {d.promos.map(p => <PromoRow key={p.id} p={p} orders={d.orders} busy={busy} send={send} />)}
      </div>

      {d.available.length > 0 && (
        <form style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 14 }}
          onSubmit={async e => { e.preventDefault(); if (give.promoId && await send('', { promoId: give.promoId, qty: give.qty || null })) setGive({ promoId: '', qty: '' }); }}>
          <select style={small} value={give.promoId} onChange={e => setGive({ ...give, promoId: e.target.value })} aria-label="Promo to give">
            <option value="">Give a promo…</option>
            {d.available.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <input type="number" min={1} max={9999} style={{ ...small, width: 90 }} placeholder="How many" value={give.qty}
            onChange={e => setGive({ ...give, qty: e.target.value })} aria-label="How many to give (optional)" />
          <button className="btn" type="submit" disabled={busy || !give.promoId}>Give promo</button>
        </form>
      )}
      {err && <div className="save-msg err" role="alert" style={{ marginTop: 8 }}>{err}</div>}
    </div>
  );
}

function PromoRow({ p, orders, busy, send }: { p: Promo; orders: Order[]; busy: boolean; send: (path: string, body: unknown) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [given, setGiven] = useState(p.given == null ? '' : String(p.given));
  const [pick, setPick] = useState({ orderId: '', qty: '1' });
  const used = new Set(p.allocations.map(a => a.orderId));
  const choices = orders.filter(o => !used.has(o.id));
  const allUsed = p.left !== null && p.left <= 0;

  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 4, padding: '10px 12px', opacity: p.active ? 1 : 0.8 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Link to={`/promos/${p.id}`}><b>{p.name}</b></Link>
        {!p.active && <span className="pill neutral">Off</span>}
        {(p.startsOn || p.endsOn) && <span className="acct-region" style={{ fontSize: 12.5 }}>{dayText(p.startsOn)}{p.endsOn ? ` to ${dayText(p.endsOn)}` : ''}</span>}
      </div>

      <div className="acct-region" style={{ marginTop: 4, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        {!editing && <>
          <span>Given: <b>{p.isGiven ? (p.given ?? 'no set number') : 'not recorded'}</b></span>
          <span>Allocated: <b>{p.allocated}</b></span>
          {p.left !== null && <span>Left: <b>{p.left}</b></span>}
          <button type="button" className="link-btn" disabled={busy} onClick={() => { setGiven(p.given == null ? '' : String(p.given)); setEditing(true); }}>{p.isGiven ? 'Change quantity' : 'Record as given'}</button>
          {p.isGiven && p.allocated === 0 && <>{' · '}<button type="button" className="link-btn" disabled={busy}
            onClick={() => { if (window.confirm(`Take "${p.name}" back from this customer?`)) send('/remove', { promoId: p.id }); }}>Take back</button></>}
        </>}
        {editing && (
          <form style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}
            onSubmit={async e => { e.preventDefault(); if (await send('', { promoId: p.id, qty: given || null })) setEditing(false); }}>
            Given <input type="number" min={1} max={9999} style={{ ...small, width: 90 }} placeholder="No set number" value={given}
              onChange={e => setGiven(e.target.value)} aria-label={`How many of ${p.name} were given`} autoFocus />
            <button className="btn" type="submit" disabled={busy}>Save</button>
            <button className="btn secondary" type="button" onClick={() => setEditing(false)}>Cancel</button>
          </form>
        )}
      </div>

      {p.allocations.length > 0 && (
        <div style={{ marginTop: 8, display: 'grid', gap: 4 }}>
          {p.allocations.map(a => (
            <div key={a.orderId} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 14 }}>
              <Link to={`/orders/${a.orderId}`}><b>{a.number}</b></Link>
              <span className="acct-region">{dayText(a.date)}</span>
              <span>Qty {a.qty}</span>
              <button type="button" className="link-btn" disabled={busy}
                onClick={() => { if (window.confirm(`Take "${p.name}" off ${a.number}?`)) send('/unallocate', { promoId: p.id, orderId: a.orderId }); }}>Remove</button>
            </div>
          ))}
        </div>
      )}

      {allUsed ? <div className="acct-region" style={{ marginTop: 8 }}>All allocated.</div> : choices.length === 0 ? (
        <div className="acct-region" style={{ marginTop: 8 }}>{orders.length ? 'Every order of this customer already has this promo.' : 'This customer has no orders to allocate it to yet.'}</div>
      ) : (
        <form style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}
          onSubmit={async e => { e.preventDefault(); if (pick.orderId && await send('/allocate', { promoId: p.id, orderId: pick.orderId, qty: Number(pick.qty) || 1 })) setPick({ orderId: '', qty: '1' }); }}>
          <select style={small} value={pick.orderId} onChange={e => setPick({ ...pick, orderId: e.target.value })} aria-label={`Order to allocate ${p.name} to`}>
            <option value="">Allocate to order…</option>
            {choices.map(o => <option key={o.id} value={o.id}>{o.number} · {dayText(o.date)}{o.status ? ` · ${nice(o.status)}` : ''}</option>)}
          </select>
          <input type="number" min={1} max={p.left ?? 9999} style={{ ...small, width: 70 }} value={pick.qty}
            onChange={e => setPick({ ...pick, qty: e.target.value })} aria-label={`Quantity of ${p.name} on that order`} />
          <button className="btn" type="submit" disabled={busy || !pick.orderId}>Allocate</button>
        </form>
      )}
    </div>
  );
}
