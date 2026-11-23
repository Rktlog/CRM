import { useState } from 'react';
import { Link } from 'react-router-dom';
import { apiPost } from '../lib/api';
import type { OrderProposal } from '../lib/aiStream';

// The preview the assistant builds when a rep tells it a trade show order. Nothing is saved until "Create draft" is pressed, and then only a DRAFT order
// is made: the rep opens it to check offers, freight and the total, choose how the customer pays, and confirm it there. Each line's quantity can be
// changed here first, and a line can be taken off.
const money = (n: number) => `$${n.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function OrderPreview({ proposal }: { proposal: OrderProposal }) {
  const [qty, setQty] = useState<number[]>(() => proposal.lines.map(l => l.qty));
  const [on, setOn] = useState<boolean[]>(() => proposal.lines.map(() => true));
  const [state, setState] = useState<'idle' | 'saving' | 'done' | 'cancelled'>('idle');
  const [made, setMade] = useState<{ orderId: string; number: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const chosen = proposal.lines.map((l, i) => ({ l, q: qty[i] ?? l.qty, on: on[i] })).filter(x => x.on && x.q >= 1);
  const goods = chosen.reduce((a, x) => a + x.q * x.l.price, 0);

  async function create() {
    setState('saving'); setError(null);
    try { setMade(await apiPost('/ai/show-order/confirm', { showId: proposal.showId, accountId: proposal.accountId, kind: proposal.kind, lines: chosen.map(x => ({ sku: x.l.sku, qty: x.q })) })); setState('done'); }
    catch (e) { setError((e as Error).message); setState('idle'); }   // nothing was made, so it can be pressed again
  }
  const cell = { padding: '4px 8px', borderBottom: '1px solid var(--line)', verticalAlign: 'top' as const, fontSize: 13 };
  const done = state === 'done' || state === 'cancelled';
  return (
    <div style={{ marginTop: 10, border: '1px solid var(--line)', borderRadius: 6, background: '#fff', color: '#111' }}>
      <div style={{ padding: '8px 10px', fontWeight: 600 }}>{proposal.kind === 'quote' ? 'Quote' : 'Order'} for {proposal.customer}{proposal.region ? ` (${proposal.region})` : ''} <span style={{ fontWeight: 400, color: 'var(--muted)' }}>at {proposal.showName}</span></div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>{['', 'Product', 'Qty', 'Price ex GST', 'Line', 'Stock'].map(h => <th key={h} style={{ ...cell, textAlign: 'left', color: 'var(--muted)', fontWeight: 500 }}>{h}</th>)}</tr></thead>
          <tbody>{proposal.lines.map((l, i) => (
            <tr key={l.sku} style={{ opacity: on[i] ? 1 : 0.45 }}>
              <td style={cell}><input type="checkbox" aria-label={`Include ${l.name}`} checked={on[i]} disabled={done} onChange={e => setOn(o => o.map((v, j) => (j === i ? e.target.checked : v)))} /></td>
              <td style={cell}><b>{l.name}</b><div style={{ color: 'var(--muted)', fontSize: 12 }}>{l.sku}</div></td>
              <td style={cell}><input inputMode="numeric" aria-label={`Quantity of ${l.name}`} style={{ width: 56, textAlign: 'right' }} disabled={done} value={qty[i]} onChange={e => { const n = Math.max(0, Math.floor(Number(e.target.value) || 0)); setQty(q => q.map((v, j) => (j === i ? n : v))); }} /></td>
              <td style={{ ...cell, textAlign: 'right' }}>{money(l.price)}</td>
              <td style={{ ...cell, textAlign: 'right' }}>{money((qty[i] ?? l.qty) * l.price)}</td>
              <td style={{ ...cell, color: l.warning ? 'var(--rust)' : undefined }}>{l.warning ?? l.stock}</td>
            </tr>))}
          </tbody>
        </table>
      </div>
      <div style={{ padding: '6px 10px', fontSize: 13 }}>Goods ex GST: <b>{money(goods)}</b> <span style={{ color: 'var(--muted)' }}>(offers, freight and GST are worked out on the order)</span></div>
      {proposal.problems.length > 0 && <div style={{ padding: '4px 10px', fontSize: 13, color: 'var(--rust)' }}>{proposal.problems.map((p, i) => <div key={i}><b>{p.what}</b>: {p.reason}</div>)}</div>}
      {error && <div className="save-msg err" role="alert" style={{ margin: '4px 10px' }}>{error}</div>}
      <div style={{ padding: '8px 10px', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {state === 'done' && made ? <span role="status">Draft {made.number} made. <Link to={`/trade-shows/orders/${made.orderId}`}>Open it</Link> to check the total, say how they pay and confirm.</span>
          : state === 'cancelled' ? <span style={{ color: 'var(--muted)' }}>Cancelled. Nothing was saved.</span>
          : <>
              <button type="button" className="btn" disabled={state === 'saving' || !chosen.length} onClick={create}>{state === 'saving' ? 'Making the draft…' : 'Create draft'}</button>
              <button type="button" className="btn secondary" disabled={state === 'saving'} onClick={() => setState('cancelled')}>Cancel</button>
              <span style={{ color: 'var(--muted)', fontSize: 12.5 }}>Only a draft is made. You confirm it on the order.</span>
            </>}
      </div>
    </div>
  );
}
