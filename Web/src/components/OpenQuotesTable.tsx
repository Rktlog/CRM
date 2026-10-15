import { useState } from 'react';
import { Link } from 'react-router-dom';
import { apiPatch, apiPost } from '../lib/api';
import { fmtMoney, fmtDate, fmtDateWithYear, fmtDuration } from '../lib/types';
import { todayLocal } from '../lib/logDate';
import OrderLog from './OrderLog';

// Orders > Open quotes. One row per open quote: order no, customer, state, order date, age, total, what is still to
// pay, and the next follow-up. Click a row to expand it: deposit / prepaid, the follow-up schedule (mark done, or set
// your own next date) and the team's notes on the order. Amounts are inc GST, as DEAR holds them.
//
// Follow-ups: 1st = 7 days after the order date. 2nd = 14 days after the 1st was done. A date you set yourself
// replaces the automatic one until it is done or cleared. Colours: 1st amber, 2nd rust, your own date teal, all done grey.

type FollowUp = {
  fu1Due: string; fu1DoneOn: string | null; fu2Due: string | null; fu2DoneOn: string | null; manualOn: string | null;
  next: { kind: 'fu1' | 'fu2' | 'manual'; date: string } | null;
};
export type OpenQuoteRow = {
  id: string; number: string; accountId: string; customer: string; region: string; repName: string | null;
  date: string; ageDays: number; stage: string; reference: string | null;
  amount: number; deposit: number; remaining: number; followUp: FollowUp;
};

const KIND = {
  fu1: { label: '1st', pill: 'amber', name: 'Follow-up 1' },
  fu2: { label: '2nd', pill: 'rust', name: 'Follow-up 2' },
  manual: { label: 'Set', pill: 'teal', name: 'Your date' },
} as const;
const dayDiff = (a: string, b: string) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000);   // a minus b, in days

function when(date: string, today: string): { text: string; late: boolean } {
  const d = dayDiff(date, today);
  if (d < 0) return { text: `${fmtDuration(-d)} overdue`, late: true };
  if (d === 0) return { text: 'Due today', late: false };
  return { text: `in ${fmtDuration(d)}`, late: false };
}

