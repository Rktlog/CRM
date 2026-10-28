import { ChangeEvent, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiGet, apiPost, apiDelete, apiPostText } from '../lib/api';
import { fmtDateWithYear } from '../lib/types';
import DictationTextarea from '../components/DictationTextarea';
import { useAuth } from '../context/AuthContext';

type Item = { productName: string; sku: string | null; available: number | null; quantity: number; price: number; total: number };
type Earlier = { quoteId: string; number: string; status: string };   // an order or quote the current one took over from
type Standing = { quoteId: string; number: string; date: string; itemsOrdered: number; otherItems: number; status: string; total: number; replaces: Earlier[] };
type Log = { id: string; method: string; note: string; at: string; by: string | null; mine: boolean };
type Cart = {
  id: string;
  abandonedAt: string;
  contact: string;
  email: string;
  account: { id: string; name: string; rep: string | null; region: string | null; phone: string | null } | null;   // region: the customer's state
  itemCount: number;
  units: number;
  value: number;
  status: 'open' | 'ordered';
  orderedSince: Standing | null;      // the order as it stands now: a voided one is replaced by the new one
  quotePrepared: Standing | null;     // no order yet, but a quote has been prepared
  cancelled: Earlier[];               // orders since the cart that were voided and not replaced
  logs: Log[];
  items: Item[];
};
type Data = {
  summary: { openCarts: number; openValue: number; orderedCarts: number; notInCrm: number };
  lastImportedAt: string | null;
  logsAvailable: boolean;
  carts: Cart[];
};

const COLS = '1fr 2.2fr 0.6fr 0.7fr 0.9fr 1.3fr';
const money = (n: number) => '$' + n.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qty = (n: number) => n.toLocaleString('en-AU', { maximumFractionDigits: 2 });
const STATUS_WORDS: Record<string, string> = { VOIDED: 'voided', CREDITED: 'credited', DRAFT: 'draft quote', ESTIMATING: 'quote being prepared', ESTIMATED: 'quote', ORDERING: 'being ordered', ORDERED: 'ordered', BACKORDERED: 'backordered', SHIPPING: 'shipping', SHIPPED: 'shipped', COMPLETED: 'completed' };
const statusWord = (s: string) => STATUS_WORDS[s.toUpperCase()] ?? s.toLowerCase();
const METHODS: { key: string; label: string }[] = [{ key: 'note', label: 'Note' }, { key: 'called', label: 'Called' }, { key: 'emailed', label: 'Emailed' }, { key: 'left_message', label: 'Left a message' }];
const methodLabel = (k: string) => METHODS.find(m => m.key === k)?.label ?? 'Note';
const when = (d: string) => new Date(d).toLocaleString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });

