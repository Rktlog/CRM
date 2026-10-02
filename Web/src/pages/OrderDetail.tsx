import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { apiGet } from '../lib/api';
import { fmtMoney, fmtDateWithYear } from '../lib/types';
import { orderStatusPills } from './Orders';

type Line = {
  sku: string; productName: string; brand: string | null;
  quantity: number; unitPrice: number; discount: number; tax: number; lineTotal: number;
};
type Shipment = { date: string | null; carrier: string | null; trackingNumber: string | null; trackingUrl: string | null };
type ShipDetails = {
  company: string | null; contact: string | null; line1: string | null; line2: string | null;
  city: string | null; state: string | null; postcode: string | null; country: string | null;
};
type Order = {
  id: string; number: string; date: string;
  invoiceDate: string | null; invoiceNumber: string | null;
  reference: string | null; memo: string | null; source: string; miscType: string | null;
  paid: boolean; paymentStatus: string | null; fulfillmentStatus: string | null; shippingStatus: string | null;
  syncedAt: string;
  contact: { name: string | null; email: string | null; phone: string | null };
  shipTo: { company: string | null; address: string | null; details: ShipDetails | null };
  shipments: Shipment[];
  account: { id: string; name: string; region: string };
  lines: Line[];
  subtotal: number; taxTotal: number | null; total: number;
};

const money = (n: number) => fmtMoney(Math.round(n * 100) / 100);
const LINE_COLS = '0.9fr 2fr 0.6fr 0.8fr 0.6fr 0.9fr';

function Row({ k, v }: { k: string; v: ReactNode }) {
  if (v === null || v === undefined || v === '') return null;
  return <div className="kv"><span className="k">{k}</span><span>{v}</span></div>;
}

export default function OrderDetail() {
  const { id } = useParams<{ id: string }>();
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    setOrder(null);
    apiGet(`/orders/${id}`).then(setOrder).catch(e => setError(e.message));
  }, [id]);

  if (error) return <div className="empty-state">Couldn't load this order: {error}</div>;
  if (!order) return <div className="empty-state">Loading…</div>;

  const d = order.shipTo.details;
  const addressLines = d
    ? [d.line1, d.line2, [d.city, d.state, d.postcode].filter(Boolean).join(' '), d.country].filter(Boolean)
    : order.shipTo.address ? [order.shipTo.address] : [];
  const shipCompany = d?.company ?? order.shipTo.company;
  const hasDiscount = order.lines.some(l => l.discount > 0);

  return (
    <>
      <a className="back-link" href="#" onClick={e => { e.preventDefault(); navigate(-1); }}>← Back</a>

      <div className="order-head">
        <div>
          <h1 style={{ marginBottom: 4 }}>Order <span className="num">{order.number}</span></h1>
          <div style={{ color: 'var(--muted)', fontSize: 13 }}>
            <Link to={`/accounts/${order.account.id}`} className="acct-name" style={{ color: 'var(--ink)' }}>{order.account.name}</Link>
            {', '}{order.account.region}{', '}{fmtDateWithYear(order.date)}
          </div>
        </div>
        <div className="order-pills">{orderStatusPills(order)}</div>
      </div>

      <div className="detail-grid">
        <div>
          <div className="card">
            <h3>Items</h3>
            {order.lines.length === 0 ? (
              <div style={{ color: 'var(--muted)', fontSize: 13 }}>No line items on record for this order.</div>
            ) : (
              <div className="manifest" style={{ border: 'none' }}>
                <div className="m-row head" style={{ gridTemplateColumns: LINE_COLS, padding: '8px 0' }}>
                  <div>SKU</div><div>Product</div>
                  <div className="num">Qty</div><div className="num">Price</div>
                  <div className="num">{hasDiscount ? 'Disc.' : ''}</div><div className="num">Total</div>
                </div>
                {order.lines.map((l, i) => (
                  <div className="m-row" key={i} style={{ gridTemplateColumns: LINE_COLS, padding: '8px 0', cursor: 'default' }}>
                    <div className="num">{l.sku}</div>
                    <div>
                      <div>{l.productName}</div>
                      {l.brand && <div className="acct-region">{l.brand}</div>}
                    </div>
                    <div className="num">{l.quantity}</div>
                    <div className="num">{money(l.unitPrice)}</div>
                    <div className="num">{l.discount > 0 ? `${l.discount}%` : ''}</div>
                    <div className="num">{money(l.lineTotal)}</div>
                  </div>
                ))}
              </div>
            )}

            <div className="order-totals">
              <div className="kv"><span className="k">Items</span><span className="num">{money(order.subtotal)}</span></div>
              {order.taxTotal !== null && (
                <div className="kv"><span className="k">Tax</span><span className="num">{money(order.taxTotal)}</span></div>
              )}
              <div className="kv order-total"><span>Order total</span><span className="num">{money(order.total)}</span></div>
            </div>
          </div>

          {order.memo && (
            <div className="card">
              <h3>Notes</h3>
              <div style={{ fontSize: 13, whiteSpace: 'pre-wrap', color: 'var(--ink-soft)' }}>{order.memo}</div>
            </div>
          )}
        </div>

        <div>
          <div className="card">
            <h3>Shipping</h3>
            {shipCompany && <div className="acct-name">{shipCompany}</div>}
            {d?.contact && <div style={{ fontSize: 13 }}>Attn: {d.contact}</div>}
            {addressLines.map((line, i) => <div key={i} style={{ fontSize: 13 }}>{line}</div>)}
            {!shipCompany && !addressLines.length && (
              <div style={{ color: 'var(--muted)', fontSize: 13 }}>No shipping address on record.</div>
            )}

            <div style={{ marginTop: 12 }}>
              <Row k="Shipping status" v={order.shippingStatus} />
              {order.shipments.map((s, i) => (
                <div className="kv" key={i}>
                  <span className="k">
                    {s.date ? fmtDateWithYear(s.date) : 'Shipment'}{s.carrier ? `, ${s.carrier}` : ''}
                  </span>
                  <span className="num">
                    {s.trackingUrl && s.trackingNumber
                      ? <a href={s.trackingUrl} target="_blank" rel="noreferrer" className="order-link">{s.trackingNumber}</a>
                      : s.trackingNumber ?? 'No tracking'}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <h3>Payment</h3>
            <Row k="Payment status" v={order.paymentStatus ?? (order.paid ? 'Paid' : 'Unpaid')} />
            <Row k="Invoice no." v={order.invoiceNumber && <span className="num">{order.invoiceNumber}</span>} />
            <Row k="Invoice date" v={order.invoiceDate && fmtDateWithYear(order.invoiceDate)} />
          </div>

          <div className="card">
            <h3>Order</h3>
            <Row k="Order date" v={fmtDateWithYear(order.date)} />
            <Row k="Customer reference" v={order.reference} />
            <Row k="Order status" v={order.fulfillmentStatus} />
            <Row k="Contact" v={order.contact.name} />
            <Row k="Email" v={order.contact.email && <a href={`mailto:${order.contact.email}`} className="order-link">{order.contact.email}</a>} />
            <Row k="Phone" v={order.contact.phone && <a href={`tel:${order.contact.phone}`} className="order-link">{order.contact.phone}</a>} />
          </div>

          <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
            Synced from DEAR {new Date(order.syncedAt).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}
          </div>
        </div>
      </div>
    </>
  );
}