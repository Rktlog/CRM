import { Router } from 'express';
import * as XLSX from 'xlsx';
import { prisma } from '../lib/prisma';

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
  const where: any = { ...(isManager ? {} : { repId: req.rep!.id }) };
  if (region) where.region = { in: region.split(',') };
  if (isManager && repId) where.repId = repId;
  const accounts = await prisma.account.findMany({ where, select: { id: true, name: true, region: true, type: true, stage: true, category: true, contactName: true, phone: true, email: true, spend30: true, spend90: true, spend365: true, lastOrderAt: true, avgOrderGapDays: true, repId: true, archived: true } });
  return accounts;
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
        const quotes = await prisma.quote.findMany({ where: { accountId: { in: accounts.map(a => a.id) }, paid: false }, orderBy: { sentAt: 'asc' } });
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

        const account = await prisma.account.findUnique({ where: { id: accountId }, select: { id: true, name: true, repId: true } });
        if (!account) return res.status(404).json({ error: 'Account not found' });
        const isManager = req.rep!.role === 'manager';
        if (!isManager && account.repId !== req.rep!.id) return res.status(403).json({ error: 'Not your account' });

        const quotes = await prisma.quote.findMany({ where: { accountId }, select: { id: true } });
        const lines = await prisma.quoteLine.findMany({ where: { quoteId: { in: quotes.map(q => q.id) } } });

        const bySku = new Map<string, { productName: string; brand: string | null; quantity: number; total: number }>();
        for (const l of lines) {
          const e = bySku.get(l.sku) ?? { productName: l.productName, brand: l.brand, quantity: 0, total: 0 };
          e.quantity += l.quantity; e.total += l.lineTotal;
          bySku.set(l.sku, e);
        }
        const rows = [...bySku.entries()]
          .map(([sku, v]) => ({ SKU: sku, Product: v.productName, Brand: v.brand ?? 'Unbranded', Quantity: v.quantity, Total: Math.round(v.total * 100) / 100 }))
          .sort((a, b) => b.Total - a.Total);

        const safeName = account.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
        return sendWorkbook(res, `${safeName}-products.xlsx`, [{ name: 'Products Purchased', rows }]);
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
