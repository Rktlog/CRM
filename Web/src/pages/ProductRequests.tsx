import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { apiGet, apiPost } from '../lib/api';
import { ago, requestsChanged, shortDate, STATUS_LABEL, STATUS_TONE, type RequestItem } from '../lib/productRequests';

// Product Requests: the sales team asks for a product, either one we already sell (to be ordered or topped up) or a new one. The ordering team sees every request
// in the Special requests section of Order Forecast & Procurement, with the stock and what is already on order, and answers here with a status and a note.
type Found = { sku: string; name: string; brand: string | null; available: number; onOrder: number };
const field: CSSProperties = { width: '100%', maxWidth: 420, padding: '6px 9px', border: '1px solid var(--line)', borderRadius: 3, fontSize: 14, font: 'inherit' };
const label: CSSProperties = { display: 'grid', gap: 4, fontSize: 13 };
const todayLocal = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

export default function ProductRequests() {
  const [kind, setKind] = useState<'existing' | 'new'>('existing');
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Found[]>([]);
  const [chosen, setChosen] = useState<Found | null>(null);
  const [name, setName] = useState('');
  const [brand, setBrand] = useState('');
  const [supplier, setSupplier] = useState('');
  const [link, setLink] = useState('');
  const [qty, setQty] = useState('');
  const [customer, setCustomer] = useState('');
  const [neededBy, setNeededBy] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [mine, setMine] = useState<RequestItem[] | null>(null);
  const [mineErr, setMineErr] = useState<string | null>(null);
  const working = useRef(false);   // a second click, or Enter pressed twice, while it is working does nothing
  const latest = useRef(0);

  const loadMine = useCallback(() => {
    apiGet('/product-requests/mine', { fresh: true }).then((d: { items: RequestItem[] }) => { setMine(d.items); setMineErr(null); }).catch((e: Error) => setMineErr(e.message));
  }, []);
  useEffect(() => { loadMine(); }, [loadMine]);

  useEffect(() => {
    const term = q.trim();
    if (kind !== 'existing' || chosen || term.length < 2) { setFound([]); return; }
    const mineNow = ++latest.current;
    const t = setTimeout(() => {
      apiGet(`/products/search?q=${encodeURIComponent(term)}`)
        .then((d: { results: Found[] }) => { if (latest.current === mineNow) setFound((d.results ?? []).slice(0, 8)); })
        .catch(() => { if (latest.current === mineNow) setFound([]); });
    }, 300);
    return () => clearTimeout(t);
  }, [q, kind, chosen]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (working.current) return;
    setMsg(null);
    if (kind === 'existing' && !chosen) { setMsg({ ok: false, text: 'Choose the product from the list first.' }); return; }
    if (kind === 'new' && name.trim().length < 2) { setMsg({ ok: false, text: 'Say what the new product is.' }); return; }
    working.current = true; setBusy(true);
    try {
      const r = await apiPost('/product-requests', {
        kind, sku: kind === 'existing' ? chosen?.sku : undefined, itemName: kind === 'new' ? name : undefined, brand: kind === 'new' ? brand : undefined,
        supplier: kind === 'new' ? supplier : undefined, link: kind === 'new' ? link : undefined, qty: qty ? Number(qty) : null, customer, neededBy: neededBy || null, notes,
      });
      setMsg({ ok: true, text: r.duplicate ? 'You sent this a moment ago, so it was not sent twice.' : 'Request sent. The ordering team will see it in the Special requests section of Order Forecast & Procurement.' });
      setQ(''); setFound([]); setChosen(null); setName(''); setBrand(''); setSupplier(''); setLink(''); setQty(''); setCustomer(''); setNeededBy(''); setNotes('');
      requestsChanged(); loadMine();
    } catch (err) { setMsg({ ok: false, text: (err as Error).message }); }
    finally { working.current = false; setBusy(false); }
  }

  async function cancel(id: string) {
    try { await apiPost(`/product-requests/${id}/cancel`, {}); requestsChanged(); loadMine(); }
    catch (err) { setMineErr((err as Error).message); }
  }

  return (
    <>
      <h1>Product Requests</h1>
      <div className="acct-region" style={{ marginBottom: 14, maxWidth: 640 }}>
        Ask for a product we already sell (to order or top up) or a new one. The ordering team sees it when they are ordering and will answer here.
      </div>

      <div className="section">
        <div className="panel-title">Make a request</div>
        <form onSubmit={submit} noValidate style={{ display: 'grid', gap: 12, maxWidth: 440 }}>
          <div role="radiogroup" aria-label="What are you asking for" style={{ display: 'flex', gap: 18, fontSize: 14 }}>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="radio" name="kind" checked={kind === 'existing'} onChange={() => setKind('existing')} /> A product we already sell</label>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="radio" name="kind" checked={kind === 'new'} onChange={() => setKind('new')} /> A new product</label>
          </div>

          {kind === 'existing' ? (
            chosen ? (
              <div style={{ border: '1px solid var(--line)', borderRadius: 6, padding: '8px 12px', background: 'var(--panel)' }}>
                <b>{chosen.name}</b> <span className="acct-region">{chosen.sku}{chosen.brand ? ` · ${chosen.brand}` : ''}</span>
                <div className="acct-region">{chosen.available.toLocaleString('en-AU')} available, {chosen.onOrder.toLocaleString('en-AU')} on order</div>
                <button type="button" className="link-btn" onClick={() => { setChosen(null); setQ(''); }}>Choose a different product</button>
              </div>
            ) : (
              <div>
                <label style={label}>Which product? (type its SKU or name)
                  <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search SKU or product name" autoComplete="off" style={field} />
                </label>
                {found.length > 0 && (
                  <div role="listbox" aria-label="Matching products" style={{ border: '1px solid var(--line)', borderRadius: 6, marginTop: 4, maxWidth: 420, background: 'var(--panel)' }}>
                    {found.map(f => (
                      <button key={f.sku} type="button" role="option" aria-selected={false} onClick={() => setChosen(f)}
                        style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 10px', border: 'none', borderBottom: '1px solid var(--line)', background: 'none', cursor: 'pointer', font: 'inherit', fontSize: 13 }}>
                        <b>{f.name}</b> <span className="acct-region">{f.sku}{f.brand ? ` · ${f.brand}` : ''}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )
          ) : (
            <>
              <label style={label}>What is it? <input value={name} onChange={e => setName(e.target.value)} maxLength={200} style={field} /></label>
              <label style={label}>Brand (if you know it) <input value={brand} onChange={e => setBrand(e.target.value)} maxLength={100} style={field} /></label>
              <label style={label}>Supplier (if you know it) <input value={supplier} onChange={e => setSupplier(e.target.value)} maxLength={120} style={field} /></label>
              <label style={label}>Link to the product (if there is one) <input value={link} onChange={e => setLink(e.target.value)} placeholder="https://" maxLength={500} style={field} /></label>
            </>
          )}

          <label style={label}>How many do you want? (roughly) <input type="number" min={1} max={100000} step={1} value={qty} onChange={e => setQty(e.target.value)} style={{ ...field, maxWidth: 160 }} /></label>
          <label style={label}>Which store is it for? (if it is for one) <input value={customer} onChange={e => setCustomer(e.target.value)} maxLength={160} style={field} /></label>
          <label style={label}>Needed by (if there is a date) <input type="date" min={todayLocal()} value={neededBy} onChange={e => setNeededBy(e.target.value)} style={{ ...field, maxWidth: 200 }} /></label>
          <label style={label}>Anything else the ordering team should know <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3} maxLength={1000} style={field} /></label>
          <div><button className="btn" type="submit" disabled={busy}>{busy ? 'Sending…' : 'Send request'}</button></div>
          {msg && <div className={msg.ok ? 'save-msg ok' : 'save-msg err'} role={msg.ok ? 'status' : 'alert'}>{msg.text}</div>}
        </form>
      </div>

      <div className="section">
        <div className="panel-title">My requests</div>
        {mineErr && <div className="save-msg err" role="alert">{mineErr}</div>}
        {!mineErr && mine === null && <div className="acct-region">Loading…</div>}
        {mine && mine.length === 0 && <div className="acct-region">You have not asked for anything yet.</div>}
        <div style={{ display: 'grid', gap: 8, maxWidth: 760 }}>
          {(mine ?? []).map(i => (
            <div key={i.id} style={{ border: '1px solid var(--line)', borderRadius: 6, padding: '8px 12px', background: 'var(--panel)', display: 'grid', gap: 4 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <b>{i.itemName}</b>
                {i.kind === 'new' && <span className="pill neutral">New item</span>}
                <span className={`pill ${STATUS_TONE[i.status]}`}>{STATUS_LABEL[i.status]}</span>
                <span className="acct-region">{i.sku ? `${i.sku} · ` : ''}asked {ago(i.createdAt)}</span>
              </div>
              <div style={{ fontSize: 13 }}>
                {i.qty ? `${i.qty.toLocaleString('en-AU')} wanted` : 'quantity not given'}{i.customer ? ` · for ${i.customer}` : ''}{i.neededBy ? ` · needed by ${shortDate(i.neededBy)}` : ''}
              </div>
              {i.decisionNote && <div style={{ fontSize: 13 }}><b>Ordering team:</b> {i.decisionNote}</div>}
              {i.supplierAnswer && <div style={{ fontSize: 13 }}><b>Supplier said:</b> {i.supplierAnswer}{i.supplierAnswerAt ? <span className="acct-region"> ({new Date(i.supplierAnswerAt).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })})</span> : null}</div>}
              {(i.status === 'requested' || i.status === 'seen') && <div><button type="button" className="link-btn" onClick={() => cancel(i.id)}>Cancel this request</button></div>}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
