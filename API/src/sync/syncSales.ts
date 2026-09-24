/**
 * IMPORTANT: this file NEVER creates new crm.accounts rows. It only
 * matches DEAR data against accounts that already exist (by
 * dearCustomerId or by name). A DEAR customer/sale with no match is
 * skipped and counted as unmatched — deliberately, so one-off retail
 * buyers and unrelated sales channels (e.g. an old Shopify storefront)
 * never spam the Accounts page with junk. If you ever need account
 * auto-creation from DEAR, that is a deliberate new decision, not a
 * bug to "fix" here.
 */
import { prisma } from '../lib/prisma';
import { normalize } from '../lib/normalize';
import { fetchSalesUpdatedSince, fetchSaleDetail, fetchAllProducts } from './dearClient';
import { computeAvgOrderGapDays } from '../lib/orderCadence';
import { writeFileSync } from 'fs';
import { join } from 'path';

/**
 * Field names below are now confirmed against Cin7 Core's own official
 * Sale GET documentation, plus your working Pantone fulfillment app's
 * production code for anything the docs didn't cover (list-item field
 * names, real-world Fulfilments[] shape). Nothing here is a guess
 * anymore.
 */

// CombinedPaymentStatus is a real, reliable top-level field confirmed
// on this account (e.g. "PREPAID") — this business relies heavily on
// prepayment against the Quote itself (see Quote.Prepayments), not
// always a formal Invoice, so Invoice.Status alone would miss real
// paid orders. Using CombinedPaymentStatus as the primary signal,
// with Invoice.Status/Paid as a fallback when it's absent. Only
// values confirmed paid are allow-listed — "UNPAID" and similar
// contain the substring "PAID" too, so this can't just check
// .includes('PAID').
const KNOWN_PAID_VALUES = ['PREPAID', 'PAID', 'FULLY PAID', 'OVERPAID', 'OVERPAID / CREDITED'];

function isPaid(detail: any): boolean {
  const combined = String(detail.CombinedPaymentStatus ?? '').toUpperCase();
  if (combined) {
    if (KNOWN_PAID_VALUES.includes(combined)) return true;
    if (combined !== 'UNPAID' && combined !== 'PARTIALLY PAID' && combined !== 'AWAITING PAYMENT' && combined !== 'OVERDUE') {
      // A value we haven't seen before — don't guess, log it so it
      // can be added to the known list deliberately.
      console.warn(`Unrecognized CombinedPaymentStatus value: "${detail.CombinedPaymentStatus}" — treating as unpaid, review this.`);
    }
    return false;
  }
  const invoice = detail.Invoice;
  if (!invoice) return false;
  if (invoice.Status === 'PAID') return true;
  const total = Number(invoice.Total ?? 0);
  const paid = Number(invoice.Paid ?? 0);
  return total > 0 && paid >= total - 0.01;
}

// Documented: top-level Ship.Status, "AUTHORISED" means genuinely
// shipped. Real production data on this same account also showed a
// Fulfilments[] array for multi-box orders, and a cheap top-level
// CombinedShippingStatus === "SHIPPED" field — checking all three
// since the plain Status field is confirmed to lag behind reality
// (a real order here showed Status: "ORDERED" while already shipped
// and invoiced).
function isDispatched(detail: any): boolean {
  if ((detail.CombinedShippingStatus ?? '').toUpperCase() === 'SHIPPED') return true;
  if ((detail.Ship?.Status ?? '').toUpperCase() === 'AUTHORISED') return true;
  const fulfilments = detail.Fulfilments ?? [];
  return fulfilments.some((f: any) => (f.Ship?.Status ?? '').toUpperCase() === 'AUTHORISED');
}

