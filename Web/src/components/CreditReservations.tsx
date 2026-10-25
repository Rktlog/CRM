import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiGet, apiPatch, apiPost } from '../lib/api';
import { fmtMoney, fmtDate } from '../lib/types';
import { groupReservations, groupStatus, type ReservationGroup } from '../lib/creditGroups';

// Credit on an account. The team reserves credit by hand: a name, an amount, the credit
// note number, the sales order / quote number (blank = their next order) and a note. It
// shows here as Reserved, and against the credit note. When DEAR shows that credit note
// applied for a similar amount, the SAME row is marked used by itself.
//
// Several credit notes can be reserved for the SAME order in one go (tick them, enter the
// order once). Reservations for the same order are shown together:
// "SQ37512: 3 credit notes, $425.00, Used".
//
// Each piece of money appears ONCE. A reservation row carries its credit note's details
// (date), and a credit note only gets a row of its own for the part that is still free, so
// the same $197.87 is never listed both as a credit note and as a reservation.

type Note = {
  creditNo: string; date: string | null; orderNo: string; total: number; onAccount: number;
  reservedAmount: number; reservedFor: string | null; free: number;
};
type Prepaid = { orderNo: string; orderId: string; status: string; cancelled: boolean; orderDate: string | null; amount: number; reserved: number; free: number; checkable?: number; needsCheck?: boolean; orderTotal?: number | null; leftToPay?: number | null };
// How much of a prepayment can be put forward: what is free, or, on a completed order, what DEAR will be asked to confirm.
const room = (p: Pick<Prepaid, 'free' | 'checkable' | 'needsCheck'>) => (p.needsCheck ? p.checkable ?? 0 : p.free);
type Reservation = {
  id: string; name: string; amount: number; orderRef: string | null; creditNo: string | null; sourceKind?: 'credit_note' | 'prepayment'; sourceOrder?: string | null;
  usedOnOrder: string | null; note: string | null;
  status: 'reserved' | 'used' | 'cancelled'; createdAt: string; resolvedAt: string | null;
  fromAccountId: string; fromName: string; toAccountId: string; toName: string;
  createdBy: string | null; resolvedBy: string | null; direction: 'own' | 'out' | 'in'; stale: boolean;
};
type Credit = {
  creditInDear: number; otherCredit: number; reserved: number; available: number;
  reservable: { creditNo: string; date: string | null; onAccount: number; free: number }[];
  notes: Note[]; reservations: Reservation[];
  // prepaid money on cancelled or finished orders: reservable like a credit note
  prepaid?: Prepaid[]; prepaidHeld?: number; prepaidFree?: number;
};
type OrderInfo = { found?: boolean; status?: string; total?: number; toPay?: number; error?: string };
const TONE = { reserved: 'amber', used: 'teal', cancelled: 'neutral' } as const;
const WORD = { reserved: 'Reserved', used: 'Used', cancelled: 'Released' } as const;
const nice = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : '');

