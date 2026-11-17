import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { apiGet, apiPatch, apiPost } from '../lib/api';
import { useMe } from '../lib/useMe';
import TsLogFollowUps from '../components/TsLogFollowUps';
import { $, errMsg, shortDay, STAGE_TONE, type Order, type Product } from '../lib/tradeshow';

// A trade show order or quote. While it is being written: search products (stock free to sell, and what is coming when it is short),
// quantities, discount (managers), freight, card surcharge, totals. Confirm sends it to sales@ with the DEAR file. After that: the reference
// can be changed (or the customer's PO added) and it can be sent again; it shows where it is in DEAR; and it has its log and follow-ups.
const th: CSSProperties = { textAlign: 'left', fontSize: 13, color: 'var(--muted)', fontWeight: 500, padding: '7px 8px', borderBottom: '1px solid var(--line)', whiteSpace: 'nowrap' };
const td: CSSProperties = { padding: '8px', borderBottom: '1px solid var(--line)', fontSize: 14, verticalAlign: 'top' };
const num: CSSProperties = { ...td, textAlign: 'right', whiteSpace: 'nowrap' };
const field: CSSProperties = { padding: '7px 10px', border: '1px solid var(--line)', borderRadius: 3, font: 'inherit', fontSize: 15 };
type Line = { sku: string; name: string; qty: number; comment: string };

function stockText(p: Pick<Product, 'free' | 'incoming' | 'eta'>) {
  const coming = p.incoming ? `${p.incoming.qty} coming${p.incoming.date ? ` ${p.incoming.date}` : ''}` : p.eta ? `ETA ${p.eta}` : '';
  return `${Math.max(p.free, 0)} free${coming ? `, ${coming}` : ''}`;
}

