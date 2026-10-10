import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiGet, apiPatch, apiPost } from '../lib/api';
import { fmtMoney, fmtDate } from '../lib/types';

// Credit on an account. The team reserves credit by hand: a name, an amount, the
// credit note number, the sales order / quote number (blank = their next order) and a
// note. It shows here as Reserved, and against the credit note. When DEAR shows that
// credit note applied for a similar amount, the SAME row is marked used by itself.

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
  creditInDear: number; reserved: number; available: number;
  reservable: { creditNo: string; date: string | null; onAccount: number; free: number }[];
  notes: Note[]; reservations: Reservation[];
};
const TONE = { reserved: 'amber', used: 'teal', cancelled: 'neutral' } as const;
const WORD = { reserved: 'Reserved', used: 'Used', cancelled: 'Released' } as const;

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
  // Nothing to show: no credit, nothing reserved.
  if (credit.creditInDear <= 0.005 && !credit.reservations.length && !withCredit.length) return null;

  async function close(r: Reservation, status: 'used' | 'cancelled') {
    const what = status === 'used' ? 'Mark this credit as applied in DEAR? (When it has a credit no, this happens by itself.)' : 'Release this reservation and free the credit?';
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
              <div style={{ textAlign: 'right' }}>
                {n.reservedAmount > 0.005 && <span className="pill amber">Reserved {fmtMoney(n.reservedAmount)}{n.reservedFor ? ` for ${n.reservedFor}` : ''}</span>}
                {n.free > 0.005 && <div><span className={n.reservedAmount > 0.005 ? 'acct-region' : 'pill teal'}>{n.reservedAmount > 0.005 ? `${fmtMoney(n.free)} free` : 'Free'}</span></div>}
              </div>
            </div>
          ))}
        </div>
      )}

      {credit.reservations.length > 0 && (
        <div className="credit-list">
          {credit.reservations.map(r => (
            <div className="credit-row" key={r.id} style={r.status === 'reserved' ? undefined : { opacity: 0.75 }}>
              <div>
                <div className="acct-name">
                  {fmtMoney(r.amount)}{r.creditNo ? `, ${r.creditNo}` : ''}
                  {r.direction === 'out' && <> for <Link to={`/accounts/${r.toAccountId}`} className="order-link">{r.toName}</Link></>}
                  {' '}<span className="acct-region">{r.orderRef ? `for ${r.orderRef}` : 'for their next order'}</span>
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
                    <button className="btn secondary" onClick={() => close(r, 'cancelled')}>Release</button>
                    {!r.creditNo && <button className="link-btn" onClick={() => close(r, 'used')}>Mark used</button>}
                  </div>
                )}
              </div>
            </div>
          ))}
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

function ReserveForm({ accountId, accountName, available, options, onDone, onCancel }: {
  accountId: string; accountName: string; available: number; options: Credit['reservable']; onDone: () => void; onCancel: () => void;
}) {
  const [name, setName] = useState(accountName);
  const [amount, setAmount] = useState('');
  const [creditNo, setCreditNo] = useState('');
  const [orderNo, setOrderNo] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const amountTyped = useRef(false);   // once the person types an amount, picking a credit note no longer overwrites it

  const picked = options.find(o => o.creditNo.toUpperCase() === creditNo.trim().toUpperCase());
  const max = picked ? picked.free : available;
  const n = Number(amount);
  const valid = Number.isFinite(n) && n > 0 && n <= max + 0.005 && (orderNo.trim() === '' || /^SQ\d{3,}$/i.test(orderNo.trim()));

  function chooseCredit(value: string) {
    setCreditNo(value);
    const o = options.find(x => x.creditNo.toUpperCase() === value.trim().toUpperCase());
    if (o && !amountTyped.current) setAmount(o.free.toFixed(2));   // the whole note, which can be changed
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await apiPost(`/credit/account/${accountId}/reserve`, {
        name: name.trim() || undefined, amount: n, creditNo: creditNo.trim() || undefined,
        orderNo: orderNo.trim() || undefined, note: note.trim() || undefined,
      });
      onDone();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="credit-form">
      <label style={{ display: 'block' }}>
        Name
        <input value={name} onChange={e => setName(e.target.value)} className="credit-input" />
      </label>
      <div className="credit-form-row" style={{ marginTop: 8 }}>
        <label>
          Amount (up to {fmtMoney(max)})
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
      <label style={{ display: 'block', marginTop: 8 }}>
        Note (optional)
        <input value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. agreed with Kim on the phone" className="credit-input" />
      </label>

      {error && <div className="save-msg err">{error}</div>}
      <div className="plan-actions" style={{ marginTop: 8 }}>
        <button className="btn" onClick={save} disabled={!valid || saving}>{saving ? 'Saving…' : 'Reserve'}</button>
        <button className="link-btn" onClick={onCancel}>Cancel</button>
        <span className="acct-region">
          {creditNo.trim() ? 'With the credit no filled in, it is marked used by itself when DEAR shows it applied.' : 'Fill in the credit no so it can be marked used by itself.'}
        </span>
      </div>
    </div>
  );
}