export default function CreditReservations({ accountId, accountName }: { accountId: string; accountName?: string }) {
  const [credit, setCredit] = useState<Credit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    apiGet(`/credit/account/${accountId}`).then(setCredit).catch(e => setError(e.message));
  }, [accountId, refresh]);

  if (error || !credit) return null;
  const withCredit = credit.notes.filter(n => n.onAccount > 0.005);
  // A credit note is listed on its own only for the part that is still free; reserved parts show as reservations.
  const freeNotes = withCredit.filter(n => n.free > 0.005);
  const noteOf = new Map(credit.notes.map(n => [n.creditNo.toUpperCase(), n]));
  const heldLink = `/credit?tab=prepayments&view=all&q=${encodeURIComponent(accountName ?? '')}`;
  // Prepaid money on cancelled or finished orders is free to reserve, like a credit note.
  const prepaid = credit.prepaid ?? [];
  const freePrepaid = prepaid.filter(p => p.free > 0.005);
  // Prepaid money still showing on a COMPLETED order: normally the order used it, but if the customer overpaid, DEAR still holds it. It is offered,
  // not counted as free, and DEAR is asked before any of it is reserved.
  const checkPrepaid = prepaid.filter(p => p.needsCheck && (p.checkable ?? 0) > 0.005);
  const reservablePrepaid = [...freePrepaid, ...checkPrepaid];
  const prepaidHeld = credit.prepaidHeld ?? 0, prepaidFree = credit.prepaidFree ?? 0;
  // Nothing at all: no credit, nothing reserved, nothing held on orders.
  if (credit.creditInDear <= 0.005 && !credit.reservations.length && !withCredit.length && !prepaid.length && credit.otherCredit <= 0.005) return null;
  // No credit notes or prepaid money, but money is held on orders: say why there is nothing to reserve, instead of vanishing.
  if (credit.creditInDear <= 0.005 && !credit.reservations.length && !withCredit.length && !prepaid.length) {
    return (
      <div className="card credit-card">
        <h3>Credit</h3>
        <div className="acct-region">
          No credit notes on account, so there is nothing to reserve here. {fmtMoney(credit.otherCredit)} is held on orders as a prepayment
          or overpayment, which is not a credit note. It becomes free to reserve if its order is cancelled.{' '}
          <Link to={heldLink} className="order-link">See those orders</Link>
        </div>
      </div>
    );
  }

  async function close(r: Reservation, status: 'used' | 'cancelled') {
    const what = status === 'used' ? 'Mark this credit as applied in DEAR? (When it has a credit no, this happens by itself.)' : 'Release this reservation and free the credit?';
    if (!window.confirm(what)) return;
    await apiPatch(`/credit/reservations/${r.id}`, { status });
    setRefresh(n => n + 1);
  }
  async function releaseAll(g: ReservationGroup<Reservation>) {
    const open = g.items.filter(r => r.status === 'reserved');
    if (!window.confirm(`Release all ${open.length} open reservations for ${g.orderRef ?? 'their next order'} and free the credit?`)) return;
    for (const r of open) await apiPatch(`/credit/reservations/${r.id}`, { status: 'cancelled' });
    setRefresh(n => n + 1);
  }

  const groups = groupReservations(credit.reservations);

  return (
    <div className="card credit-card">
      <h3>Credit</h3>

      {(credit.creditInDear > 0.005 || prepaidHeld > 0.005) && (
        <div className="credit-summary">
          <div>
            <div className="stat-label">Free to use</div>
            <div className="credit-free num">{fmtMoney(credit.available + prepaidFree)}</div>
          </div>
          <div className="acct-region">
            {[credit.creditInDear > 0.005 && `${fmtMoney(credit.creditInDear)} on credit notes`, prepaidHeld > 0.005 && `${fmtMoney(prepaidHeld)} prepaid on cancelled or finished orders`].filter(Boolean).join(', ')}
            {credit.reserved > 0.005 ? `, ${fmtMoney(credit.reserved)} reserved` : ''}
          </div>
        </div>
      )}
      {credit.otherCredit > 0.005 && (
        <div className="acct-region" style={{ marginBottom: 8 }}>
          Also {fmtMoney(credit.otherCredit)} is held as a prepayment or overpayment on orders. That is not a credit note, so it is not counted above or free to reserve.{' '}
          <Link to={heldLink} className="order-link">See those orders</Link>
        </div>
      )}

      {freeNotes.length > 0 && (
        <div className="credit-list">
          {freeNotes.map(n => (
            <div className="credit-row" key={n.creditNo}>
              <div>
                <div className="acct-name">{n.creditNo} <span className="acct-region">{n.date ? fmtDate(n.date) : ''}</span></div>
                <div className="acct-region">
                  {fmtMoney(n.free)} free
                  {n.reservedAmount > 0.005 ? `, the rest of this credit note is reserved` : ' on account'}
                  {n.onAccount < n.total - 0.005 ? ` (credit note of ${fmtMoney(n.total)})` : ''}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}><span className="pill teal">Free</span></div>
            </div>
          ))}
        </div>
      )}

      {freePrepaid.length > 0 && (
        <div className="credit-list">
          {freePrepaid.map(p => (
            <div className="credit-row" key={p.orderNo}>
              <div>
                <div className="acct-name">Prepaid on <Link to={`/orders/${p.orderId}`} className="order-link">{p.orderNo}</Link>{' '}
                  <span className="acct-region">{p.cancelled ? 'order cancelled' : `order ${nice(p.status).toLowerCase()}`}{p.orderDate ? `, ${fmtDate(p.orderDate)}` : ''}</span></div>
                <div className="acct-region">
                  {fmtMoney(p.free)} free{p.reserved > 0.005 ? ', the rest is reserved' : ''}{p.amount - p.free - p.reserved > 0.005 ? ` (of ${fmtMoney(p.amount)} prepaid)` : ''}
                </div>
                {p.orderTotal != null && (
                  <div className="acct-region">
                    Order {fmtMoney(p.orderTotal)}, {fmtMoney(p.amount)} prepaid{p.leftToPay == null ? '' : p.leftToPay > 0.005 ? `, ${fmtMoney(p.leftToPay)} left to pay` : ', paid in full'}
                  </div>
                )}
              </div>
              <div style={{ textAlign: 'right' }}><span className="pill teal">Free</span></div>
            </div>
          ))}
        </div>
      )}

      {checkPrepaid.length > 0 && (
        <div className="credit-list">
          {checkPrepaid.map(p => (
            <div className="credit-row" key={`check-${p.orderNo}`}>
              <div>
                <div className="acct-name">Prepaid on <Link to={`/orders/${p.orderId}`} className="order-link">{p.orderNo}</Link>{' '}
                  <span className="acct-region">completed order{p.orderDate ? `, ${fmtDate(p.orderDate)}` : ''}</span></div>
                <div className="acct-region">
                  {fmtMoney(p.checkable ?? 0)} still shows as prepaid on a completed order{p.orderTotal != null ? ` (the order was ${fmtMoney(p.orderTotal)})` : ''}.
                  If DEAR still holds it unapplied, the customer overpaid and you can reserve it for their next order. DEAR is checked first, and only what DEAR confirms can be reserved.
                </div>
              </div>
              <div style={{ textAlign: 'right' }}><span className="pill neutral">Check in DEAR</span></div>
            </div>
          ))}
        </div>
      )}

      {groups.length > 0 && (
        <div className="credit-list">
          {groups.map(g => g.items.length === 1
            ? <ReservationRow key={g.items[0].id} r={g.items[0]} accountName={accountName} onClose={close} note={noteOf.get((g.items[0].creditNo ?? '').toUpperCase())} />
            : <GroupBlock key={g.key} g={g} accountName={accountName} onClose={close} onReleaseAll={releaseAll} noteOf={noteOf} />)}
        </div>
      )}

      {(credit.available > 0.005 || reservablePrepaid.length > 0) && !formOpen && (
        <button className="btn secondary" style={{ marginTop: 8 }} onClick={() => setFormOpen(true)}>{credit.available > 0.005 ? 'Reserve credit' : 'Reserve prepaid money'}</button>
      )}
      {formOpen && (
        <ReserveForm
          accountId={accountId}
          accountName={accountName ?? ''}
          available={credit.available}
          options={credit.reservable}
          prepaid={reservablePrepaid}
          onDone={() => { setFormOpen(false); setRefresh(n => n + 1); }}
          onCancel={() => setFormOpen(false)}
        />
      )}

      <div className="acct-region credit-footnote">
        Reserving records the plan. The credit is applied in DEAR. When DEAR shows that credit note applied for a similar amount, this same row is marked used by itself.
      </div>
    </div>
  );
}

