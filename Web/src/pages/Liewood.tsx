import { useCallback, useEffect, useRef, useState, type CSSProperties, type DragEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { apiGet, apiPost } from '../lib/api';
import { useMe } from '../lib/useMe';
import { CHECK_LABEL, money, ORDER_STAGE, sendFile, type OrderSummary, type Uploaded } from '../lib/liewood';

// Liewood (Products): every Liewood sales order, where it is (confirmed, on the DEAR PO, invoiced = coming, received), and anything missing.
// Managers drop the Excel sales order here to add one; the PDF confirmation and the PO number go on the order's own page.
const th: CSSProperties = { textAlign: 'left', fontSize: 13, color: 'var(--muted)', fontWeight: 500, padding: '8px 10px', borderBottom: '1px solid var(--line)', whiteSpace: 'nowrap' };
const td: CSSProperties = { padding: '9px 10px', borderBottom: '1px solid var(--line)', fontSize: 14, verticalAlign: 'top' };

export default function Liewood() {
  const me = useMe(), isManager = me?.role === 'manager', nav = useNavigate();
  const [orders, setOrders] = useState<OrderSummary[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [again, setAgain] = useState<File | null>(null);   // the same order uploaded twice: asked before replacing
  const [showClosed, setShowClosed] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(() => { apiGet('/liewood/orders', { fresh: true }).then((d: { orders: OrderSummary[] }) => { setOrders(d.orders); setErr(null); }).catch((e: Error) => setErr(e.message)); }, []);
  useEffect(() => { load(); }, [load]);

  async function upload(file: File, replace = false) {
    if (busy) return;
    setMsg(null); setAgain(null);
    if (/\.pdf$/i.test(file.name)) { setMsg({ ok: false, text: 'That is the PDF. Add the Excel sales order here first; the PDF goes on the order\'s page.' }); return; }
    if (!/\.xlsx?$/i.test(file.name)) { setMsg({ ok: false, text: 'Add the Excel sales order (.xlsx) from Liewood.' }); return; }
    setBusy(true);
    try {
      const r = await sendFile<Uploaded>(`/liewood/orders${replace ? '?replace=1' : ''}`, file);
      const notes = [r.notInDear ? `${r.notInDear} of its products are not in DEAR yet` : '', r.range && r.range.added ? `${r.range.added} new SKU${r.range.added === 1 ? '' : 's'} added to the range` : '', ...r.problems.slice(0, 3)].filter(Boolean);
      setMsg({ ok: true, text: `${r.soNumber} ${r.replaced ? 'updated' : 'added'}: ${r.lines} lines, ${r.units.toLocaleString('en-AU')} units.${notes.length ? ' ' + notes.join('. ') + '.' : ''} Opening it…` });
      load();
      setTimeout(() => nav(`/liewood/${r.id}`), 900);
    } catch (e) {
      const x = e as Error & { status?: number };
      if (x.status === 409) setAgain(file);
      setMsg({ ok: false, text: x.message });
    } finally { setBusy(false); if (input.current) input.current.value = ''; }
  }
  const drop = (e: DragEvent) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files?.[0]; if (f && isManager) void upload(f); };
  async function checkNow() {
    setBusy(true); setMsg(null);
    try {
      const r: { pos: number; ok: number; failed: { po: string; error: string }[]; alerts: number } = await apiPost('/liewood/check', {});
      setMsg({ ok: !r.failed.length, text: r.pos ? `Read ${r.ok} of ${r.pos} purchase orders from DEAR.${r.failed.length ? ' ' + r.failed.map(f => `${f.po}: ${f.error}`).join(' ') : ''}${r.alerts ? ` ${r.alerts} alert email${r.alerts === 1 ? '' : 's'} sent.` : ''}` : 'No open order has a PO number yet.' });
      load();
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); } finally { setBusy(false); }
  }

  const shown = (orders ?? []).filter(o => showClosed || !o.closed), closedCount = (orders ?? []).filter(o => o.closed).length;
  return (
    <>
      <h1 style={{ display: 'flex', gap: 14, alignItems: 'baseline', flexWrap: 'wrap' }}>Liewood <Link to="/liewood/range" style={{ fontSize: 15, fontWeight: 400 }}>Range and pricing →</Link></h1>
      <div className="acct-region" style={{ marginBottom: 14, maxWidth: 700 }}>
        Each Liewood sales order, checked against its DEAR purchase order. An invoice from Liewood on the PO means it is confirmed coming; the stock received against each invoice is checked line by line, and anything missing is flagged.
      </div>

      {isManager && (
        <div className="section">
          <div className="panel-title">Add a sales order</div>
          <div onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={drop}
            style={{ border: `2px dashed ${over ? 'var(--teal)' : 'var(--line)'}`, borderRadius: 6, padding: '22px 18px', background: over ? 'var(--teal-bg)' : 'var(--panel)', maxWidth: 640, textAlign: 'center' }}>
            <div style={{ fontSize: 14.5, marginBottom: 8 }}>Drop the Excel sales order from Liewood here (for example SO493681_Sales_Order.xlsx)</div>
            <button type="button" className="btn secondary" disabled={busy} onClick={() => input.current?.click()}>{busy ? 'Reading…' : 'Choose the file'}</button>
            <input ref={input} type="file" accept=".xlsx,.xls" hidden onChange={e => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
          </div>
          {msg && <div className={msg.ok ? 'save-msg ok' : 'save-msg err'} role={msg.ok ? 'status' : 'alert'} style={{ maxWidth: 640 }}>{msg.text}</div>}
          {again && <div style={{ marginTop: 8 }}><button type="button" className="btn" disabled={busy} onClick={() => upload(again, true)}>Replace it with this file</button> <button type="button" className="link-btn" onClick={() => { setAgain(null); setMsg(null); }}>Keep the one already here</button></div>}
        </div>
      )}

      <div className="section">
        <div style={{ display: 'flex', gap: 12, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <div className="panel-title" style={{ flex: 1 }}>Orders</div>
          {closedCount > 0 && <label style={{ fontSize: 13, display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={showClosed} onChange={e => setShowClosed(e.target.checked)} /> Show finished ({closedCount})</label>}
          {isManager && <button type="button" className="btn secondary" disabled={busy} onClick={checkNow}>Check DEAR now</button>}
        </div>
        {!isManager && msg && <div className={msg.ok ? 'save-msg ok' : 'save-msg err'}>{msg.text}</div>}
        {err && <div className="save-msg err" role="alert">{err}</div>}
        {!err && orders === null && <div className="acct-region">Loading…</div>}
        {orders && shown.length === 0 && <div className="empty-state">No Liewood orders yet.{isManager ? ' Drop a sales order above to add the first one.' : ''}</div>}
        {shown.length > 0 && (
          <div style={{ overflowX: 'auto', border: '1px solid var(--line)', borderRadius: 4, background: 'var(--panel)' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr><th style={th}>Order</th><th style={th}>Name</th><th style={th}>ETA</th><th style={th}>DEAR PO</th><th style={{ ...th, textAlign: 'right' }}>Units</th><th style={{ ...th, textAlign: 'right' }}>Value</th><th style={th}>Where it is</th><th style={th}>Checks</th></tr></thead>
              <tbody>
                {shown.map(o => (
                  <tr key={o.id} style={{ opacity: o.closed ? 0.6 : 1 }}>
                    <td style={td}><Link to={`/liewood/${o.id}`}><b>{o.soNumber}</b></Link></td>
                    <td style={td}>{o.name ?? <span className="acct-region">{o.season ? `Season ${o.season}` : ''}</span>}</td>
                    <td style={td}>{o.eta ?? ''}{o.overdue && <> <span className="pill rust">Late</span></>}</td>
                    <td style={td}>{o.poNumber ?? <span className="acct-region">not linked</span>}</td>
                    <td style={{ ...td, textAlign: 'right' }}>{o.units.toLocaleString('en-AU')}</td>
                    <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>{money(o.amount, o.currency)}</td>
                    <td style={td}><span className={`pill ${ORDER_STAGE[o.stage].tone}`}>{o.closed ? 'Finished' : ORDER_STAGE[o.stage].label}</span></td>
                    <td style={td}><span className={`pill ${CHECK_LABEL[o.confirmation].tone}`}>{CHECK_LABEL[o.confirmation].label}</span>{o.issues > 0 && <> <span className="pill rust">{o.issues} to look at</span></>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="acct-region" style={{ marginTop: 8, fontSize: 13 }}>DEAR is read every hour. The alert emails go to the Liewood list in Settings, once a manager turns it on.</div>
      </div>
    </>
  );
}
