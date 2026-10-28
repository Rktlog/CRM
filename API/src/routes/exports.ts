import { Router } from 'express';
import * as XLSX from 'xlsx';
import { prisma } from '../lib/prisma';
import { territoryWhere, canSeeAccount } from '../lib/territory';
import { LIVE_ORDER, isHistory, isOwing } from '../lib/orderSource';
import { wholesalePrice, retailPrice } from '../lib/pricing';
import { buildPriceList, priceListWorkbook, PriceListAvailability, PriceListStatus } from '../lib/priceList';
import { computeConversion, conversionSheets, parsePeriod, regionsOf } from './conversion';
import { buildEolReport, makeSnapshot, allocateInvoices, EOL_BRANDS, DEFAULT_START, DEFAULT_CHECKPOINTS, EolOrder, Snapshot, Sheet as EolSheet } from '../lib/eolReport';
import { melDay } from '../lib/receivables';
import { overview, campaignReport } from '../lib/marketing/overview';
import { loadCreditNotes, loadMovements, loadReservations, loadHeld, regionsParam } from './credit';

// Where a marketing or warranty order was sent: the ship-to name, address and
// state. These orders are billed to one account (e.g. "Rhino Rhino Marketing")
// but go to many different people and stores, so the account says nothing about
// the recipient.
const STATE_CODES: Record<string, string> = {
  VICTORIA: 'VIC', 'NEW SOUTH WALES': 'NSW', QUEENSLAND: 'QLD', 'WESTERN AUSTRALIA': 'WA', 'SOUTH AUSTRALIA': 'SA',
  TASMANIA: 'TAS', 'AUSTRALIAN CAPITAL TERRITORY': 'ACT', 'NORTHERN TERRITORY': 'NT',
};
export function shipTo(q: {
  shippingDetails: unknown; shippingCompany: string | null; shippingAddress: string | null;
  account: { name: string; region: string };
}) {
  const d = (q.shippingDetails ?? {}) as Record<string, string | null>;
  const rawState = (d.state ?? '').trim();
  // The ship-to state; failing that the state in the saved address text; failing
  // that blank (the account's own state says nothing about where it was sent).
  const inText = (q.shippingAddress ?? '').match(/\b(VIC|NSW|QLD|WA|SA|TAS|ACT|NT)\b/i)?.[1]?.toUpperCase();
  const state = /new zealand/i.test(d.country ?? '') ? 'NZ'
    : STATE_CODES[rawState.toUpperCase()] ?? (rawState ? rawState.toUpperCase() : inText ?? '');
  return {
    name: d.company || q.shippingCompany || d.contact || q.account.name,
    contact: d.contact ?? '',
    address: [d.line1, d.line2].filter(Boolean).join(', ') || q.shippingAddress || '',
    suburb: d.city ?? '',
    state,
    postcode: d.postcode ?? '',
    country: d.country ?? '',
  };
}

export const exportsRouter = Router();

function addMonths(d: Date, n: number) {
  const r = new Date(d);
  r.setMonth(r.getMonth() + n);
  return r;
}
function fyStart(forDate: Date): Date {
  const y = forDate.getMonth() >= 6 ? forDate.getFullYear() : forDate.getFullYear() - 1;
  return new Date(y, 6, 1);
}

function sendWorkbook(res: any, filename: string, sheets: { name: string; rows: any[] }[]) {
  const wb = XLSX.utils.book_new();
  for (const s of sheets) {
    const ws = XLSX.utils.json_to_sheet(s.rows);
    XLSX.utils.book_append_sheet(wb, ws, s.name.slice(0, 31));
  }
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
}

// For reports laid out by hand (merged headers, widths, money columns): each sheet is a grid of cells.
function sendSheets(res: any, filename: string, sheets: EolSheet[]) {
  const wb = XLSX.utils.book_new();
  for (const s of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(s.aoa);
    if (s.merges) ws['!merges'] = s.merges;
    if (s.widths) ws['!cols'] = s.widths.map(wch => ({ wch }));
    if (s.moneyCols) {
      for (const addr of Object.keys(ws)) {
        if (addr[0] === '!') continue;
        if (s.moneyCols.includes(XLSX.utils.decode_cell(addr).c) && ws[addr].t === 'n') ws[addr].z = '#,##0.00';
      }
    }
    XLSX.utils.book_append_sheet(wb, ws, s.name.slice(0, 31));
  }
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
}

async function scopedAccountIds(req: any, region?: string, repId?: string) {
  const isManager = req.rep!.role === 'manager';
  const where: any = { AND: [await territoryWhere(req.rep!)] };
  if (region) where.AND.push({ region: { in: region.split(',') } });
  if (isManager && repId) where.AND.push({ repId });
  const accounts = await prisma.account.findMany({ where, select: { id: true, name: true, region: true, type: true, stage: true, category: true, contactName: true, phone: true, email: true, spend30: true, spend90: true, spend365: true, lastOrderAt: true, avgOrderGapDays: true, repId: true, archived: true } });
  return accounts;
}

const cents = (n: number) => Math.round(n * 100) / 100;
const xlDate = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : '');

// Plain-English order status for spreadsheets (matches the app's tags).
function orderStatusWords(q: {
  source?: string | null; number?: string | null; fulfillmentStatus?: string | null; shippingStatus?: string | null;
}): string {
  if (isHistory(q)) return 'History';
  const status = (q.fulfillmentStatus ?? '').toUpperCase();
  const ship = (q.shippingStatus ?? '').toUpperCase();
  if (status === 'VOIDED') return 'Voided';
  if (status === 'CREDITED') return 'Credited';
  if (['DRAFT', 'ESTIMATING', 'ESTIMATED'].includes(status)) return 'Quote';
  if (ship === 'SHIPPED' || status === 'COMPLETED') return 'Shipped';
  if (ship === 'PARTIALLY SHIPPED') return 'Part shipped';
  if (status === 'BACKORDERED') return 'Backordered';
  if (status === 'ORDERING') return 'Draft order';
  return status ? 'Confirmed' : '';
}

function paymentWords(q: {
  source?: string | null; number?: string | null; paid: boolean; paymentStatus?: string | null;
  invoiceDate?: Date | null; invoiceNumber?: string | null; miscType?: string | null;
  amountDue?: number | null; amountPaid?: number | null; creditedTotal?: number | null;
}): string {
  if (isHistory(q)) return '';
  if (q.miscType && !((q.amountDue ?? 0) > 0.005)) return 'No charge';
  const pay = (q.paymentStatus ?? '').toUpperCase();
  if (pay === 'PREPAID') return 'Prepaid';
  // DEAR's balance, once synced: settled by payment, by credit, or part paid.
  if (q.amountDue != null) {
    if (q.amountDue <= 0.005) return (q.creditedTotal ?? 0) > 0 && (q.amountPaid ?? 0) <= 0.005 ? 'Credited' : 'Paid';
    if ((q.amountPaid ?? 0) > 0.005 || (q.creditedTotal ?? 0) > 0.005) return 'Part paid';
    return 'Unpaid';
  }
  if (q.paid) return 'Paid';
  if (pay.includes('PARTIALLY')) return 'Part paid';
  return q.invoiceDate || q.invoiceNumber ? 'Unpaid' : 'Not invoiced';
}