export default function TradeShowOrder() {
  const { id = '' } = useParams(), nav = useNavigate();
  const me = useMe(), isManager = me?.role === 'manager';
  const [o, setO] = useState<Order | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [dirty, setDirty] = useState(false);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Product[]>([]);
  const [disc, setDisc] = useState({ kind: 'pct' as 'pct' | 'amount', value: '' });
  const [freight, setFreight] = useState('');
  const [ref, setRef] = useState('');
  const [po, setPo] = useState('');
  const [notes, setNotes] = useState('');
  const [dearNo, setDearNo] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const latest = useRef(0);

  const show = useCallback((x: Order) => {
    setO(x); setLines(x.lines.map(l => ({ sku: l.sku, name: l.name, qty: l.qty, comment: l.comment ?? '' }))); setDirty(false);
    setDisc({ kind: x.discount?.kind ?? 'pct', value: x.discount ? String(x.discount.value) : '' }); setFreight(x.freight ? String(x.freight) : ''); setRef(x.reference); setPo(x.customerPo ?? ''); setNotes(x.notes ?? '');
  }, []);
  const load = useCallback(() => { apiGet(`/tradeshow/orders/${id}`, { fresh: true }).then((d: { order: Order }) => { show(d.order); setErr(null); }).catch(e => setErr(errMsg(e))); }, [id, show]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const term = q.trim(); if (term.length < 2) { setHits([]); return; }
    const mine = ++latest.current;
    const t = setTimeout(() => apiGet(`/tradeshow/products?q=${encodeURIComponent(term)}`).then((d: { products: Product[] }) => { if (latest.current === mine) setHits(d.products); }).catch(() => {}), 250);
    return () => clearTimeout(t);
  }, [q]);

  async function act(f: () => Promise<any>, okText?: string) {
    if (busy) return;
    setBusy(true); setMsg(null);
    try { const r = await f(); if (r?.order) show(r.order); else load(); if (okText) setMsg({ ok: true, text: okText }); return r; }
    catch (e) { setMsg({ ok: false, text: errMsg(e) }); } finally { setBusy(false); }
  }
  const body = () => ({ lines: lines.map(l => ({ sku: l.sku, qty: l.qty, comment: l.comment })), freight: freight || 0, notes, customerPo: po, reference: ref,
    ...(isManager ? { discount: disc.value ? { kind: disc.kind, value: disc.value } : null } : {}) });
  const save = (extra: object = {}) => act(() => apiPatch(`/tradeshow/orders/${id}`, { ...body(), ...extra }), 'Saved.');
  async function confirm() {
    if (!o) return;
    const r = await act(async () => { await apiPatch(`/tradeshow/orders/${id}`, body()); return apiPost(`/tradeshow/orders/${id}/confirm`, {}); });
    if (r) setMsg(r.emailed ? { ok: true, text: `Confirmed and emailed to sales with the DEAR file. Reference: ${r.order.reference}` } : { ok: false, text: `Confirmed, but not emailed: ${r.reason}` });
  }
  function add(p: Product) {
    setLines(ls => { const i = ls.findIndex(l => l.sku === p.sku); const step = p.increment && p.increment > 1 ? p.increment : 1; return i >= 0 ? ls.map((l, j) => (j === i ? { ...l, qty: l.qty + step } : l)) : [...ls, { sku: p.sku, name: p.name, qty: step, comment: '' }]; });
    setDirty(true); setQ(''); setHits([]);
  }

  if (err) return <><p><Link to="/trade-shows">← Trade Shows</Link></p><div className="save-msg err" role="alert">{err}</div></>;
  if (!o) return <div className="acct-region">Loading…</div>;
  const draft = o.status === 'draft', t = o.totals, mine = isManager || o.repId === me?.id;
  const byLine = new Map(o.lines.map(l => [l.sku, l]));
  const liveStock = draft || o.stage === 'sent' || o.stage === 'in_dear_quote';   // once DEAR has the order, its own stock view is what counts
  return (
    <>
      <p style={{ margin: '0 0 6px' }}><Link to={`/trade-shows/${o.show.id}`}>← {o.show.name}</Link></p>
      <h1 style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>{o.kind === 'quote' ? 'Quote' : 'Order'} {o.number}
        <span className={`pill ${STAGE_TONE[o.stage] ?? 'neutral'}`}>{o.stageLabel}{o.dear ? ` ${o.dear.number}` : ''}</span></h1>
      <div className="acct-region" style={{ marginBottom: 14 }}>{shortDay(o.orderDate)} · by {o.repName ?? 'unknown'}{o.cancelReason ? ` · cancelled: ${o.cancelReason}` : ''}</div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16, marginBottom: 16 }}>
        <div className="card" style={{ marginBottom: 0 }}>
          <div className="panel-title">Customer</div>
          <div style={{ fontSize: 15 }}><Link to={`/accounts/${o.customer.id}`}><b>{o.customer.name}</b></Link> <span className="acct-region">{o.customer.region}</span>{o.newCustomer && <> <span className="pill teal">New</span></>}</div>
          <div style={{ fontSize: 13.5, marginTop: 6, lineHeight: 1.6 }}>{[o.contact.name, o.contact.email, o.contact.phone].filter(Boolean).join(' · ')}{o.contact.address && <div>{o.contact.address}</div>}{o.customer.terms && <div className="acct-region">Terms: {o.customer.terms}</div>}</div>
        </div>
        <div className="card" style={{ marginBottom: 0 }}>
          <div className="panel-title">Reference for DEAR</div>
          <input style={{ ...field, width: '100%' }} value={ref} disabled={!mine || o.status === 'cancelled'} onChange={e => { setRef(e.target.value); setDirty(true); }} />
          <div style={{ fontSize: 13, marginTop: 8 }}>Customer's PO number (optional)</div><input style={{ ...field, width: '100%', marginTop: 4 }} placeholder="e.g. 4471" value={po} disabled={!mine || o.status === 'cancelled'} onChange={e => { setPo(e.target.value); setDirty(true); }} />
          <div className="acct-region" style={{ fontSize: 12.5, marginTop: 6 }}>Keep {o.number} in it, so Radar finds the DEAR order. If the customer needs their own reference, add it.</div>
          {!draft && o.status === 'sent' && mine && (dirty || ref !== o.reference || po !== (o.customerPo ?? '')) && <button type="button" className="btn secondary" style={{ marginTop: 8 }} disabled={busy} onClick={() => save({ lines: undefined, discount: undefined, freight: undefined })}>Save changes</button>}
        </div>
      </div>

      {draft && mine && (
        <div className="section" style={{ marginBottom: 14 }}>
          <input style={{ ...field, width: '100%', maxWidth: 640, fontSize: 16 }} placeholder="Add a product: SKU, name, barcode or brand" value={q} onChange={e => setQ(e.target.value)} />
          {hits.length > 0 && (
            <div style={{ border: '1px solid var(--line)', borderRadius: 6, maxWidth: 640, background: 'var(--panel)', marginTop: 4, maxHeight: 340, overflowY: 'auto' }}>
              {hits.map(p => (
                <button key={p.sku} type="button" onClick={() => add(p)} disabled={p.price === null} style={{ display: 'flex', gap: 10, width: '100%', textAlign: 'left', padding: '8px 12px', border: 0, borderBottom: '1px solid var(--line)', background: 'none', font: 'inherit', cursor: 'pointer', alignItems: 'center' }}>
                  <span style={{ flex: 1 }}><b>{p.name}</b><div className="acct-region" style={{ fontSize: 12.5 }}>{p.sku}{p.brand ? ` · ${p.brand}` : ''}{p.increment && p.increment > 1 ? ` · packs of ${p.increment}` : ''}</div></span>
                  <span style={{ textAlign: 'right', fontSize: 13, whiteSpace: 'nowrap' }}>{p.price === null ? <span style={{ color: 'var(--rust)' }}>no wholesale price</span> : $(p.price)}<div style={{ color: p.free > 0 ? 'var(--teal)' : 'var(--rust)', fontSize: 12.5 }}>{stockText(p)}</div></span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div style={{ overflowX: 'auto', border: '1px solid var(--line)', borderRadius: 4, background: 'var(--panel)' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr><th style={th}>Product</th><th style={{ ...th, textAlign: 'right' }}>Qty</th><th style={{ ...th, textAlign: 'right' }}>Price ex GST</th><th style={{ ...th, textAlign: 'right' }}>Line ex GST</th><th style={th}>Stock</th>{draft && mine && <th style={th} />}</tr></thead>
          <tbody>
            {lines.map((l, i) => { const saved = byLine.get(l.sku); const changed = !saved || saved.qty !== l.qty; return (
              <tr key={l.sku}>
                <td style={td}><b>{l.name}</b><div className="acct-region" style={{ fontSize: 12.5 }}>{l.sku}{saved?.packNote && !changed ? <span style={{ color: 'var(--amber)' }}> · {saved.packNote}</span> : ''}</div>
                  {draft && mine ? <input style={{ ...field, fontSize: 13, padding: '3px 6px', marginTop: 4, width: '100%' }} placeholder="Comment for DEAR (optional)" value={l.comment} onChange={e => { setLines(ls => ls.map((x, j) => (j === i ? { ...x, comment: e.target.value } : x))); setDirty(true); }} /> : l.comment && <div style={{ fontSize: 12.5 }}>{l.comment}</div>}</td>
                <td style={num}>{draft && mine ? <input inputMode="numeric" style={{ ...field, width: 70, textAlign: 'right' }} value={l.qty} onChange={e => { const n = Math.max(0, Math.floor(Number(e.target.value) || 0)); setLines(ls => ls.map((x, j) => (j === i ? { ...x, qty: n } : x))); setDirty(true); }} /> : l.qty}</td>
                <td style={num}>{saved ? $(saved.price) : ''}</td>
                <td style={num}>{saved && !changed ? $(saved.lineTotal) : <span className="acct-region">save to see</span>}</td>
                <td style={{ ...td, fontSize: 13, color: liveStock && saved?.stock && saved.stock.backorder > 0 && !changed ? 'var(--rust)' : undefined }}>{saved?.stock && !changed && liveStock ? saved.stock.note : !liveStock ? <span className="acct-region">In DEAR</span> : ''}</td>
                {draft && mine && <td style={td}><button type="button" className="link-btn" onClick={() => { setLines(ls => ls.filter((_, j) => j !== i)); setDirty(true); }}>Remove</button></td>}
              </tr>
            ); })}
            {!lines.length && <tr><td style={td} colSpan={6}><span className="acct-region">No products yet.</span></td></tr>}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16, marginTop: 16 }}>
        <div className="card" style={{ marginBottom: 0 }}>
          <div className="panel-title">Discount, freight, payment</div>
          <div style={{ display: 'grid', gap: 10 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, width: 70 }}>Discount</span>
              <select style={field} value={disc.kind} disabled={!draft || !isManager} onChange={e => { setDisc({ ...disc, kind: e.target.value as 'pct' | 'amount' }); setDirty(true); }}><option value="pct">%</option><option value="amount">$</option></select>
              <input inputMode="decimal" style={{ ...field, width: 100 }} value={disc.value} disabled={!draft || !isManager} onChange={e => { setDisc({ ...disc, value: e.target.value }); setDirty(true); }} />
              {!isManager && draft && <span className="acct-region" style={{ fontSize: 12.5 }}>Managers give discounts</span>}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><span style={{ fontSize: 13, width: 70 }}>Freight</span><input inputMode="decimal" style={{ ...field, width: 120 }} value={freight} placeholder="0.00" disabled={!draft || !mine} onChange={e => { setFreight(e.target.value); setDirty(true); }} /><span className="acct-region" style={{ fontSize: 12.5 }}>ex GST</span></div>
            <label style={{ fontSize: 14, display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={o.cardPayment} disabled={!draft || !mine || busy} onChange={e => save({ cardPayment: e.target.checked })} /> Paying by card{o.cardSurchargePct ? ` (${o.cardSurchargePct}% surcharge)` : ' (no surcharge set for this show)'}</label>
            <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>Notes for sales<textarea style={{ ...field, minHeight: 54 }} value={notes} disabled={!mine || o.status === 'cancelled'} onChange={e => { setNotes(e.target.value); setDirty(true); }} /></label>
          </div>
        </div>
        <div className="card" style={{ marginBottom: 0 }}>
          <div className="panel-title">Total{dirty && draft ? ' (press Save to update)' : ''}</div>
          <div className="kv"><span>Goods (wholesale ex GST)</span><span className="num">{$(t.goods)}</span></div>
          {t.linePct > 0 && <div className="kv"><span>Discount {t.linePct}%</span><span className="num">-{$(t.discount)}</span></div>}
          <div className="kv"><span>Freight</span><span className="num">{$(t.freight)}</span></div>
          {t.surcharge > 0 && <div className="kv"><span>Card surcharge {t.surchargePct}%</span><span className="num">{$(t.surcharge)}</span></div>}
          <div className="kv"><span>Total ex GST</span><span className="num">{$(t.exGst)}</span></div>
          <div className="kv"><span>GST{o.gstRate === 0 ? ' (none: overseas)' : ''}</span><span className="num">{$(t.gst)}</span></div>
          <div className="kv" style={{ fontWeight: 600, fontSize: 16 }}><span>Total inc GST</span><span className="num">{$(t.total)}</span></div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', margin: '16px 0' }}>
        {draft && mine && <>
          <button type="button" className="btn secondary" disabled={busy} onClick={() => save()}>{busy ? 'Saving…' : 'Save'}</button>
          <select style={field} value={o.kind} disabled={busy} onChange={e => save({ kind: e.target.value })}><option value="order">Order</option><option value="quote">Quote</option></select>
          <button type="button" className="btn" disabled={busy || !lines.length || lines.some(l => l.qty < 1)} onClick={confirm}>Confirm and send to sales</button>
          <button type="button" className="link-btn" style={{ color: 'var(--rust)' }} disabled={busy} onClick={async () => { if (window.confirm('Throw this draft away?')) { await apiPost(`/tradeshow/orders/${id}/cancel`, {}); nav(`/trade-shows/${o.show.id}`); } }}>Discard draft</button>
        </>}
        {o.status === 'sent' && mine && <>
          <button type="button" className="btn secondary" disabled={busy} onClick={() => act(() => apiPost(`/tradeshow/orders/${id}/resend`, {}), 'Sent to sales again.')}>Send to sales again</button>
          {!o.dear && <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input style={{ ...field, width: 130 }} placeholder="DEAR SQ number" value={dearNo} onChange={e => setDearNo(e.target.value)} /><button type="button" className="btn secondary" disabled={busy || !dearNo.trim()} onClick={() => act(() => apiPost(`/tradeshow/orders/${id}/link`, { number: dearNo }), 'Linked.')}>Link</button></span>}
          <button type="button" className="link-btn" style={{ color: 'var(--rust)' }} disabled={busy} onClick={() => { const why = window.prompt('Why is it cancelled?'); if (why) act(() => apiPost(`/tradeshow/orders/${id}/cancel`, { reason: why }), 'Cancelled.'); }}>Cancel {o.kind}</button>
        </>}
      </div>
      {o.status === 'sent' && o.emailError && <div className="save-msg err" role="alert">Not emailed to sales: {o.emailError}</div>}
      {o.status === 'sent' && o.emailedAt && !o.emailError && <div className="acct-region" style={{ fontSize: 13 }}>Emailed to sales {new Date(o.emailedAt).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}{o.emailVersion > 1 ? ` (version ${o.emailVersion})` : ''}.</div>}
      {msg && <div className={msg.ok ? 'save-msg ok' : 'save-msg err'} role={msg.ok ? 'status' : 'alert'}>{msg.text}</div>}

      {o.status !== 'draft' && (
        <div className="section" style={{ marginTop: 18 }}>
          <TsLogFollowUps target={{ orderId: o.id }} log={o.log} followUps={o.followUps} closed={o.followUpsClosed} onChange={load}
            closedNote={o.stage === 'cancelled' ? 'Cancelled: no more follow-ups.' : o.kind === 'quote' ? 'This quote is now a confirmed DEAR order: no more follow-ups.' : 'Paid in DEAR: no more follow-ups.'} />
        </div>
      )}
    </>
  );
}
