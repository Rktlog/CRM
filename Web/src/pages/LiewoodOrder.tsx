import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { apiDelete, apiGet, apiPatch } from '../lib/api';
import { useMe } from '../lib/useMe';
import { CHECK_LABEL, LINE_STAGE, money, openPdf, ORDER_STAGE, sendFile, shortDay, type Check, type Order } from '../lib/liewood';

// One Liewood order: its name, ETA, DEAR PO and notes (managers edit), the PDF confirmation and its check, Liewood's invoices on the PO
// with what was received against each, and every line: ordered, on the PO, invoiced, received.
const th: CSSProperties = { textAlign: 'left', fontSize: 13, color: 'var(--muted)', fontWeight: 500, padding: '7px 9px', borderBottom: '1px solid var(--line)', whiteSpace: 'nowrap' };
const td: CSSProperties = { padding: '7px 9px', borderBottom: '1px solid var(--line)', fontSize: 13.5, verticalAlign: 'top' };
const num: CSSProperties = { ...td, textAlign: 'right' };
const field: CSSProperties = { width: '100%', padding: '6px 9px', border: '1px solid var(--line)', borderRadius: 3, font: 'inherit', fontSize: 14 };
const label: CSSProperties = { display: 'grid', gap: 4, fontSize: 13 };
const ago = (iso: string) => { const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 2 ? 'just now' : m < 90 ? `${m} minutes ago` : m < 36 * 60 ? `${Math.round(m / 60)} hours ago` : `${Math.round(m / 1440)} days ago`; };

