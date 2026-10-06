import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiGet, apiPatch, apiPost } from '../lib/api';
import { fmtMoney, fmtDate } from '../lib/types';

// Credit reservations on an account: how much credit the customer has, what
// the team has set aside (for their next order or for another customer),
// and what's coming to them from another account. The CRM records the plan
// so everyone tells customers the same thing; the credit is applied in DEAR
// by the accounts team, then marked "used" here.

type Reservation = {
  id: string; amount: number; orderRef: string | null; note: string | null;
  status: 'reserved' | 'used' | 'cancelled'; createdAt: string; resolvedAt: string | null;
  fromAccountId: string; fromName: string; toAccountId: string; toName: string;
  createdBy: string | null; resolvedBy: string | null; direction: 'own' | 'out' | 'in';
};
type Credit = {
  creditInDear: number; reserved: number; available: number; incoming: number;
  overReserved: boolean; reservations: Reservation[];
};
type AccountOption = { id: string; name: string; region: string };

export default function CreditReservations({ accountId, accountName }: { accountId: string; accountName: string }) {
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
  // Nothing to show: no credit, nothing reserved, nothing coming in.
  if (credit.creditInDear <= 0.005 && !credit.reservations.length) return null;

  async function close(r: Reservation, status: 'used' | 'cancelled') {
    const what = status === 'used' ? 'Mark this credit as applied in DEAR?' : 'Reverse this reservation and free the credit?';
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

      {credit.overReserved && (
        <div className="task-dupe" style={{ marginBottom: 8 }}>
          More is reserved than DEAR now shows as credit. It may have been applied differently in DEAR, so check before promising it to a customer.
        </div>
      )}

      {credit.incoming > 0.005 && (
        <div className="credit-incoming">
          <b>{fmtMoney(credit.incoming)}</b> credit coming to this customer from another account, below.
        </div>
      )}

      {open.length > 0 && (
        <div className="credit-list">
          {open.map(r => (
            <div className="credit-row" key={r.id}>
              <div>
                <div className="acct-name">
                  {fmtMoney(r.amount)}{' '}
                  {r.direction === 'own' && <>reserved for {accountName}'s {r.orderRef || 'next order'}</>}
                  {r.direction === 'out' && <>reserved for <Link to={`/accounts/${r.toAccountId}`} className="order-link">{r.toName}</Link>{r.orderRef ? `, ${r.orderRef}` : ''}</>}
                  {r.direction === 'in' && <>from <Link to={`/accounts/${r.fromAccountId}`} className="order-link">{r.fromName}</Link>, for {r.orderRef || 'their next order'}</>}
                </div>
                <div className="acct-region">
                  By {r.createdBy ?? 'someone'} on {fmtDate(r.createdAt)}{r.note ? `. ${r.note}` : ''}
                </div>
              </div>
              <div className="credit-actions">
                <button className="btn secondary" onClick={() => close(r, 'used')} title="The accounts team has applied it in DEAR">Mark used</button>
                <button className="link-btn" onClick={() => close(r, 'cancelled')}>Reverse</button>
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
          accountName={accountName}
          available={credit.available}
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
                    <div>
                      {fmtMoney(r.amount)}{' '}
                      {r.direction === 'in' ? `from ${r.fromName}` : r.direction === 'out' ? `for ${r.toName}` : `for ${r.orderRef || 'own order'}`}
                    </div>
                    <div className="acct-region">
                      {r.status === 'used' ? 'Used' : 'Reversed'}{r.resolvedBy ? ` by ${r.resolvedBy}` : ''}{r.resolvedAt ? ` on ${fmtDate(r.resolvedAt)}` : ''}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      <div className="acct-region credit-footnote">
        Reservations are the team's plan, shown on both accounts. The credit itself is applied in DEAR.
      </div>
    </div>
  );
}

function ReserveForm({ accountId, accountName, available, onDone, onCancel }: {
  accountId: string; accountName: string; available: number; onDone: () => void; onCancel: () => void;
}) {
  const [forWho, setForWho] = useState<'own' | 'other'>('own');
  const [amount, setAmount] = useState(available.toFixed(2));
  const [orderRef, setOrderRef] = useState('');
  const [note, setNote] = useState('');
  const [accounts, setAccounts] = useState<AccountOption[] | null>(null);
  const [search, setSearch] = useState('');
  const [target, setTarget] = useState<AccountOption | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (forWho === 'other' && !accounts) apiGet('/accounts').then(setAccounts).catch(e => setError(e.message));
  }, [forWho]);

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!accounts || q.length < 2) return [];
    return accounts.filter(a => a.id !== accountId && a.name.toLowerCase().includes(q)).slice(0, 8);
  }, [accounts, search]);

  const value = Number(amount);
  const valid = Number.isFinite(value) && value > 0 && value <= available + 0.005 && (forWho === 'own' || !!target);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await apiPost(`/credit/account/${accountId}/reserve`, {
        amount: value,
        toAccountId: forWho === 'other' ? target!.id : undefined,
        orderRef: orderRef || undefined,
        note: note || undefined,
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
      <div className="plan-log-types">
        <button type="button" className={'btn secondary' + (forWho === 'own' ? ' on' : '')} onClick={() => setForWho('own')}>
          For {accountName}
        </button>
        <button type="button" className={'btn secondary' + (forWho === 'other' ? ' on' : '')} onClick={() => setForWho('other')}>
          For another customer
        </button>
      </div>

      {forWho === 'other' && (
        target ? (
          <div className="task-acct-head" style={{ margin: '8px 0' }}>
            <span className="acct-name">{target.name} <span className="acct-region">{target.region}</span></span>
            <button type="button" className="link-btn" onClick={() => { setTarget(null); setSearch(''); }}>Change</button>
          </div>
        ) : (
          <div style={{ margin: '8px 0' }}>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder={accounts ? 'Search customer' : 'Loading customers…'} className="credit-input" />
            {matches.length > 0 && (
              <div className="task-matches">
                {matches.map(a => (
                  <div key={a.id} className="task-match" onMouseDown={e => { e.preventDefault(); setTarget(a); }}>
                    {a.name}<span>{a.region}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      )}

      <div className="credit-form-row">
        <label>
          Amount (up to {fmtMoney(available)})
          <input type="number" min="0.01" step="0.01" max={available} value={amount} onChange={e => setAmount(e.target.value)} className="credit-input" />
        </label>
        <label style={{ flex: 1 }}>
          For which order (optional)
          <input value={orderRef} onChange={e => setOrderRef(e.target.value)} placeholder="e.g. next order, SQ37512" className="credit-input" />
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
      </div>
    </div>
  );
}