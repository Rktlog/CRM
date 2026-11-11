import { useState, type CSSProperties } from 'react';
import { apiGet, apiPatch } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { ago, isOpen, requestsChanged, shortDate, STATUS_LABEL, STATUS_TONE, useOpenRequests, type RequestItem, type RequestStatus } from '../lib/productRequests';
import SupplierEmail from './SupplierEmail';

// The ordering team's side of the special requests.
// - RequestsPanel: the "Special requests" section at the top of Order Forecast & Procurement: what the sales team has asked for, newest unseen first, with the
//   buttons to move each one along and a note back to the person who asked.
// - RequestPill and RequestsForSku: on a product's row in the ordering plan, so the requests are in front of the buyer when he decides how much to order.
//   They are shown beside the suggested quantity and never added to it: the buyer decides.
// - RequestBadge: the number on the menu.

export function RequestBadge({ n, corner }: { n: number; corner?: boolean }) {
  // corner: a small dot at the top right of a menu tab that takes up no width, so the menu never shifts or wraps when a request arrives
  const base: CSSProperties = { display: 'inline-block', minWidth: 16, padding: '0 4px', borderRadius: 8, background: 'var(--rust)', color: '#fff', fontSize: 10.5, fontWeight: 700, lineHeight: '16px', textAlign: 'center' };
  const where: CSSProperties = corner ? { position: 'absolute', top: -10, right: -14 } : { marginLeft: 5, verticalAlign: 'middle' };
  return <span aria-label={`${n} new requests`} style={{ ...base, ...where }}>{n}</span>;
}

const units = (q: number | null) => (q ? `${q.toLocaleString('en-AU')} unit${q === 1 ? '' : 's'}` : 'quantity not given');
const small: CSSProperties = { padding: '4px 11px', fontSize: 12.5 };

function Card({ item }: { item: RequestItem }) {
  const [note, setNote] = useState(item.decisionNote ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const noteChanged = note.trim() !== (item.decisionNote ?? '');
  async function move(status: RequestStatus | null) {
    setBusy(status ?? 'note'); setErr(null);
    try {
      await apiPatch(`/product-requests/${item.id}`, { ...(status ? { status } : {}), ...(noteChanged ? { decisionNote: note.trim() || null } : {}) });
      requestsChanged();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(null); }
  }
  const actions: [RequestStatus, string][] = [['seen', 'Seen'], ['asked_supplier', 'Asked supplier'], ['supplier_replied', 'Supplier replied'], ['ordered', 'Ordered'], ['declined', 'Declined']];
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 6, padding: '10px 12px', background: 'var(--panel)', display: 'grid', gap: 6 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <b>{item.itemName}</b>
        {item.kind === 'new' && <span className="pill neutral">New item</span>}
        <span className={`pill ${STATUS_TONE[item.status]}`}>{STATUS_LABEL[item.status]}</span>
        <span className="acct-region">{item.sku ? `${item.sku} · ` : ''}{item.brand ?? ''}</span>
      </div>
      <div style={{ fontSize: 13 }}>
        {units(item.qty)} · {item.customer ? `for ${item.customer}` : 'no customer given'} · {item.neededBy ? `needed by ${shortDate(item.neededBy)}` : 'no date given'}
        <span className="acct-region"> · asked by {item.requestedBy.name ?? 'someone who has left'}, {ago(item.createdAt)}</span>
      </div>
      {item.stock && <div className="acct-region">Stock now: {item.stock.available.toLocaleString('en-AU')} available, {item.stock.onOrder.toLocaleString('en-AU')} on order</div>}
      {item.supplier && <div className="acct-region">Supplier they suggest: {item.supplier}</div>}
      {item.notes && <div style={{ fontSize: 13, color: 'var(--ink-soft)' }}>{item.notes}</div>}
      {item.link && <div style={{ fontSize: 13 }}><a href={item.link} target="_blank" rel="noopener noreferrer">{item.link.length > 70 ? item.link.slice(0, 70) + '…' : item.link}</a></div>}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {actions.filter(([k]) => k !== item.status).map(([k, label]) => (
          <button key={k} type="button" className="btn secondary" style={small} disabled={busy !== null} onClick={() => move(k)}>{busy === k ? 'Saving…' : label}</button>
        ))}
        {item.status !== 'requested' && <button type="button" className="btn secondary" style={small} disabled={busy !== null} onClick={() => move('requested')}>{busy === 'requested' ? 'Saving…' : 'Back to new'}</button>}
      </div>
      <SupplierEmail item={item} />
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <input value={note} onChange={e => setNote(e.target.value)} placeholder="Note back to the person who asked (they will see it)" aria-label="Note back to the person who asked" maxLength={1000}
          style={{ flex: '1 1 280px', padding: '5px 9px', border: '1px solid var(--line)', borderRadius: 3, fontSize: 13 }} />
        {noteChanged && <button type="button" className="btn secondary" style={small} disabled={busy !== null} onClick={() => move(null)}>{busy === 'note' ? 'Saving…' : 'Save note'}</button>}
      </div>
      {err && <div className="save-msg err" role="alert">{err}</div>}
    </div>
  );
}