export default function LiewoodOrder() {
  const { id = '' } = useParams(), nav = useNavigate();
  const me = useMe(), isManager = me?.role === 'manager';
  const [o, setO] = useState<Order | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', eta: '', poNumber: '', notes: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [filter, setFilter] = useState<'all' | 'issues'>('all');
  const pdfInput = useRef<HTMLInputElement>(null);

  const show = useCallback((x: Order) => { setO(x); setForm({ name: x.name ?? '', eta: x.eta ?? '', poNumber: x.poNumber ?? '', notes: x.notes ?? '' }); }, []);
  const load = useCallback(() => { apiGet(`/liewood/orders/${id}`, { fresh: true }).then((d: { order: Order }) => { show(d.order); setErr(null); }).catch((e: Error) => setErr(e.message)); }, [id, show]);
  useEffect(() => { load(); }, [load]);

  async function save(extra: Record<string, unknown> = {}) {
    if (busy) return;
    setBusy(true); setMsg(null);
    try { const d: { order: Order } = await apiPatch(`/liewood/orders/${id}`, { ...form, ...extra }); show(d.order); setMsg({ ok: true, text: 'Saved.' }); }
    catch (e) { setMsg({ ok: false, text: (e as Error).message }); } finally { setBusy(false); }
  }
  async function addPdf(f: File) {
    setBusy(true); setMsg(null);
    try { const r = await sendFile<{ check: Check }>(`/liewood/orders/${id}/confirmation`, f); setMsg({ ok: r.check.status !== 'mismatch', text: r.check.status === 'match' ? 'PDF added: its order number and totals match the Excel.' : r.check.reasons.join(' ') }); load(); }
    catch (e) { setMsg({ ok: false, text: (e as Error).message }); } finally { setBusy(false); if (pdfInput.current) pdfInput.current.value = ''; }
  }
  async function remove() {
    if (!o || !window.confirm(`Delete ${o.soNumber} from Radar? This removes the order, its lines and its PDF here. Nothing in DEAR changes.`)) return;
    try { await apiDelete(`/liewood/orders/${id}`); nav('/liewood'); } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
  }

  if (err) return <><p><Link to="/liewood">← Liewood</Link></p><div className="save-msg err" role="alert">{err}</div></>;
  if (!o) return <div className="acct-region">Loading…</div>;
  const stock = o.lines.filter(l => !l.display), displays = o.lines.filter(l => l.display);
  const bad = (l: Order['lines'][number]) => l.stage === 'not_on_po' || l.stage === 'short_on_po' || o.shortages.some(s => s.sku === l.sku);
  const lines = filter === 'issues' ? stock.filter(bad) : stock;
  const tot = (k: 'qty' | 'onPo' | 'invoiced' | 'received') => stock.reduce((t, l) => t + l[k], 0);
  const check = o.confirmation?.status ?? (o.confirmationName ? 'not_checked' : 'none');

  return (
    <>
      <p style={{ margin: '0 0 6px' }}><Link to="/liewood">← Liewood</Link></p>
      <h1 style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>{o.soNumber}{o.name ? <span style={{ fontWeight: 400 }}>{o.name}</span> : null}
        <span className={`pill ${ORDER_STAGE[o.stage].tone}`}>{o.closed ? 'Finished' : ORDER_STAGE[o.stage].label}</span>{o.overdue && <span className="pill rust">Past its ETA, not all invoiced</span>}</h1>
      <div className="acct-region" style={{ marginBottom: 16 }}>
        {o.units.toLocaleString('en-AU')} units · {money(o.amount, o.currency)}{o.season ? ` · season ${o.season}` : ''}{o.deliveryWindow ? ` · Liewood's delivery window ${o.deliveryWindow}` : ''}{o.customerOrderNo ? ` · our ref ${o.customerOrderNo}` : ''}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16, marginBottom: 20 }}>
        <div className="card" style={{ marginBottom: 0 }}>
          <div className="panel-title">Order details</div>
          <div style={{ display: 'grid', gap: 10 }}>
            <label style={label}>Name (what the team calls it)<input style={field} value={form.name} disabled={!isManager} placeholder="1.27 SS27 China" onChange={e => setForm({ ...form, name: e.target.value })} /></label>
            <label style={label}>ETA (as Liewood gave it)<input style={field} value={form.eta} disabled={!isManager} placeholder="April 2027" onChange={e => setForm({ ...form, eta: e.target.value })} /></label>
            <label style={label}>DEAR purchase order<input style={field} value={form.poNumber} disabled={!isManager} placeholder="PO-00089" onChange={e => setForm({ ...form, poNumber: e.target.value })} /></label>
            <label style={label}>Notes<textarea style={{ ...field, minHeight: 60 }} value={form.notes} disabled={!isManager} onChange={e => setForm({ ...form, notes: e.target.value })} /></label>
            {isManager && <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <button type="button" className="btn" disabled={busy} onClick={() => save()}>{busy ? 'Saving…' : 'Save'}</button>
              <button type="button" className="link-btn" disabled={busy} onClick={() => save({ closed: !o.closed })}>{o.closed ? 'Open it again' : 'Mark finished (no more checks)'}</button>
              <button type="button" className="link-btn" style={{ color: 'var(--rust)' }} onClick={remove}>Delete</button>
            </div>}
            {msg && <div className={msg.ok ? 'save-msg ok' : 'save-msg err'} role={msg.ok ? 'status' : 'alert'}>{msg.text}</div>}
          </div>
        </div>

        <div className="card" style={{ marginBottom: 0 }}>
          <div className="panel-title">Order confirmation (PDF)</div>
          <div style={{ fontSize: 14, display: 'grid', gap: 8 }}>
            <div><span className={`pill ${CHECK_LABEL[check].tone}`}>{CHECK_LABEL[check].label}</span>{o.confirmationName && <> <button type="button" className="link-btn" onClick={() => openPdf(id).catch(e => setMsg({ ok: false, text: e.message }))}>{o.confirmationName}</button></>}</div>
            {o.confirmation?.reasons.map((r, i) => <div key={i} style={{ fontSize: 13 }}>{r}</div>)}
            {o.confirmation?.pdf && <div className="acct-region" style={{ fontSize: 13 }}>The PDF says {o.confirmation.pdf.orderNo ?? '?'}, {o.confirmation.pdf.totalUnits ?? '?'} units, {o.confirmation.pdf.currency ?? ''} {o.confirmation.pdf.totalAmount?.toLocaleString('en-AU', { minimumFractionDigits: 2 }) ?? '?'}.</div>}
            {isManager && <div><button type="button" className="btn secondary" disabled={busy} onClick={() => pdfInput.current?.click()}>{o.confirmationName ? 'Replace the PDF' : 'Add the PDF'}</button>
              <input ref={pdfInput} type="file" accept="application/pdf,.pdf" hidden onChange={e => { const f = e.target.files?.[0]; if (f) void addPdf(f); }} /></div>}
          </div>
          <div className="panel-title" style={{ marginTop: 18 }}>DEAR</div>
          <div style={{ fontSize: 14, display: 'grid', gap: 6 }}>
            {!o.poNumber && <div className="acct-region">Add the DEAR purchase order number once the PO is raised. Radar then reads it every hour.</div>}
            {o.poNumber && !o.po && <div className="acct-region">{o.poNumber} has not been read from DEAR yet. It is read every hour, or press Check DEAR now on the Liewood page.</div>}
            {o.po && !o.po.ok && <div className="save-msg err">{o.po.error} <span className="acct-region">({ago(o.po.fetchedAt)})</span></div>}
            {o.po?.ok && <div>{o.poNumber}{o.po.status ? `, ${o.po.status.toLowerCase()}` : ''}. <span className="acct-region">Read {ago(o.po.fetchedAt)}.</span></div>}
            {o.sharedWith.length > 0 && <div className="acct-region" style={{ fontSize: 13 }}>Also on this PO: {o.sharedWith.join(', ')}. Where they order the same product, the older order is counted first.</div>}
          </div>
        </div>
      </div>

      {o.invoices.length > 0 && (
        <div className="section">
          <div className="panel-title">Liewood invoices on {o.poNumber} (confirmed coming)</div>
          <div style={{ overflowX: 'auto', border: '1px solid var(--line)', borderRadius: 4, background: 'var(--panel)', maxWidth: 760 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr><th style={th}>Invoice</th><th style={th}>Date</th><th style={{ ...th, textAlign: 'right' }}>Units for this order</th><th style={{ ...th, textAlign: 'right' }}>Units on the invoice</th><th style={th}>Received</th></tr></thead>
              <tbody>{o.invoices.map((v, i) => (
                <tr key={i}><td style={td}>{v.number ?? '(no number)'}</td><td style={td}>{shortDay(v.date)}</td><td style={num}>{v.units.toLocaleString('en-AU')}</td><td style={num}>{v.allUnits.toLocaleString('en-AU')}</td>
                  <td style={td}>{v.received === null ? <span className="pill neutral">Not yet</span> : v.received >= v.allUnits ? <span className="pill teal">{v.received.toLocaleString('en-AU')} received{v.receivedOn ? ` ${shortDay(v.receivedOn)}` : ''}</span> : <span className="pill rust">{v.received.toLocaleString('en-AU')} of {v.allUnits.toLocaleString('en-AU')} received</span>}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      )}

      {(o.shortages.length > 0 || o.extraOnPo.length > 0) && (
        <div className="section">
          <div className="panel-title">To look at</div>
          <div className="card" style={{ maxWidth: 760 }}>
            {o.shortages.map((s, i) => <div key={i} style={{ fontSize: 14, padding: '3px 0' }}><b>{s.sku}</b>: {s.invoiced === 0 ? `${s.received} received but not on invoice ${s.invoice}` : `invoice ${s.invoice} billed ${s.invoiced}, ${s.received} received (${s.invoiced - s.received} short)`}</div>)}
            {o.extraOnPo.length > 0 && <div style={{ fontSize: 13, marginTop: 6 }} className="acct-region">On {o.poNumber} but on no uploaded Liewood order: {o.extraOnPo.slice(0, 20).map(x => `${x.sku} (${x.qty})`).join(', ')}{o.extraOnPo.length > 20 ? ` and ${o.extraOnPo.length - 20} more` : ''}.</div>}
          </div>
        </div>
      )}

      <div className="section">
        <div style={{ display: 'flex', gap: 14, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <div className="panel-title" style={{ flex: 1 }}>Lines ({stock.length})</div>
          <label style={{ fontSize: 13, display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={filter === 'issues'} onChange={e => setFilter(e.target.checked ? 'issues' : 'all')} /> Only lines to look at</label>
        </div>
        <div style={{ overflowX: 'auto', border: '1px solid var(--line)', borderRadius: 4, background: 'var(--panel)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={th}>SKU</th><th style={th}>Product</th><th style={th}>Size</th><th style={{ ...th, textAlign: 'right' }}>Ordered</th><th style={{ ...th, textAlign: 'right' }}>On PO</th><th style={{ ...th, textAlign: 'right' }}>Invoiced</th><th style={{ ...th, textAlign: 'right' }}>Received</th><th style={th}>Where it is</th></tr></thead>
            <tbody>
              {lines.map(l => (
                <tr key={l.lineNo}>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>{l.sku}{!l.inDear && <div className="acct-region" style={{ fontSize: 12 }}>not in DEAR yet</div>}</td>
                  <td style={td}>{l.styleName}{l.colour ? ` · ${l.colour}` : ''}</td>
                  <td style={td}>{l.size}</td>
                  <td style={num}>{l.qty}</td>
                  <td style={{ ...num, color: o.po?.ok && l.onPo < l.qty ? 'var(--rust)' : undefined }}>{o.po?.ok ? l.onPo : ''}</td>
                  <td style={num}>{o.po?.ok ? l.invoiced : ''}</td>
                  <td style={{ ...num, color: o.shortages.some(s => s.sku === l.sku) ? 'var(--rust)' : undefined }}>{o.po?.ok ? l.received : ''}</td>
                  <td style={td}>{o.po?.ok && l.stage ? <span className={`pill ${LINE_STAGE[l.stage].tone}`}>{LINE_STAGE[l.stage].label}</span> : <span className="acct-region">{o.poNumber ? 'not read yet' : 'no PO yet'}</span>}</td>
                </tr>
              ))}
              {filter === 'issues' && lines.length === 0 && <tr><td style={td} colSpan={8}>Nothing to look at.</td></tr>}
            </tbody>
            {filter === 'all' && <tfoot><tr><td style={{ ...td, fontWeight: 600 }} colSpan={3}>Total</td><td style={{ ...num, fontWeight: 600 }}>{tot('qty')}</td><td style={{ ...num, fontWeight: 600 }}>{o.po?.ok ? tot('onPo') : ''}</td><td style={{ ...num, fontWeight: 600 }}>{o.po?.ok ? tot('invoiced') : ''}</td><td style={{ ...num, fontWeight: 600 }}>{o.po?.ok ? tot('received') : ''}</td><td style={td} /></tr></tfoot>}
          </table>
        </div>
        {displays.length > 0 && <div className="acct-region" style={{ marginTop: 8, fontSize: 13 }}>Also on the order, not counted as stock: {displays.map(d => `${d.styleNo} ${d.styleName ?? ''} (${d.qty})`).join(', ')}.</div>}
        {o.sourceFile && <div className="acct-region" style={{ marginTop: 4, fontSize: 12.5 }}>From {o.sourceFile}. To update the lines, drop a newer Excel for {o.soNumber} on the Liewood page and choose to replace it.</div>}
      </div>
    </>
  );
}