export async function syncSales() {
  const state = await prisma.syncState.findUnique({ where: { key: 'sales' } });
  const since = state?.lastSyncedAt ?? new Date(Date.now() - 30 * 86400000);
  console.log(`Fetching sales updated since ${since.toISOString()}`);

  const sales = await fetchSalesUpdatedSince(since);
  console.log(`Fetched ${sales.length} sales from DEAR.`);

  // CustomerID is a documented real field on Sale. Fall back to
  // matching the Customer name string if it's missing for some reason.
  const accounts = await prisma.account.findMany({
    where: { OR: [{ dearCustomerId: { not: null } }, { type: 'customer' }] },
    select: { id: true, name: true, dearCustomerId: true, stage: true, contactName: true, type: true },
  });
  const byDearId = new Map(accounts.filter(a => a.dearCustomerId).map(a => [a.dearCustomerId!, a]));
  const byName = new Map(accounts.map(a => [normalize(a.name), a]));

  // SKU -> Brand map, built once per run — brand lives on the Product
  // record, not the sale line itself (confirmed from a real sample),
  // so this avoids an API call per line item.
  console.log('Fetching product catalog for brand lookup...');
  const products = await fetchAllProducts();
  const brandBySku = new Map(products.map(p => [p.SKU, p.Brand || null]));
  console.log(`Fetched ${products.length} products.`);

  let processed = 0;
  let unmatchedCustomer = 0;
  let loggedSample = false;

  for (const sale of sales) {
    let account = sale.CustomerID ? byDearId.get(String(sale.CustomerID)) : undefined;
    if (!account && sale.Customer) account = byName.get(normalize(String(sale.Customer)));
    if (!account) {
      unmatchedCustomer++;
      continue;
    }

    // A voided sale is a cancelled transaction, not a real order.
    if ((sale.Status ?? '').toUpperCase() === 'VOIDED') continue;

    // Warranty replacements and marketing/sample orders are real
    // orders, just not commercial sales — import and tag them so
    // they show up on the Misc page, instead of discarding them.
    const referenceText = String(sale.CustomerReference ?? '').toLowerCase();
    const miscType = referenceText.includes('warranty') ? 'warranty'
      : referenceText.includes('marketing') ? 'marketing'
      : null;

    const detail = await fetchSaleDetail(sale.SaleID);
    if (!loggedSample) {
      const samplePath = join(process.cwd(), 'sample-sale.json');
      writeFileSync(samplePath, JSON.stringify(detail, null, 2));
      console.log(`Sample sale detail written to: ${samplePath}`);
      console.log('Open that file and search for "Order" and "Invoice" to see their real shape.');
      loggedSample = true;
    }

    const number = String(sale.OrderNumber ?? detail.CustomerReference ?? sale.SaleID);

    // Documented field: Order.Total, in customer currency, already
    // includes tax — no need to sum lines ourselves.
    const amount = Math.round(Number(detail.Order?.Total ?? detail.Quote?.Total ?? 0));

    const sentAt = new Date(detail.SaleOrderDate ?? detail.Created ?? detail.LastModifiedOn ?? sale.Updated ?? Date.now());
    const invoiceDate = detail.Invoice?.InvoiceDate ? new Date(detail.Invoice.InvoiceDate) : null;
    const paid = isPaid(detail);
    const dispatched = isDispatched(detail);
    // DEAR's own documented Status field — captured as-is so a real
    // backorder shows up distinctly rather than being flattened into
    // just "unpaid" or "dispatched".
    const fulfillmentStatus = detail.Status ?? null;

    // The Sale itself carries a Contact/Phone/Email — often the real
    // person who placed this order, which the Customer master record
    // frequently lacks. Backfill onto the account only if it doesn't
    // already have this, so a rep's own entry is never overwritten.
    if (!account.contactName && detail.Contact) {
      const contactPatch: any = { contactName: detail.Contact };
      if (detail.Phone) contactPatch.phone = detail.Phone;
      if (detail.Email) contactPatch.email = detail.Email;
      await prisma.account.update({ where: { id: account.id }, data: contactPatch });
    }

    // Per-order shipping details — the account's own address is the
    // billing address; this is where a different store/franchise
    // location shows up for this specific order.
    const shipTo = detail.ShippingAddress;
    const shippingCompany = shipTo?.Company && shipTo.Company.trim() ? shipTo.Company.trim() : null;
    const shippingAddressParts = [shipTo?.Line1, shipTo?.City, shipTo?.State, shipTo?.Postcode].filter(Boolean);
    const shippingAddress = shippingAddressParts.length ? shippingAddressParts.join(', ') : null;

    const quote = await prisma.quote.upsert({
      where: { number },
      create: { accountId: account.id, number, amount, sentAt, invoiceDate, paid, fulfillmentStatus, shippingCompany, shippingAddress, reference: sale.CustomerReference ?? null, source: 'cin7', miscType },
      update: { amount, invoiceDate, paid, fulfillmentStatus, shippingCompany, shippingAddress, reference: sale.CustomerReference ?? null, source: 'cin7', syncedAt: new Date(), miscType },
    });

    // Line items live under Order.Lines (confirmed from a real sale) —
    // fall back to Quote.Lines for sales that never became a real
    // order. Replace wholesale on every sync so an edited/updated
    // order doesn't leave stale or duplicate lines behind.
    const rawLines = detail.Order?.Lines ?? detail.Quote?.Lines ?? [];
    if (rawLines.length) {
      await prisma.quoteLine.deleteMany({ where: { quoteId: quote.id } });
      await prisma.quoteLine.createMany({
        data: rawLines.map((line: any) => ({
          quoteId: quote.id,
          sku: line.SKU ?? 'UNKNOWN',
          productName: line.Name ?? 'Unknown product',
          brand: brandBySku.get(line.SKU) ?? null,
          quantity: line.Quantity ?? 0,
          unitPrice: line.Price ?? 0,
          lineTotal: (line.Quantity ?? 0) * (line.Price ?? 0),
        })),
      });
    }

    const order = ['new_lead', 'approached', 'quote_sent', 'payment_cleared', 'dispatched'];
    let nextStage = account.stage;
    if (dispatched) nextStage = 'dispatched';
    else if (paid) nextStage = 'payment_cleared';
    else nextStage = 'quote_sent';

    const patch: any = {};
    if (order.indexOf(nextStage) > order.indexOf(account.stage)) patch.stage = nextStage;
    if (paid) patch.lastOrderAt = sentAt;
    // A real paid order is what actually makes someone a customer —
    // promote from prospect here rather than assuming it on creation.
    if (paid && account.type === 'prospect') patch.type = 'customer';
    if (Object.keys(patch).length) {
      await prisma.account.update({ where: { id: account.id }, data: patch });
    }

    processed++;
  }

  const accountsWithQuotes = await prisma.account.findMany({
    where: { quotes: { some: {} } },
    select: { id: true },
  });
  const now = Date.now();
  for (const { id } of accountsWithQuotes) {
    const quotes = await prisma.quote.findMany({ where: { accountId: id, paid: true } });
    const sum = (days: number) =>
      quotes.filter(q => now - q.sentAt.getTime() <= days * 86400000).reduce((s, q) => s + q.amount, 0);
    await prisma.account.update({
      where: { id },
      data: {
        spend30: sum(30),
        spend90: sum(90),
        spend365: sum(365),
        avgOrderGapDays: computeAvgOrderGapDays(quotes.map(q => q.sentAt)),
      },
    });
  }

  await prisma.syncState.upsert({
    where: { key: 'sales' },
    create: { key: 'sales', lastSyncedAt: new Date() },
    update: { lastSyncedAt: new Date() },
  });

  console.log(`Sales processed: ${processed}`);
  console.log(`Sales with no matching CRM account: ${unmatchedCustomer}`);
}