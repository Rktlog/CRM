import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { apiGet, apiPost, apiDownload } from '../lib/api';
import { fmtMoney, fmtDate } from '../lib/types';
import { groupReservations, groupStatus } from '../lib/creditGroups';
import { useMe, stateOptionsFor } from '../lib/useMe';
import StateFilter from '../components/StateFilter';
import DearPaymentCheck from '../components/DearPaymentCheck';

// Credit: every credit note on account, every reservation (one row each, whose status
// changes from Reserved to Used when DEAR shows the credit applied), and every credit
// movement, so the team can follow where credit has gone. Credit is applied in DEAR.
// The Prepayments tab lists money held on orders that is not a credit note: customers who
// paid up front, and overpaid orders. Finished orders that still hold money need applying
// in DEAR (or refunding). Any prepaid money can be reserved, open order or finished, except on an order that is
// complete in full (it has used its prepayment).

type NoteRow = {
  accountId: string; account: string; region: string; rep: string | null; orderNo: string; creditNo: string; date: string | null;
  total: number; applied: number; refunded: number; onAccount: number; reservedAmount: number; reservedFor: string | null; free: number;
};
type Reservation = {
  id: string; name: string; accountId: string; account: string; region: string; rep: string | null; amount: number;
  creditNo: string | null; orderRef: string | null; usedOnOrder: string | null; note: string | null;
  sourceKind?: 'credit_note' | 'prepayment'; sourceOrder?: string | null; toAccountId?: string; forAccount?: string;
  status: 'reserved' | 'used' | 'cancelled'; createdAt: string; createdBy: string | null; resolvedAt: string | null; resolvedBy: string | null;
};
type Totals = { onAccount: number; reserved: number; free: number; openNotes: number; customers: number; heldOnOrders?: number; toApply?: number; prepaidFree?: number };
type Held = {
  id: string; number: string; accountId: string; account: string; region: string; rep: string | null; status: string;
  orderDate: string | null; kind: 'Prepayment' | 'Overpaid'; amount: number; finished: boolean;
  cancelled?: boolean; completeInFull?: boolean; reservable?: boolean; orderTotal?: number | null; remaining?: number | null; reserved?: number; free?: number; released?: boolean; releaseNote?: string | null;
};
type HeldTotals = { free?: { amount: number; count: number }; toApply: { amount: number; count: number }; open: { amount: number; count: number }; all: { amount: number; count: number } };
const nice = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : '');
type Move = {
  date: string | null; type: string; accountId: string; account: string; region: string; rep: string | null;
  creditNo: string | null; reference: string | null; amount: number; by: string | null;
};
const PAGE = 100;
const TONE: Record<string, string> = { 'Credit note issued': 'teal', 'Applied to invoice': 'neutral', 'Refunded to customer': 'rust' };
const STATUS_TONE = { reserved: 'amber', used: 'teal', cancelled: 'neutral' } as const;
const STATUS_WORD = { reserved: 'Reserved', used: 'Used', cancelled: 'Released' } as const;

