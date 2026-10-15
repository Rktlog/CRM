import { useState } from 'react';
import { Link } from 'react-router-dom';
import { apiPatch } from '../lib/api';
import { fmtMoney, fmtDateWithYear, fmtDuration } from '../lib/types';
import { todayLocal } from '../lib/logDate';
import OrderLog from './OrderLog';

// Orders > Open quotes. One row per open quote: order no, customer, state, order date, age, total and what is
// still to pay. Click a row to expand it: deposit / prepaid amount, the follow-up date (editable) and the
// team's notes on the order (add one right there). Amounts are inc GST, as DEAR holds them.

export type OpenQuoteRow = {
  id: string; number: string; accountId: string; customer: string; region: string; repName: string | null;
  date: string; ageDays: number; stage: string; reference: string | null;
  amount: number; deposit: number; remaining: number; followUpAt: string | null;
};

export default function OpenQuotesTable({ rows, showRep }: { rows: OpenQuoteRow[]; showRep: boolean }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [saved, setSaved] = useState<Record<string, string | null>>({});   // follow-ups changed on this screen
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggle = (id: string) => setOpen(s => {
    const n = new Set(s);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  });
  const followUpOf = (r: OpenQuoteRow) => (r.id in saved ? saved[r.id] : r.followUpAt);

  async function setFollowUp(r: OpenQuoteRow, date: string | null) {
    setBusy(r.id); setError(null);
    try {
      await apiPatch(`/orders/${r.id}/follow-up`, { date });
      setSaved(s => ({ ...s, [r.id]: date }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const today = todayLocal();
  return (
    <div className="ledger-table-scroll tall">
      {error && <div className="save-msg err" style={{ margin: '0 0 8px' }}>{error}</div>}
      <table className="ov-table">
        <thead>
          <tr>
            <th style={{ width: 28 }} />
            <th>Order no</th><th>Customer</th><th>State</th><th>Order date</th>
            <th className="num-col">Age</th><th className="num-col">Total</th><th className="num-col">Remaining</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const isOpen = open.has(r.id);
            const fu = followUpOf(r);
            return (
              <FragmentRows key={r.id}>
                <tr className="ov-click" onClick={() => toggle(r.id)} aria-expanded={isOpen}>
                  <td style={{ color: 'var(--muted)' }}>{isOpen ? '▾' : '▸'}</td>
                  <td><Link to={`/orders/${r.id}`} className="order-link num" onClick={e => e.stopPropagation()}>{r.number}</Link></td>
                  <td><Link to={`/accounts/${r.accountId}`} className="ledger-link" onClick={e => e.stopPropagation()}>{r.customer}</Link></td>
                  <td>{r.region}</td>
                  <td>{fmtDateWithYear(r.date)}</td>
                  <td className={`num-col num${r.ageDays > 60 ? ' ov-late-d90' : r.ageDays > 30 ? ' ov-late-d60' : ''}`}>{fmtDuration(r.ageDays)}</td>
                  <td className="num-col num">{fmtMoney(r.amount)}</td>
                  <td className="num-col num"><b>{fmtMoney(r.remaining)}</b></td>
                </tr>
                {isOpen && (
                  <tr>
                    <td />
                    <td colSpan={7} style={{ background: 'var(--paper)', padding: '12px 14px' }}>
                      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 300px) 1fr', gap: 24, alignItems: 'start' }}>
                        <div>
                          <Detail label="Deposit / prepaid">{r.deposit > 0.005 ? <b className="num">{fmtMoney(r.deposit)}</b> : <span className="acct-region">None</span>}</Detail>
                          <Detail label="Follow-up date">
                            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                              <input type="date" value={fu ?? ''} disabled={busy === r.id}
                                onChange={e => setFollowUp(r, e.target.value || null)} />
                              {fu && <button type="button" className="link-btn" disabled={busy === r.id} onClick={() => setFollowUp(r, null)}>Clear</button>}
                              {fu && fu < today && <span className="pill rust">Overdue</span>}
                            </div>
                          </Detail>
                          <Detail label="Stage">{r.stage}</Detail>
                          {r.reference && <Detail label="Reference">{r.reference}</Detail>}
                          {showRep && r.repName && <Detail label="Rep">{r.repName}</Detail>}
                        </div>
                        <div>
                          <div className="stat-label" style={{ marginBottom: 6 }}>Notes on this order</div>
                          <OrderLog orderId={r.id} accountId={r.accountId} accountName={r.customer} />
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </FragmentRows>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="stat-label">{label}</div>
      <div>{children}</div>
    </div>
  );
}

// A row plus its expanded row, kept together under one key.
function FragmentRows({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}