export function RequestsPanel() {
  const { role } = useAuth();
  const s = useOpenRequests(role === 'manager');
  const [open, setOpen] = useState<boolean | null>(null);
  const [closed, setClosed] = useState<RequestItem[] | null>(null);
  const [closedErr, setClosedErr] = useState<string | null>(null);
  const [marking, setMarking] = useState(false);
  if (role !== 'manager') return null;
  const fresh = s.items.filter(i => i.status === 'requested'), inProgress = s.items.filter(i => i.status !== 'requested');
  const isOpenNow = open ?? fresh.length > 0;

  async function showClosed() {
    setClosedErr(null);
    try { setClosed((await apiGet('/product-requests/closed', { fresh: true })).items); } catch (e) { setClosedErr((e as Error).message); }
  }
  async function markAllSeen() {
    setMarking(true);
    try { for (const i of fresh) await apiPatch(`/product-requests/${i.id}`, { status: 'seen' }); } catch { /* the list below shows what did and did not change */ }
    setMarking(false); requestsChanged();
  }

  return (
    <details className="section" open={isOpenNow} onToggle={e => setOpen((e.currentTarget as HTMLDetailsElement).open)} style={{ marginBottom: 14 }}>
      <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
        Special requests
        {s.ready && fresh.length > 0 && <RequestBadge n={fresh.length} />}
        <span className="acct-region" style={{ fontWeight: 400, marginLeft: 8 }}>
          {!s.loaded ? 'loading…' : !s.ready ? '' : `${fresh.length} new, ${inProgress.length} in progress`}
        </span>
      </summary>
      <div style={{ display: 'grid', gap: 10, marginTop: 10 }}>
        <div className="acct-region" style={{ maxWidth: 760 }}>
          What the sales team has asked for, for products we already sell and for new ones. They are for you to weigh when ordering: the suggested quantities below do not include them.
          A request also shows on that product's row in the plan.
        </div>
        {!s.ready && <div className="save-msg err" role="alert">{s.error}</div>}
        {s.ready && s.error && <div className="save-msg err" role="alert">{s.error}</div>}
        {s.ready && s.loaded && s.items.length === 0 && !s.error && <div className="acct-region">No open requests.</div>}
        {fresh.length > 1 && <div><button type="button" className="btn secondary" style={small} disabled={marking} onClick={markAllSeen}>{marking ? 'Saving…' : `Mark all ${fresh.length} new as seen`}</button></div>}
        {fresh.map(i => <Card key={i.id + i.status + (i.decisionNote ?? '')} item={i} />)}
        {inProgress.length > 0 && <div className="stat-label" style={{ marginTop: 4 }}>In progress</div>}
        {inProgress.map(i => <Card key={i.id + i.status + (i.decisionNote ?? '')} item={i} />)}
        {s.ready && (closed === null
          ? <div><button type="button" className="link-btn" onClick={showClosed}>Show ordered, declined and cancelled in the last 30 days</button></div>
          : (<>
              <div className="stat-label" style={{ marginTop: 4 }}>Closed in the last 30 days</div>
              {closed.length === 0 && <div className="acct-region">None.</div>}
              {closed.map(i => (
                <div key={i.id} style={{ fontSize: 13, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <span className={`pill ${STATUS_TONE[i.status]}`}>{STATUS_LABEL[i.status]}</span>
                  <b>{i.itemName}</b><span className="acct-region">{units(i.qty)} · asked by {i.requestedBy.name ?? 'someone who has left'}{i.decisionNote ? ` · ${i.decisionNote}` : ''}</span>
                </div>
              ))}
            </>))}
        {closedErr && <div className="save-msg err" role="alert">{closedErr}</div>}
      </div>
    </details>
  );
}

/** On a product's row in the ordering plan: how many open requests it has, and for how many units. */
export function RequestPill({ sku }: { sku: string }) {
  const { role } = useAuth();
  const s = useOpenRequests(role === 'manager');
  const list = (s.bySku.get(sku.toUpperCase()) ?? []).filter(i => isOpen(i.status));
  if (!list.length) return null;
  const total = list.reduce((a, i) => a + (i.qty ?? 0), 0);
  return <div><span className="pill amber" title="Sales requests for this product (not included in the suggested quantity)">{list.length} request{list.length === 1 ? '' : 's'}{total ? ` · ${total.toLocaleString('en-AU')} units` : ''}</span></div>;
}

/** In a product's opened row: who asked, for which store, how many, and by when. */
export function RequestsForSku({ sku }: { sku: string }) {
  const { role } = useAuth();
  const s = useOpenRequests(role === 'manager');
  const list = (s.bySku.get(sku.toUpperCase()) ?? []).filter(i => isOpen(i.status));
  if (!list.length) return null;
  const total = list.reduce((a, i) => a + (i.qty ?? 0), 0);
  return (
    <div style={{ maxWidth: 380 }}>
      <div className="stat-label">Sales requests</div>
      {list.map(i => (
        <div key={i.id} style={{ marginBottom: 4 }}>
          {i.requestedBy.name ?? 'Someone who has left'} · {units(i.qty)}{i.customer ? ` · for ${i.customer}` : ''}{i.neededBy ? ` · needed by ${shortDate(i.neededBy)}` : ''}
          <span className="acct-region"> · {STATUS_LABEL[i.status].toLowerCase()}, {ago(i.createdAt)}</span>
          {i.notes && <div style={{ color: 'var(--ink-soft)' }}>{i.notes}</div>}
          {i.supplierAnswer && <div>Supplier said: {i.supplierAnswer}</div>}
        </div>
      ))}
      {total > 0 && <div className="acct-region">Asked for in total: {total.toLocaleString('en-AU')} units, not included in the suggested quantity.</div>}
    </div>
  );
}
