import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { searchWords } from './products';

export const ordersRouter = Router();

// Order lookup from our own synced tables, so reps don't need to open
// DEAR to check an order. Company-wide like Sales Data and Products:
// anyone on the team can look up any order.

const SEARCH_LIMIT = 50;

// GET /orders/search?q=   (empty q = most recent orders)
// Matches order number, invoice number, customer reference, the
// account's name, the ship-to store name, or any SKU / product name
// on the order. Multiple words are matched independently.
ordersRouter.get('/search', async (req, res) => {
  const q = String(req.query.q ?? '').trim();

  // Every word must match somewhere on the order, in any order:
  // "miffy brisbane" finds Miffy orders for the Brisbane store.
  const words = q.length >= 2 ? searchWords(q) : [];
  const contains = (w: string) => ({ contains: w, mode: 'insensitive' as const });
  const where = words.length
    ? {
        AND: words.map(w => ({
          OR: [
            { number: contains(w) },
            { invoiceNumber: contains(w) },
            { reference: contains(w) },
            { shippingCompany: contains(w) },
            { account: { name: contains(w) } },
            { lines: { some: { sku: contains(w) } } },
            { lines: { some: { productName: contains(w) } } },
          ],
        })),
      }
    : {};

  const quotes = await prisma.quote.findMany({
    where,
    orderBy: { sentAt: 'desc' },
    take: SEARCH_LIMIT,
    select: {
      id: true,
      number: true,
      sentAt: true,
      amount: true,
      total: true,
      paid: true,
      paymentStatus: true,
      fulfillmentStatus: true,
      shippingStatus: true,
      shippingCompany: true,
      reference: true,
      invoiceNumber: true,
      miscType: true,
      source: true,
      account: { select: { id: true, name: true, region: true } },
      _count: { select: { lines: true } },
    },
  });

  res.json({
    query: q,
    results: quotes.map(o => ({
      id: o.id,
      number: o.number,
      date: o.sentAt,
      total: o.total ?? o.amount,
      paid: o.paid,
      paymentStatus: o.paymentStatus,
      fulfillmentStatus: o.fulfillmentStatus,
      shippingStatus: o.shippingStatus,
      shipTo: o.shippingCompany,
      reference: o.reference,
      invoiceNumber: o.invoiceNumber,
      miscType: o.miscType,
      source: o.source,
      accountId: o.account.id,
      accountName: o.account.name,
      region: o.account.region,
      itemCount: o._count.lines,
    })),
  });
});

// GET /orders/:id   full detail for one order
ordersRouter.get('/:id', async (req, res) => {
  const o = await prisma.quote.findUnique({
    where: { id: req.params.id },
    include: {
      account: { select: { id: true, name: true, region: true, contactName: true, email: true, phone: true } },
      lines: true,
    },
  });
  if (!o) return res.status(404).json({ error: 'Order not found' });

  const lines = o.lines.map(l => ({
    sku: l.sku,
    productName: l.productName,
    brand: l.brand,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    discount: l.discount,
    tax: l.tax,
    lineTotal: Math.round(l.lineTotal * 100) / 100,
  }));
  const subtotal = Math.round(lines.reduce((s, l) => s + l.lineTotal, 0) * 100) / 100;

  res.json({
    id: o.id,
    number: o.number,
    date: o.sentAt,
    invoiceDate: o.invoiceDate,
    invoiceNumber: o.invoiceNumber,
    reference: o.reference,
    memo: o.memo,
    source: o.source,
    miscType: o.miscType,
    paid: o.paid,
    paymentStatus: o.paymentStatus,
    fulfillmentStatus: o.fulfillmentStatus,
    shippingStatus: o.shippingStatus,
    syncedAt: o.syncedAt,
    contact: {
      name: o.orderContact ?? o.account.contactName,
      email: o.orderEmail ?? o.account.email,
      phone: o.orderPhone ?? o.account.phone,
    },
    shipTo: {
      company: o.shippingCompany,
      address: o.shippingAddress,
      details: o.shippingDetails,
    },
    shipments: o.shipments ?? [],
    account: { id: o.account.id, name: o.account.name, region: o.account.region },
    lines,
    subtotal,
    taxTotal: o.taxTotal,
    total: o.total ?? o.amount,
  });
});