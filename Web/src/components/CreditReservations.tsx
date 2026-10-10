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
type Reservation = {
  id: string; name: string; amount: number; orderRef: string | null; creditNo: string | null; usedOnOrder: string | null; note: string | null;
  status: 'reserved' | 'used' | 'cancelled'; createdAt: string; resolvedAt: string | null;
  fromAccountId: string; fromName: string; toAccountId: string; toName: string;
  createdBy: string | null; resolvedBy: string | null; direction: 'own' | 'out' | 'in'; stale: boolean;
};
type Credit = {
  creditInDear: number; otherCredit: number; reserved: number; available: number;
  reservable: { creditNo: string; date: string | null; onAccount: number; free: number }[];
  notes: Note[]; reservations: Reservation[];
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
  // Nothing at all: no credit, nothing reserved, nothing held on orders.
  if (credit.creditInDear <= 0.005 && !credit.reservations.length && !withCredit.length && credit.otherCredit <= 0.005) return null;
  // No credit notes, but money is held on orders: say why there is nothing to reserve, instead of vanishing.
  if (credit.creditInDear <= 0.005 && !credit.reservations.length && !withCredit.length) {
    return (
      <div className="card credit-card">
        <h3>Credit</h3>
        <div className="acct-region">
          No credit notes on account, so there is nothing to reserve here. {fmtMoney(credit.otherCredit)} is held on orders as a prepayment
          or overpayment, which is not a credit note.{' '}
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

      {credit.creditInDear > 0.005 && (
        <div className="credit-summary">
          <div>
            <div className="stat-label">Free to use</div>
            <div className="credit-free num">{fmtMoney(credit.available)}</div>
          </div>
          <div className="acct-region">
            {fmtMoney(credit.creditInDear)} on credit notes
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

      {groups.length > 0 && (
        <div className="credit-list">
          {groups.map(g => g.items.length === 1
            ? <ReservationRow key={g.items[0].id} r={g.items[0]} accountName={accountName} onClose={close} note={noteOf.get((g.items[0].creditNo ?? '').toUpperCase())} />
            : <GroupBlock key={g.key} g={g} accountName={accountName} onClose={close} onReleaseAll={releaseAll} noteOf={noteOf} />)}
        </div>
      )}

      {credit.available > 0.005 && !formOpen && (
        <button className="btn secondary" style={{ marginTop: 8 }} onClick={() => setFormOpen(true)}>Reserve credit</button>
      )}
      {formOpen && (
        <ReserveForm
          accountId={accountId}
          accountName={accountName ?? ''}
          available={credit.available}
          options={credit.reservable}
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
          {fmtMoney(r.amount)}{r.creditNo ? `, ${r.creditNo}` : ''}
          {note?.date && <span className="acct-region"> (credit note of {fmtDate(note.date)}{note.total > r.amount + 0.005 ? `, ${fmtMoney(note.total)} in all` : ''})</span>}
          {r.direction === 'out' && <> for <Link to={`/accounts/${r.toAccountId}`} className="order-link">{r.toName}</Link></>}
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

function ReserveForm({ accountId, accountName, available, options, onDone, onCancel }: {
  accountId: string; accountName: string; available: number; options: Credit['reservable']; onDone: () => void; onCancel: () => void;
}) {
  const canSeveral = options.length >= 2;
  const [mode, setMode] = useState<'one' | 'several'>('one');
  const [name, setName] = useState(accountName);
  const [orderNo, setOrderNo] = useState('');
  const [note, setNote] = useState('');
  // one credit note
  const [amount, setAmount] = useState('');
  const [creditNo, setCreditNo] = useState('');
  const amountTyped = useRef(false);   // once the person types an amount, picking a credit note no longer overwrites it
  // several credit notes: credit no -> the amount to reserve from it (present = ticked)
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

  // ---- one credit note ----
  const one = options.find(o => o.creditNo.toUpperCase() === creditNo.trim().toUpperCase());
  const maxOne = one ? one.free : available;
  const n1 = Number(amount);
  const validOne = Number.isFinite(n1) && n1 > 0 && n1 <= maxOne + 0.005 && orderOk;

  // ---- several credit notes ----
  const ticked = options.filter(o => picked[o.creditNo] !== undefined);
  const amountOf = (o: { creditNo: string }) => Number(picked[o.creditNo]);
  const pickedTotal = Math.round(ticked.reduce((t, o) => t + (Number.isFinite(amountOf(o)) ? amountOf(o) : 0), 0) * 100) / 100;
  const validSeveral = ticked.length > 0 && orderOk && pickedTotal <= available + 0.005
    && ticked.every(o => Number.isFinite(amountOf(o)) && amountOf(o) > 0 && amountOf(o) <= o.free + 0.005);
  const credits = mode === 'several' ? pickedTotal : Number.isFinite(n1) && n1 > 0 ? n1 : 0;

  function chooseCredit(value: string) {
    setCreditNo(value);
    const o = options.find(x => x.creditNo.toUpperCase() === value.trim().toUpperCase());
    if (o && !amountTyped.current) setAmount(o.free.toFixed(2));   // the whole note, which can be changed
  }
  function tick(o: Credit['reservable'][number], on: boolean) {
    setPicked(p => {
      const next = { ...p };
      if (on) next[o.creditNo] = o.free.toFixed(2); else delete next[o.creditNo];
      return next;
    });
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const shared = { name: name.trim() || undefined, orderNo: orderTyped || undefined, note: note.trim() || undefined };
      if (mode === 'several') {
        await apiPost(`/credit/account/${accountId}/reserve`, { ...shared, items: ticked.map(o => ({ creditNo: o.creditNo, amount: amountOf(o) })) });
      } else {
        await apiPost(`/credit/account/${accountId}/reserve`, { ...shared, amount: n1, creditNo: creditNo.trim() || undefined });
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
          <button type="button" className={word('one')} onClick={() => setMode('one')}>One credit note</button>
          <button type="button" className={word('several')} onClick={() => setMode('several')}>Several credit notes</button>
        </div>
      )}

      <label style={{ display: 'block' }}>
        Name
        <input value={name} onChange={e => setName(e.target.value)} className="credit-input" />
      </label>

      {mode === 'one' ? (
        <div className="credit-form-row" style={{ marginTop: 8 }}>
          <label>
            Amount (up to {fmtMoney(maxOne)})
            <input
              value={amount} inputMode="decimal" placeholder="0.00" className="credit-input" style={{ width: 130 }}
              onChange={e => { amountTyped.current = true; setAmount(e.target.value); }}
            />
          </label>
          <label>
            Credit no
            <input value={creditNo} onChange={e => chooseCredit(e.target.value)} list="credit-notes" placeholder="e.g. CR02219" className="credit-input" style={{ width: 170 }} />
            <datalist id="credit-notes">
              {options.map(o => <option key={o.creditNo} value={o.creditNo}>{fmtMoney(o.free)} free{o.date ? `, ${fmtDate(o.date)}` : ''}</option>)}
            </datalist>
          </label>
          <label style={{ flex: 1 }}>
            Sales order / quote no
            <input value={orderNo} onChange={e => setOrderNo(e.target.value)} placeholder="e.g. SQ37512, or blank for their next order" className="credit-input" />
          </label>
        </div>
      ) : (
        <>
          <div className="credit-list" style={{ marginTop: 8 }}>
            {options.map(o => {
              const on = picked[o.creditNo] !== undefined;
              return (
                <div className="credit-row" key={o.creditNo}>
                  <label style={{ display: 'flex', gap: 8, alignItems: 'center', flex: 1 }}>
                    <input type="checkbox" checked={on} onChange={e => tick(o, e.target.checked)} />
                    <span><b>{o.creditNo}</b> <span className="acct-region">{o.date ? fmtDate(o.date) : ''}</span></span>
                  </label>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span className="acct-region">{fmtMoney(o.free)} free</span>
                    {on && (
                      <input
                        value={picked[o.creditNo]} inputMode="decimal" className="credit-input" style={{ width: 100 }} aria-label={`Amount of ${o.creditNo}`}
                        onChange={e => setPicked(p => ({ ...p, [o.creditNo]: e.target.value }))}
                      />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="acct-region" style={{ marginTop: 4 }}>
            <button type="button" className="link-btn" onClick={() => setPicked(Object.fromEntries(options.map(o => [o.creditNo, o.free.toFixed(2)])))}>Tick all</button>
            {' · '}
            <button type="button" className="link-btn" onClick={() => setPicked({})}>Clear</button>
          </div>
          <label style={{ display: 'block', marginTop: 8 }}>
            Sales order / quote no (all of these credit notes go to this order)
            <input value={orderNo} onChange={e => setOrderNo(e.target.value)} placeholder="e.g. SQ37512, or blank for their next order" className="credit-input" />
          </label>
        </>
      )}

      {/* The running total, lined up against the order when it can be found. */}
      {mode === 'several' && (
        <div className="credit-total" style={{ marginTop: 8, fontWeight: 600 }}>
          {ticked.length} credit {ticked.length === 1 ? 'note' : 'notes'} ticked: {fmtMoney(pickedTotal)}
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
          {saving ? 'Saving…' : mode === 'several' ? `Reserve ${ticked.length || ''} credit ${ticked.length === 1 ? 'note' : 'notes'}${ticked.length ? ` (${fmtMoney(pickedTotal)})` : ''}` : 'Reserve'}
        </button>
        <button className="link-btn" onClick={onCancel}>Cancel</button>
        <span className="acct-region">
          {mode === 'several'
            ? 'One reservation is made per credit note, and each is marked used by itself when DEAR shows it applied.'
            : creditNo.trim() ? 'With the credit no filled in, it is marked used by itself when DEAR shows it applied.' : 'Fill in the credit no so it can be marked used by itself.'}
        </span>
      </div>
    </div>
  );
}