export default function AbandonedCarts() {
  const [status, setStatus] = useState<'open' | 'ordered' | 'all'>('open');
  const [days, setDays] = useState('90');
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  async function load() {
    setError(null);
    try {
      const d: Data = await apiGet(`/abandoned-carts?status=${status}&days=${days}`);
      // Tolerates an older API that does not send the newer fields yet.
      setData({
        ...d, logsAvailable: d.logsAvailable ?? false,
        carts: d.carts.map(c => ({
          ...c, logs: c.logs ?? [], quotePrepared: c.quotePrepared ?? null, cancelled: c.cancelled ?? [],
          orderedSince: c.orderedSince ? { ...c.orderedSince, otherItems: c.orderedSince.otherItems ?? 0, status: c.orderedSince.status ?? '', total: c.orderedSince.total ?? 0, replaces: c.orderedSince.replaces ?? [] } : null,
        })),
      });
    } catch (e: any) {
      setError(e.message);
    }
  }

  useEffect(() => { load(); }, [status, days]);

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setImporting(true);
    setImportMsg(null);
    try {
      const r = await apiPostText('/abandoned-carts/import', await file.text());
      setImportMsg(`Imported: ${r.newLines.toLocaleString()} new cart lines${r.alreadyHad ? `, ${r.alreadyHad.toLocaleString()} already here` : ''}.`);
      await load();
    } catch (err: any) {
      setImportMsg(`Import failed: ${err.message}`);
    } finally {
      setImporting(false);
    }
  }

  return (
    <>
      <div className="carts-head">
        <h1>Abandoned carts</h1>
        <div>
          <input ref={fileInput} type="file" accept=".csv,text/csv" onChange={onFile} hidden />
          <button className="btn" onClick={() => fileInput.current?.click()} disabled={importing}>
            {importing ? 'Importing…' : 'Import from Cin7'}
          </button>
        </div>
      </div>

      <div className="stock-as-of">
        {importMsg ?? (data?.lastImportedAt
          ? `Last imported ${when(data.lastImportedAt)}. Export from Cin7: Integrations → Cin7 Core B2B → your portal → Abandoned Carts → Export.`
          : 'No carts yet. Export from Cin7 (Integrations → Cin7 Core B2B → your portal → Abandoned Carts → Export), then import the file here.')}
      </div>

      {data && (
        <div className="ledger-stats">
          <div className="ledger-stat"><div className="label">Open carts</div><div className="val">{data.summary.openCarts}</div></div>
          <div className="ledger-stat"><div className="label">Open cart value</div><div className="val">{money(data.summary.openValue)}</div></div>
          <div className="ledger-stat"><div className="label">Ordered since</div><div className="val">{data.summary.orderedCarts}</div></div>
          {data.summary.notInCrm > 0 && (
            <div className="ledger-stat"><div className="label">Not in the CRM</div><div className="val">{data.summary.notInCrm}</div></div>
          )}
        </div>
      )}

      <div className="carts-filters">
        <div className="seg">
          {(['open', 'ordered', 'all'] as const).map(s => (
            <button key={s} className={status === s ? 'on' : ''} onClick={() => setStatus(s)}>
              {s === 'open' ? 'Open' : s === 'ordered' ? 'Ordered since' : 'All'}
            </button>
          ))}
        </div>
        <select value={days} onChange={e => setDays(e.target.value)}>
          <option value="30">Last 30 days</option>
          <option value="90">Last 90 days</option>
          <option value="365">Last 12 months</option>
          <option value="all">All time</option>
        </select>
      </div>

      {error && <div className="empty-state">Couldn't load carts: {error}</div>}
      {!error && !data && <div className="empty-state">Loading…</div>}
      {!error && data && !data.carts.length && <div className="empty-state">No carts here.</div>}

      {!error && data && data.carts.length > 0 && (
        <div className="manifest">
          <div className="m-row head" style={{ gridTemplateColumns: COLS }}>
            <div>Abandoned</div><div>Customer</div><div>State</div><div className="num">Items</div><div className="num">Value</div><div>Status</div>
          </div>
          {data.carts.map(c => {
            const open = openId === c.id;
            return (
              <div key={c.id}>
                <div
                  className={'m-row' + (open ? ' open product-row' : '')}
                  style={{ gridTemplateColumns: COLS }}
                  onClick={() => setOpenId(open ? null : c.id)}
                  aria-expanded={open}
                >
                  <div>{fmtDateWithYear(c.abandonedAt)}</div>
                  <div>
                    <div className="acct-name">{c.account?.name ?? c.contact}</div>
                    <div className="acct-region">
                      {c.account ? (c.account.rep ? `Rep: ${c.account.rep}` : c.email) : `${c.email}, not in the CRM`}
                    </div>
                  </div>
                  <div>{c.account?.region ?? <span className="acct-region" title="Not matched to a customer in the CRM, so no state">-</span>}</div>
                  <div className="num">{c.itemCount}</div>
                  <div className="num">{money(c.value)}</div>
                  <div>
                    {c.status === 'ordered'
                      ? <span className="pill teal">Ordered {fmtDateWithYear(c.orderedSince!.date)}</span>
                      : <span className="pill amber">Open</span>}
                    {c.status === 'ordered' && <div className="acct-region">#{c.orderedSince!.number}{c.orderedSince!.replaces.length > 0 ? ' (replaces an earlier one)' : ''}</div>}
                    {c.status === 'open' && c.quotePrepared && <div className="acct-region">Quote #{c.quotePrepared.number} prepared</div>}
                    {c.logs.length > 0 && <div className="acct-region" title={c.logs[0].note}>{c.logs.length} {c.logs.length === 1 ? 'note' : 'notes'}, last {fmtDateWithYear(c.logs[0].at)}</div>}
                  </div>
                </div>
                {open && <CartDetail cart={c} logsAvailable={data.logsAvailable} onLogs={logs => setData(d => d && ({ ...d, carts: d.carts.map(x => (x.id === c.id ? { ...x, logs } : x)) }))} />}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

// Where the customer has got to since the cart: the order as it stands now, what it replaced, or a quote not yet an order.
function SinceThen({ c }: { c: Cart }) {
  const earlier = (e: Earlier) => <span key={e.quoteId}><Link to={`/orders/${e.quoteId}`} className="order-link">#{e.number}</Link> ({statusWord(e.status)})</span>;
  const list = (items: Earlier[]) => items.map((e, i) => <span key={e.quoteId}>{i > 0 ? ', ' : ''}{earlier(e)}</span>);
  const items = (o: Standing) => (
    <div className="pd-sub">
      {o.itemsOrdered} of {c.itemCount} cart {c.itemCount === 1 ? 'item' : 'items'} on {o.status && isQuote(o.status) ? 'that quote' : 'that order'}
      {o.otherItems > 0 ? `, plus ${o.otherItems} other ${o.otherItems === 1 ? 'item' : 'items'} that ${o.otherItems === 1 ? 'was' : 'were'} not in the cart` : ''}
    </div>
  );
  if (c.orderedSince) {
    const o = c.orderedSince;
    return (
      <>
        <div>
          Ordered <Link to={`/orders/${o.quoteId}`} className="order-link">#{o.number}</Link> on {fmtDateWithYear(o.date)}{' '}
          <span className="pill neutral">{statusWord(o.status)}</span> {money(o.total)}
        </div>
        {items(o)}
        {o.replaces.length > 0 && <div className="pd-sub">Replaces {list(o.replaces)}: the order was changed, and this is the new one.</div>}
      </>
    );
  }
  if (c.quotePrepared) {
    const q = c.quotePrepared;
    return (
      <>
        <div>
          Quote <Link to={`/orders/${q.quoteId}`} className="order-link">#{q.number}</Link> prepared on {fmtDateWithYear(q.date)}{' '}
          <span className="pill amber">{statusWord(q.status)}</span> {money(q.total)}
        </div>
        {items(q)}
        <div className="pd-sub">Not confirmed as an order yet.{q.replaces.length > 0 ? <> Replaces {list(q.replaces)}.</> : null}</div>
      </>
    );
  }
  return (
    <>
      {c.cancelled.length > 0 && <div className="pd-sub" style={{ marginBottom: 4 }}>{list(c.cancelled)} {c.cancelled.length === 1 ? 'was' : 'were'} cancelled and nothing has replaced {c.cancelled.length === 1 ? 'it' : 'them'}.</div>}
      <div className="pd-sub">No order since. Worth a follow-up call.</div>
    </>
  );
}
const isQuote = (status: string) => ['DRAFT', 'ESTIMATING', 'ESTIMATED', 'ORDERING'].includes(status.toUpperCase());

// Notes, calls and emails on a cart, newest first, with a box to add one.
function CartLog({ cart: c, available, onLogs }: { cart: Cart; available: boolean; onLogs: (logs: Log[]) => void }) {
  const { role } = useAuth();
  const canDeleteAny = role === 'manager';   // anyone can delete their own entries; a manager can delete any
  const [note, setNote] = useState('');
  const [method, setMethod] = useState('note');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    if (!note.trim() || busy) return;
    setBusy(true); setError(null);
    try {
      const l: Log = await apiPost('/abandoned-carts/log', { cart: c.id, note, method });
      onLogs([l, ...c.logs]); setNote(''); setMethod('note');
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }
  async function remove(l: Log) {
    if (!window.confirm('Delete this entry?')) return;
    try { await apiDelete(`/abandoned-carts/log/${l.id}`); onLogs(c.logs.filter(x => x.id !== l.id)); }
    catch (e: any) { setError(e.message); }
  }

  return (
    <div className="pd-section">
      <div className="pd-section-title">Log ({c.logs.length})</div>
      {!available && <div className="pd-sub">Logging is not set up yet. Ask for abandoned-cart-logs.sql to be run in the database.</div>}
      {available && (
        <div style={{ marginBottom: 10, maxWidth: 640 }}>
          <DictationTextarea value={note} onChange={setNote} rows={2} maxLength={2000} placeholder="What happened? For example: rang Ann, she will reorder next week" aria-label="Add to the log" />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
            <select value={method} onChange={e => setMethod(e.target.value)} aria-label="How you got in touch">
              {METHODS.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
            </select>
            <button type="button" className="btn" disabled={busy || !note.trim()} onClick={add}>{busy ? 'Adding…' : 'Add to log'}</button>
            {error && <span className="save-msg err">{error}</span>}
          </div>
        </div>
      )}
      {c.logs.length === 0 && available && <div className="pd-sub">Nothing logged on this cart yet.</div>}
      {c.logs.map(l => (
        <div key={l.id} style={{ padding: '6px 0', borderTop: '1px solid var(--line)' }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <span className="pill neutral">{methodLabel(l.method)}</span>
            <span className="acct-region">{l.by ?? 'Someone'}, {when(l.at)}</span>
            {(l.mine || canDeleteAny) && <button type="button" className="link-btn" style={{ fontSize: 12 }} onClick={() => remove(l)}>Delete</button>}
          </div>
          <div style={{ whiteSpace: 'pre-wrap', marginTop: 2 }}>{l.note}</div>
        </div>
      ))}
    </div>
  );
}

function CartDetail({ cart: c, logsAvailable, onLogs }: { cart: Cart; logsAvailable: boolean; onLogs: (logs: Log[]) => void }) {
  return (
    <div className="pd">
      <div className="pd-row">
        <div className="pd-box">
          <div className="pd-box-title">Customer</div>
          {c.account
            ? <Link to={`/accounts/${c.account.id}`} className="acct-name order-link">{c.account.name}</Link>
            : <div className="acct-name">{c.contact}</div>}
          <div className="pd-sub"><a href={`mailto:${c.email}`} className="order-link">{c.email}</a></div>
          {c.account?.phone && <div className="pd-sub"><a href={`tel:${c.account.phone.replace(/[^\d+]/g, '')}`} className="order-link">{c.account.phone}</a></div>}
          <div className="pd-sub">Abandoned {when(c.abandonedAt)}</div>
          {!c.account && <div className="pd-sub" style={{ marginTop: 6 }}>Not matched to a CRM account yet.</div>}
        </div>
        <div className="pd-box">
          <div className="pd-box-title">Since then</div>
          <SinceThen c={c} />
        </div>
      </div>

      <CartLog cart={c} available={logsAvailable} onLogs={onLogs} />

      <div className="pd-section">
        <div className="pd-section-title">Cart ({c.itemCount} items, {qty(c.units)} units, {money(c.value)})</div>
        <div className="manifest" style={{ border: 'none' }}>
          <div className="m-row head" style={{ gridTemplateColumns: '2.4fr 1fr 0.6fr 0.8fr 0.8fr 0.9fr', padding: '8px 0' }}>
            <div>Product</div><div>SKU</div><div className="num">Qty</div><div className="num">Price</div><div className="num">Total</div><div className="num">Available now</div>
          </div>
          {c.items.map((i, idx) => (
            <div className="m-row" key={idx} style={{ gridTemplateColumns: '2.4fr 1fr 0.6fr 0.8fr 0.8fr 0.9fr', padding: '8px 0', cursor: 'default' }}>
              <div>{i.productName}</div>
              <div className="num">{i.sku ?? '—'}</div>
              <div className="num">{qty(i.quantity)}</div>
              <div className="num">{money(i.price)}</div>
              <div className="num">{money(i.total)}</div>
              <div className="num">
                {i.available === null ? '—' : (
                  <span className={'pill num ' + (i.available <= 0 ? 'rust' : i.available < i.quantity ? 'amber' : 'teal')}>{qty(i.available)}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}