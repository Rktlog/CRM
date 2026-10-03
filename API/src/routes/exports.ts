import { Router } from 'express';
import * as XLSX from 'xlsx';
import { prisma } from '../lib/prisma';
import { territoryWhere, canSeeAccount } from '../lib/territory';
import { LIVE_ORDER, isHistory } from '../lib/orderSource';
import { wholesalePrice, retailPrice } from '../lib/pricing';

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
}): string {
  if (isHistory(q)) return '';
  if (q.miscType) return 'No charge';
  const pay = (q.paymentStatus ?? '').toUpperCase();
  if (pay === 'PREPAID') return 'Prepaid';
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
        const quotes = await prisma.quote.findMany({ where: { accountId: { in: accounts.map(a => a.id) }, paid: false, ...LIVE_ORDER }, orderBy: { sentAt: 'asc' } });
        const rows = quotes.map(q => ({
          Order: q.number,
          Date: q.sentAt.toISOString().slice(0, 10),
          Account: accountById.get(q.accountId)?.name ?? 'Unknown',
          Contact: accountById.get(q.accountId)?.contactName ?? '',
          Phone: accountById.get(q.accountId)?.phone ?? '',
          Status: q.fulfillmentStatus ?? '',
          Amount: q.amount,
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

        const quotes = await prisma.quote.findMany({ where: { accountId }, select: { id: true } });
        const lines = await prisma.quoteLine.findMany({ where: { quoteId: { in: quotes.map(q => q.id) } } });

        const bySku = new Map<string, { productName: string; brand: string | null; quantity: number; total: number }>();
        for (const l of lines) {
          const e = bySku.get(l.sku) ?? { productName: l.productName, brand: l.brand, quantity: 0, total: 0 };
          e.quantity += l.quantity; e.total += l.lineTotal;
          bySku.set(l.sku, e);
        }
        // Current prices and stock from crm.products (kept in sync with DEAR).
        const products = new Map((await prisma.product.findMany({
          where: { sku: { in: [...bySku.keys()] } },
          select: { sku: true, prices: true, available: true },
        })).map(p => [p.sku, p]));

        const rows = [...bySku.entries()]
          .map(([sku, v]) => {
            const p = products.get(sku);
            const prices = p?.prices as Record<string, number> | undefined;
            return {
              SKU: sku,
              Product: v.productName,
              Brand: v.brand ?? 'Unbranded',
              Quantity: v.quantity,
              Total: cents(v.total),
              'Wholesale price': wholesalePrice(prices) ?? '',
              'Retail price': retailPrice(prices) ?? '',
              'Available now': p ? p.available : '',
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
            (select min(pl.last_received_at) from crm.purchase_lines pl where pl.sku = s.sku and pl.quantity_received > 0) as first_received,
            (select min(q.sent_at) from crm.quote_lines l join crm.quotes q on q.id = l.quote_id where l.sku = s.sku) as first_sold
          from unnest(${allSkus}::text[]) as s(sku)
        `;
        const isNew = new Map(firstSeen.map(f => [
          f.sku,
          !!f.first_received && f.first_received >= newCutoff && (!f.first_sold || f.first_sold >= newCutoff),
        ]));

        // Next expected delivery for anything on order.
        const openPOs = await prisma.purchaseLine.findMany({
          where: { sku: { in: allSkus }, purchase: { status: { notIn: ['VOIDED', 'CREDITED', 'DRAFT', 'COMPLETED'] } } },
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

      case 'misc-marketing':
      case 'misc-warranty': {
        const miscType = type === 'misc-marketing' ? 'marketing' : 'warranty';
        const quotes = await prisma.quote.findMany({
          where: { miscType },
          include: { account: { select: { name: true, region: true } } },
          orderBy: { sentAt: 'desc' },
        });
        const rows = quotes.map(q => ({
          Account: q.account.name, Region: q.account.region, Order: q.number,
          Date: q.sentAt.toISOString().slice(0, 10), Amount: q.amount, Reference: q.reference ?? '', Source: q.source,
        }));
        return sendWorkbook(res, `misc-${miscType}.xlsx`, [{ name: miscType === 'warranty' ? 'Warranty' : 'Marketing', rows }]);
      }

      case 'rep-activity': {
        const isManager = req.rep!.role === 'manager';
        const days = req.query.days ? Number(req.query.days) : 30;
        const since = new Date(Date.now() - days * 86400000);
        const activities = await prisma.activity.findMany({
          where: { occurredAt: { gte: since }, ...(isManager ? {} : { repId: req.rep!.id }) },
          include: { rep: { select: { name: true } }, account: { select: { name: true, region: true } } },
          orderBy: { occurredAt: 'desc' },
        });
        const rows = activities.map(a => ({
          Date: a.occurredAt.toISOString().slice(0, 10), Rep: a.rep?.name ?? 'Unknown', Type: a.type,
          Account: a.account?.name ?? 'Unknown', Region: a.account?.region ?? '', Note: a.note,
        }));
        return sendWorkbook(res, 'rep-activity.xlsx', [{ name: 'Rep Activity', rows }]);
      }

      default:
        return res.status(404).json({ error: `Unknown report type: ${type}` });
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: (e as Error).message });
  }
});