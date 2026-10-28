import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiGet } from '../lib/api';
import { fmtMoney, type QuoteLineItem } from '../lib/types';

// The items of one order, shown under it on the account page when it is opened. The account page is no longer sent every line of every order (a big
// customer has thousands), so they are fetched here, once, when the order is first opened. If the lines came with the order (an older API), they are
// used as they are and nothing is fetched.
// An order's items are kept for a few minutes, so closing an order and opening it again does not ask again.
const KEEP_MS = 5 * 60_000;
const kept = new Map<string, { at: number; lines: QuoteLineItem[] }>();
const keptFor = (id: string) => { const k = kept.get(id); return k && Date.now() - k.at < KEEP_MS ? k.lines : null; };

export default function OrderLines({ orderId, preloaded }: { orderId: string; preloaded?: QuoteLineItem[] }) {
  const [lines, setLines] = useState<QuoteLineItem[] | null>(preloaded ?? keptFor(orderId));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (preloaded || keptFor(orderId)) return;
    let cancelled = false;
    apiGet(`/orders/${orderId}/lines`)
      .then(d => { kept.set(orderId, { at: Date.now(), lines: d }); if (!cancelled) setLines(d); })
      .catch(e => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [orderId]);

  return (
    <div className="order-lines">
      {error && <div className="acct-region">Couldn't load this order's items: {error}</div>}
      {!error && !lines && <div className="acct-region">Loading…</div>}
      {lines?.map((l, i) => (
        <div className="order-line" key={i}>
          <div>
            <div>{l.productName}</div>
            <div className="acct-region num">{l.sku}{l.brand ? `, ${l.brand}` : ''}</div>
          </div>
          <div className="num">{l.quantity} × {fmtMoney(l.unitPrice)}</div>
          <div className="num">{fmtMoney(Math.round(l.lineTotal * 100) / 100)}</div>
        </div>
      ))}
      <Link to={`/orders/${orderId}`} className="order-link order-full-link">Full order details</Link>
    </div>
  );
}