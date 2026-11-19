import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiGet } from '../lib/api';

// The promos allocated to an order, shown inside the order's team log. They are given and allocated on the customer's page, so this only lists them.
// Nothing shows when the order has none.
type P = { id: string; name: string; active: boolean; qty: number };

export default function OrderPromos({ orderId, accountId }: { orderId: string; accountId: string }) {
  const [list, setList] = useState<P[] | null>(null);
  useEffect(() => {
    setList(null);
    apiGet(`/promos/order/${orderId}`, { fresh: true }).then((d: { promos: P[] }) => setList(d.promos)).catch(() => setList([]));
  }, [orderId]);

  if (!list || list.length === 0) return null;
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 4, padding: '10px 12px', marginBottom: 14 }}>
      <div style={{ fontWeight: 500, marginBottom: 6 }}>Promos on this order</div>
      <div style={{ display: 'grid', gap: 4 }}>
        {list.map(p => (
          <div key={p.id} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Link to={`/promos/${p.id}`}>{p.name}</Link>
            <span className="acct-region">Qty {p.qty}</span>
            {!p.active && <span className="pill neutral">Off</span>}
          </div>
        ))}
      </div>
      <div className="acct-region" style={{ marginTop: 8, fontSize: 12.5 }}>To change these, use the Promos box on <Link to={`/accounts/${accountId}`}>the customer's page</Link>.</div>
    </div>
  );
}