export default function OpenQuotesTable({ rows, showRep }: { rows: OpenQuoteRow[]; showRep: boolean }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [changed, setChanged] = useState<Record<string, FollowUp>>({});   // follow-ups updated on this screen
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const today = todayLocal();

  const toggle = (id: string) => setOpen(s => {
    const n = new Set(s);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  });
  const fuOf = (r: OpenQuoteRow) => changed[r.id] ?? r.followUp;

  async function act(r: OpenQuoteRow, call: () => Promise<{ followUp: FollowUp }>) {
    setBusy(r.id); setError(null);
    try {
      const d = await call();
      setChanged(s => ({ ...s, [r.id]: d.followUp }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  const setDate = (r: OpenQuoteRow, date: string | null) => act(r, () => apiPatch(`/orders/${r.id}/follow-up`, { date }));
  const markDone = (r: OpenQuoteRow) => act(r, () => apiPost(`/orders/${r.id}/follow-up/done`, {}));
  const undo = (r: OpenQuoteRow) => act(r, () => apiPost(`/orders/${r.id}/follow-up/undo`, {}));

  return (
    <div className="ledger-table-scroll tall">
      <div className="acct-region" style={{ margin: '0 0 8px', display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <span><span className="pill amber">1st</span> follow-up, 7 days after the order</span>
        <span><span className="pill rust">2nd</span> follow-up, 14 days after the 1st</span>
        <span><span className="pill teal">Set</span> a date you chose</span>
        <span><span className="pill neutral">Done</span> both follow-ups made</span>
      </div>
      {error && <div className="save-msg err" style={{ margin: '0 0 8px' }}>{error}</div>}
      <table className="ov-table">
        <thead>
          <tr>
            <th style={{ width: 28 }} />
            <th>Order no</th><th>Customer</th><th>State</th><th>Order date</th>
            <th className="num-col">Age</th><th className="num-col">Total</th><th className="num-col">Remaining</th><th>Follow-up</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const isOpen = open.has(r.id);
            const fu = fuOf(r);
            const w = fu.next ? when(fu.next.date, today) : null;
            return (
              <Rows key={r.id}>
                <tr className="ov-click" onClick={() => toggle(r.id)} aria-expanded={isOpen}>
                  <td style={{ color: 'var(--muted)' }}>{isOpen ? '▾' : '▸'}</td>
                  <td><Link to={`/orders/${r.id}`} className="order-link num" onClick={e => e.stopPropagation()}>{r.number}</Link></td>
                  <td><Link to={`/accounts/${r.accountId}`} className="ledger-link" onClick={e => e.stopPropagation()}>{r.customer}</Link></td>
                  <td>{r.region}</td>
                  <td>{fmtDateWithYear(r.date)}</td>
                  <td className={`num-col num${r.ageDays > 60 ? ' ov-late-d90' : r.ageDays > 30 ? ' ov-late-d60' : ''}`}>{fmtDuration(r.ageDays)}</td>
                  <td className="num-col num">{fmtMoney(r.amount)}</td>
                  <td className="num-col num"><b>{fmtMoney(r.remaining)}</b></td>
                  <td>
                    {fu.next ? (
                      <>
                        <span className={`pill ${KIND[fu.next.kind].pill}`}>{KIND[fu.next.kind].label}</span>{' '}
                        <span className="num">{fmtDate(fu.next.date)}</span>
                        <div className="cust-meta" style={w!.late ? { color: 'var(--rust)', fontWeight: 600 } : undefined}>{w!.text}</div>
                      </>
                    ) : <span className="pill neutral">Done</span>}
                  </td>
                </tr>
                {isOpen && (
                  <tr>
                    <td />
                    <td colSpan={8} style={{ background: 'var(--paper)', padding: '12px 14px' }}>
                      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(240px, 320px) 1fr', gap: 24, alignItems: 'start' }}>
                        <div>
                          <Detail label="Deposit / prepaid">{r.deposit > 0.005 ? <b className="num">{fmtMoney(r.deposit)}</b> : <span className="acct-region">None</span>}</Detail>

                          <Detail label="Follow-ups">
                            <Step kind="fu1" date={fu.fu1Due} doneOn={fu.fu1DoneOn} today={today} />
                            <Step kind="fu2" date={fu.fu2Due} doneOn={fu.fu2DoneOn} today={today} waiting={!fu.fu1DoneOn} />
                          </Detail>

                          <Detail label="Next follow-up (your date)">
                            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                              <input type="date" value={fu.manualOn ?? ''} disabled={busy === r.id}
                                onChange={e => setDate(r, e.target.value || null)} />
                              {fu.manualOn && <button type="button" className="link-btn" disabled={busy === r.id} onClick={() => setDate(r, null)}>Clear</button>}
                            </div>
                          </Detail>

                          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                            <button type="button" className="btn secondary" disabled={busy === r.id || !fu.next} onClick={() => markDone(r)}>
                              {fu.next ? `Mark ${fu.next.kind === 'manual' ? 'your date' : KIND[fu.next.kind].name.toLowerCase()} done` : 'All follow-ups done'}
                            </button>
                            {(fu.fu1DoneOn || fu.fu2DoneOn) && (
                              <button type="button" className="link-btn" disabled={busy === r.id} onClick={() => undo(r)}>Undo last</button>
                            )}
                          </div>

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
              </Rows>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Step({ kind, date, doneOn, today, waiting }: { kind: 'fu1' | 'fu2'; date: string | null; doneOn: string | null; today: string; waiting?: boolean }) {
  const k = KIND[kind];
  const w = date && !doneOn ? when(date, today) : null;
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 4 }}>
      <span className={`pill ${doneOn ? 'neutral' : k.pill}`} style={{ minWidth: 34, textAlign: 'center' }}>{k.label}</span>
      {doneOn ? <span>Done {fmtDate(doneOn)}</span>
        : waiting || !date ? <span className="acct-region">Set 14 days after the 1st is done</span>
        : <span><span className="num">{fmtDate(date)}</span> <span className="acct-region" style={w?.late ? { color: 'var(--rust)', fontWeight: 600 } : undefined}>{w?.text}</span></span>}
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
function Rows({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}