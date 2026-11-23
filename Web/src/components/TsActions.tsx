import { useState } from 'react';
import { Link } from 'react-router-dom';
import { apiPost } from '../lib/api';
import { $, errMsg, shortDay, type ActionRow, type Actions } from '../lib/tradeshow';
import { tableBox, td, th } from '../lib/tsExtra';
import { ProofButton } from './TsPayment';

// What sales still has to do for the show, in one list instead of WhatsApp messages. Every confirmed order is here until someone presses Done:
// a paid one says how it was paid and carries the customer's screenshot (reconcile it to the DEAR order); an unpaid one says to send the payment
// details or the quote. When DEAR itself shows the order paid in full, the row says so, so it only needs the tick.
function what(r: ActionRow) {
  if (r.mode === 'paid') return <><b>Reconcile</b>: paid by {r.method === 'card' ? 'card' : 'bank transfer'}{r.amount != null ? `, ${$(r.amount)}` : ''}</>;
  return <><b>{r.kind === 'quote' ? 'Send the quote' : 'Send the payment details'}</b></>;
}
export default function TsActions({ data, onChange }: { data: Actions | null; onChange: () => void }) {
  const [busy, setBusy] = useState<string | null>(null), [err, setErr] = useState<string | null>(null);
  async function mark(id: string, done: boolean) { setBusy(id); setErr(null); try { await apiPost(`/tradeshow/orders/${id}/actioned`, { done }); onChange(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(null); } }
  if (!data) return <div className="acct-region">Loading…</div>;
  if (!data.ready) return <div className="empty-state">The To action list needs one set-up step in the database (tradeshow-handoffs.sql). Ask whoever looks after Radar.</div>;
  const table = (rows: ActionRow[], done: boolean) => (
    <div style={tableBox}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr><th style={th}>Order</th><th style={th}>Customer</th><th style={th}>Rep</th><th style={th}>What to do</th><th style={th}>Payment screenshot</th><th style={th}>DEAR</th><th style={th}>{done ? 'Done' : ''}</th></tr></thead>
        <tbody>{rows.map(r => (
          <tr key={r.id}>
            <td style={td}><Link to={`/trade-shows/orders/${r.id}`}><b>{r.number}</b></Link><div className="acct-region" style={{ fontSize: 12.5 }}>{r.kind === 'quote' ? 'Quote' : 'Order'} · {shortDay(r.confirmedAt)}</div></td>
            <td style={td}>{r.customer} <span className="acct-region">{r.region}</span></td>
            <td style={td}>{r.rep}</td>
            <td style={td}>{what(r)}</td>
            <td style={td}>{r.hasProof ? <ProofButton orderId={r.id} /> : <span className="acct-region">None</span>}</td>
            <td style={td}>{r.dear ? <>{r.dear} <span className={`pill ${r.dearPaid ? 'teal' : 'neutral'}`}>{r.stageLabel}</span></> : <span className="acct-region">Not in DEAR yet</span>}</td>
            <td style={td}>{done
              ? <span style={{ fontSize: 13 }}>{r.actionedBy ? `${r.actionedBy}, ` : ''}{shortDay(String(r.actionedAt).slice(0, 10))} <button type="button" className="link-btn" disabled={busy === r.id} onClick={() => mark(r.id, false)}>Undo</button></span>
              : <button type="button" className="btn secondary" disabled={busy === r.id} onClick={() => mark(r.id, true)}>{busy === r.id ? 'Saving…' : 'Done'}</button>}</td>
          </tr>))}
        </tbody>
      </table>
    </div>
  );
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {err && <div className="save-msg err" role="alert">{err}</div>}
      <div className="acct-region" style={{ fontSize: 13.5 }}>Everything the team has confirmed at this show that sales has not dealt with yet. Press Done once it is reconciled in DEAR, or the payment details or quote have gone to the customer.</div>
      {data.todo.length ? table(data.todo, false) : <div className="empty-state">Nothing to action. Everything confirmed has been dealt with.</div>}
      {data.done.length > 0 && <div><h3 style={{ margin: '4px 0 8px' }}>Done recently</h3>{table(data.done, true)}</div>}
    </div>
  );
}
