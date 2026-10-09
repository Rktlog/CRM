import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiGet, apiPatch, apiPost } from '../lib/api';
import { fmtMoney, fmtDate } from '../lib/types';

// Credit on an account: the customer's credit notes, and which of them the team
// has set aside for an order. To reserve, pick the credit note and enter the order
// or sales quote number. Nobody has to mark it used: when DEAR shows that credit
// applied to that order, the CRM marks it used by itself.

type Note = {
  creditNo: string; date: string | null; orderNo: string; total: number; onAccount: number;
  reservationId: string | null; reservedFor: string | null;
};
type Reservation = {
  id: string; amount: number; orderRef: string | null; creditNo: string | null; note: string | null;
  status: 'reserved' | 'used' | 'cancelled'; createdAt: string; resolvedAt: string | null;
  fromAccountId: string; fromName: string; toAccountId: string; toName: string;
  createdBy: string | null; resolvedBy: string | null; direction: 'own' | 'out' | 'in'; stale: boolean;
};
type Credit = {
  creditInDear: number; reserved: number; available: number;
  reservable: { creditNo: string; date: string | null; onAccount: number }[];
  notes: Note[]; reservations: Reservation[];
};

export default function CreditReservations({ accountId }: { accountId: string; accountName?: string }) {
  const [credit, setCredit] = useState<Credit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [showClosed, setShowClosed] = useState(false);

  useEffect(() => {
    apiGet(`/credit/account/${accountId}`).then(setCredit).catch(e => setError(e.message));
  }, [accountId, refresh]);

  if (error || !credit) return null;
  const open = credit.reservations.filter(r => r.status === 'reserved');
  const closed = credit.reservations.filter(r => r.status !== 'reserved');
  const withCredit = credit.notes.filter(n => n.onAccount > 0.005);
  // Nothing to show: no credit, nothing reserved.
  if (credit.creditInDear <= 0.005 && !credit.reservations.length && !withCredit.length) return null;

  async function close(r: Reservation, status: 'used' | 'cancelled') {
    const what = status === 'used' ? 'Mark this credit as applied in DEAR? (Normally this happens by itself.)' : 'Release this reservation and free the credit?';
    if (!window.confirm(what)) return;
    await apiPatch(`/credit/reservations/${r.id}`, { status });
    setRefresh(n => n + 1);
  }

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
            {fmtMoney(credit.creditInDear)} credit in DEAR
            {credit.reserved > 0.005 ? `, ${fmtMoney(credit.reserved)} reserved` : ''}
          </div>
        </div>
      )}

      {withCredit.length > 0 && (
        <div className="credit-list">
          {withCredit.map(n => (
            <div className="credit-row" key={n.creditNo}>
              <div>
                <div className="acct-name">{n.creditNo} <span className="acct-region">{n.date ? fmtDate(n.date) : ''}</span></div>
                <div className="acct-region">{fmtMoney(n.onAccount)} on account{n.onAccount < n.total - 0.005 ? ` (of ${fmtMoney(n.total)})` : ''}</div>
              </div>
              <div>
                {n.reservedFor ? <span className="pill amber">Reserved for {n.reservedFor}</span> : <span className="pill teal">Free</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      {open.length > 0 && (
        <div className="credit-list">
          {open.map(r => (
            <div className="credit-row" key={r.id}>
              <div>
                <div className="acct-name">
                  {r.creditNo ? <>{r.creditNo} ({fmtMoney(r.amount)}) reserved for {r.orderRef ?? 'an order'}</>
                    : <>{fmtMoney(r.amount)} reserved{r.direction === 'out' ? <> for <Link to={`/accounts/${r.toAccountId}`} className="order-link">{r.toName}</Link></> : ''}{r.orderRef ? `, ${r.orderRef}` : ''}</>}
                </div>
                <div className="acct-region">
                  By {r.createdBy ?? 'someone'} on {fmtDate(r.createdAt)}{r.note ? `. ${r.note}` : ''}
                </div>
                {r.stale && (
                  <div className="task-dupe" style={{ marginTop: 4 }}>
                    This credit note has changed in DEAR since it was reserved, so check before promising it.
                  </div>
                )}
                {r.creditNo && <div className="acct-region">Waiting for DEAR to show it applied to {r.orderRef}. It is marked used by itself.</div>}
              </div>
              <div className="credit-actions">
                <button className="btn secondary" onClick={() => close(r, 'cancelled')}>Release</button>
                {!r.creditNo && <button className="link-btn" onClick={() => close(r, 'used')}>Mark used</button>}
              </div>
            </div>
          ))}
        </div>
      )}

      {credit.reservable.length > 0 && !formOpen && (
        <button className="btn secondary" style={{ marginTop: 8 }} onClick={() => setFormOpen(true)}>Reserve credit</button>
      )}
      {formOpen && (
        <ReserveForm
          accountId={accountId}
          options={credit.reservable}
          onDone={() => { setFormOpen(false); setRefresh(n => n + 1); }}
          onCancel={() => setFormOpen(false)}
        />
      )}

      {closed.length > 0 && (
        <>
          <button className="link-btn" style={{ marginTop: 8 }} onClick={() => setShowClosed(!showClosed)}>
            {showClosed ? 'Hide' : 'Show'} past reservations ({closed.length})
          </button>
          {showClosed && (
            <div className="credit-list closed">
              {closed.map(r => (
                <div className="credit-row" key={r.id}>
                  <div>
                    <div>{r.creditNo ?? fmtMoney(r.amount)}{r.creditNo ? ` (${fmtMoney(r.amount)})` : ''} for {r.orderRef ?? 'an order'}</div>
                    <div className="acct-region">
                      {r.status === 'used'
                        ? (r.resolvedBy ? `Marked used by ${r.resolvedBy}` : 'Used: DEAR showed it applied')
                        : `Released${r.resolvedBy ? ` by ${r.resolvedBy}` : ''}`}
                      {r.resolvedAt ? ` on ${fmtDate(r.resolvedAt)}` : ''}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      <div className="acct-region credit-footnote">
        Reserving records the plan. The credit is applied in DEAR, and once DEAR shows it applied to that order the reservation is marked used.
      </div>
    </div>
  );
}

function ReserveForm({ accountId, options, onDone, onCancel }: {
  accountId: string; options: Credit['reservable']; onDone: () => void; onCancel: () => void;
}) {
  const [creditNo, setCreditNo] = useState(options[0]?.creditNo ?? '');
  const [orderNo, setOrderNo] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = !!creditNo && /^SQ\d{3,}$/i.test(orderNo.trim());

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await apiPost(`/credit/account/${accountId}/reserve`, { creditNo, orderNo: orderNo.trim(), note: note || undefined });
      onDone();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="credit-form">
      <div className="credit-form-row">
        <label>
          Credit no
          <select value={creditNo} onChange={e => setCreditNo(e.target.value)} className="credit-input">
            {options.map(o => (
              <option key={o.creditNo} value={o.creditNo}>{o.creditNo}, {fmtMoney(o.onAccount)}{o.date ? `, ${fmtDate(o.date)}` : ''}</option>
            ))}
          </select>
        </label>
        <label style={{ flex: 1 }}>
          Order or sales quote no
          <input value={orderNo} onChange={e => setOrderNo(e.target.value)} placeholder="e.g. SQ37512" className="credit-input" />
        </label>
      </div>
      <label>
        Note (optional)
        <input value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. agreed with Kim on the phone" className="credit-input" />
      </label>

      {error && <div className="save-msg err">{error}</div>}
      <div className="plan-actions" style={{ marginTop: 8 }}>
        <button className="btn" onClick={save} disabled={!valid || saving}>{saving ? 'Saving…' : 'Reserve'}</button>
        <button className="link-btn" onClick={onCancel}>Cancel</button>
        <span className="acct-region">The whole credit note is reserved. It is marked used when DEAR shows it applied to that order.</span>
      </div>
    </div>
  );
}