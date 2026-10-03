import { ChangeEvent, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiGet, apiPostText } from '../lib/api';
import { fmtDateWithYear } from '../lib/types';

type Item = { productName: string; sku: string | null; available: number | null; quantity: number; price: number; total: number };
type Cart = {
  id: string;
  abandonedAt: string;
  contact: string;
  email: string;
  account: { id: string; name: string; rep: string | null } | null;
  itemCount: number;
  units: number;
  value: number;
  status: 'open' | 'ordered';
  orderedSince: { quoteId: string; number: string; date: string; itemsOrdered: number } | null;
  items: Item[];
};
type Data = {
  summary: { openCarts: number; openValue: number; orderedCarts: number; notInCrm: number };
  lastImportedAt: string | null;
  carts: Cart[];
};

const COLS = '1fr 2.2fr 0.7fr 0.9fr 1.3fr';
const money = (n: number) => '$' + n.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qty = (n: number) => n.toLocaleString('en-AU', { maximumFractionDigits: 2 });
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
      setData(await apiGet(`/abandoned-carts?status=${status}&days=${days}`));
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
            <div>Abandoned</div><div>Customer</div><div className="num">Items</div><div className="num">Value</div><div>Status</div>
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
                  <div className="num">{c.itemCount}</div>
                  <div className="num">{money(c.value)}</div>
                  <div>
                    {c.status === 'ordered'
                      ? <span className="pill teal">Ordered {fmtDateWithYear(c.orderedSince!.date)}</span>
                      : <span className="pill amber">Open</span>}
                  </div>
                </div>
                {open && <CartDetail cart={c} />}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

function CartDetail({ cart: c }: { cart: Cart }) {
  return (
    <div className="pd">
      <div className="pd-row">
        <div className="pd-box">
          <div className="pd-box-title">Customer</div>
          {c.account
            ? <Link to={`/accounts/${c.account.id}`} className="acct-name order-link">{c.account.name}</Link>
            : <div className="acct-name">{c.contact}</div>}
          <div className="pd-sub"><a href={`mailto:${c.email}`} className="order-link">{c.email}</a></div>
          <div className="pd-sub">Abandoned {when(c.abandonedAt)}</div>
          {!c.account && <div className="pd-sub" style={{ marginTop: 6 }}>Not matched to a CRM account yet.</div>}
        </div>
        <div className="pd-box">
          <div className="pd-box-title">Since then</div>
          {c.orderedSince ? (
            <>
              <div>
                Ordered <Link to={`/orders/${c.orderedSince.quoteId}`} className="order-link">#{c.orderedSince.number}</Link>
                {' '}on {fmtDateWithYear(c.orderedSince.date)}
              </div>
              <div className="pd-sub">
                {c.orderedSince.itemsOrdered} of {c.itemCount} cart {c.itemCount === 1 ? 'item' : 'items'} on that order
              </div>
            </>
          ) : (
            <div className="pd-sub">No order since. Worth a follow-up call.</div>
          )}
        </div>
      </div>

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