// Reservations for the same order, together: "SQ37512: 3 credit notes, $425.00" and one status.
function GroupBlock({ g, accountName, onClose, onReleaseAll, noteOf }: {
  g: ReservationGroup<Reservation>; accountName?: string; noteOf: Map<string, Note>;
  onClose: (r: Reservation, status: 'used' | 'cancelled') => void; onReleaseAll: (g: ReservationGroup<Reservation>) => void;
}) {
  const st = groupStatus(g);
  const open = g.items.filter(r => r.status === 'reserved').length;
  return (
    <div data-group={g.orderRef ?? 'next'} style={{ borderLeft: '3px solid var(--line)' }}>
      <div className="credit-row" style={{ background: 'var(--paper)' }}>
        <div>
          <div className="acct-name">{g.orderRef ?? 'Their next order'}: {g.items.length} credit notes, {fmtMoney(g.total)}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <span className={`pill ${st.tone}`}>{st.word}</span>
          {open > 1 && <div><button className="link-btn" onClick={() => onReleaseAll(g)}>Release all {open}</button></div>}
        </div>
      </div>
      {g.items.map(r => <ReservationRow key={r.id} r={r} accountName={accountName} onClose={onClose} nested note={noteOf.get((r.creditNo ?? '').toUpperCase())} />)}
    </div>
  );
}

