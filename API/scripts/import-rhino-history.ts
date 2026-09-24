/**
 * Imports historical order/line-item data from the Rhino spreadsheet
 * (58,534 rows, Jan 2022 - Jun 2025, real SKU/brand/category/contact
 * detail per line). This predates and overlaps with what's already
 * synced from DEAR.
 *
 * Order numbers here (e.g. "Q08063") are a DIFFERENT format from
 * what's already in the database (e.g. "SQ33899") — they can't be
 * matched directly. Deduplication for the overlapping period uses a
 * fingerprint instead: same account, same order date, same total.
 *
 * Three modes:
 *   npx tsx scripts/import-rhino-history.ts <path-to-xlsx> <repId>
 *     Preview only. Reports everything, creates nothing.
 *
 *   npx tsx scripts/import-rhino-history.ts <path-to-xlsx> <repId> --apply
 *     Imports only orders dated BEFORE your earliest already-synced
 *     order — zero overlap risk, this is always safe.
 *
 *   npx tsx scripts/import-rhino-history.ts <path-to-xlsx> <repId> --apply --apply-overlap
 *     Also imports orders in the overlapping period that don't
 *     fingerprint-match an existing quote. Review the preview output
 *     from a plain run first before using this.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import * as XLSX from 'xlsx';

const prisma = new PrismaClient();

const [, , filePath, repId, ...flags] = process.argv;
const apply = flags.includes('--apply');
const applyOverlap = flags.includes('--apply-overlap');

if (!filePath || !repId) {
  console.error('Usage: npx tsx scripts/import-rhino-history.ts <path-to-xlsx> <repId> [--apply] [--apply-overlap]');
  process.exit(1);
}

function normalize(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}
function cleanState(raw: string | undefined): string {
  if (!raw) return 'Unknown';
  return raw.replace(/\/HO$/i, '').trim() || 'Unknown';
}

type Row = {
  'SQ Number': string; 'Order Date': Date | string; Status: string; Customer: string; State: string;
  'Business Category': string; 'Contact Name': string; Email: string; Phone: string | number;
  Brand: string; SKU: string; Product: string; Qty: number; 'Unit Price': number; 'Line Total ex GST': number;
  'Order Total ex GST ex Freight': number; 'Invoice #': string; 'Invoice Date': Date | string;
};

async function main() {
  console.log(`Reading ${filePath}...`);
  const wb = XLSX.readFile(filePath, { cellDates: true });
  const rows: Row[] = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
  console.log(`Read ${rows.length} line-item rows.`);

  // Group into real orders — one row per line item, many lines per order.
  const orders = new Map<string, { sqNumber: string; orderDate: Date; status: string; customer: string; state: string; category: string; contactName: string; email: string; phone: string; invoiceNumber: string; invoiceDate: Date; orderTotal: number; lines: Row[] }>();
  for (const r of rows) {
    const key = r['SQ Number'];
    if (!orders.has(key)) {
      orders.set(key, {
        sqNumber: key,
        orderDate: r['Order Date'] instanceof Date ? r['Order Date'] : new Date(r['Order Date']),
        status: r.Status,
        customer: r.Customer,
        state: cleanState(r.State),
        category: r['Business Category'],
        contactName: r['Contact Name'] || '',
        email: r.Email || '',
        phone: r.Phone ? String(r.Phone) : '',
        invoiceNumber: r['Invoice #'] || '',
        invoiceDate: r['Invoice Date'] instanceof Date ? r['Invoice Date'] : new Date(r['Invoice Date']),
        orderTotal: 0,
        lines: [],
      });
    }
    const order = orders.get(key)!;
    order.lines.push(r);
    if (r['Order Total ex GST ex Freight']) order.orderTotal = r['Order Total ex GST ex Freight'];
  }
  console.log(`Grouped into ${orders.size} real orders.`);

  // Skip voided/cancelled-style rows the same way the DEAR sync does.
  const realOrders = [...orders.values()].filter(o => o.status !== 'Credit Note');

  // The safe cutoff — anything before your earliest already-synced
  // order is guaranteed non-overlapping, no fingerprint check needed.
  // Earliest order from a REAL DEAR sync specifically — excluding
  // anything this script itself already imported. Without this
  // filter, a second run of this script sees its own previous
  // import as "already synced" and the cutoff collapses to the
  // start of the whole file, wrongly reclassifying everything as
  // overlap zone.
  const earliestSynced = await prisma.quote.findFirst({
    where: { source: { not: 'rhino-history' } },
    orderBy: { sentAt: 'asc' },
    select: { sentAt: true },
  });
  const cutoff = earliestSynced?.sentAt ?? new Date();
  console.log(`Earliest already-synced order: ${cutoff.toISOString().slice(0, 10)}`);

  const safeZone = realOrders.filter(o => o.orderDate < cutoff);
  const overlapZone = realOrders.filter(o => o.orderDate >= cutoff);
  console.log(`Safe zone (before earliest synced order): ${safeZone.length} orders`);
  console.log(`Overlap zone (needs fingerprint check): ${overlapZone.length} orders`);

  // Existing accounts, for matching.
  const accounts = await prisma.account.findMany({ select: { id: true, name: true } });
  const accountByNormName = new Map(accounts.map(a => [normalize(a.name), a]));

  // Every order number already in the database, regardless of
  // source — the direct, reliable check for "have I already
  // imported this exact spreadsheet order in a previous run of this
  // script." The number is guaranteed unique per real order, so
  // this is a much sturdier check than the fingerprint, which is
  // only needed for the fuzzier "does this look like the same order
  // DEAR already synced under a different number" question.
  const existingNumbers = new Set((await prisma.quote.findMany({ select: { number: true } })).map(q => q.number));

  // Existing REAL DEAR-synced quotes in the overlap window, for
  // fingerprint matching — excludes this script's own prior imports,
  // which are already covered by the number check above.
  const existingQuotesInWindow = await prisma.quote.findMany({
    where: { sentAt: { gte: cutoff }, source: { not: 'rhino-history' } },
    select: { accountId: true, sentAt: true, amount: true },
  });
  const fingerprint = (accountId: string, date: Date, amount: number) =>
    `${accountId}|${date.toISOString().slice(0, 10)}|${Math.round(amount * 100)}`;
  const existingFingerprints = new Set(existingQuotesInWindow.map(q => fingerprint(q.accountId, q.sentAt, q.amount)));

  // Resolve every order to an account (existing match, or a new one
  // to create — deduped within this run so the same new customer
  // doesn't get created twice).
  const newAccountsByNormName = new Map<string, { name: string; state: string; category: string; contactName: string; email: string; phone: string }>();
  function resolveAccount(o: typeof realOrders[number]) {
    const key = normalize(o.customer);
    const existing = accountByNormName.get(key);
    if (existing) return { existingId: existing.id, isNew: false };
    if (!newAccountsByNormName.has(key)) {
      newAccountsByNormName.set(key, { name: o.customer, state: o.state, category: o.category, contactName: o.contactName, email: o.email, phone: o.phone });
    }
    return { existingId: null, isNew: true, key };
  }

  let safeMatchedAcct = 0, safeNewAcct = 0;
  for (const o of safeZone) { const r = resolveAccount(o); if (r.isNew) safeNewAcct++; else safeMatchedAcct++; }
  let overlapSkippedDupe = 0, overlapWouldCreate = 0;
  for (const o of overlapZone) resolveAccount(o); // populate newAccountsByNormName too

  console.log(`\nDistinct new customers found across the file: ${newAccountsByNormName.size}`);
  console.log(`Safe zone: ${safeMatchedAcct} orders match an existing account, ${safeNewAcct} orders belong to a new one.`);

  if (!apply) {
    console.log('\nPreview only. Re-run with --apply to import the safe zone.');
    return;
  }

  // ---- Create new accounts (from both zones — a customer's account
  // should exist regardless of which order first references them). ----
  const createdAccountIds = new Map<string, string>();
  for (const [key, a] of newAccountsByNormName) {
    const created = await prisma.account.create({
      data: {
        name: a.name, region: a.state, repId, credit: 'account',
        type: 'customer', stage: 'dispatched', // proven real historical orders — this is legitimate, unlike the DEAR-list bug
        contactName: a.contactName || null, phone: a.phone || null, email: a.email || null,
        category: a.category || null,
      },
    });
    createdAccountIds.set(key, created.id);
    accountByNormName.set(key, { id: created.id, name: a.name });
  }
  console.log(`Created ${createdAccountIds.size} new accounts.`);

  // ---- Import the safe zone ----
  let importedSafe = 0, safeSkippedAlready = 0;
  for (const o of safeZone) {
    if (existingNumbers.has(o.sqNumber)) { safeSkippedAlready++; continue; } // already imported in a prior run
    const accountId = accountByNormName.get(normalize(o.customer))!.id;
    const quote = await prisma.quote.create({
      data: {
        accountId, number: o.sqNumber, amount: o.orderTotal || o.lines.reduce((s, l) => s + (l['Line Total ex GST'] || 0), 0),
        sentAt: o.orderDate, invoiceDate: o.invoiceDate, paid: o.status === 'Completed',
        fulfillmentStatus: o.status.toUpperCase(), reference: o.invoiceNumber, source: 'rhino-history',
      },
    });
    await prisma.quoteLine.createMany({
      data: o.lines.map(l => ({
        quoteId: quote.id, sku: l.SKU ? String(l.SKU) : 'UNKNOWN', productName: l.Product ? String(l.Product) : 'Unknown product',
        brand: l.Brand ? String(l.Brand) : null, quantity: l.Qty || 0, unitPrice: l['Unit Price'] || 0, lineTotal: l['Line Total ex GST'] || 0,
      })),
    });
    existingNumbers.add(o.sqNumber);
    importedSafe++;
    if (importedSafe % 200 === 0) console.log(`...${importedSafe}/${safeZone.length} orders imported so far`);
  }
  console.log(`Imported ${importedSafe} orders from the safe zone (${safeSkippedAlready} already imported in a prior run, skipped).`);

  if (!applyOverlap) {
    console.log('\nOverlap zone NOT imported — rerun with --apply-overlap once you\'ve reviewed the safe-zone results.');
    return;
  }

  // ---- Import the overlap zone, skipping anything already imported
  // in a prior run OR that fingerprint-matches a real DEAR quote ----
  let importedOverlap = 0, overlapSkippedAlready = 0;
  for (const o of overlapZone) {
    if (existingNumbers.has(o.sqNumber)) { overlapSkippedAlready++; continue; } // already imported in a prior run
    const accountId = accountByNormName.get(normalize(o.customer))!.id;
    const amount = o.orderTotal || o.lines.reduce((s, l) => s + (l['Line Total ex GST'] || 0), 0);
    if (existingFingerprints.has(fingerprint(accountId, o.orderDate, amount))) { overlapSkippedDupe++; continue; }

    const quote = await prisma.quote.create({
      data: {
        accountId, number: o.sqNumber, amount,
        sentAt: o.orderDate, invoiceDate: o.invoiceDate, paid: o.status === 'Completed',
        fulfillmentStatus: o.status.toUpperCase(), reference: o.invoiceNumber, source: 'rhino-history',
      },
    });
    existingNumbers.add(o.sqNumber);
    await prisma.quoteLine.createMany({
      data: o.lines.map(l => ({
        quoteId: quote.id, sku: l.SKU ? String(l.SKU) : 'UNKNOWN', productName: l.Product ? String(l.Product) : 'Unknown product',
        brand: l.Brand ? String(l.Brand) : null, quantity: l.Qty || 0, unitPrice: l['Unit Price'] || 0, lineTotal: l['Line Total ex GST'] || 0,
      })),
    });
    importedOverlap++;
    if ((importedOverlap + overlapSkippedDupe) % 200 === 0) console.log(`...${importedOverlap + overlapSkippedDupe}/${overlapZone.length} overlap orders checked so far`);
  }
  console.log(`Overlap zone: imported ${importedOverlap}, skipped ${overlapSkippedDupe} as likely already synced via DEAR, skipped ${overlapSkippedAlready} as already imported in a prior run.`);

  console.log('\nRun scripts/recompute-all-spend.ts afterward to refresh spend figures for every affected account.');
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