export default function Credit() {
  const me = useMe();
  const stateOptions = stateOptionsFor(me);
  // Links like /credit?tab=prepayments&view=all&q=MOOII open straight onto a tab and a customer.
  const [params] = useSearchParams();
  const startTab = params.get('tab');
  const [tab, setTab] = useState<'notes' | 'prepayments' | 'reservations' | 'moves'>(
    startTab === 'prepayments' || startTab === 'reservations' || startTab === 'moves' ? startTab : 'notes');
  const [region, setRegion] = useState('');
  const [search, setSearch] = useState(params.get('q') ?? '');
  const [status, setStatus] = useState('open');
  const [resStatus, setResStatus] = useState('reserved');
  const startView = params.get('view');
  const [heldView, setHeldView] = useState<'free' | 'apply' | 'open' | 'all'>(startView === 'open' || startView === 'all' || startView === 'apply' ? startView : 'free');
  const [held, setHeld] = useState<Held[] | null>(null);
  const [heldTotals, setHeldTotals] = useState<HeldTotals | null>(null);
  const [reservations, setReservations] = useState<Reservation[] | null>(null);
  const [type, setType] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const [notes, setNotes] = useState<NoteRow[] | null>(null);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [moves, setMoves] = useState<Move[]>([]);
  const [moveTotal, setMoveTotal] = useState(0);
  const [types, setTypes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [reload, setReload] = useState(0);
  const [dearFor, setDearFor] = useState<string | null>(null);

  // The customer no longer wants this open order (a dropped backorder): free its prepayment so it can be reserved.
  async function release(h: Held) {
    const note = window.prompt(`Free the ${fmtMoney(h.amount)} prepaid on ${h.number} so it can be used?\n\nWhy? For example: customer doesn't want the backorder`);
    if (!note || !note.trim()) return;
    try {
      await apiPost('/credit/release-order', { orderNo: h.number, note });
    } catch (e) {
      const msg = (e as Error).message;
      if (!msg.startsWith("Couldn't confirm with DEAR")) { window.alert(msg); return; }
      if (!window.confirm(`${msg}\n\nRelease it anyway? Only if you have checked the payment in DEAR yourself.`)) return;
      try { await apiPost('/credit/release-order', { orderNo: h.number, note, confirmedInDear: true }); }
      catch (e2) { window.alert((e2 as Error).message); return; }
    }
    window.alert(`${h.number} is released. Also cancel its backordered lines in DEAR, or the stock may still ship and use this money.`);
    setReload(n => n + 1);
  }
  async function unrelease(h: Held) {
    if (!window.confirm(`Put the money back with ${h.number}?`)) return;
    try { await apiPost('/credit/unrelease-order', { orderNo: h.number }); setReload(n => n + 1); }
    catch (e) { window.alert((e as Error).message); }
  }

  const base = () => {
    const p = new URLSearchParams();
    if (region) p.set('region', region);
    if (search.trim()) p.set('q', search.trim());
    return p;
  };

  // The totals follow the state filter and search, on both tabs.
  useEffect(() => {
    const t = setTimeout(() => {
      setError(null);
      const p = base();
      if (tab === 'notes') {
        p.set('status', status);
        setLoading(true);
        apiGet(`/credit/notes?${p.toString()}`).then(d => { setNotes(d.rows); setTotals(d.totals); }).catch(e => setError(e.message)).finally(() => setLoading(false));
      } else if (tab === 'prepayments') {
        apiGet(`/credit/notes?${base().toString()}`).then(d => setTotals(d.totals)).catch(() => {});
        const p3 = base();
        p3.set('view', heldView);
        setLoading(true);
        apiGet(`/credit/prepayments?${p3.toString()}`).then(d => { setHeld(d.rows); setHeldTotals(d.totals); }).catch(e => setError(e.message)).finally(() => setLoading(false));
      } else if (tab === 'reservations') {
        apiGet(`/credit/notes?${base().toString()}`).then(d => setTotals(d.totals)).catch(() => {});
        const p2 = base();
        if (resStatus) p2.set('status', resStatus);
        setLoading(true);
        apiGet(`/credit/reservations?${p2.toString()}`).then(d => setReservations(d.rows)).catch(e => setError(e.message)).finally(() => setLoading(false));
      } else {
        apiGet(`/credit/notes?${base().toString()}`).then(d => setTotals(d.totals)).catch(() => {});
        loadMoves(0, false);
      }
    }, search ? 300 : 0);
    return () => clearTimeout(t);
  }, [tab, region, search, status, resStatus, heldView, type, from, to, reload]);

  function loadMoves(offset: number, append: boolean) {
    const p = base();
    if (type) p.set('type', type);
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    p.set('limit', String(PAGE)); p.set('offset', String(offset));
    setLoading(true);
    apiGet(`/credit/movements?${p.toString()}`)
      .then(d => { setMoves(prev => (append ? [...prev, ...d.rows] : d.rows)); setMoveTotal(d.total); setTypes(d.types); })
      .catch(e => setError(e.message)).finally(() => setLoading(false));
  }

  async function download() {
    setDownloading(true);
    try {
      const p = base();
      if (type) p.set('type', type);
      if (from) p.set('from', from);
      if (to) p.set('to', to);
      await apiDownload(`/exports/credit-movements?${p.toString()}`, 'credit.xlsx');
    } catch { alert('Download failed. Check the API is running.'); }
    finally { setDownloading(false); }
  }

  const signed = (n: number) => (n < 0 ? `-${fmtMoney(-n)}` : fmtMoney(n));

  return (
    <>
      <h1>Credit</h1>
      <div className="stock-as-of">
        Every credit note on account, every reservation and every credit movement. Credit is applied in DEAR. A reservation is the team's plan, and the same row is marked used by itself once DEAR shows that credit note applied.
      </div>

      <div className="stat-row" style={{ margin: '12px 0' }}>
        <Stat label="Credit on account" value={totals ? fmtMoney(totals.onAccount) : '…'} sub={totals ? `${totals.openNotes} credit notes, ${totals.customers} customers` : ''} tone="flag-teal" />
        <Stat label="Reserved for orders" value={totals ? fmtMoney(totals.reserved) : '…'} sub="set aside, waiting for DEAR" tone="flag-amber" />
        <Stat label="Free to use" value={totals ? fmtMoney(totals.free) : '…'} sub="not reserved" />
      </div>

      {totals && (totals.heldOnOrders ?? 0) > 0.005 && (
        <div className="acct-region" style={{ margin: '-4px 0 12px' }}>
          Not counted above: {fmtMoney(totals.heldOnOrders!)} held as prepayments or overpayments on orders. They are not credit notes.{' '}
          {(totals.prepaidFree ?? 0) > 0.005 ? `${fmtMoney(totals.prepaidFree!)} of it is prepaid money that can be reserved. ` : ''}
          {(totals.toApply ?? 0) > 0.005 ? `${fmtMoney(totals.toApply!)} is on finished or cancelled orders and needs applying in DEAR. ` : ''}
          <button className="link-btn" onClick={() => setTab('prepayments')}>See the Prepayments tab</button>
        </div>
      )}

      <div className="controls" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
        <StateFilter value={region} onChange={setRegion} options={stateOptions} allLabel={me?.role === 'manager' ? 'All states' : 'All my states'} />
        <input type="search" placeholder="Search customer, credit no or order" value={search} onChange={e => setSearch(e.target.value)}
          style={{ padding: '7px 10px', border: '1px solid var(--line)', borderRadius: 6, font: 'inherit', fontSize: 13, background: 'var(--panel)', minWidth: 240 }} />
        <button className="btn secondary" style={{ marginLeft: 'auto' }} disabled={downloading} onClick={download}>{downloading ? 'Downloading…' : '⬇ Excel'}</button>
      </div>

      <div className="tab-bar" style={{ marginBottom: 12 }}>
        <button className={'tab' + (tab === 'notes' ? ' active' : '')} onClick={() => setTab('notes')}>Credit on account</button>
        <button className={'tab' + (tab === 'prepayments' ? ' active' : '')} onClick={() => setTab('prepayments')}>Prepayments</button>
        <button className={'tab' + (tab === 'reservations' ? ' active' : '')} onClick={() => setTab('reservations')}>Reservations</button>
        <button className={'tab' + (tab === 'moves' ? ' active' : '')} onClick={() => setTab('moves')}>Movements</button>
      </div>

      {error && <div className="empty-state">Couldn't load credit: {error}</div>}

      {!error && tab === 'notes' && (
        <>
          <div className="controls" style={{ marginBottom: 8 }}>
            <select value={status} onChange={e => setStatus(e.target.value)} aria-label="Credit status">
              <option value="open">Free to use</option>
              <option value="reserved">Reserved</option>
              <option value="used">Fully used</option>
              <option value="">All credit notes</option>
            </select>
          </div>
          {loading && !notes ? <div className="empty-state">Loading…</div>
            : !notes || !notes.length ? <div className="empty-state">No credit notes match.</div>
            : (
              <div className="manifest">
                <div className="m-row head" style={{ gridTemplateColumns: '2fr 0.5fr 0.9fr 0.8fr 0.8fr 0.9fr 0.9fr 1.2fr' }}>
                  <div>Customer</div><div>State</div><div>Credit no</div><div>Date</div><div className="num">Total</div><div className="num">Applied</div><div className="num">On account</div><div>Reserved</div>
                </div>
                {notes.map(n => (
                  <div className="m-row" key={n.creditNo + n.orderNo} style={{ gridTemplateColumns: '2fr 0.5fr 0.9fr 0.8fr 0.8fr 0.9fr 0.9fr 1.2fr', cursor: 'default' }}>
                    <div><Link to={`/accounts/${n.accountId}`} className="order-link">{n.account}</Link>{n.rep && <div className="acct-region">{n.rep}</div>}</div>
                    <div>{n.region}</div>
                    <div>{n.creditNo}<div className="acct-region">{n.orderNo}</div></div>
                    <div>{n.date ? fmtDate(n.date) : ''}</div>
                    <div className="num">{fmtMoney(n.total)}</div>
                    <div className="num">{fmtMoney(n.applied + n.refunded)}</div>
                    <div className="num"><b>{fmtMoney(n.onAccount)}</b></div>
                    <div>
                      {n.reservedAmount > 0.005 && <span className="pill amber">{fmtMoney(n.reservedAmount)}{n.reservedFor ? ` · ${n.reservedFor}` : ''}</span>}
                      {n.reservedAmount <= 0.005 && <span className="acct-region">{n.onAccount > 0.005 ? 'Free' : 'Used'}</span>}
                      {n.reservedAmount > 0.005 && n.free > 0.005 && <div className="acct-region">{fmtMoney(n.free)} free</div>}
                    </div>
                  </div>
                ))}
              </div>
            )}
        </>
      )}

      {!error && tab === 'prepayments' && (
        <>
          <div className="acct-region" style={{ marginBottom: 8, maxWidth: 760 }}>
            Money held on orders that is not a credit note. Any prepaid money can be <b>reserved</b> for that customer's next order
            (press Reserve to open the customer), whether the order is open, cancelled or released, except on an order that is
            <b>complete in full</b>: that order has used its prepayment. Money on an open order is checked against DEAR before it is
            reserved, and that order stops counting it as paid. It still has to be applied or refunded in DEAR. If the customer has
            dropped an open order, press <b>Release</b> (also checked against DEAR first).
          </div>
          <div className="tab-bar" style={{ marginBottom: 10 }}>
            {([
              ['free', 'Free to reserve', heldTotals?.free],
              ['apply', 'To apply in DEAR', heldTotals?.toApply],
              ['open', 'Held for open orders', heldTotals?.open],
              ['all', 'All', heldTotals?.all],
            ] as const).map(([key, label, t]) => (
              <button key={key} className={'tab' + (heldView === key ? ' active' : '')} onClick={() => setHeldView(key)}>
                {label}{t ? ` · ${fmtMoney(t.amount)} (${t.count})` : ''}
              </button>
            ))}
          </div>
          {loading && !held ? <div className="empty-state">Loading…</div>
            : !held || !held.length ? <div className="empty-state">{heldView === 'free' ? 'No prepaid money is free to reserve. (Prepaid money on an order that is complete in full is not reservable.)' : heldView === 'apply' ? 'Nothing to apply: no finished or cancelled order is holding a prepayment.' : 'None.'}</div>
            : (
              <div className="manifest">
                <div className="m-row head" style={{ gridTemplateColumns: '1.8fr 0.45fr 0.85fr 1fr 0.8fr 0.7fr 0.85fr 0.85fr 0.85fr 0.85fr 1.4fr' }}>
                  <div>Customer</div><div>State</div><div>Order</div><div>Status</div><div>Order date</div><div>Type</div><div className="num">Order total</div><div className="num">Prepaid</div><div className="num">Left to pay</div><div className="num">Free to reserve</div><div></div>
                </div>
                {held.map(h => (
                  <div className="m-row" key={h.id + h.kind} style={{ gridTemplateColumns: '1.8fr 0.45fr 0.85fr 1fr 0.8fr 0.7fr 0.85fr 0.85fr 0.85fr 0.85fr 1.4fr', cursor: 'default' }}>
                    <div><Link to={`/accounts/${h.accountId}`} className="order-link">{h.account}</Link>{h.rep && <div className="acct-region">{h.rep}</div>}</div>
                    <div>{h.region}</div>
                    <div><Link to={`/orders/${h.id}`} className="order-link">{h.number}</Link></div>
                    <div><span className={`pill ${h.cancelled ? 'rust' : h.finished ? 'amber' : 'neutral'}`}>{h.cancelled ? 'Cancelled' : nice(h.status) || '—'}</span>{h.released && <div><span className="pill teal" title={h.releaseNote ?? undefined}>Released</span></div>}</div>
                    <div>{h.orderDate ? fmtDate(h.orderDate) : ''}</div>
                    <div><span className={`pill ${h.kind === 'Overpaid' ? 'rust' : 'teal'}`}>{h.kind}</span></div>
                    <div className="num">{h.orderTotal != null ? fmtMoney(h.orderTotal) : ''}</div>
                    <div className="num"><b>{fmtMoney(h.amount)}</b></div>
                    <div className="num">{h.remaining == null ? <span className="acct-region">—</span> : h.remaining > 0.005 ? <b>{fmtMoney(h.remaining)}</b> : <span className="pill teal">Paid in full</span>}</div>
                    <div className="num">
                      {h.reservable ? <><b>{fmtMoney(h.free ?? 0)}</b>{(h.reserved ?? 0) > 0.005 && <div className="acct-region">{fmtMoney(h.reserved!)} reserved</div>}</> : <span className="acct-region">{h.completeInFull ? 'complete in full' : 'held'}</span>}
                    </div>
                    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                      {(h.free ?? 0) > 0.005 && <Link to={`/accounts/${h.accountId}`} className="order-link">Reserve</Link>}
                      {h.kind === 'Prepayment' && <button type="button" className="link-btn" onClick={() => setDearFor(h.number)}>Check DEAR</button>}
                      {h.kind === 'Prepayment' && !h.finished && <button type="button" className="link-btn" title="The customer has dropped this order. Checked against DEAR first." onClick={() => release(h)}>Release</button>}
                      {h.released && <button type="button" className="link-btn" onClick={() => unrelease(h)}>Undo release</button>}
                    </div>
                  </div>
                ))}
              </div>
            )}
        </>
      )}

      {!error && tab === 'reservations' && (
        <>
          <div className="controls" style={{ marginBottom: 8 }}>
            <select value={resStatus} onChange={e => setResStatus(e.target.value)} aria-label="Reservation status">
              <option value="reserved">Reserved</option>
              <option value="used">Used</option>
              <option value="cancelled">Released</option>
              <option value="">All reservations</option>
            </select>
          </div>
          {loading && !reservations ? <div className="empty-state">Loading…</div>
            : !reservations || !reservations.length ? <div className="empty-state">No reservations match.</div>
            : (
              <div className="manifest">
                <div className="m-row head" style={{ gridTemplateColumns: '2fr 0.5fr 0.9fr 0.9fr 1fr 1.6fr 1fr' }}>
                  <div>Name</div><div>State</div><div className="num">Amount</div><div>Credit no</div><div>Sales order / quote</div><div>Note</div><div>Status</div>
                </div>
                {groupReservations(reservations).map(g => {
                  const st = groupStatus(g);
                  return (
                    <div key={g.key} data-group={g.items.length > 1 ? (g.orderRef ?? 'next') : undefined}>
                      {g.items.length > 1 && (
                        // Reservations for the same order, together: "SQ37512: 3 credit notes, $425.00, Used"
                        <div className="m-row" style={{ gridTemplateColumns: '1fr auto', cursor: 'default', background: 'var(--paper)' }}>
                          <div>
                            <b>{g.orderRef ?? 'Their next order'}: {g.items.length} {g.items.every(x => x.sourceKind === 'prepayment') ? 'prepayments' : g.items.some(x => x.sourceKind === 'prepayment') ? 'items' : 'credit notes'}, {fmtMoney(g.total)}</b>
                            <span className="acct-region"> · {g.items[0].name}</span>
                          </div>
                          <div><span className={`pill ${st.tone}`}>{st.word}</span></div>
                        </div>
                      )}
                      {g.items.map(r => (
                      <div className="m-row" key={r.id} style={{ gridTemplateColumns: '2fr 0.5fr 0.9fr 0.9fr 1fr 1.6fr 1fr', cursor: 'default' }}>
                        <div>
                          <Link to={`/accounts/${r.accountId}`} className="order-link">{r.name}</Link>
                          <div className="acct-region">{r.name !== r.account ? `${r.account}. ` : ''}{r.forAccount && r.forAccount !== r.account ? `For ${r.forAccount}. ` : ''}{r.createdBy ?? ''}{r.createdBy ? ', ' : ''}{r.createdAt ? fmtDate(r.createdAt) : ''}</div>
                        </div>
                        <div>{r.region}</div>
                        <div className="num"><b>{fmtMoney(r.amount)}</b></div>
                        <div>{r.creditNo ?? (r.sourceKind === 'prepayment' ? `Prepaid on ${r.sourceOrder}` : '')}</div>
                        <div>{r.usedOnOrder ?? r.orderRef ?? <span className="acct-region">Next order</span>}</div>
                        <div className="acct-region">{r.note ?? ''}</div>
                        <div>
                          <span className={`pill ${STATUS_TONE[r.status]}`}>{STATUS_WORD[r.status]}</span>
                          {r.status !== 'reserved' && r.resolvedAt && (
                            <div className="acct-region">{fmtDate(r.resolvedAt)}{r.status === 'used' && r.resolvedBy === 'Found in DEAR' ? ', DEAR' : r.resolvedBy ? `, ${r.resolvedBy}` : ''}</div>
                          )}
                        </div>
                      </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            )}
        </>
      )}

      {!error && tab === 'moves' && (
        <>
          <div className="controls" style={{ marginBottom: 8, flexWrap: 'wrap' }}>
            <select value={type} onChange={e => setType(e.target.value)} aria-label="Movement type">
              <option value="">All movements</option>
              {(types.length ? types : ['Credit note issued', 'Applied to invoice', 'Refunded to customer']).map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <label className="acct-region">From <input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label>
            <label className="acct-region">To <input type="date" value={to} onChange={e => setTo(e.target.value)} /></label>
            {(type || from || to) && <button className="link-btn" onClick={() => { setType(''); setFrom(''); setTo(''); }}>Clear</button>}
          </div>
          {loading && !moves.length ? <div className="empty-state">Loading…</div>
            : !moves.length ? <div className="empty-state">No movements match.</div>
            : (
              <div className="manifest">
                <div className="m-row head" style={{ gridTemplateColumns: '0.8fr 1.2fr 2fr 0.5fr 0.9fr 1.5fr 0.9fr 1fr' }}>
                  <div>Date</div><div>Movement</div><div>Customer</div><div>State</div><div>Credit no</div><div>Reference</div><div className="num">Amount</div><div>By</div>
                </div>
                {moves.map((m, i) => (
                  <div className="m-row" key={i} style={{ gridTemplateColumns: '0.8fr 1.2fr 2fr 0.5fr 0.9fr 1.5fr 0.9fr 1fr', cursor: 'default' }}>
                    <div>{m.date ? fmtDate(m.date) : ''}</div>
                    <div><span className={`pill ${TONE[m.type] ?? 'neutral'}`}>{m.type}</span></div>
                    <div><Link to={`/accounts/${m.accountId}`} className="order-link">{m.account}</Link></div>
                    <div>{m.region}</div>
                    <div>{m.creditNo ?? ''}</div>
                    <div className="acct-region">{m.reference ?? ''}</div>
                    <div className="num" style={{ color: m.amount < 0 ? 'var(--rust)' : undefined }}>{signed(m.amount)}</div>
                    <div className="acct-region">{m.by ?? ''}</div>
                  </div>
                ))}
              </div>
            )}
          {moves.length > 0 && moves.length < moveTotal && (
            <button className="btn secondary" style={{ marginTop: 12 }} disabled={loading} onClick={() => loadMoves(moves.length, true)}>
              {loading ? 'Loading…' : `Show ${Math.min(PAGE, moveTotal - moves.length)} more (${(moveTotal - moves.length).toLocaleString('en-AU')} left)`}
            </button>
          )}
        </>
      )}
    </>
  );
}

function Stat({ label, value, sub, tone = '' }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className={`stat ${tone}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value num">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}