import type { Incoming, Stock } from './tradeshow';
import { combinePct } from './tsOffers';

// The same sums the server does (API/src/lib/tradeshowCore.ts), so the page can show prices, stock and totals the moment a product is
// added, without waiting for Save. The server still works them out again on every save, and that is what gets sent to sales.
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
type Discount = { kind: 'pct' | 'amount'; value: number } | null;

export function liveTotals(t: { lines: { qty: number; price: number; pct?: number }[]; discount: Discount; freight: number; cardPayment: boolean; surchargePct: number | null; gstRate: number }) {
  const goods = round2(t.lines.reduce((s, l) => s + l.qty * l.price, 0));
  const offerBase = round2(t.lines.reduce((s, l) => s + round2(l.qty * l.price * (1 - (l.pct || 0) / 100)), 0));   // after the offers
  const pct = !t.discount || !(t.discount.value > 0) || !(offerBase > 0) ? 0 : Math.min(100, Math.round((t.discount.kind === 'pct' ? t.discount.value : (t.discount.value / offerBase) * 100) * 100) / 100);
  const linePcts = t.lines.map(l => ((l.pct || 0) >= 100 ? 100 : combinePct(l.pct || 0, pct)));
  const lineTotals = t.lines.map((l, i) => round2(l.qty * l.price * (1 - linePcts[i]! / 100)));
  const goodsAfter = round2(lineTotals.reduce((s, x) => s + x, 0));
  const freight = round2(Math.max(0, t.freight || 0));
  const surchargePct = t.cardPayment && t.surchargePct && t.surchargePct > 0 ? t.surchargePct : 0;
  const surcharge = round2(((goodsAfter + freight) * surchargePct) / 100);
  const exGst = round2(goodsAfter + freight + surcharge), gst = round2(exGst * t.gstRate);
  return { goods, linePct: pct, offerDiscount: round2(goods - offerBase), linePcts, discount: round2(goods - goodsAfter), goodsAfter, freight, surcharge, surchargePct, exGst, gst, total: round2(exGst + gst), lineTotals };
}

export function liveStock(qty: number, available: number, pending: number, incoming: Incoming, eta: string | null): Stock {
  const free = Math.floor(available - pending), canShip = Math.max(0, Math.min(qty, free)), backorder = Math.max(0, qty - canShip);
  const when = incoming ? `${incoming.qty} more coming${incoming.po ? ` on ${incoming.po}` : ''}${incoming.date ? `, due ${incoming.date}` : ''}` : '';
  const note = backorder === 0 ? 'In stock' : [canShip ? `${canShip} now, ${backorder} on backorder` : `None free now, ${backorder} on backorder`, when || (eta ? `ETA ${eta}` : '') || 'Nothing on order yet'].filter(Boolean).join('. ');
  return { available, pending, free, canShip, backorder, incoming, eta, note };
}
export const packProblem = (qty: number, inc: number | null | undefined) => (inc && inc > 1 && qty % inc !== 0 ? `Sold in packs of ${inc}` : null);