exportsRouter.get('/:type', async (req, res) => {
  const { type } = req.params;
  const region = req.query.region as string | undefined;
  const repId = req.query.repId as string | undefined;
  const year = req.query.year ? Number(req.query.year) : new Date().getFullYear();

  try {
    switch (type) {
      case 'sales-by-sku': {
        const accounts = await scopedAccountIds(req, region, repId);
        const accountIds = accounts.map(a => a.id);
        const fyStartCurrent = fyStart(new Date());
        const quotes = await prisma.quote.findMany({ where: { accountId: { in: accountIds }, paid: true, sentAt: { gte: fyStartCurrent } }, select: { id: true } });
        const lines = await prisma.quoteLine.findMany({ where: { quoteId: { in: quotes.map(q => q.id) } } });
        const bySku = new Map<string, { productName: string; brand: string | null; quantity: number; total: number }>();
        for (const l of lines) {
          const e = bySku.get(l.sku) ?? { productName: l.productName, brand: l.brand, quantity: 0, total: 0 };
          e.quantity += l.quantity; e.total += l.lineTotal;
          bySku.set(l.sku, e);
        }
        const rows = [...bySku.entries()].map(([sku, v]) => ({ SKU: sku, Product: v.productName, Brand: v.brand ?? 'Unbranded', Quantity: v.quantity, Revenue: Math.round(v.total * 100) / 100 })).sort((a, b) => b.Revenue - a.Revenue);
        return sendWorkbook(res, 'sales-by-sku.xlsx', [{ name: 'Sales by SKU', rows }]);
      }

      case 'sales-by-brand': {
        const accounts = await scopedAccountIds(req, region, repId);
        const accountIds = accounts.map(a => a.id);
        const fyStartCurrent = fyStart(new Date());
        const quotes = await prisma.quote.findMany({ where: { accountId: { in: accountIds }, paid: true, sentAt: { gte: fyStartCurrent } }, select: { id: true } });
        const lines = await prisma.quoteLine.findMany({ where: { quoteId: { in: quotes.map(q => q.id) } } });
        const byBrand = new Map<string, { quantity: number; total: number }>();
        for (const l of lines) {
          const b = l.brand || 'Unbranded';
          const e = byBrand.get(b) ?? { quantity: 0, total: 0 };
          e.quantity += l.quantity; e.total += l.lineTotal;
          byBrand.set(b, e);
        }
        const rows = [...byBrand.entries()].map(([brand, v]) => ({ Brand: brand, Quantity: v.quantity, Revenue: Math.round(v.total * 100) / 100 })).sort((a, b) => b.Revenue - a.Revenue);
        return sendWorkbook(res, 'sales-by-brand.xlsx', [{ name: 'Sales by Brand', rows }]);
      }

      case 'sales-by-category': {
        const accounts = await scopedAccountIds(req, region, repId);
        const accountById = new Map(accounts.map(a => [a.id, a]));
        const fyStartCurrent = fyStart(new Date());
        const quotes = await prisma.quote.findMany({ where: { accountId: { in: accounts.map(a => a.id) }, paid: true, sentAt: { gte: fyStartCurrent } } });
        const byCat = new Map<string, number>();
        for (const q of quotes) {
          const cat = accountById.get(q.accountId)?.category || 'Uncategorized';
          byCat.set(cat, (byCat.get(cat) ?? 0) + q.amount);
        }
        const rows = [...byCat.entries()].map(([Category, Revenue]) => ({ Category, Revenue: Math.round(Revenue * 100) / 100 })).sort((a, b) => b.Revenue - a.Revenue);
        return sendWorkbook(res, 'sales-by-category.xlsx', [{ name: 'Sales by Category', rows }]);
      }

      case 'sales-by-region': {
        const accounts = await scopedAccountIds(req, region, repId);
        const accountById = new Map(accounts.map(a => [a.id, a]));
        const fyStartCurrent = fyStart(new Date());
        const quotes = await prisma.quote.findMany({ where: { accountId: { in: accounts.map(a => a.id) }, paid: true, sentAt: { gte: fyStartCurrent } } });
        const byRegion = new Map<string, number>();
        for (const q of quotes) {
          const r = accountById.get(q.accountId)?.region || 'Unknown';
          byRegion.set(r, (byRegion.get(r) ?? 0) + q.amount);
        }
        const rows = [...byRegion.entries()].map(([Region, Revenue]) => ({ Region, Revenue: Math.round(Revenue * 100) / 100 })).sort((a, b) => b.Revenue - a.Revenue);
        return sendWorkbook(res, 'sales-by-region.xlsx', [{ name: 'Sales by Region', rows }]);
      }

      case 'sales-by-account': {
        const accounts = await scopedAccountIds(req, region, repId);
        const fyStartCurrent = fyStart(new Date());
        const fyStartPrior = addMonths(fyStartCurrent, -12);
        const quotes = await prisma.quote.findMany({ where: { accountId: { in: accounts.map(a => a.id) }, paid: true, sentAt: { gte: fyStartPrior } } });
        const rows = accounts.map(a => {
          const acctQuotes = quotes.filter(q => q.accountId === a.id);
          const fyCurrent = acctQuotes.filter(q => q.sentAt >= fyStartCurrent).reduce((s, q) => s + q.amount, 0);
          const fyPrior = acctQuotes.filter(q => q.sentAt >= fyStartPrior && q.sentAt < fyStartCurrent).reduce((s, q) => s + q.amount, 0);
          return { Account: a.name, Region: a.region, Type: a.type, Stage: a.stage, 'Last FY': Math.round(fyPrior * 100) / 100, 'This FY': Math.round(fyCurrent * 100) / 100 };
        }).sort((a, b) => b['This FY'] - a['This FY']);
        return sendWorkbook(res, 'sales-by-account.xlsx', [{ name: 'Sales by Account', rows }]);
      }

      case 'full-orders': {
        const accounts = await scopedAccountIds(req, region, repId);
        const accountById = new Map(accounts.map(a => [a.id, a]));
        const quotes = await prisma.quote.findMany({ where: { accountId: { in: accounts.map(a => a.id) } }, orderBy: { sentAt: 'desc' } });
        const rows = quotes.map(q => ({
          Invoice: q.number,
          Date: q.sentAt.toISOString().slice(0, 10),
          Account: accountById.get(q.accountId)?.name ?? 'Unknown',
          Region: accountById.get(q.accountId)?.region ?? 'Unknown',
          Paid: q.paid ? 'Yes' : 'No',
          Status: q.fulfillmentStatus ?? '',
          Amount: q.amount,
        }));
        return sendWorkbook(res, 'full-orders.xlsx', [{ name: 'All Orders', rows }]);
      }

      case 'unpaid-quotes': {
        const accounts = await scopedAccountIds(req, region, repId);
        const accountById = new Map(accounts.map(a => [a.id, a]));
        const quotes = (await prisma.quote.findMany({
          where: { accountId: { in: accounts.map(a => a.id) }, ...LIVE_ORDER },
          orderBy: { sentAt: 'asc' },
        })).filter(q => isOwing(q));
        const rows = quotes.map(q => ({
          Order: q.number,
          Date: q.sentAt.toISOString().slice(0, 10),
          Account: accountById.get(q.accountId)?.name ?? 'Unknown',
          Contact: accountById.get(q.accountId)?.contactName ?? '',
          Phone: accountById.get(q.accountId)?.phone ?? '',
          Status: orderStatusWords(q),
          'Invoice no.': q.invoiceNumber ?? '',
          'Invoice date': xlDate(q.invoiceDate),
          'Order total': cents(q.total ?? q.amount),
          Paid: q.amountPaid != null ? cents(q.amountPaid) : '',
          Credited: q.creditedTotal != null ? cents(q.creditedTotal) : '',
          'Amount due': cents(q.amountDue ?? q.amount),
        }));
        return sendWorkbook(res, 'unpaid-quotes.xlsx', [{ name: 'Unpaid Quotes', rows }]);
      }

      case 'budget-vs-actual': {
        const isManager = req.rep!.role === 'manager';
        const reps = await prisma.rep.findMany({ where: isManager ? {} : { id: req.rep!.id }, select: { id: true, name: true } });
        const targets = await prisma.budgetTarget.findMany({ where: { year, repId: { in: reps.map(r => r.id) } } });
        const accounts = await prisma.account.findMany({ where: { repId: { in: reps.map(r => r.id) } }, select: { id: true, repId: true } });
        const quotes = await prisma.quote.findMany({ where: { accountId: { in: accounts.map(a => a.id) }, paid: true, sentAt: { gte: new Date(year, 0, 1), lt: new Date(year + 1, 0, 1) } } });
        const accountToRep = new Map(accounts.map(a => [a.id, a.repId]));
        const rows: any[] = [];
        for (const rep of reps) {
          for (let q = 1; q <= 4; q++) {
            const qStartMonth = (q - 1) * 3;
            const qStart = new Date(year, qStartMonth, 1);
            const qEnd = new Date(year, qStartMonth + 3, 1);
            const actual = quotes.filter(qt => accountToRep.get(qt.accountId) === rep.id && qt.sentAt >= qStart && qt.sentAt < qEnd).reduce((s, qt) => s + qt.amount, 0);
            const target = targets.find(t => t.repId === rep.id && t.quarter === q)?.amount ?? 0;
            rows.push({ Rep: rep.name, Year: year, Quarter: `Q${q}`, Target: target, Actual: Math.round(actual * 100) / 100, Variance: Math.round((actual - target) * 100) / 100 });
          }
        }
        return sendWorkbook(res, 'budget-vs-actual.xlsx', [{ name: 'Budget vs Actual', rows }]);
      }

      case 'accounts': {
        // Mirrors the real Accounts page exactly — company-wide,
        // excludes misc, and applies the same "has a real order, or
        // none yet" visibility rule, not the older scopedAccountIds
        // helper shared by the sales-figure reports (which never
        // excluded archived or misc accounts at all).
        const accountWhere: any = {
          archived: false,
          misc: false,
          OR: [{ quotes: { none: {} } }, { quotes: { some: { miscType: null } } }],
        };
        if (region) accountWhere.region = { in: region.split(',') };
        if (repId) accountWhere.repId = repId;
        const accounts = await prisma.account.findMany({
          where: accountWhere,
          include: { rep: { select: { name: true } } },
          orderBy: { updatedAt: 'desc' },
        });
        const rows = accounts.map(a => ({
          Account: a.name, Region: a.region, Rep: a.rep?.name ?? '', Type: a.type, Stage: a.stage, Category: a.category ?? '',
          Contact: a.contactName ?? '', Phone: a.phone ?? '', Email: a.email ?? '',
          'Spend 30d': a.spend30, 'Spend 90d': a.spend90, 'Spend 365d': a.spend365,
          'Last Order': a.lastOrderAt ? a.lastOrderAt.toISOString().slice(0, 10) : '',
        }));
        return sendWorkbook(res, 'accounts.xlsx', [{ name: 'Accounts', rows }]);
      }

      case 'inactive-customers': {
        const accounts = await scopedAccountIds(req, region, repId);
        const now = Date.now();
        const rows = accounts
          .filter(a => a.type === 'customer' && a.lastOrderAt && !a.archived)
          .map(a => {
            const threshold = a.avgOrderGapDays ? Math.max(a.avgOrderGapDays * 1.5, 14) : 75;
            const daysSince = Math.round((now - a.lastOrderAt!.getTime()) / 86400000);
            return { ...a, daysSince, threshold };
          })
          .filter(a => a.daysSince > a.threshold)
          .sort((a, b) => b.daysSince - a.daysSince)
          .map(a => ({
            Account: a.name, Region: a.region, Contact: a.contactName ?? '', Phone: a.phone ?? '',
            'Last Order': a.lastOrderAt!.toISOString().slice(0, 10), 'Days Since': a.daysSince,
            'Typical Gap (days)': a.avgOrderGapDays ?? '—', 'Spend 365d': a.spend365,
          }));
        return sendWorkbook(res, 'inactive-customers.xlsx', [{ name: 'Inactive Customers', rows }]);
      }

      case 'brand-search': {
        const q = (req.query.q as string || '').trim();
        if (!q) return res.status(400).json({ error: 'q (search term) required — matches brand or product name' });

        const accounts = await scopedAccountIds(req, region, repId);
        const accountById = new Map(accounts.map(a => [a.id, a]));
        const quotes = await prisma.quote.findMany({ where: { accountId: { in: accounts.map(a => a.id) } }, select: { id: true, accountId: true } });
        const quoteToAccount = new Map(quotes.map(q => [q.id, q.accountId]));

        const lines = await prisma.quoteLine.findMany({
          where: {
            quoteId: { in: quotes.map(q => q.id) },
            OR: [
              { brand: { contains: q, mode: 'insensitive' } },
              { productName: { contains: q, mode: 'insensitive' } },
            ],
          },
        });

        if (lines.length === 0) {
          return sendWorkbook(res, `search-${q.replace(/[^a-z0-9]+/gi, '-')}.xlsx`, [
            { name: 'No results', rows: [{ Note: `No orders found matching "${q}" in brand or product name.` }] },
          ]);
        }

        // ---- By customer ----
        const byCustomer = new Map<string, { qty: number; revenue: number; orderIds: Set<string> }>();
        for (const l of lines) {
          const accountId = quoteToAccount.get(l.quoteId);
          if (!accountId) continue;
          const e = byCustomer.get(accountId) ?? { qty: 0, revenue: 0, orderIds: new Set() };
          e.qty += l.quantity; e.revenue += l.lineTotal; e.orderIds.add(l.quoteId);
          byCustomer.set(accountId, e);
        }
        const customerRows = [...byCustomer.entries()]
          .map(([accountId, v]) => {
            const a = accountById.get(accountId);
            return {
              Account: a?.name ?? 'Unknown', Region: a?.region ?? '', Contact: a?.contactName ?? '', Phone: a?.phone ?? '',
              Orders: v.orderIds.size, Quantity: v.qty, Revenue: Math.round(v.revenue * 100) / 100,
            };
          })
          .sort((a, b) => b.Revenue - a.Revenue);

        // ---- By SKU ----
        const bySku = new Map<string, { productName: string; brand: string | null; qty: number; revenue: number }>();
        for (const l of lines) {
          const e = bySku.get(l.sku) ?? { productName: l.productName, brand: l.brand, qty: 0, revenue: 0 };
          e.qty += l.quantity; e.revenue += l.lineTotal;
          bySku.set(l.sku, e);
        }
        const skuRows = [...bySku.entries()]
          .map(([sku, v]) => ({ SKU: sku, Product: v.productName, Brand: v.brand ?? 'Unbranded', Quantity: v.qty, Revenue: Math.round(v.revenue * 100) / 100 }))
          .sort((a, b) => b.Revenue - a.Revenue);

        return sendWorkbook(res, `search-${q.replace(/[^a-z0-9]+/gi, '-')}.xlsx`, [
          { name: 'By Customer', rows: customerRows },
          { name: 'By SKU', rows: skuRows },
        ]);
      }

      case 'account-products': {
        const accountId = req.query.accountId as string;
        if (!accountId) return res.status(400).json({ error: 'accountId required' });

        const account = await prisma.account.findUnique({ where: { id: accountId }, select: { id: true, name: true, repId: true, region: true } });
        if (!account) return res.status(404).json({ error: 'Account not found' });
        if (!(await canSeeAccount(req.rep!, account))) return res.status(403).json({ error: 'This account is outside your states' });

        // One query does it all: each product's quantity and total across every order of this account, with its current price, stock and barcode
        // (crm.products, kept in sync with DEAR). It used to read every line of every order into the server, then the products, one after another.
        // The name and brand shown are from the most recent order that has them.
        const found = await prisma.$queryRaw<{ sku: string; product_name: string; brand: string | null; quantity: number; total: number; prices: unknown; available: number | null; barcode: string | null; in_products: boolean }[]>`
          select l.sku,
                 (array_agg(l.product_name order by q.sent_at desc))[1] as product_name,
                 (array_agg(l.brand order by q.sent_at desc) filter (where l.brand is not null))[1] as brand,
                 sum(l.quantity)::float8 as quantity, sum(l.line_total)::float8 as total,
                 p.prices, p.available, p.barcode, (p.sku is not null) as in_products
          from crm.quote_lines l
          join crm.quotes q on q.id = l.quote_id
          left join crm.products p on p.sku = l.sku
          where q.account_id = ${accountId}::uuid
          group by l.sku, p.sku, p.prices, p.available, p.barcode`;

        const rows = found
          .map(r => {
            const prices = r.prices as Record<string, number> | undefined;
            return {
              SKU: r.sku,
              Product: r.product_name,
              Brand: r.brand ?? 'Unbranded',
              Barcode: r.barcode ?? '',   // kept as text, so a leading zero survives (from DEAR, via crm.products)
              Quantity: r.quantity,
              Total: cents(r.total),
              'Wholesale price': wholesalePrice(prices) ?? '',
              'Retail price': retailPrice(prices) ?? '',
              'Available now': r.in_products ? r.available : '',
            };
          })
          .sort((a, b) => b.Total - a.Total);

        const safeName = account.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
        return sendWorkbook(res, `${safeName}-products.xlsx`, [{ name: 'Products Purchased', rows }]);
      }

      // ---- One account's full order history: orders, then every line ----
      case 'account-orders': {
        const accountId = req.query.accountId as string;
        if (!accountId) return res.status(400).json({ error: 'accountId required' });
        const account = await prisma.account.findUnique({ where: { id: accountId }, select: { id: true, name: true, repId: true, region: true } });
        if (!account) return res.status(404).json({ error: 'Account not found' });
        if (!(await canSeeAccount(req.rep!, account))) return res.status(403).json({ error: 'This account is outside your states' });

        const quotes = await prisma.quote.findMany({
          where: { accountId },
          include: { lines: true },
          orderBy: { sentAt: 'desc' },
        });

        const orderRows = quotes.map(q => ({
          Order: q.number,
          Date: xlDate(q.sentAt),
          'Invoice no.': q.invoiceNumber ?? '',
          'Invoice date': xlDate(q.invoiceDate),
          Status: orderStatusWords(q),
          Payment: paymentWords(q),
          Total: cents(q.total ?? q.amount),
          'Paid so far': q.amountPaid != null ? cents(q.amountPaid) : '',
          Credited: q.creditedTotal != null ? cents(q.creditedTotal) : '',
          'Amount due': q.amountDue != null ? cents(q.amountDue) : '',
          Type: q.miscType === 'marketing' ? 'Marketing' : q.miscType === 'warranty' ? 'Warranty' : isHistory(q) ? 'History' : 'Sale',
          Reference: q.reference ?? '',
          'Ship to': q.shippingCompany ?? q.shippingAddress ?? '',
          Items: q.lines.length,
        }));

        const lineRows = quotes.flatMap(q => q.lines.map(l => ({
          Order: q.number,
          Date: xlDate(q.sentAt),
          SKU: l.sku,
          Product: l.productName,
          Brand: l.brand ?? '',
          Quantity: l.quantity,
          'Unit price': cents(l.unitPrice),
          'Discount %': l.discount || '',
          'Line total': cents(l.lineTotal),
        })));

        const safeName = account.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
        return sendWorkbook(res, `${safeName}-order-history.xlsx`, [
          { name: 'Orders', rows: orderRows },
          { name: 'Order lines', rows: lineRows },
        ]);
      }

      // ---- Monthly stocklist for one account ----
      // Sheet 1: what they stock now (everything they've ordered).
      // Sheet 2: products from the same brands they don't stock yet, in
      // stock or on the way, newest first. Prices and stock are current.
      case 'account-stocklist': {
        const accountId = req.query.accountId as string;
        if (!accountId) return res.status(400).json({ error: 'accountId required' });
        const account = await prisma.account.findUnique({ where: { id: accountId }, select: { id: true, name: true, repId: true, region: true } });
        if (!account) return res.status(404).json({ error: 'Account not found' });
        if (!(await canSeeAccount(req.rep!, account))) return res.status(403).json({ error: 'This account is outside your states' });

        const since12m = new Date(Date.now() - 365 * 86400000);
        const NEW_WINDOW_DAYS = 90;
        const newCutoff = new Date(Date.now() - NEW_WINDOW_DAYS * 86400000);

        // What they've bought, per SKU (marketing/warranty aren't purchases).
        const lines = await prisma.quoteLine.findMany({
          where: { quote: { accountId, miscType: null } },
          select: { sku: true, productName: true, brand: true, quantity: true, quote: { select: { sentAt: true } } },
        });
        const bought = new Map<string, { name: string; brand: string | null; lastOrdered: Date; units12m: number; unitsAll: number }>();
        for (const l of lines) {
          const b = bought.get(l.sku) ?? { name: l.productName, brand: l.brand, lastOrdered: l.quote.sentAt, units12m: 0, unitsAll: 0 };
          b.unitsAll += l.quantity;
          if (l.quote.sentAt >= since12m) b.units12m += l.quantity;
          if (l.quote.sentAt > b.lastOrdered) b.lastOrdered = l.quote.sentAt;
          bought.set(l.sku, b);
        }

        const boughtProducts = await prisma.product.findMany({ where: { sku: { in: [...bought.keys()] } } });
        const productBySku = new Map(boughtProducts.map(p => [p.sku, p]));

        // Brands they buy (from the catalogue, falling back to the order line).
        const brands = new Set<string>();
        for (const [sku, b] of bought) {
          const brand = productBySku.get(sku)?.brand ?? b.brand;
          if (brand) brands.add(brand);
        }

        // Same-brand products they don't stock yet, available or on order.
        const candidates = brands.size
          ? await prisma.product.findMany({
              where: {
                brand: { in: [...brands] },
                sku: { notIn: [...bought.keys()] },
                OR: [{ status: null }, { status: { not: 'Deprecated' } }],
                AND: [{ OR: [{ available: { gt: 0 } }, { onOrder: { gt: 0 } }] }],
              },
            })
          : [];

        const allSkus = [...bought.keys(), ...candidates.map(c => c.sku)];

        // "New" = first stock received in the last 90 days, and no sales
        // to anyone before then.
        const firstSeen = await prisma.$queryRaw<{ sku: string; first_received: Date | null; first_sold: Date | null }[]>`
          select s.sku,
            -- First time stock arrived: a purchase order receipt, or a completed
            -- stock adjustment that added stock (some products come in that way).
            least(
              (select min(pl.last_received_at) from crm.purchase_lines pl where pl.sku = s.sku and pl.quantity_received > 0),
              (select min(coalesce(al.received_date, sa.effective_date))
                 from crm.stock_adjustment_lines al join crm.stock_adjustments sa on sa.id = al.adjustment_id
                 where al.sku = s.sku and al.quantity > 0 and upper(coalesce(sa.status, '')) like 'COMPLETED%')
            ) as first_received,
            (select min(q.sent_at) from crm.quote_lines l join crm.quotes q on q.id = l.quote_id where l.sku = s.sku) as first_sold
          from unnest(${allSkus}::text[]) as s(sku)
        `;
        const isNew = new Map(firstSeen.map(f => [
          f.sku,
          !!f.first_received && f.first_received >= newCutoff && (!f.first_sold || f.first_sold >= newCutoff),
        ]));

        // Next expected delivery for anything on order.
        const openPOs = await prisma.purchaseLine.findMany({
          where: { sku: { in: allSkus }, purchase: { status: { notIn: ['VOIDED', 'CREDITED', 'DRAFT'] }, NOT: { status: { startsWith: 'COMPLETED' } } } },
          select: { sku: true, quantityOrdered: true, quantityReceived: true, purchase: { select: { requiredBy: true } } },
        });
        const nextDue = new Map<string, Date>();
        for (const po of openPOs) {
          if (po.quantityOrdered - po.quantityReceived <= 0 || !po.purchase.requiredBy) continue;
          const cur = nextDue.get(po.sku);
          if (!cur || po.purchase.requiredBy < cur) nextDue.set(po.sku, po.purchase.requiredBy);
        }

        const availability = (p?: { available: number; onOrder: number } | null) => {
          if (!p) return 'Not in catalogue';
          if (p.available > 0) return 'In stock';
          if (p.onOrder > 0) return 'On order';
          return 'Out of stock';
        };

        const currentRows = [...bought.entries()]
          .sort((a, b) => b[1].lastOrdered.getTime() - a[1].lastOrdered.getTime())
          .map(([sku, b]) => {
            const p = productBySku.get(sku);
            const prices = p?.prices as Record<string, number> | undefined;
            return {
              SKU: sku,
              Product: p?.name ?? b.name,
              Brand: p?.brand ?? b.brand ?? '',
              Stock: p?.status === 'Deprecated' ? 'Discontinued' : isNew.get(sku) ? 'New' : 'Existing',
              'Wholesale price': wholesalePrice(prices) ?? '',
              'Retail price': retailPrice(prices) ?? '',
              Availability: availability(p),
              'Available qty': p ? p.available : '',
              'On order': p ? p.onOrder : '',
              'Next delivery': xlDate(nextDue.get(sku)),
              'Last ordered': xlDate(b.lastOrdered),
              'Units, last 12 months': b.units12m,
              'Units, all time': b.unitsAll,
            };
          });

        const newRows = candidates
          .sort((a, b) =>
            Number(isNew.get(b.sku) ?? false) - Number(isNew.get(a.sku) ?? false)
            || (a.brand ?? '').localeCompare(b.brand ?? '')
            || b.available - a.available)
          .slice(0, 500)
          .map(p => {
            const prices = p.prices as Record<string, number>;
            return {
              SKU: p.sku,
              Product: p.name,
              Brand: p.brand ?? '',
              Category: p.category ?? '',
              Stock: isNew.get(p.sku) ? 'New' : 'Existing',
              'Wholesale price': wholesalePrice(prices) ?? '',
              'Retail price': retailPrice(prices) ?? '',
              Availability: availability(p),
              'Available qty': p.available,
              'On order': p.onOrder,
              'Next delivery': xlDate(nextDue.get(p.sku)),
            };
          });

        const month = new Date().toLocaleDateString('en-AU', { month: 'short', year: 'numeric' }).replace(' ', '-').toLowerCase();
        const safeName = account.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
        return sendWorkbook(res, `${safeName}-stocklist-${month}.xlsx`, [
          { name: 'Current range', rows: currentRows.length ? currentRows : [{ Note: 'No products ordered yet.' }] },
          { name: 'New for you', rows: newRows.length ? newRows : [{ Note: 'Nothing new from their brands right now.' }] },
        ]);
      }

      // ---- Customer price list (the report sent to stores), with filters ----
      // ?accountId=  &brands=A|B|C  &status=new,current,other  &availability=available,preorder,discontinued
      case 'account-pricelist': {
        const accountId = req.query.accountId as string;
        if (!accountId) return res.status(400).json({ error: 'accountId required' });
        const account = await prisma.account.findUnique({ where: { id: accountId }, select: { id: true, name: true, repId: true, region: true } });
        if (!account) return res.status(404).json({ error: 'Account not found' });
        if (!(await canSeeAccount(req.rep!, account))) return res.status(403).json({ error: 'This account is outside your states' });

        const list = (v: unknown, sep: string) => (typeof v === 'string' && v.trim() ? v.split(sep).map(s => s.trim()).filter(Boolean) : undefined);
        const { rows } = await buildPriceList(account.id, {
          brands: list(req.query.brands, '|'),
          statuses: list(req.query.status, ',') as PriceListStatus[] | undefined,
          availability: list(req.query.availability, ',') as PriceListAvailability[] | undefined,
        });

        const buffer = await priceListWorkbook(rows);
        const safeName = account.name.replace(/[^a-z0-9]+/gi, ' ').trim().replace(/\s+/g, ' ');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${safeName}.xlsx"`);
        return res.send(buffer);
      }

      case 'misc-marketing':
      case 'misc-warranty': {
        const miscType = type === 'misc-marketing' ? 'marketing' : 'warranty';
        const quotes = await prisma.quote.findMany({
          where: { miscType },
          include: { account: { select: { name: true, region: true } }, lines: true },
          orderBy: { sentAt: 'desc' },
        });

        // These orders are usually charged at $0, so value what was sent at
        // today's wholesale price (from crm.products, kept in sync with DEAR).
        const skus = [...new Set(quotes.flatMap(q => q.lines.map(l => l.sku)))];
        const wholesaleBySku = new Map(
          (await prisma.product.findMany({ where: { sku: { in: skus } }, select: { sku: true, prices: true } }))
            .map(p => [p.sku, wholesalePrice(p.prices as Record<string, number>)]),
        );
        const lineValue = (sku: string, qty: number) => {
          const price = wholesaleBySku.get(sku);
          return price != null ? cents(price * qty) : null;
        };

        const label = miscType === 'warranty' ? 'Warranty' : 'Marketing';
        const orderRows = quotes.map(q => {
          const values = q.lines.map(l => lineValue(l.sku, l.quantity));
          const to = shipTo(q);
          return {
            Account: q.account.name,
            'Sent to': to.name,
            Contact: to.contact,
            Address: to.address,
            Suburb: to.suburb,
            State: to.state,
            Postcode: to.postcode,
            Country: to.country,
            Region: q.account.region,
            Order: q.number,
            Date: xlDate(q.sentAt),
            Reference: q.reference ?? '',
            Items: q.lines.length,
            Units: q.lines.reduce((sum, l) => sum + l.quantity, 0),
            'Charged': cents(q.total ?? q.amount),
            'Wholesale value': cents(values.reduce<number>((sum, v) => sum + (v ?? 0), 0)),
            'Missing prices': values.filter(v => v == null).length || '',
            Source: q.source,
          };
        });

        const itemRows = quotes.flatMap(q => q.lines.map(l => {
          const price = wholesaleBySku.get(l.sku);
          const to = shipTo(q);
          return {
            Order: q.number,
            Date: xlDate(q.sentAt),
            Account: q.account.name,
            'Sent to': to.name,
            State: to.state,
            Region: q.account.region,
            SKU: l.sku,
            Product: l.productName,
            Brand: l.brand ?? '',
            Quantity: l.quantity,
            'Wholesale price': price ?? '',
            'Wholesale value': lineValue(l.sku, l.quantity) ?? '',
          };
        }));

        return sendWorkbook(res, `misc-${miscType}.xlsx`, [
          { name: `${label} orders`, rows: orderRows.length ? orderRows : [{ Note: `No ${label.toLowerCase()} orders.` }] },
          { name: 'Items sent', rows: itemRows.length ? itemRows : [{ Note: 'No items.' }] },
        ]);
      }

      case 'rep-activity': {
        const isManager = req.rep!.role === 'manager';
        const days = req.query.days ? Number(req.query.days) : 30;
        const since = new Date(Date.now() - days * 86400000);
        const activities = await prisma.activity.findMany({
          where: { occurredAt: { gte: since }, ...(isManager ? {} : { repId: req.rep!.id }) },
          include: { rep: { select: { name: true } }, account: { select: { name: true, region: true } }, quote: { select: { number: true } } },
          orderBy: { occurredAt: 'desc' },
        });
        const rows = activities.map(a => ({
          Date: a.occurredAt.toISOString().slice(0, 10), Rep: a.rep?.name ?? 'Unknown', Type: ({ call: 'Phone', email: 'Email', visit: 'F2F visit', remark: 'Remark' } as Record<string, string>)[a.type] ?? a.type,
          Account: a.account?.name ?? 'Unknown', Region: a.account?.region ?? '', Order: a.quote?.number ?? '', Note: a.note,
        }));
        return sendWorkbook(res, 'rep-activity.xlsx', [{ name: 'Rep Activity', rows }]);
      }

      case 'conversion': {
        // Abandoned cart / Prospect / Inactive Stockist P1 and P2, each to an Order and a Sales Quote, with the days it took.
        const period = parsePeriod(req.query);   // ?days=90 or ?from=&to= (a month or a fiscal quarter)
        const r = await computeConversion(req.rep!, { from: period.from, to: period.to, regions: regionsOf(req.query.region) });
        return sendWorkbook(res, 'conversion.xlsx', conversionSheets(r, xlDate));
      }

      case 'eol': {
        // EOL sell-through report: sales since the start date and stock left for the clearance brands, one sheet each.
        // GET /exports/eol  (?from=2026-05-22  &checkpoints=2026-06-16,2026-07-01,...). Managers only.
        if (req.rep!.role !== 'manager') return res.status(403).json({ error: 'Only a manager can download this report' });
        const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
        const from = isDay(req.query.from) ? req.query.from : DEFAULT_START;
        const today = melDay();
        // The old fortnightly dates (sales only) belong to the 22 May campaign. Saved days are added by themselves.
        const checkpoints = typeof req.query.checkpoints === 'string' && req.query.checkpoints
          ? req.query.checkpoints.split(',').map(x => x.trim()).filter(isDay)
          : from === DEFAULT_START ? DEFAULT_CHECKPOINTS : [];

        // Live orders placed since the day before the start, or invoiced since it (an older order can ship later).
        const ids = (await prisma.$queryRaw<{ id: string }[]>`
          select q.id from crm.quotes q
          where q.source <> 'rhino-history' and q.number not like 'Q%'
            and upper(coalesce(q.fulfillment_status, '')) not in ('VOIDED', 'CREDITED')
            and (q.sent_at >= ${from}::date - 1
              or case when jsonb_typeof(q.invoices) = 'array' then exists (
                   select 1 from jsonb_array_elements(q.invoices) i
                   where left(coalesce(i->>'date', ''), 10) >= ${from}
                     and upper(coalesce(i->>'status', '')) <> 'VOIDED') else false end)`).map(r => r.id);
        const quotes = await prisma.quote.findMany({
          where: { id: { in: ids } },
          select: {
            sentAt: true, fulfillmentStatus: true, invoices: true, fulfilments: true,
            account: { select: { name: true, region: true, category: true, contactName: true, email: true, phone: true } },
            lines: { select: { sku: true, productName: true, brand: true, quantity: true, unitPrice: true, discount: true, lineTotal: true } },
          },
        });
        const words = (s: string | null) => (s ? s.charAt(0) + s.slice(1).toLowerCase() : '');
        const orders: EolOrder[] = quotes.map(q => ({
          orderDate: melDay(q.sentAt),
          status: words(q.fulfillmentStatus),
          completed: (q.fulfillmentStatus ?? '').toUpperCase() === 'COMPLETED',
          account: {
            name: q.account.name, state: q.account.region, category: q.account.category ?? '',
            contact: q.account.contactName ?? '', email: q.account.email ?? '', phone: q.account.phone ?? '',
          },
          invoices: (Array.isArray(q.invoices) ? (q.invoices as any[]) : []).map(i => ({ number: i?.number ? String(i.number) : null, date: i?.date ? melDay(String(i.date)) : null, status: i?.status ?? null })),
          fulfilments: (Array.isArray(q.fulfilments) ? (q.fulfilments as any[]) : []).map(f => ({ shippedAt: f?.shippedAt ? String(f.shippedAt) : null, lines: Array.isArray(f?.lines) ? f.lines : [] })),
          lines: q.lines.map(l => ({ sku: l.sku, product: l.productName, brand: l.brand, qty: l.quantity, unitPrice: l.unitPrice, discount: l.discount, lineTotal: l.lineTotal })),
        }));

        const products = await prisma.product.findMany({
          where: { brand: { in: EOL_BRANDS }, available: { gt: 0 } },
          select: { sku: true, name: true, brand: true, available: true, prices: true },
        });
        const stock = products.map(p => ({
          sku: p.sku, name: p.name, brand: p.brand ?? '', available: p.available,
          rrp: retailPrice(p.prices as any), wholesale: wholesalePrice(p.prices as any),
        }));

        // Each download saves that day's figures (a second download the same day replaces it) and shows every saved
        // day side by side. ?save=0 downloads without saving. A problem with the history never blocks the download:
        // it is written on the Notes sheet instead.
        const input = { lines: orders.flatMap(allocateInvoices), stock, from };
        const key = `eol:${from}`;
        const warnings: string[] = [];
        let snapshots: Snapshot[] = [];
        try {
          const rows = await prisma.$queryRaw<{ day: string; data: any }[]>`
            select taken_on::text as day, data from crm.eol_snapshots where report_key = ${key} order by taken_on`;
          snapshots = rows.map(r => ({ ...(r.data as Omit<Snapshot, 'date'>), date: r.day }));
        } catch (e) { console.error('eol history load failed', e); warnings.push(`Earlier days could not be loaded: ${(e as Error).message}`); }
        if (req.query.save !== '0') {
          try {
            const { date: _day, ...data } = makeSnapshot({ ...input, asOf: today });
            await prisma.$executeRaw`
              insert into crm.eol_snapshots (report_key, taken_on, taken_by, data)
              values (${key}, ${today}::date, ${req.rep!.id}::uuid, ${JSON.stringify(data)}::jsonb)
              on conflict (report_key, taken_on) do update set data = excluded.data, taken_by = excluded.taken_by, taken_at = now()`;
          } catch (e) { console.error('eol snapshot save failed', e); warnings.push(`Today's figures could not be saved: ${(e as Error).message}`); }
        }
        const sheets = buildEolReport({ ...input, checkpoints, asOf: today, snapshots, warnings });
        return sendSheets(res, `eol-report-${from}.xlsx`, sheets);
      }

      case 'marketing': {
        // All marketing emails in a period: the headline numbers, each campaign, the automatic emails, and the orders credited to emails.
        if (req.rep!.role !== 'manager') return res.status(403).json({ error: 'Marketing is for managers' });
        const period = parsePeriod(req.query);
        const o = await overview(period.from, period.to);
        const t = o.totals as any, r = o.rates as any;
        const summary = [
          ['Period from', xlDate(period.from)], ['Period to', xlDate(period.to)], ['Emails sent', t.sent], ['Delivered', t.delivered], ['Delivered %', r.delivered],
          ['Opened (people)', t.opened], ['Opened % of delivered', r.opened], ['Clicked (people)', t.clicked], ['Clicked % of delivered', r.clicked],
          ['Unsubscribed', t.unsubscribed], ['Bounced', t.bounced], ['Spam complaints', t.complained],
          [`Orders after a click (within ${o.attributionDays} days)`, o.orders.count], ['Sales from those orders (ex GST)', o.orders.revenue],
          ['Note', 'Opens are approximate: some inboxes load pictures automatically. Clicks and orders are the reliable measures.'],
        ].map(([Measure, Value]) => ({ Measure, Value }));
        const campaigns = o.campaigns.map((c: any) => ({ Campaign: c.name, Subject: c.subject, Sent: xlDate(c.sentAt), Emails: c.sent, Delivered: c.delivered, Opened: c.opened, 'Open %': c.openRate,
          Clicked: c.clicked, 'Click %': c.clickRate, Unsubscribed: c.unsubscribed, Bounced: c.bounced, Orders: c.orders, 'Sales ex GST': c.revenue }));
        const autos = o.automations.map((a: any) => ({ 'Automatic email': a.name, Type: a.marketing ? 'Marketing' : 'Order email', Sent: a.sent, Opened: a.opened, Clicked: a.clicked, Waiting: a.waiting, Orders: a.orders, 'Sales ex GST': a.revenue }));
        const orders = o.orders.recent.map((x: any) => ({ Order: x.number, 'Order date': xlDate(x.orderAt), Customer: x.accountName, 'Sales ex GST': x.value, 'Credited to': x.campaignName ?? x.automationKey ?? '', 'Clicked on': xlDate(x.clickedAt) }));
        return sendWorkbook(res, 'marketing.xlsx', [
          { name: 'Summary', rows: summary }, { name: 'Campaigns', rows: campaigns.length ? campaigns : [{ Note: 'No campaigns sent in this period' }] },
          { name: 'Automatic emails', rows: autos }, { name: 'Orders from emails', rows: orders.length ? orders : [{ Note: 'No orders credited in this period' }] },
        ]);
      }

      case 'marketing-campaign': {
        // One campaign: the numbers, every recipient, the links clicked, and the orders credited to it.
        if (req.rep!.role !== 'manager') return res.status(403).json({ error: 'Marketing is for managers' });
        const id = String(req.query.id ?? '');
        const r = /^[0-9a-f-]{36}$/i.test(id) ? await campaignReport(id) : null;
        if (!r) return res.status(404).json({ error: 'Campaign not found' });
        const st = r.stats as any;
        const summary = [
          ['Campaign', r.campaign.name], ['Subject', r.campaign.subject], ['Sent', xlDate(r.campaign.sentAt)], ['Recipients', st.total], ['Sent', st.sent], ['Delivered', st.delivered],
          ['Opened (people)', st.opened], ['Open %', st.openRate], ['Clicked (people)', st.clicked], ['Click %', st.clickRate], ['Unsubscribed', st.unsubscribed], ['Bounced', st.bounced],
          ['Not sent (skipped or failed)', st.skipped + st.failed], [`Orders after a click (within ${r.attributionDays} days)`, r.orders.count], ['Sales from those orders (ex GST)', r.orders.revenue],
        ].map(([Measure, Value]) => ({ Measure, Value }));
        const rec = r.recipients.map((x: any) => ({ Email: x.email, Name: x.name ?? '', Store: x.company ?? '', Status: x.status, Opens: x.opens, Clicks: x.clicks, 'First sent': xlDate(x.sentAt), Unsubscribed: x.unsubscribedAt ? 'Yes' : '', Note: x.error ?? '' }));
        const links = r.links.map((x: any) => ({ Link: x.url, Clicks: x.clicks, People: x.people }));
        const orders = r.orders.rows.map((x: any) => ({ Order: x.number, 'Order date': xlDate(x.orderAt), Customer: x.accountName, 'Sales ex GST': x.value, 'Clicked on': xlDate(x.clickedAt) }));
        return sendWorkbook(res, 'campaign-report.xlsx', [
          { name: 'Summary', rows: summary }, { name: 'Recipients', rows: rec.length ? rec : [{ Note: 'No recipients' }] },
          { name: 'Links clicked', rows: links.length ? links : [{ Note: 'No clicks yet' }] }, { name: 'Orders', rows: orders.length ? orders : [{ Note: 'No orders credited yet' }] },
        ]);
      }

      case 'hidden-accounts': {
        // Every account that is not on the Accounts list, and why. Managers only.
        if (req.rep!.role !== 'manager') return res.status(403).json({ error: 'Only a manager can download this report' });
        const rows = await prisma.$queryRaw<any[]>`
          select a.name, a.region as state, coalesce(nullif(a.category, ''), 'Uncategorized') as category, r.name as rep,
            case
              when a.archived and a.keep_archived then 'Archived, locked (stays hidden)'
              when a.archived then 'Archived, comes back on a real order'
              when a.misc then 'Marked misc (marketing or warranty)'
              when exists (select 1 from crm.quotes q where q.account_id = a.id) and not exists (select 1 from crm.quotes q where q.account_id = a.id and q.misc_type is null) then 'Only marketing or warranty orders'
              else 'Hidden from some reps by a manager'
            end as why_hidden,
            s.status as crm_status, a.dear_customer_id is not null as in_dear, a.created_at::date::text as created,
            ((s.last_order at time zone 'UTC') at time zone 'Australia/Melbourne')::date::text as last_order, a.spend_365::float8 as spend_365,
            (select count(*)::int from crm.rep_account_exclusions e where e.account_id = a.id) as hidden_from_reps
          from crm.accounts a
          left join crm.reps r on r.id = a.rep_id
          left join crm.account_status s on s.account_id = a.id
          where (a.archived or a.misc
                 or (exists (select 1 from crm.quotes q where q.account_id = a.id) and not exists (select 1 from crm.quotes q where q.account_id = a.id and q.misc_type is null))
                 or exists (select 1 from crm.rep_account_exclusions e where e.account_id = a.id))
          order by 5, a.name`;
        const why = new Map<string, number>();
        for (const r of rows) why.set(r.why_hidden, (why.get(r.why_hidden) ?? 0) + 1);
        return sendWorkbook(res, 'archived-and-hidden-accounts.xlsx', [
          { name: 'Summary', rows: [...why.entries()].sort((a, b) => b[1] - a[1]).map(([Why, Accounts]) => ({ Why, Accounts })) },
          { name: 'Hidden accounts', rows: rows.map(r => ({
            Account: r.name, State: r.state, Category: r.category, Rep: r.rep ?? '', 'Why hidden': r.why_hidden, Status: r.crm_status ?? '',
            'In DEAR': r.in_dear ? 'Yes' : 'No', Created: r.created ?? '', 'Last order': r.last_order ?? '', 'Spend 365 days': r.spend_365, 'Hidden from reps': r.hidden_from_reps,
          })) },
        ]);
      }

      case 'credit-movements': {
        // Every credit note on account, and every credit movement.
        const regions = regionsParam(req.query.region);
        const date = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
        const notes = await loadCreditNotes(req.rep!, { regions, q: String(req.query.q ?? '').trim() || undefined });
        const reservations = await loadReservations(req.rep!, { regions, q: String(req.query.q ?? '').trim() || undefined });
        const held = await loadHeld(req.rep!, { regions, q: String(req.query.q ?? '').trim() || undefined });
        const moves = await loadMovements(req.rep!, {
          regions, q: String(req.query.q ?? '').trim() || undefined, type: String(req.query.type ?? '') || undefined,
          from: date(req.query.from), to: date(req.query.to), limit: 20000,
        });
        return sendWorkbook(res, 'credit.xlsx', [
          { name: 'Credit notes', rows: notes.map(n => ({
            Customer: n.account, State: n.region, Rep: n.rep ?? '', 'Credit no': n.creditNo, Date: n.date ?? '', Order: n.orderNo,
            Total: n.total, Applied: n.applied, Refunded: n.refunded, 'On account': n.onAccount,
            Reserved: n.reservedAmount, 'Reserved for': n.reservedFor ?? '', Free: n.free,
          })) },
          { name: 'Prepayments', rows: held.map(h => ({
            Customer: h.account, State: h.region, Rep: h.rep ?? '', Order: h.number, Status: h.status, 'Order date': h.orderDate ?? '',
            Type: h.kind, Amount: h.amount, Action: h.finished ? 'Finished order: apply in DEAR or refund' : 'Held for the open order',
          })) },
          { name: 'Reservations', rows: reservations.map(r => ({
            Name: r.name, Customer: r.account, State: r.region, Rep: r.rep ?? '', Amount: r.amount, 'Credit no': r.creditNo ?? '',
            'Sales order / quote': r.orderRef ?? 'Next order', 'Used on': r.usedOnOrder ?? '', Note: r.note ?? '',
            Status: r.status === 'cancelled' ? 'Released' : r.status === 'used' ? 'Used' : 'Reserved',
            'Reserved on': xlDate(new Date(r.createdAt)), 'Reserved by': r.createdBy ?? '',
            'Closed on': r.resolvedAt ? xlDate(new Date(r.resolvedAt)) : '', 'Closed by': r.resolvedBy ?? '',
          })) },
          { name: 'Movements', rows: moves.rows.map(m => ({
            Date: m.date ?? '', Type: m.type, Customer: m.account, State: m.region, Rep: m.rep ?? '',
            'Credit no': m.creditNo ?? '', Reference: m.reference ?? '', Amount: m.amount, By: m.by ?? '',
          })) },
        ]);
      }

      default:
        return res.status(404).json({ error: `Unknown report type: ${type}` });
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: (e as Error).message });
  }
});