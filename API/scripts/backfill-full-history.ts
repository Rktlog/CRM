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
/**
 * A slow, deliberate, fully-resumable backfill of everything DEAR
 * has — not the quick sync:once. This is built to survive being
 * interrupted (Ctrl+C, a crash, a dropped connection) without losing
 * progress, and to correctly work through large batches of records
 * that share an identical timestamp (a real, confirmed DEAR behavior
 * — a bulk import or batch edit touches many records at once).
 *
 * Progress saves after EVERY batch, not once at the end. Run it,
 * stop it, run it again later — it always resumes exactly where it
 * left off. Keep running it until it prints "Fully caught up."
 *
 * Usage:
 *   npx tsx scripts/backfill-full-history.ts
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { normalize } from '../src/lib/normalize';
import { fetchSalesUpdatedSince, fetchSaleDetail, fetchAllProducts } from '../src/sync/dearClient';
import { computeAvgOrderGapDays } from '../src/lib/orderCadence';

const prisma = new PrismaClient();
const BATCH_SIZE = 25; // detail-fetches per batch — deliberately small
const PAUSE_BETWEEN_BATCHES_MS = 3000; // extra breathing room beyond the per-call throttle already in dearClient
const MAX_BATCHES = 2000; // hard safety cap, not expected to be hit

const KNOWN_PAID_VALUES = ['PREPAID', 'PAID', 'FULLY PAID', 'OVERPAID', 'OVERPAID / CREDITED'];
function isPaid(detail: any): boolean {
  const combined = String(detail.CombinedPaymentStatus ?? '').toUpperCase();
  if (combined) {
    if (KNOWN_PAID_VALUES.includes(combined)) return true;
    if (!['UNPAID', 'PARTIALLY PAID', 'AWAITING PAYMENT', 'OVERDUE'].includes(combined)) {
      console.warn(`Unrecognized CombinedPaymentStatus: "${detail.CombinedPaymentStatus}" — treating as unpaid, review this.`);
    }
    return false;
  }
  const invoice = detail.Invoice;
  if (!invoice) return false;
  if (invoice.Status === 'PAID') return true;
  return Number(invoice.Total ?? 0) > 0 && Number(invoice.Paid ?? 0) >= Number(invoice.Total ?? 0) - 0.01;
}

function isDispatched(detail: any): boolean {
  if ((detail.CombinedShippingStatus ?? '').toUpperCase() === 'SHIPPED') return true;
  if ((detail.Ship?.Status ?? '').toUpperCase() === 'AUTHORISED') return true;
  return (detail.Fulfilments ?? []).some((f: any) => (f.Ship?.Status ?? '').toUpperCase() === 'AUTHORISED');
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  const stageOrder = ['new_lead', 'approached', 'quote_sent', 'payment_cleared', 'dispatched'];
  let batchNum = 0;
  let totalProcessed = 0;
  let totalUnmatched = 0;

  while (batchNum < MAX_BATCHES) {
    const state = await prisma.syncState.findUnique({ where: { key: 'sales_backfill' } });
    const since = state?.lastSyncedAt ?? new Date(Date.now() - 3 * 365 * 86400000);
    const lastId = state?.lastId ?? null;

    // The expensive part — fetch the WHOLE remaining candidate list
    // ONCE, not once per small batch. This was the actual bug: doing
    // this inside the inner loop meant re-paginating tens of
    // thousands of records just to pull out the next 25 every time.
    console.log(`Fetching candidate list since ${since.toISOString()} (this can take a few minutes for a large backlog)...`);
    const rawSales = await fetchSalesUpdatedSince(since);

    const candidatesAll = lastId
      ? rawSales.filter(s => {
          const t = new Date(s.Updated ?? 0).getTime();
          const cursorT = new Date(since).getTime();
          if (t > cursorT) return true;
          if (t === cursorT) return String(s.SaleID) > String(lastId);
          return false;
        })
      : rawSales;

    if (candidatesAll.length === 0) {
      console.log(`\nFully caught up. Total processed across this run: ${totalProcessed}, unmatched: ${totalUnmatched}.`);
      break;
    }

    const sorted = candidatesAll.sort((a, b) => new Date(a.Updated ?? 0).getTime() - new Date(b.Updated ?? 0).getTime());
    console.log(`Fetched ${sorted.length} candidates. Working through them in batches of ${BATCH_SIZE} from memory — no more re-fetching until this list is exhausted.`);

    const accounts = await prisma.account.findMany({
      where: { OR: [{ dearCustomerId: { not: null } }, { type: 'customer' }] },
      select: { id: true, name: true, dearCustomerId: true, stage: true, contactName: true, type: true, archived: true },
    });
    const byDearId = new Map(accounts.filter(a => a.dearCustomerId).map(a => [a.dearCustomerId!, a]));
    const byName = new Map(accounts.map(a => [normalize(a.name), a]));

    console.log('Fetching product catalog for brand lookup...');
    const products = await fetchAllProducts();
    const brandBySku = new Map(products.map(p => [p.SKU, p.Brand || null]));
    console.log(`Fetched ${products.length} products.`);

    for (let i = 0; i < sorted.length; i += BATCH_SIZE) {
      batchNum++;
      if (batchNum > MAX_BATCHES) break;
      const batch = sorted.slice(i, i + BATCH_SIZE);

      let batchProcessed = 0;
      let batchUnmatched = 0;
      let batchVoided = 0;
      const unmatchedSample: string[] = [];
      const touchedAccountIds = new Set<string>();

      for (const sale of batch) {
        let account = sale.CustomerID ? byDearId.get(String(sale.CustomerID)) : undefined;
        if (!account && sale.Customer) account = byName.get(normalize(String(sale.Customer)));
        if (!account) {
          batchUnmatched++;
          if (unmatchedSample.length < 3 && sale.Customer) unmatchedSample.push(String(sale.Customer));
          continue;
        }

        // A voided sale is a cancelled transaction, not a real order
        // — skip before even fetching detail, saving the API call too.
        if ((sale.Status ?? '').toUpperCase() === 'VOIDED') {
          batchVoided++;
          continue;
        }

        // Warranty replacements and marketing/sample orders are real
        // orders, just not commercial sales — import and tag them,
        // don't discard.
        const referenceText = String(sale.CustomerReference ?? '').toLowerCase();
        const miscType = referenceText.includes('warranty') ? 'warranty'
          : referenceText.includes('marketing') ? 'marketing'
          : null;

        const detail = await fetchSaleDetail(sale.SaleID);
        const number = String(sale.OrderNumber ?? detail.CustomerReference ?? sale.SaleID);
        const amount = Math.round(Number(detail.Order?.Total ?? detail.Quote?.Total ?? 0));
        const sentAt = new Date(detail.SaleOrderDate ?? detail.Created ?? detail.LastModifiedOn ?? sale.Updated ?? Date.now());
        const invoiceDate = detail.Invoice?.InvoiceDate ? new Date(detail.Invoice.InvoiceDate) : null;
        const paid = isPaid(detail);
        const dispatched = isDispatched(detail);
        const fulfillmentStatus = detail.Status ?? null;

        if (!account.contactName && detail.Contact) {
          const contactPatch: any = { contactName: detail.Contact };
          if (detail.Phone) contactPatch.phone = detail.Phone;
          if (detail.Email) contactPatch.email = detail.Email;
          await prisma.account.update({ where: { id: account.id }, data: contactPatch });
        }
        const shipTo = detail.ShippingAddress;
        const shippingCompany = shipTo?.Company?.trim() || null;
        const shippingAddress = [shipTo?.Line1, shipTo?.City, shipTo?.State, shipTo?.Postcode].filter(Boolean).join(', ') || null;

        const quote = await prisma.quote.upsert({
          where: { number },
          create: { accountId: account.id, number, amount, sentAt, invoiceDate, paid, fulfillmentStatus, shippingCompany, shippingAddress, reference: sale.CustomerReference ?? null, source: 'cin7', miscType },
          update: { amount, invoiceDate, paid, fulfillmentStatus, shippingCompany, shippingAddress, reference: sale.CustomerReference ?? null, source: 'cin7', syncedAt: new Date(), miscType },
        });

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
          // A line item literally named as a replacement is a
          // reliable warranty signal even when the order reference
          // text doesn't say so explicitly.
          if (!miscType && rawLines.some((l: any) => String(l.Name ?? '').toLowerCase().includes('replacement'))) {
            await prisma.quote.update({ where: { id: quote.id }, data: { miscType: 'warranty' } });
          }
        }

        let nextStage = account.stage;
        if (dispatched) nextStage = 'dispatched';
        else if (paid) nextStage = 'payment_cleared';
        else nextStage = 'quote_sent';
        const patch: any = {};
        if (stageOrder.indexOf(nextStage) > stageOrder.indexOf(account.stage)) patch.stage = nextStage;
        if (paid) patch.lastOrderAt = sentAt;
        if (paid && account.type === 'prospect') patch.type = 'customer';
        if (paid && account.archived) patch.archived = false; // real new order = real evidence an archive was wrong or the account came back to life
        if (Object.keys(patch).length) await prisma.account.update({ where: { id: account.id }, data: patch });

        touchedAccountIds.add(account.id);
        batchProcessed++;
      }

      for (const accountId of touchedAccountIds) {
        const quotes = await prisma.quote.findMany({ where: { accountId, paid: true } });
        const now = Date.now();
        const sum = (days: number) => quotes.filter(q => now - q.sentAt.getTime() <= days * 86400000).reduce((s, q) => s + q.amount, 0);
        await prisma.account.update({
          where: { id: accountId },
          data: { spend30: sum(30), spend90: sum(90), spend365: sum(365), avgOrderGapDays: computeAvgOrderGapDays(quotes.map(q => q.sentAt)) },
        });
      }

      const lastInBatch = batch[batch.length - 1];
      await prisma.syncState.upsert({
        where: { key: 'sales_backfill' },
        create: { key: 'sales_backfill', lastSyncedAt: new Date(lastInBatch.Updated ?? since), lastId: String(lastInBatch.SaleID) },
        update: { lastSyncedAt: new Date(lastInBatch.Updated ?? since), lastId: String(lastInBatch.SaleID) },
      });

      totalProcessed += batchProcessed;
      totalUnmatched += batchUnmatched;
      console.log(`Batch ${batchNum}: processed ${batchProcessed}, unmatched ${batchUnmatched}, voided ${batchVoided} — total so far: ${totalProcessed} (${i + batch.length}/${sorted.length} of this fetch)${unmatchedSample.length ? ` — sample unmatched names: ${unmatchedSample.join(' | ')}` : ''}`);

      await sleep(PAUSE_BETWEEN_BATCHES_MS);
    }
  }

  if (batchNum >= MAX_BATCHES) {
    console.warn(`Hit the ${MAX_BATCHES}-batch safety cap — run this script again to continue.`);
  }
}

main()
  .catch(e => { console.error('Backfill error (safe to re-run, progress is saved):', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
