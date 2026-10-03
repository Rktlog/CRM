import { isHistoryOrder } from './types';

// One place that turns DEAR's order fields into plain words, used by the
// Orders list, the order page and the account page.
//
// DEAR's sale "status" (ESTIMATED, ORDERED, COMPLETED...) describes the
// paperwork, not delivery: an order stays ORDERED after it has shipped,
// until it's invoiced and closed. So "where is it?" is answered from
// DEAR's shipping and picking status first, and "has it been paid?" from
// DEAR's payment status, falling back to the raw status only when needed.

export type OrderLike = {
  paid: boolean;
  number?: string | null;
  source?: string | null;
  miscType?: string | null;
  fulfillmentStatus?: string | null; // DEAR sale status
  shippingStatus?: string | null;    // DEAR CombinedShippingStatus
  pickingStatus?: string | null;     // DEAR CombinedPickingStatus
  paymentStatus?: string | null;     // DEAR CombinedPaymentStatus
  invoiceNumber?: string | null;
  invoiceDate?: string | null;
};

export type Tag = { label: string; tone: 'teal' | 'amber' | 'rust' | 'neutral' };

const up = (s?: string | null) => (s ?? '').trim().toUpperCase();
const QUOTE_STATUSES = ['DRAFT', 'ESTIMATING', 'ESTIMATED', 'QUOTE'];

// Where is it?
export function stageTag(o: OrderLike): Tag | null {
  const status = up(o.fulfillmentStatus);
  const ship = up(o.shippingStatus);
  const pick = up(o.pickingStatus);

  if (status === 'VOIDED') return { label: 'Voided', tone: 'neutral' };
  if (status === 'CREDITED') return { label: 'Credited', tone: 'neutral' };
  if (QUOTE_STATUSES.includes(status)) return { label: 'Quote', tone: 'neutral' };
  if (ship === 'SHIPPED' || status === 'COMPLETED') return { label: 'Shipped', tone: 'teal' };
  if (ship === 'PARTIALLY SHIPPED') {
    return status === 'BACKORDERED'
      ? { label: 'Part shipped, rest backordered', tone: 'rust' }
      : { label: 'Part shipped', tone: 'amber' };
  }
  if (status === 'BACKORDERED') return { label: 'Backordered', tone: 'rust' };
  if (status === 'ORDERING') return { label: 'Draft order', tone: 'neutral' };
  if (pick === 'PICKED') return { label: 'Picked', tone: 'amber' };
  if (pick === 'PARTIALLY PICKED') return { label: 'Part picked', tone: 'amber' };
  if (status) return { label: 'Confirmed', tone: 'amber' }; // ORDERED, INVOICED etc. with nothing shipped yet
  return null;
}

// Has it been paid? null = nothing to pay (quotes, cancelled, marketing, warranty).
export function paymentTag(o: OrderLike): Tag | null {
  if (o.miscType) return null;
  const status = up(o.fulfillmentStatus);
  if (QUOTE_STATUSES.includes(status) || status === 'VOIDED' || status === 'CREDITED') return null;

  const pay = up(o.paymentStatus);
  if (pay === 'PREPAID') return { label: 'Prepaid', tone: 'teal' };
  if (o.paid || ['PAID', 'FULLY PAID', 'OVERPAID', 'OVERPAID / CREDITED'].includes(pay)) return { label: 'Paid', tone: 'teal' };
  if (pay.includes('PARTIALLY')) return { label: 'Part paid', tone: 'amber' };
  return o.invoiceNumber || o.invoiceDate
    ? { label: 'Unpaid', tone: 'amber' }
    : { label: 'Not invoiced', tone: 'neutral' };
}

const Pill = ({ tag }: { tag: Tag }) => <span className={`pill ${tag.tone}`}>{tag.label}</span>;

// The tags for one order, in the order people read them: what kind of
// order, where it is, whether it's paid. Spreadsheet history shows only
// that it's history, since its old statuses mean nothing now.
export function orderStatusPills(o: OrderLike) {
  const kind = o.miscType === 'marketing'
    ? <span className="pill marketing">Marketing</span>
    : o.miscType === 'warranty'
      ? <span className="pill neutral">Warranty</span>
      : null;

  if (isHistoryOrder({ source: o.source, number: o.number })) {
    return <>{kind}<span className="badge muted">History</span></>;
  }
  const stage = stageTag(o);
  const payment = paymentTag(o);
  return <>{kind}{stage && <Pill tag={stage} />}{payment && <Pill tag={payment} />}</>;
}