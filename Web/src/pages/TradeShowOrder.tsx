import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { apiGet, apiPatch, apiPost, apiPutText } from '../lib/api';
import { blobToBase64, shrinkImage } from '../lib/shrinkImage';
import BarcodeScanner, { scannerAvailable } from '../components/BarcodeScanner';
import { PaymentPicker, PaymentSummary, type Pay } from '../components/TsPayment';
import { useMe } from '../lib/useMe';
import TsLogFollowUps from '../components/TsLogFollowUps';
import { $, errMsg, shortDay, STAGE_TONE, type Incoming, type Order, type Product, type Stand, type Variant } from '../lib/tradeshow';
import { liveStock as stockFor, liveTotals, packProblem } from '../lib/tsLive';
import { applyOffers, freightFor, type Offer } from '../lib/tsOffers';
import { PAY_TONE } from '../lib/tsExtra';
import { FreightPanel, OffersPanel } from '../components/TsOrderOffers';

// A trade show order or quote. While it is being written: search products (stock free to sell, and what is coming when it is short),
// quantities, discount (managers), freight, card surcharge, totals. Confirm sends it to sales@ with the DEAR file. After that: the reference
// can be changed (or the customer's PO added) and it can be sent again; it shows where it is in DEAR; and it has its log and follow-ups.
const th: CSSProperties = { textAlign: 'left', fontSize: 13, color: 'var(--muted)', fontWeight: 500, padding: '7px 8px', borderBottom: '1px solid var(--line)', whiteSpace: 'nowrap' };
const td: CSSProperties = { padding: '8px', borderBottom: '1px solid var(--line)', fontSize: 14, verticalAlign: 'top' };
const num: CSSProperties = { ...td, textAlign: 'right', whiteSpace: 'nowrap' };
const field: CSSProperties = { padding: '7px 10px', border: '1px solid var(--line)', borderRadius: 3, font: 'inherit', fontSize: 15 };
type Line = { sku: string; name: string; brand: string | null; kind: 'normal' | 'bundle'; offerId: string | null; qty: number; comment: string; price: number; increment: number | null; available: number; pending: number; incoming: Incoming; eta: string | null };

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
  const [fr, setFr] = useState({ regionType: 'Metro', largeItems: false, pantone: false });
  const [frAuto, setFrAuto] = useState(true);   // freight is worked out by Radar until someone types it in
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const latest = useRef(0);
  const [pay, setPay] = useState<Pay>({ mode: 'later', method: 'bank', file: null });
  const payInit = useRef(false);   // the saved choice is read once; after that the page's own choice stands (saving the order reloads it)
  const [scanning, setScanning] = useState(false);
  const linesRef = useRef<Line[]>([]);
  const [lastSku, setLastSku] = useState<string | null>(null);   // the product just added: its other colours are suggested
  const [variants, setVariants] = useState<{ colour: string | null; others: Variant[] } | null>(null);
  const [stand, setStand] = useState<Set<string>>(new Set());   // the brands physically on this show's stand

  const show = useCallback((x: Order) => {
    setO(x); setLines(x.lines.filter(l => l.kind !== 'gift').map(l => ({ sku: l.sku, name: l.name, brand: l.brand, kind: l.kind === 'bundle' ? 'bundle' as const : 'normal' as const, offerId: l.offerId, qty: l.qty, comment: l.comment ?? '', price: l.price, increment: l.increment, available: l.stock?.available ?? 0, pending: l.stock?.pending ?? 0, incoming: l.stock?.incoming ?? null, eta: l.stock?.eta ?? null }))); setDirty(false);
    setDisc({ kind: x.discount?.kind ?? 'pct', value: x.discount ? String(x.discount.value) : '' }); setFreight(x.freight ? String(x.freight) : ''); setRef(x.dearReference); setPo(x.customerPo ?? ''); setNotes(x.notes ?? '');
    setFr({ regionType: x.freightInfo.regionType, largeItems: x.freightInfo.largeItems, pantone: x.freightInfo.pantone }); setFrAuto(!x.freightInfo.manual);
  }, []);
  const load = useCallback(() => { apiGet(`/tradeshow/orders/${id}`, { fresh: true }).then((d: { order: Order }) => { show(d.order); setErr(null); }).catch(e => setErr(errMsg(e))); }, [id, show]);
  useEffect(() => { load(); }, [load]);
  linesRef.current = lines;
  const showId = o?.show.id;
  useEffect(() => { if (showId) apiGet(`/tradeshow/shows/${showId}/stand`).then((d: Stand) => setStand(new Set(d.brands.map(b => b.toLowerCase())))).catch(() => {}); }, [showId]);
  useEffect(() => {
    if (!lastSku) { setVariants(null); return; }
    let live = true;
    apiGet(`/tradeshow/products/variants?sku=${encodeURIComponent(lastSku)}${showId ? `&showId=${showId}` : ''}`).then(d => { if (live) setVariants(d); }).catch(() => { if (live) setVariants(null); });
    return () => { live = false; };
  }, [lastSku, showId]);
  useEffect(() => { if (o && !payInit.current) { payInit.current = true; if (o.handoff?.mode === 'paid') setPay({ mode: 'paid', method: o.handoff.method ?? 'bank', file: null }); } }, [o]);
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
  const body = () => ({ lines: lines.map(l => ({ sku: l.sku, qty: l.qty, comment: l.comment, kind: l.kind, offerId: l.offerId })), freight: freight || 0, notes, customerPo: po, reference: ref,
    regionType: fr.regionType, largeItems: fr.largeItems, pantone: fr.pantone, freightEdited: !frAuto,
    ...(isManager ? { discount: disc.value ? { kind: disc.kind, value: disc.value } : null } : {}) });
  const save = (extra: object = {}) => act(() => apiPatch(`/tradeshow/orders/${id}`, { ...body(), ...extra }), 'Saved.');
  const payHere = !!o && o.kind === 'order' && o.handoffReady;   // the payment step shows on orders, once the database has the table for it
  async function confirm() {
    if (!o) return;
    const paidHere = payHere && pay.mode === 'paid';
    const r = await act(async () => {
      // the card surcharge must match how they paid, so the total (and the amount on the screenshot) is right
      await apiPatch(`/tradeshow/orders/${id}`, { ...body(), ...(paidHere ? { cardPayment: pay.method === 'card' } : {}) });
      if (payHere) {
        const proof = paidHere && pay.file ? { name: 'payment.jpg', mime: 'image/jpeg', data: await blobToBase64(await shrinkImage(pay.file)) } : undefined;
        await apiPutText(`/tradeshow/orders/${id}/handoff`, JSON.stringify({ mode: pay.mode, method: pay.method, proof }));
      }
      return apiPost(`/tradeshow/orders/${id}/confirm`, {});
    });
    if (r) setMsg(r.emailed ? { ok: true, text: `Confirmed and emailed to sales with the DEAR file${paidHere ? ' and the payment screenshot' : ''}. Reference: ${r.order.reference}` } : { ok: false, text: `Confirmed, but not emailed: ${r.reason}` });
  }
  function changePay(p: Pay) {
    setPay(p);
    if (o && p.mode === 'paid' && (p.method === 'card') !== o.cardPayment) void save({ cardPayment: p.method === 'card' });   // the total moves with the surcharge
  }
  /** One scan: the product with that barcode is added, or its quantity grows by one pack (or by 1). The scanner stays open for the next one. */
  async function onScan(code: string): Promise<{ ok: boolean; text: string }> {
    const d: { product: Product | null } = await apiGet(`/tradeshow/products/by-barcode?code=${encodeURIComponent(code)}`, { fresh: true });
    const p = d.product;
    if (!p) return { ok: false, text: `Barcode ${code} is not a product in Radar.` };
    if (p.price === null) return { ok: false, text: `${p.name}: no wholesale price, so it can't be added.` };
    const step = p.increment && p.increment > 1 ? p.increment : 1;
    const now = (linesRef.current.find(l => l.sku === p.sku && l.kind === 'normal')?.qty ?? 0) + step;
    add(p);
    return { ok: true, text: `Added: ${p.name} (+${step}), now ${now}${p.free < now ? `. Only ${Math.max(p.free, 0)} free in stock` : ''}` };
  }
  function add(p: Product) {
    setLines(ls => { const i = ls.findIndex(l => l.sku === p.sku && l.kind === 'normal'); const step = p.increment && p.increment > 1 ? p.increment : 1; return i >= 0 ? ls.map((l, j) => (j === i ? { ...l, qty: l.qty + step } : l)) : [...ls, { sku: p.sku, name: p.name, brand: p.brand, kind: 'normal' as const, offerId: null, qty: step, comment: '', price: p.price ?? 0, increment: p.increment, available: p.available, pending: p.pending, incoming: p.incoming, eta: p.eta }]; });
    setDirty(true); setQ(''); setHits([]); setLastSku(p.sku);
  }
  /** A bundle goes in as its own lines, marked with the offer, so the pack price works out however many packs are added. */
  async function addBundle(b: Offer, packs: number) {
    const got: Line[] = [];
    for (const it of b.items) {
      let p: Product | undefined;
      try { const d: { products: Product[] } = await apiGet(`/tradeshow/products?q=${encodeURIComponent(it.sku)}`); p = d.products.find(x => x.sku.toUpperCase() === it.sku.toUpperCase()); } catch { /* the offer's own details do */ }
      got.push({ sku: it.sku, name: p?.name ?? it.name ?? it.sku, brand: p?.brand ?? it.brand ?? null, kind: 'bundle', offerId: b.id, qty: it.qty * packs, comment: '', price: p?.price ?? it.price ?? 0, increment: p?.increment ?? null, available: p?.available ?? 0, pending: p?.pending ?? 0, incoming: p?.incoming ?? null, eta: p?.eta ?? null });
    }
    setLines(ls => { const next = [...ls]; for (const g of got) { const i = next.findIndex(l => l.kind === 'bundle' && l.offerId === b.id && l.sku.toUpperCase() === g.sku.toUpperCase()); if (i >= 0) next[i] = { ...next[i]!, qty: next[i]!.qty + g.qty }; else next.push(g); } return next; });
    setDirty(true);
  }

  if (err) return <><p><Link to="/trade-shows">← Trade Shows</Link></p><div className="save-msg err" role="alert">{err}</div></>;
  if (!o) return <div className="acct-region">Loading…</div>;
  const draft = o.status === 'draft', t = o.totals, mine = isManager || o.repId === me?.id;
  const liveDisc = isManager ? (disc.value && Number(disc.value) > 0 ? { kind: disc.kind, value: Number(disc.value) } : null) : o.discount;
  // offers: worked out on the page as products are added (the server works them again on Save); freight: the team's calculator, until someone types it in
  const A = draft ? applyOffers(lines.map(l => ({ sku: l.sku, name: l.name, brand: l.brand, qty: l.qty, price: l.price, comment: l.comment, kind: l.kind, offerId: l.offerId })), o.offers) : null;
  const fi = o.freightInfo, overseas = ['NZ', 'INTL'].includes(String(fi.state ?? '').toUpperCase());
  const base = liveTotals({ lines: A ? A.lines : [], discount: liveDisc, freight: 0, cardPayment: false, surchargePct: null, gstRate: o.gstRate });
  const calc = draft && frAuto && !overseas ? freightFor(fi.cfg, { state: fi.state, region: fr.regionType, orderIncGst: base.goodsAfter * (1 + o.gstRate), large: fr.largeItems, pantone: fr.pantone }) : null;
  const freightShown = calc && calc.amount !== null ? String(calc.amount) : freight;
  const live = liveTotals({ lines: A ? A.lines : [], discount: draft ? liveDisc : o.discount, freight: draft ? Number(freightShown) || 0 : o.freight, cardPayment: o.cardPayment, surchargePct: o.cardSurchargePct, gstRate: o.gstRate });
  const tt = draft ? live : t;   // while drafting, the page's own sums (the server works them again on Save); after that, the saved ones
  const liveStock = draft || o.stage === 'sent' || o.stage === 'in_dear_quote';   // once DEAR has the order, its own stock view is what counts
  return (
    <>
      <p style={{ margin: '0 0 6px' }}><Link to={`/trade-shows/${o.show.id}`}>← {o.show.name}</Link></p>
      <h1 style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>{o.kind === 'quote' ? 'Quote' : 'Order'} {o.number}
        <span className={`pill ${STAGE_TONE[o.stage] ?? 'neutral'}`}>{o.stageLabel}{o.dear ? ` ${o.dear.number}` : ''}</span></h1>
      {o.status === 'sent' && (
        <div style={{ marginBottom: 8, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className={`pill ${PAY_TONE[o.payment.status]}`}>{o.payment.label}</span>
          {o.payBy && <span style={{ fontSize: 13.5, color: o.payByOverdue && o.payment.status !== 'paid' ? 'var(--rust)' : undefined }}>Offers hold if paid by {shortDay(o.payBy)}{o.payByOverdue && o.payment.status !== 'paid' ? ' (passed)' : ''}</span>}
        </div>
      )}
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
          <div className="acct-region" style={{ fontSize: 12.5, marginTop: 6 }}>This is the reference on the DEAR order (show name and date). Radar's own number, {o.number}, is kept with it as {o.reference}. If the customer needs their own reference, add their PO.</div>
          {!draft && o.status === 'sent' && mine && (dirty || ref !== o.dearReference || po !== (o.customerPo ?? '')) && <button type="button" className="btn secondary" style={{ marginTop: 8 }} disabled={busy} onClick={() => save({ lines: undefined, discount: undefined, freight: undefined })}>Save changes</button>}
        </div>
      </div>

      <OffersPanel offers={o.offers} applied={A ? A.applied : o.applied} prompts={A ? A.prompts : o.prompts} payBy={A ? A.payBy : o.payBy} payByOverdue={o.payByOverdue} canEdit={draft && !!mine} onAddBundle={addBundle} />
      {draft && mine && (
        <div className="section" style={{ marginBottom: 14 }}>
          <div style={{ display: 'flex', gap: 8, maxWidth: 640, alignItems: 'center' }}>
            <input style={{ ...field, flex: 1, minWidth: 0, fontSize: 16 }} placeholder="Add a product: SKU, name, barcode or brand" value={q} onChange={e => setQ(e.target.value)} />
            {scannerAvailable() && <button type="button" className="btn secondary" onClick={() => setScanning(true)}>Scan barcode</button>}
          </div>
          {scanning && <BarcodeScanner onScan={onScan} onClose={() => setScanning(false)} />}
          {variants && variants.others.length > 0 && !q.trim() && (
            <div style={{ maxWidth: 640, marginTop: 8, padding: '8px 10px', border: '1px dashed var(--line)', borderRadius: 6 }}>
              <div className="acct-region" style={{ fontSize: 12.5, marginBottom: 6 }}>Other colours of this item <span style={{ opacity: 0.8 }}>(worked out from the product names)</span></div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {variants.others.map(v => {
                  const offer = o.offers.find(x => x.active && x.kind === 'pct' && x.pct && ((v.brand && x.brands.some(b => b.toLowerCase() === v.brand!.toLowerCase())) || x.skus.some(k => k.toUpperCase() === v.sku.toUpperCase())));
                  return (
                    <button key={v.sku} type="button" className="btn secondary" disabled={v.price === null} onClick={() => add(v)} title={`${v.name} (${v.sku})`} style={{ textAlign: 'left', padding: '6px 10px' }}>
                      <b style={{ textTransform: 'capitalize' }}>{v.colour}</b> <span style={{ fontSize: 12.5 }}>{v.price === null ? 'no price' : $(v.price)} · <span style={{ color: v.free > 0 ? 'var(--teal)' : 'var(--rust)' }}>{Math.max(v.free, 0)} free</span></span>
                      {v.onStand && <span className="pill teal" style={{ marginLeft: 6 }}>On the stand</span>}
                      {offer && <div style={{ fontSize: 12, color: 'var(--teal)' }}>{offer.name}: {offer.pct}% off</div>}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {hits.length > 0 && (
            <div style={{ border: '1px solid var(--line)', borderRadius: 6, maxWidth: 640, background: 'var(--panel)', marginTop: 4, maxHeight: 340, overflowY: 'auto' }}>
              {hits.map(p => (
                <button key={p.sku} type="button" onClick={() => add(p)} disabled={p.price === null} style={{ display: 'flex', gap: 10, width: '100%', textAlign: 'left', padding: '8px 12px', border: 0, borderBottom: '1px solid var(--line)', background: 'none', font: 'inherit', cursor: 'pointer', alignItems: 'center' }}>
                  <span style={{ flex: 1 }}><b>{p.name}</b>{p.brand && stand.has(p.brand.toLowerCase()) && <> <span className="pill teal">On the stand</span></>}<div className="acct-region" style={{ fontSize: 12.5 }}>{p.sku}{p.brand ? ` · ${p.brand}` : ''}{p.increment && p.increment > 1 ? ` · packs of ${p.increment}` : ''}</div></span>
                  <span style={{ textAlign: 'right', fontSize: 13, whiteSpace: 'nowrap' }}>{p.price === null ? <span style={{ color: 'var(--rust)' }}>no wholesale price</span> : $(p.price)}<div style={{ color: p.free > 0 ? 'var(--teal)' : 'var(--rust)', fontSize: 12.5 }}>{stockText(p)}</div></span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div style={{ overflowX: 'auto', border: '1px solid var(--line)', borderRadius: 4, background: 'var(--panel)' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr><th style={th}>Product</th><th style={{ ...th, textAlign: 'right' }}>Qty</th><th style={{ ...th, textAlign: 'right' }}>Price ex GST</th><th style={{ ...th, textAlign: 'right' }}>Off</th><th style={{ ...th, textAlign: 'right' }}>Line ex GST</th><th style={th}>Stock</th>{draft && mine && <th style={th} />}</tr></thead>
          <tbody>
            {(draft ? A!.lines : o.lines).map((l: any, i: number) => {
              const gift = l.kind === 'gift', edit = draft && mine && !gift, src = lines[i];
              const st = gift ? null : draft ? (src ? stockFor(src.qty, src.available, src.pending, src.incoming, src.eta) : null) : o.lines[i]?.stock ?? null;
              const offer = o.offers.find(x => x.id === l.offerId), pack = src ? packProblem(src.qty, src.increment) : null, off = tt.linePcts[i] ?? 0;
              return (
                <tr key={`${l.kind}-${l.sku}-${i}`} style={gift ? { background: 'var(--bg-soft, rgba(0,0,0,0.03))' } : undefined}>
                  <td style={td}><b>{l.name}</b><div className="acct-region" style={{ fontSize: 12.5 }}>{l.sku}{pack ? <span style={{ color: 'var(--amber)' }}> · {pack}</span> : ''}{gift ? ` · free with ${offer?.name ?? 'an offer'}` : l.kind === 'bundle' ? ` · pack: ${offer?.name ?? 'bundle'}` : ''}</div>
                    {edit && src ? <input style={{ ...field, fontSize: 13, padding: '3px 6px', marginTop: 4, width: '100%' }} placeholder="Comment for DEAR (optional)" value={src.comment} onChange={e => { setLines(ls => ls.map((x, j) => (j === i ? { ...x, comment: e.target.value } : x))); setDirty(true); }} /> : !gift && l.comment && <div style={{ fontSize: 12.5 }}>{l.comment}</div>}</td>
                  <td style={num}>{edit && src ? <input inputMode="numeric" style={{ ...field, width: 70, textAlign: 'right' }} value={src.qty} onChange={e => { const n = Math.max(0, Math.floor(Number(e.target.value) || 0)); setLines(ls => ls.map((x, j) => (j === i ? { ...x, qty: n } : x))); setDirty(true); }} /> : l.qty}</td>
                  <td style={num}>{$(l.price)}</td>
                  <td style={num}>{off > 0 ? `${off}%` : ''}</td>
                  <td style={num}>{$(tt.lineTotals[i] ?? 0)}</td>
                  <td style={{ ...td, fontSize: 13, color: liveStock && st && st.backorder > 0 ? 'var(--rust)' : undefined }}>{gift ? '' : st && liveStock ? st.note : !liveStock ? <span className="acct-region">In DEAR</span> : ''}</td>
                  {draft && mine && <td style={td}>{edit && <button type="button" className="link-btn" onClick={() => { setLines(ls => ls.filter((_, j) => j !== i)); setDirty(true); }}>Remove</button>}</td>}
                </tr>
              );
            })}
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
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><span style={{ fontSize: 13, width: 70 }}>Freight</span><input inputMode="decimal" style={{ ...field, width: 120 }} value={freightShown} placeholder="0.00" disabled={!draft || !mine} onChange={e => { setFreight(e.target.value); setFrAuto(false); setDirty(true); }} /><span className="acct-region" style={{ fontSize: 12.5 }}>ex GST</span></div>
            {draft && mine && <FreightPanel state={fi.state} regionType={fr.regionType} largeItems={fr.largeItems} pantone={fr.pantone} manual={!frAuto} note={calc ? calc.note : fi.note} cfg={fi.cfg} canEdit={!busy}
              onChange={p => { setFr(f => ({ ...f, ...p })); setDirty(true); }}
              onReset={() => { setFrAuto(true); act(() => apiPatch(`/tradeshow/orders/${id}`, { ...body(), freightEdited: false, freightReset: true }), 'Freight worked out again.'); }}
              onQuoteNz={() => act(() => apiPatch(`/tradeshow/orders/${id}`, { ...body(), freightEdited: false, freightReset: true, freightNz: true }), 'Australia Post price added.')} />}
            <label style={{ fontSize: 14, display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={o.cardPayment} disabled={!draft || !mine || busy} onChange={e => save({ cardPayment: e.target.checked })} /> Paying by card{o.cardSurchargePct ? ` (${o.cardSurchargePct}% surcharge)` : ' (no surcharge set for this show)'}</label>
            <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>Notes for sales<textarea style={{ ...field, minHeight: 54 }} value={notes} disabled={!mine || o.status === 'cancelled'} onChange={e => { setNotes(e.target.value); setDirty(true); }} /></label>
          </div>
        </div>
        {draft && mine && payHere && <PaymentPicker pay={pay} onChange={changePay} total={tt.total} savedProof={!!o.handoff?.hasProof} surchargePct={o.cardSurchargePct} disabled={busy} />}
        <div className="card" style={{ marginBottom: 0 }}>
          <div className="panel-title">Total</div>
          <div className="kv"><span>Goods (wholesale ex GST)</span><span className="num">{$(tt.goods)}</span></div>
          {tt.offerDiscount > 0 && <div className="kv"><span>Offers</span><span className="num">-{$(tt.offerDiscount)}</span></div>}
          {tt.linePct > 0 && <div className="kv"><span>Discount {tt.linePct}%</span><span className="num">-{$(Math.round((tt.discount - tt.offerDiscount) * 100) / 100)}</span></div>}
          <div className="kv"><span>Freight</span><span className="num">{$(tt.freight)}</span></div>
          {tt.surcharge > 0 && <div className="kv"><span>Card surcharge {tt.surchargePct}%</span><span className="num">{$(tt.surcharge)}</span></div>}
          <div className="kv"><span>Total ex GST</span><span className="num">{$(tt.exGst)}</span></div>
          <div className="kv"><span>GST{o.gstRate === 0 ? ' (none: overseas)' : ''}</span><span className="num">{$(tt.gst)}</span></div>
          <div className="kv" style={{ fontWeight: 600, fontSize: 16 }}><span>Total inc GST</span><span className="num">{$(tt.total)}</span></div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', margin: '16px 0' }}>
        {draft && mine && <>
          <button type="button" className="btn secondary" disabled={busy} onClick={() => save()}>{busy ? 'Saving…' : 'Save'}</button>
          <select style={field} value={o.kind} disabled={busy} onChange={e => save({ kind: e.target.value })}><option value="order">Order</option><option value="quote">Quote</option></select>
          <button type="button" className="btn" disabled={busy || !lines.length || lines.some(l => l.qty < 1) || (payHere && pay.mode === 'paid' && !pay.file && !o.handoff?.hasProof)} onClick={confirm}>Confirm and send to sales</button>
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

      {o.status === 'sent' && o.handoff && <PaymentSummary orderId={o.id} h={o.handoff} onChange={load} />}
      {o.status !== 'draft' && (
        <div className="section" style={{ marginTop: 18 }}>
          <TsLogFollowUps target={{ orderId: o.id }} log={o.log} followUps={o.followUps} closed={o.followUpsClosed} onChange={load}
            closedNote={o.stage === 'cancelled' ? 'Cancelled: no more follow-ups.' : o.kind === 'quote' ? 'This quote is now a confirmed DEAR order: no more follow-ups.' : 'Paid in DEAR: no more follow-ups.'} />
        </div>
      )}
    </>
  );
}
