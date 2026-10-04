import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { isHistory } from '../lib/orderSource';
import { searchWords } from './products';
import * as XLSX from 'xlsx';
import { openQuotes, toShip, unpaidInvoices, balances, AGE_BUCKETS } from '../lib/receivables';

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
      amountDue: true,
      amountPaid: true,
      creditedTotal: true,
      fulfillmentStatus: true,
      shippingStatus: true,
      pickingStatus: true,
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
      amountDue: o.amountDue,
      amountPaid: o.amountPaid,
      creditedTotal: o.creditedTotal,
      fulfillmentStatus: o.fulfillmentStatus,
      shippingStatus: o.shippingStatus,
      pickingStatus: o.pickingStatus,
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
// ---------- Order tracking views (tabs on the Orders page) ----------
// GET /orders/views/quotes | to-ship | unpaid | balances
//   ?region=VIC,NSW  &format=xlsx (download exactly what's on screen)
// Scoped by territory: reps see their states.
const xlDate = (d: Date | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : '');

ordersRouter.get('/views/:view', async (req, res) => {
  const regions = typeof req.query.region === 'string' && req.query.region ? req.query.region.split(',') : undefined;
  const rep = req.rep!;
  let data: any;
  let sheet: Record<string, unknown>[] = [];
  let name = '';

  switch (req.params.view) {
    case 'quotes': {
      data = await openQuotes(rep, regions);
      name = 'open-quotes';
      sheet = data.rows.map((r: any) => ({
        Order: r.number, Date: xlDate(r.date), 'Age (days)': r.ageDays, Customer: r.customer, State: r.region,
        Rep: r.repName ?? '', Stage: r.stage, Reference: r.reference ?? '', Amount: r.amount,
      }));
      break;
    }
    case 'to-ship': {
      data = await toShip(rep, regions);
      name = 'to-ship';
      sheet = data.rows.map((r: any) => ({
        Order: r.number, Date: xlDate(r.date), 'Age (days)': r.ageDays, Customer: r.customer, State: r.region,
        Rep: r.repName ?? '', Status: r.stage, Type: r.type, Amount: r.amount,
      }));
      break;
    }
    case 'unpaid': {
      data = await unpaidInvoices(rep, regions);
      name = 'unpaid-invoices';
      sheet = data.rows.map((r: any) => ({
        Invoice: r.invoice, Order: r.number, Customer: r.customer, State: r.region, Rep: r.repName ?? '',
        'Invoice date': xlDate(r.invoiceDate), 'Due date': xlDate(r.dueDate), 'Days overdue': r.daysOverdue,
        Total: r.total, Paid: r.paid, Credited: r.credited, Due: r.due, Type: r.type,
      }));
      break;
    }
    case 'balances': {
      data = await balances(rep, regions);
      name = 'customer-balances';
      sheet = data.rows.map((r: any) => ({
        Customer: r.customer, State: r.region, Rep: r.repName ?? '', 'Unpaid invoices': r.invoices,
        ...Object.fromEntries(AGE_BUCKETS.map(b => [b.label, r[b.key]])),
        Owing: r.owing, 'Credit on account': r.credit, Balance: r.balance, 'Oldest overdue (days)': r.oldestDays,
      }));
      break;
    }
    default:
      return res.status(404).json({ error: 'Unknown view' });
  }

  if (req.query.format === 'xlsx') {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sheet.length ? sheet : [{ Note: 'Nothing to show.' }]), name.slice(0, 31));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${name}-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    return res.send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  }
  res.json(data);
});

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

  // What's still to ship, per item: ordered minus shipped across all
  // fulfilments, with DEAR's backorder qty where it can't fill it yet.
  // null = no fulfilment data for this order (synced before it was
  // captured), so the page hides the section rather than guess.
  const progress = (o.lineFulfilment ?? {}) as Record<string, { picked?: number; shipped?: number; backordered?: number }>;
  const fulfilments = (o.fulfilments ?? []) as any[];
  // Spreadsheet history is closed by definition: its statuses are frozen.
  const closed = isHistory(o)
    || ['COMPLETED', 'VOIDED', 'CREDITED'].includes((o.fulfillmentStatus ?? '').toUpperCase())
    || (o.shippingStatus ?? '').toUpperCase() === 'SHIPPED';
  const hasProgress = Object.keys(progress).length > 0 || fulfilments.length > 0 || !!o.shippingStatus;

  let toShip: { sku: string; productName: string; ordered: number; shipped: number; outstanding: number; backordered: number }[] | null = null;
  if (closed) {
    toShip = [];
  } else if (hasProgress) {
    const bySku = new Map<string, { sku: string; productName: string; ordered: number }>();
    for (const l of o.lines) {
      const row = bySku.get(l.sku) ?? { sku: l.sku, productName: l.productName, ordered: 0 };
      row.ordered += l.quantity;
      bySku.set(l.sku, row);
    }
    toShip = [...bySku.values()]
      .map(r => {
        const shipped = Math.min(progress[r.sku]?.shipped ?? 0, r.ordered);
        const outstanding = r.ordered - shipped;
        return { ...r, shipped, outstanding, backordered: Math.min(progress[r.sku]?.backordered ?? 0, outstanding) };
      })
      .filter(r => r.outstanding > 0)
      .sort((a, b) => b.backordered - a.backordered);
  }

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
    // Invoices, credit notes and the balance, as DEAR records them.
    invoices: o.invoices ?? [],
    creditNotes: o.creditNotes ?? [],
    invoicedTotal: o.invoicedTotal,
    amountPaid: o.amountPaid,
    creditedTotal: o.creditedTotal,
    amountDue: o.amountDue,
    fulfillmentStatus: o.fulfillmentStatus,
    shippingStatus: o.shippingStatus,
    pickingStatus: o.pickingStatus,
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
    fulfilments,
    toShip,
    account: { id: o.account.id, name: o.account.name, region: o.account.region },
    lines,
    subtotal,
    taxTotal: o.taxTotal,
    total: o.total ?? o.amount,
  });
});