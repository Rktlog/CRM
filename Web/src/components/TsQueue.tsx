import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiGet, apiPost } from '../lib/api';
import { $, errMsg, shortDay } from '../lib/tradeshow';
import { PAY_TONE, pctText, tableBox, td, tdr, th, type Queue, type QueueRow } from '../lib/tsExtra';

// Payments and DEAR. Top: confirmed orders and quotes that are not in DEAR yet (what overseas reps and the stand wrote), with DEAR orders that look like them to confirm.
// Below: where every order stands on payment, and any pay-by dates that have passed.
export default function TsQueue({ showId }: { showId: string }) {
  const [q, setQ] = useState<Queue | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => { apiGet(`/tradeshow/shows/${showId}/queue`, { fresh: true }).then((x: Queue) => { setQ(x); setErr(null); }).catch(e => setErr(errMsg(e))); }, [showId]);
  useEffect(() => { load(); }, [load]);
  async function run(id: string, f: () => Promise<unknown>) { setBusy(id); try { await f(); load(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(null); } }
  if (err && !q) return <div className="save-msg err" role="alert">{err}</div>;
  if (!q) return <div className="acct-region">Loading…</div>;
  const s = q.summary;
  const Row = ({ r }: { r: QueueRow }) => (
    <tr>
      <td style={td}><Link to={`/trade-shows/orders/${r.id}`}><b>{r.number}</b></Link><div className="acct-region" style={{ fontSize: 12.5 }}>{r.kind === 'quote' ? 'Quote' : 'Order'} · {shortDay(r.orderDate)}</div></td>
      <td style={td}>{r.customer} <span className="acct-region">{r.region}</span>{r.overseas && <> <span className="pill amber">Overseas</span></>}</td>
      <td style={tdr}>{$(r.total)}</td>
      <td style={td}>{r.stage === 'sent' ? <><div>Reference <b>{r.dearReference}</b></div>
        <div className="acct-region" style={{ fontSize: 12.5 }}>{r.daysWaiting} {r.daysWaiting === 1 ? 'day' : 'days'} waiting{r.emailError ? ' · not emailed to sales' : ''}</div>
        {r.candidates.map(c => (
          <div key={c.id} style={{ marginTop: 6, padding: 8, border: '1px dashed var(--line)', borderRadius: 4, fontSize: 13 }}>
            Is it <b>{c.number}</b> ({$(c.total)}, {shortDay(c.sentAt)}{c.reference ? `, "${c.reference}"` : ''})?{' '}
            <button type="button" className="btn secondary" disabled={busy === r.id} onClick={() => run(r.id, () => apiPost(`/tradeshow/orders/${r.id}/link`, { number: c.number }))}>Yes, link it</button>{' '}
            <button type="button" className="link-btn" disabled={busy === r.id} onClick={() => run(r.id, () => apiPost(`/tradeshow/orders/${r.id}/reject-match`, { dearId: c.id }))}>No</button>
          </div>
        ))}</>
        : <>{r.dear}<div className="acct-region" style={{ fontSize: 12.5 }}>{r.stage.replace(/_/g, ' ')}</div></>}</td>
      <td style={td}><span className={`pill ${PAY_TONE[r.payment.status]}`}>{r.payment.label}</span>{r.payment.owing ? <div className="acct-region" style={{ fontSize: 12.5 }}>{$(r.payment.owing)} still due</div> : null}
        {r.payBy && <div style={{ fontSize: 12.5, color: r.payByOverdue ? 'var(--rust)' : undefined }}>{r.payByOverdue ? 'Pay-by date passed: ' : 'Pay by '}{shortDay(r.payBy)}</div>}</td>
    </tr>
  );
  return (
    <>
      {err && <div className="save-msg err" role="alert">{err}</div>}
      <div className="ledger-stats" style={{ flexWrap: 'wrap' }}>
        <div className="ledger-stat" style={{ minWidth: 150 }}><div className="label">Paid</div><div className="val" style={{ fontSize: 20 }}>{pctText(s.paidPct) || '0%'}</div><div className="acct-region" style={{ fontSize: 12.5 }}>of {$(s.value)} ex GST · {s.paid} of {s.orders} paid</div></div>
        <div className="ledger-stat" style={{ minWidth: 150 }}><div className="label">Still owing</div><div className="val" style={{ fontSize: 20 }}>{$(s.owing)}</div><div className="acct-region" style={{ fontSize: 12.5 }}>{s.unpaid} {s.unpaid === 1 ? 'order' : 'orders'} unpaid or part paid</div></div>
        <div className="ledger-stat" style={{ minWidth: 150 }}><div className="label">Not in DEAR yet</div><div className="val" style={{ fontSize: 20 }}>{s.notInDear}</div></div>
        <div className="ledger-stat" style={{ minWidth: 150 }}><div className="label">Pay-by date passed</div><div className="val" style={{ fontSize: 20, color: s.overdue ? 'var(--rust)' : undefined }}>{s.overdue}</div></div>
      </div>
      <div className="panel-title" style={{ marginTop: 18 }}>To enter in DEAR ({q.toEnter.length})</div>
      {q.toEnter.length === 0 ? <div className="empty-state" style={{ padding: 18 }}>Everything confirmed is in DEAR.</div> : (
        <div style={tableBox}><table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr><th style={th}>No.</th><th style={th}>Customer</th><th style={{ ...th, textAlign: 'right' }}>Total</th><th style={th}>For DEAR</th><th style={th}>Payment</th></tr></thead>
          <tbody>{q.toEnter.map(r => <Row key={r.id} r={r} />)}</tbody></table></div>
      )}
      <div className="panel-title" style={{ marginTop: 18 }}>In DEAR: payment ({q.payments.length})</div>
      {q.payments.length === 0 ? <div className="empty-state" style={{ padding: 18 }}>None yet.</div> : (
        <div style={tableBox}><table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr><th style={th}>No.</th><th style={th}>Customer</th><th style={{ ...th, textAlign: 'right' }}>Total</th><th style={th}>DEAR</th><th style={th}>Payment</th></tr></thead>
          <tbody>{q.payments.map(r => <Row key={r.id} r={r} />)}</tbody></table></div>
      )}
      <div className="acct-region" style={{ fontSize: 12.5, marginTop: 8 }}>Payment comes from the DEAR order Radar found for each one. A DEAR order is only linked once it matches the customer and the reference, or someone confirms it here.</div>
    </>
  );
}
