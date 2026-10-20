import { useState } from 'react';
import { Link } from 'react-router-dom';
import { apiPatch, apiPost } from '../lib/api';
import { fmtMoney, fmtDate, fmtDateWithYear, fmtDuration } from '../lib/types';
import { todayLocal } from '../lib/logDate';
import OrderLog from './OrderLog';

// Orders > Open quotes. One row per quote or unpaid order: order no, customer, state, order date, age, total, what is
// still to pay, and the next follow-up. An order stays here until it is both paid and confirmed. Click a row to expand
// it: what has been paid, the follow-ups (mark done, or set the 2nd) and the team's notes on the order. Amounts are inc GST,
// as DEAR holds them.
//
// Follow-ups: the 1st is automatic, a week after payment was due (the order date for a customer who pays first, the invoice
// due date for a customer on terms). There is no automatic 2nd: the sales team sets it by choosing a date. Whichever is
// earliest is shown as next. Colours: 1st amber, 2nd rust, nothing left to chase grey.

type FollowUp = {
  fu1Due: string; fu1DoneOn: string | null; fu2DoneOn: string | null; secondOn: string | null;   // secondOn: the 2nd date the team set
  secondRep: { id: string; name: string } | null;   // the rep the sales team asked to follow up the 2nd
  next: { kind: 'fu1' | 'fu2'; date: string } | null;
};
export type OpenQuoteRow = {
  id: string; number: string; accountId: string; customer: string; region: string; repName: string | null; terms?: string;
  date: string; ageDays: number; stage: string; reference: string | null;
  amount: number; paid: number; remaining: number; payment: 'unpaid' | 'part' | 'paid'; confirmed: boolean; status: string; followUp: FollowUp;
};

const KIND = {
  fu1: { label: '1st', pill: 'amber', name: 'Follow-up 1' },
  fu2: { label: '2nd', pill: 'rust', name: 'Follow-up 2' },
} as const;
const dayDiff = (a: string, b: string) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000);   // a minus b, in days

function when(date: string, today: string): { text: string; late: boolean } {
  const d = dayDiff(date, today);
  if (d < 0) return { text: `${fmtDuration(-d)} overdue`, late: true };
  if (d === 0) return { text: 'Due today', late: false };
  return { text: `in ${fmtDuration(d)}`, late: false };
}