function ReservationRow({ r, accountName, onClose, nested, note }: {
  r: Reservation; accountName?: string; onClose: (r: Reservation, status: 'used' | 'cancelled') => void; nested?: boolean; note?: Note;
}) {
  return (
    <div className="credit-row" style={{ ...(r.status === 'reserved' ? {} : { opacity: 0.75 }), ...(nested ? { paddingLeft: 14 } : {}) }}>
      <div>
        <div className="acct-name">
          {fmtMoney(r.amount)}{r.creditNo ? `, ${r.creditNo}` : ''}{r.sourceKind === 'prepayment' && r.sourceOrder ? `, prepaid on ${r.sourceOrder}` : ''}
          {note?.date && <span className="acct-region"> (credit note of {fmtDate(note.date)}{note.total > r.amount + 0.005 ? `, ${fmtMoney(note.total)} in all` : ''})</span>}
          {r.direction === 'out' && <> for <Link to={`/accounts/${r.toAccountId}`} className="order-link">{r.toName}</Link></>}
          {r.direction === 'in' && <> from <Link to={`/accounts/${r.fromAccountId}`} className="order-link">{r.fromName}</Link></>}
          {!nested && <>{' '}<span className="acct-region">{r.orderRef ? `for ${r.orderRef}` : 'for their next order'}</span></>}
        </div>
        <div className="acct-region">
          {r.name && r.name !== accountName ? `${r.name}. ` : ''}
          By {r.createdBy ?? 'someone'} on {fmtDate(r.createdAt)}{r.note ? `. ${r.note}` : ''}
        </div>
        {r.status === 'used' && (
          <div className="acct-region">
            {r.resolvedBy === 'Found in DEAR' || !r.resolvedBy ? 'DEAR showed it applied' : `Marked used by ${r.resolvedBy}`}
            {r.usedOnOrder ? ` on ${r.usedOnOrder}` : ''}{r.resolvedAt ? `, ${fmtDate(r.resolvedAt)}` : ''}
          </div>
        )}
        {r.status === 'cancelled' && <div className="acct-region">Released{r.resolvedBy ? ` by ${r.resolvedBy}` : ''}{r.resolvedAt ? ` on ${fmtDate(r.resolvedAt)}` : ''}</div>}
        {r.stale && (
          <div className="task-dupe" style={{ marginTop: 4 }}>
            DEAR shows less of this credit note on account than was reserved, so check this before promising it.
          </div>
        )}
        {r.status === 'reserved' && r.creditNo && <div className="acct-region">Waiting for DEAR to show it applied. It is marked used by itself.</div>}
        {r.status === 'reserved' && r.sourceKind === 'prepayment' && <div className="acct-region">Apply it in DEAR (move or refund the prepayment), then press Mark used.</div>}
      </div>
      <div className="credit-actions" style={{ textAlign: 'right' }}>
        <span className={`pill ${TONE[r.status]}`}>{WORD[r.status]}</span>
        {r.status === 'reserved' && (
          <div style={{ marginTop: 6, display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
            <button className="btn secondary" onClick={() => onClose(r, 'cancelled')}>Release</button>
            {!r.creditNo && <button className="link-btn" onClick={() => onClose(r, 'used')}>Mark used</button>}
          </div>
        )}
      </div>
    </div>
  );
}

// One thing money can be taken from: a credit note, or the prepayment held on an order.
type Src = { key: string; kind: 'note' | 'prepaid'; creditNo?: string; prepaidOrder?: string; free: number; check?: boolean; label: string; detail: string };
const nounOf = (items: { kind: 'note' | 'prepaid' }[]) => {
  const n = items.length, notes = items.filter(i => i.kind === 'note').length;
  const w = notes === n ? ['credit note', 'credit notes'] : notes === 0 ? ['prepayment', 'prepayments'] : ['item', 'items'];
  return n === 1 ? w[0] : w[1];
};

function ReserveForm({ accountId, accountName, available, options, prepaid, onDone, onCancel }: {
  accountId: string; accountName: string; available: number; options: Credit['reservable']; prepaid: Prepaid[]; onDone: () => void; onCancel: () => void;
}) {
  const sources: Src[] = [
    ...options.map(o => ({ key: o.creditNo, kind: 'note' as const, creditNo: o.creditNo, free: o.free, label: o.creditNo, detail: o.date ? fmtDate(o.date) : '' })),
    ...prepaid.map(p => ({ key: `pp:${p.orderNo}`, kind: 'prepaid' as const, prepaidOrder: p.orderNo, free: room(p), check: !!p.needsCheck, label: `Prepaid on ${p.orderNo}`, detail: p.needsCheck ? 'completed order, DEAR is checked' : p.cancelled ? 'order cancelled' : `order ${nice(p.status).toLowerCase()}` })),
  ];
  const canSeveral = sources.length >= 2;
  const [mode, setMode] = useState<'one' | 'several'>('one');
  const [name, setName] = useState(accountName);
  const [orderNo, setOrderNo] = useState('');
  const [note, setNote] = useState('');
  // one: a credit note (typed) or a prepayment (chosen)
  const [amount, setAmount] = useState('');
  const [creditNo, setCreditNo] = useState('');
  const [from, setFrom] = useState('');   // '' = a credit note; otherwise the order that holds the prepayment
  const amountTyped = useRef(false);   // once the person types an amount, picking a source no longer overwrites it
  // several: source key -> the amount to reserve from it (present = ticked)
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [order, setOrder] = useState<OrderInfo | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const orderTyped = orderNo.trim();
  const orderOk = orderTyped === '' || /^SQ\d{3,}$/i.test(orderTyped);

  // Look the order up (after a short pause) so the credit can be lined up against what is owed.
  useEffect(() => {
    setOrder(null);
    if (!/^SQ\d{3,}$/i.test(orderTyped)) return;
    let live = true;
    const t = setTimeout(() => {
      apiGet(`/credit/account/${accountId}/order/${orderTyped.toUpperCase()}`)
        .then(d => { if (live) setOrder(d); })
        .catch(e => { if (live) setOrder({ error: e.message }); });
    }, 350);
    return () => { live = false; clearTimeout(t); };
  }, [orderTyped, accountId]);

  // ---- one ----
  const onePre = prepaid.find(p => p.orderNo === from);
  const one = onePre ? undefined : options.find(o => o.creditNo.toUpperCase() === creditNo.trim().toUpperCase());
  const maxOne = onePre ? room(onePre) : one ? one.free : available;
  const n1 = Number(amount);
  const validOne = Number.isFinite(n1) && n1 > 0 && n1 <= maxOne + 0.005 && orderOk;

  // ---- several ----
  const ticked = sources.filter(s => picked[s.key] !== undefined);
  const amountOf = (s: Src) => Number(picked[s.key]);
  const pickedTotal = Math.round(ticked.reduce((t, s) => t + (Number.isFinite(amountOf(s)) ? amountOf(s) : 0), 0) * 100) / 100;
  const noteTotal = Math.round(ticked.filter(s => s.kind === 'note').reduce((t, s) => t + (Number.isFinite(amountOf(s)) ? amountOf(s) : 0), 0) * 100) / 100;
  const validSeveral = ticked.length > 0 && orderOk && noteTotal <= available + 0.005
    && ticked.every(s => Number.isFinite(amountOf(s)) && amountOf(s) > 0 && amountOf(s) <= s.free + 0.005);
  const credits = mode === 'several' ? pickedTotal : Number.isFinite(n1) && n1 > 0 ? n1 : 0;
  const anyPrepaid = mode === 'several' ? ticked.some(s => s.kind === 'prepaid') : !!onePre;
  const hasPrepaid = prepaid.length > 0;

  function chooseCredit(value: string) {
    setCreditNo(value);
    const o = options.find(x => x.creditNo.toUpperCase() === value.trim().toUpperCase());
    if (o && !amountTyped.current) setAmount(o.free.toFixed(2));   // the whole note, which can be changed
  }
  function chooseFrom(value: string) {
    setFrom(value);
    if (value) setCreditNo('');
    const p = prepaid.find(x => x.orderNo === value);
    if (p && !amountTyped.current) setAmount(room(p).toFixed(2));   // all of it, which can be changed (DEAR may confirm less on a completed order)
  }
  function tick(s: Src, on: boolean) {
    setPicked(p => {
      const next = { ...p };
      if (on) next[s.key] = s.free.toFixed(2); else delete next[s.key];
      return next;
    });
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const shared = { name: name.trim() || undefined, orderNo: orderTyped || undefined, note: note.trim() || undefined };
      if (mode === 'several') {
        await apiPost(`/credit/account/${accountId}/reserve`, { ...shared, items: ticked.map(s => (s.kind === 'prepaid' ? { prepaidOrder: s.prepaidOrder, amount: amountOf(s) } : { creditNo: s.creditNo, amount: amountOf(s) })) });
      } else {
        await apiPost(`/credit/account/${accountId}/reserve`, { ...shared, amount: n1, ...(onePre ? { prepaidOrder: onePre.orderNo } : { creditNo: creditNo.trim() || undefined }) });
      }
      onDone();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  const word = (k: 'one' | 'several') => (mode === k ? 'btn secondary on' : 'btn secondary');
  return (
    <div className="credit-form">
      {canSeveral && (
        <div className="plan-log-types" style={{ marginBottom: 8 }}>
          <button type="button" className={word('one')} onClick={() => setMode('one')}>{hasPrepaid ? 'One' : 'One credit note'}</button>
          <button type="button" className={word('several')} onClick={() => setMode('several')}>{hasPrepaid ? 'Several' : 'Several credit notes'}</button>
        </div>
      )}

      <label style={{ display: 'block' }}>
        Name
        <input value={name} onChange={e => setName(e.target.value)} className="credit-input" />
      </label>

      {mode === 'one' ? (
        <>
          {hasPrepaid && (
            <label style={{ display: 'block', marginTop: 8 }}>
              Take it from
              <select value={from} onChange={e => chooseFrom(e.target.value)} className="credit-input" aria-label="Take it from">
                <option value="">A credit note</option>
                {prepaid.map(p => <option key={p.orderNo} value={p.orderNo}>Prepaid on {p.orderNo} ({p.needsCheck ? `${fmtMoney(room(p))} to check in DEAR, completed order` : `${fmtMoney(p.free)} free, ${p.cancelled ? 'cancelled' : 'finished'}`})</option>)}
              </select>
            </label>
          )}
          <div className="credit-form-row" style={{ marginTop: 8 }}>
            <label>
              Amount (up to {fmtMoney(maxOne)})
              <input
                value={amount} inputMode="decimal" placeholder="0.00" className="credit-input" style={{ width: 130 }}
                onChange={e => { amountTyped.current = true; setAmount(e.target.value); }}
              />
            </label>
            {!onePre && (
              <label>
                Credit no
                <input value={creditNo} onChange={e => chooseCredit(e.target.value)} list="credit-notes" placeholder="e.g. CR02219" className="credit-input" style={{ width: 170 }} />
                <datalist id="credit-notes">
                  {options.map(o => <option key={o.creditNo} value={o.creditNo}>{fmtMoney(o.free)} free{o.date ? `, ${fmtDate(o.date)}` : ''}</option>)}
                </datalist>
              </label>
            )}
            <label style={{ flex: 1 }}>
              Sales order / quote no
              <input value={orderNo} onChange={e => setOrderNo(e.target.value)} placeholder="e.g. SQ37512, or blank for their next order" className="credit-input" />
            </label>
          </div>
        </>
      ) : (
        <>
          <div className="credit-list" style={{ marginTop: 8 }}>
            {sources.map(s => {
              const on = picked[s.key] !== undefined;
              return (
                <div className="credit-row" key={s.key}>
                  <label style={{ display: 'flex', gap: 8, alignItems: 'center', flex: 1 }}>
                    <input type="checkbox" checked={on} onChange={e => tick(s, e.target.checked)} />
                    <span><b>{s.label}</b> <span className="acct-region">{s.detail}</span></span>
                  </label>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span className="acct-region">{fmtMoney(s.free)} {s.check ? 'to check in DEAR' : 'free'}</span>
                    {on && (
                      <input
                        value={picked[s.key]} inputMode="decimal" className="credit-input" style={{ width: 100 }} aria-label={`Amount of ${s.label}`}
                        onChange={e => setPicked(p => ({ ...p, [s.key]: e.target.value }))}
                      />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="acct-region" style={{ marginTop: 4 }}>
            <button type="button" className="link-btn" onClick={() => setPicked(Object.fromEntries(sources.map(s => [s.key, s.free.toFixed(2)])))}>Tick all</button>
            {' · '}
            <button type="button" className="link-btn" onClick={() => setPicked({})}>Clear</button>
          </div>
          <label style={{ display: 'block', marginTop: 8 }}>
            Sales order / quote no ({hasPrepaid ? 'everything ticked goes to this order' : 'all of these credit notes go to this order'})
            <input value={orderNo} onChange={e => setOrderNo(e.target.value)} placeholder="e.g. SQ37512, or blank for their next order" className="credit-input" />
          </label>
        </>
      )}

      {/* The running total, lined up against the order when it can be found. */}
      {mode === 'several' && (
        <div className="credit-total" style={{ marginTop: 8, fontWeight: 600 }}>
          {ticked.length} {hasPrepaid ? nounOf(ticked) : `credit ${ticked.length === 1 ? 'note' : 'notes'}`} ticked: {fmtMoney(pickedTotal)}
        </div>
      )}
      {order?.error && <div className="save-msg err">{order.error}</div>}
      {order && order.found === false && <div className="acct-region">{orderTyped.toUpperCase()} isn't in the CRM yet. That is fine if it was only just created.</div>}
      {order && order.found && (
        <div className="acct-region" style={{ marginTop: 4 }}>
          {orderTyped.toUpperCase()}: {nice(order.status ?? '')}. Order total {fmtMoney(order.total ?? 0)}, still to pay {fmtMoney(order.toPay ?? 0)}.
          {credits > 0.005 && (credits > (order.toPay ?? 0) + 0.005
            ? ` This credit is ${fmtMoney(credits - (order.toPay ?? 0))} more than is owed.`
            : ` After ${fmtMoney(credits)} of credit: ${fmtMoney(Math.max(0, (order.toPay ?? 0) - credits))} still to pay.`)}
        </div>
      )}

      <label style={{ display: 'block', marginTop: 8 }}>
        Note (optional)
        <input value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. agreed with Kim on the phone" className="credit-input" />
      </label>

      {error && <div className="save-msg err">{error}</div>}
      <div className="plan-actions" style={{ marginTop: 8 }}>
        <button className="btn" onClick={save} disabled={saving || (mode === 'several' ? !validSeveral : !validOne)}>
          {saving ? 'Saving…' : mode === 'several' ? `Reserve ${ticked.length ? `${ticked.length} ` : ''}${hasPrepaid ? nounOf(ticked.length ? ticked : [{ kind: 'note' }, { kind: 'note' }]) : `credit ${ticked.length === 1 ? 'note' : 'notes'}`}${ticked.length ? ` (${fmtMoney(pickedTotal)})` : ''}` : 'Reserve'}
        </button>
        <button className="link-btn" onClick={onCancel}>Cancel</button>
        <span className="acct-region">
          {mode === 'several'
            ? anyPrepaid
              ? 'One reservation is made per item. Credit notes are marked used by themselves when DEAR shows them applied. Prepaid money is marked used by hand once you have applied it in DEAR.'
              : 'One reservation is made per credit note, and each is marked used by itself when DEAR shows it applied.'
            : onePre
              ? 'Prepaid money is not matched in DEAR automatically. Once you have moved or refunded the prepayment in DEAR, press Mark used on the reservation.'
              : creditNo.trim() ? 'With the credit no filled in, it is marked used by itself when DEAR shows it applied.' : 'Fill in the credit no so it can be marked used by itself.'}
        </span>
      </div>
    </div>
  );
}