export default function OpenQuotesTable({ rows, showRep, repOptions = [] }: { rows: OpenQuoteRow[]; showRep: boolean; repOptions?: { id: string; name: string }[] }) {
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
  // The 2nd follow-up: a date, and optionally which rep follows it up (repId null = nobody chosen). Clearing the date clears the rep too.
  const setDate = (r: OpenQuoteRow, date: string | null, repId?: string | null) => act(r, () => apiPatch(`/orders/${r.id}/follow-up`, { date, ...(repId !== undefined ? { repId } : {}) }));
  const markDone = (r: OpenQuoteRow) => act(r, () => apiPost(`/orders/${r.id}/follow-up/done`, {}));
  const undo = (r: OpenQuoteRow) => act(r, () => apiPost(`/orders/${r.id}/follow-up/undo`, {}));

  return (
    <div className="ledger-table-scroll tall">
      <div className="acct-region" style={{ margin: '0 0 8px', display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <span><span className="pill amber">1st</span> follow-up, a week after payment was due</span>
        <span><span className="pill rust">2nd</span> follow-up, a date the sales team sets</span>
        <span><span className="pill neutral">Done</span> nothing left to chase</span>
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
                  <td>
                    <Link to={`/accounts/${r.accountId}`} className="ledger-link" onClick={e => e.stopPropagation()}>{r.customer}</Link>
                    {r.terms && r.terms !== 'Prepayment' && <div className="cust-meta">{r.terms}</div>}
                  </td>
                  <td>{r.region}</td>
                  <td>{fmtDateWithYear(r.date)}</td>
                  <td className={`num-col num${r.ageDays > 60 ? ' ov-late-d90' : r.ageDays > 30 ? ' ov-late-d60' : ''}`}>{fmtDuration(r.ageDays)}</td>
                  <td className="num-col num">{fmtMoney(r.amount)}</td>
                  <td className="num-col num"><b>{fmtMoney(r.remaining)}</b>{r.payment === 'paid' && <div><span className="pill teal">Paid</span></div>}</td>
                  <td>
                    {fu.next ? (
                      <>
                        <span className={`pill ${KIND[fu.next.kind].pill}`}>{KIND[fu.next.kind].label}</span>{' '}
                        <span className="num">{fmtDate(fu.next.date)}</span>
                        <div className="cust-meta" style={w!.late ? { color: 'var(--rust)', fontWeight: 600 } : undefined}>{w!.text}</div>
                        {(fu.next.kind === 'fu2' && fu.secondRep ? fu.secondRep.name : r.repName) && (
                          <div className="cust-meta">by {fu.next.kind === 'fu2' && fu.secondRep ? fu.secondRep.name : r.repName}</div>
                        )}
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
                          <Detail label="Payment">
                            <b className="num">{fmtMoney(r.paid)}</b> <span className="acct-region">of {fmtMoney(r.amount)}</span>{' '}
                            <span className={`pill ${r.payment === 'paid' ? 'teal' : r.payment === 'part' ? 'amber' : 'rust'}`}>{r.payment === 'paid' ? 'Paid' : r.payment === 'part' ? 'Part paid' : 'Unpaid'}</span>
                            <div className="acct-region">
                              {r.payment === 'paid' ? 'Paid. Waiting for the order to be confirmed in DEAR.'
                                : r.confirmed ? `${fmtMoney(r.remaining)} still to pay on a confirmed order.`
                                : `Not confirmed yet. ${fmtMoney(r.remaining)} still to pay.`}
                            </div>
                          </Detail>

                          <Detail label="Follow-ups">
                            <Step kind="fu1" date={fu.fu1DoneOn ? null : fu.fu1Due} doneOn={fu.fu1DoneOn} today={today} empty="" />
                            <Step kind="fu2" date={fu.secondOn} doneOn={fu.secondOn ? null : fu.fu2DoneOn} today={today} empty="Not set: choose a date below" by={fu.secondRep?.name} />
                          </Detail>

                          <Detail label="2nd follow-up date (set by the sales team)">
                            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                              <input type="date" value={fu.secondOn ?? ''} disabled={busy === r.id}
                                onChange={e => setDate(r, e.target.value || null)} />
                              {fu.secondOn && <button type="button" className="link-btn" disabled={busy === r.id} onClick={() => setDate(r, null)}>Clear</button>}
                            </div>
                            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
                              <label className="acct-region" htmlFor={`by-${r.id}`}>Followed up by</label>
                              <select id={`by-${r.id}`} aria-label="Followed up by" value={fu.secondRep?.id ?? ''} disabled={busy === r.id || !fu.secondOn}
                                onChange={e => setDate(r, fu.secondOn, e.target.value || null)}>
                                <option value="">{fu.secondOn ? 'Not assigned (the account rep)' : 'Choose a date first'}</option>
                                {fu.secondRep && !repOptions.some(o => o.id === fu.secondRep!.id) && <option value={fu.secondRep.id}>{fu.secondRep.name}</option>}
                                {repOptions.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                              </select>
                            </div>
                            {!fu.next && <div className="acct-region">Nothing left to chase. Choose a date if it needs another call.</div>}
                          </Detail>

                          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                            <button type="button" className="btn secondary" disabled={busy === r.id || !fu.next} onClick={() => markDone(r)}>
                              {fu.next ? `Mark ${KIND[fu.next.kind].name.toLowerCase()} done` : 'All follow-ups done'}
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

function Step({ kind, date, doneOn, today, empty, by }: { kind: 'fu1' | 'fu2'; date: string | null; doneOn: string | null; today: string; empty: string; by?: string | null }) {
  const k = KIND[kind];
  const w = date ? when(date, today) : null;
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 4 }}>
      <span className={`pill ${doneOn || (!date && !doneOn) ? 'neutral' : k.pill}`} style={{ minWidth: 34, textAlign: 'center' }}>{k.label}</span>
      {doneOn ? <span>Done {fmtDate(doneOn)}</span>
        : date ? <span><span className="num">{fmtDate(date)}</span> <span className="acct-region" style={w?.late ? { color: 'var(--rust)', fontWeight: 600 } : undefined}>{w?.text}</span>{by && <span className="acct-region"> · by {by}</span>}</span>
        : <span className="acct-region">{empty || 'Done'}</span>}
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