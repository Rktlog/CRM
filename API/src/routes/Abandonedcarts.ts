import express, { Router } from 'express';
import { prisma } from '../lib/prisma';
import { assignedRegions } from '../lib/territory';

export const abandonedCartsRouter = Router();

// B2B portal abandoned carts. Cin7 has no API for these, so they come
// in from the portal's Abandoned Carts CSV export. Accounts, SKUs, stock
// and "ordered since" are all matched here at read time.

const EXPECTED_COLUMNS = ['AbandonedDateTime', 'Product', 'Quantity', 'Price', 'Total', 'Contact', 'Email'];
// Carts placed while testing the portal, not real customers.
const TEST_CONTACT = /\btest\b/i;

// ---------- CSV parsing ----------
// Cin7's export quotes fields that contain commas, but leaves inch marks
// unquoted mid-field (`Miffy - 23 cm - 9"`). A quote only opens a quoted
// field when it's the first character of the field, which handles both.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let fieldStart = true;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
      continue;
    }
    if (c === '"' && fieldStart) { inQuotes = true; fieldStart = false; continue; }
    if (c === ',') { row.push(field); field = ''; fieldStart = true; continue; }
    if (c === '\r') continue;
    if (c === '\n') {
      row.push(field);
      if (row.some(f => f !== '')) rows.push(row);
      row = []; field = ''; fieldStart = true;
      continue;
    }
    field += c;
    fieldStart = false;
  }
  row.push(field);
  if (row.some(f => f !== '')) rows.push(row);
  return rows;
}

// Cin7 exports "2025/07/23 01:04" in the account's local time (Melbourne).
// Convert to a real UTC instant, daylight saving included, so carts line
// up with order dates.
export function melbourneToUtc(text: string): Date | null {
  const m = text.trim().match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const asIfUtc = Date.UTC(y, mo - 1, d, h, mi);
  const offsetAt = (t: number) => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Australia/Melbourne', hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(new Date(t));
    const get = (type: string) => Number(parts.find(p => p.type === type)!.value);
    return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute')) - t;
  };
  // Two passes settle the offset correctly around daylight-saving changes.
  let utc = asIfUtc - offsetAt(asIfUtc);
  utc = asIfUtc - offsetAt(utc);
  return new Date(utc);
}

const normalize = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]/g, '');

// ---------- POST /abandoned-carts/import ----------
// Body: the CSV file as text. Re-importing a full export is safe.
abandonedCartsRouter.post('/import', express.text({ type: '*/*', limit: '20mb' }), async (req, res) => {
  const rows = parseCsv(String(req.body ?? '').replace(/^\uFEFF/, ''));
  if (rows.length < 2) return res.status(400).json({ error: 'The file is empty.' });

  const header = rows[0].map(h => h.trim());
  const col = Object.fromEntries(EXPECTED_COLUMNS.map(c => [c, header.indexOf(c)]));
  const missing = EXPECTED_COLUMNS.filter(c => col[c] < 0);
  if (missing.length) {
    return res.status(400).json({ error: `This doesn't look like Cin7's Abandoned Carts export. Missing: ${missing.join(', ')}` });
  }

  const data: any[] = [];
  let skipped = 0;
  for (const r of rows.slice(1)) {
    const abandonedAt = melbourneToUtc(r[col.AbandonedDateTime] ?? '');
    const email = (r[col.Email] ?? '').trim().toLowerCase();
    const productName = (r[col.Product] ?? '').trim();
    if (!abandonedAt || !email || !productName) { skipped++; continue; }
    data.push({
      abandonedAt,
      contact: (r[col.Contact] ?? '').trim(),
      email,
      productName,
      quantity: Number(r[col.Quantity]) || 0,
      price: Number(r[col.Price]) || 0,
      total: Number(r[col.Total]) || 0,
    });
  }

  const { count } = await prisma.abandonedCartLine.createMany({ data, skipDuplicates: true });
  res.json({ linesInFile: data.length, newLines: count, alreadyHad: data.length - count, skipped });
});

// ---------- GET /abandoned-carts ----------
// ?status=open|ordered|all  ?days=30|90|365|all
abandonedCartsRouter.get('/', async (req, res) => {
  const status = String(req.query.status ?? 'open');
  const days = String(req.query.days ?? '90');
  const isManager = req.rep?.role === 'manager';

  const since = days === 'all' ? new Date(0) : new Date(Date.now() - Number(days || 90) * 86400000);
  const lines = await prisma.abandonedCartLine.findMany({
    where: { abandonedAt: { gte: since } },
    orderBy: [{ abandonedAt: 'desc' }, { productName: 'asc' }],
  });

  // ---- Group lines into carts ----
  const carts = new Map<string, { abandonedAt: Date; contact: string; email: string; lines: typeof lines }>();
  for (const l of lines) {
    if (TEST_CONTACT.test(l.contact)) continue;
    const key = `${l.abandonedAt.toISOString()}|${l.email}`;
    const c = carts.get(key) ?? { abandonedAt: l.abandonedAt, contact: l.contact, email: l.email, lines: [] };
    c.lines.push(l);
    carts.set(key, c);
  }

  // ---- Match accounts: by email (account or past order), then by name ----
  const [accounts, orderEmails, products] = await Promise.all([
    prisma.account.findMany({ select: { id: true, name: true, email: true, region: true, repId: true, rep: { select: { name: true } } } }),
    prisma.quote.findMany({
      where: { orderEmail: { not: null } },
      select: { orderEmail: true, accountId: true },
      distinct: ['orderEmail', 'accountId'],
    }),
    prisma.product.findMany({ select: { sku: true, name: true, available: true } }),
  ]);
  const accountById = new Map(accounts.map(a => [a.id, a]));
  const accountByEmail = new Map<string, (typeof accounts)[number]>();
  for (const a of accounts) if (a.email) accountByEmail.set(a.email.trim().toLowerCase(), a);
  for (const o of orderEmails) {
    const a = accountById.get(o.accountId);
    if (a && o.orderEmail && !accountByEmail.has(o.orderEmail.trim().toLowerCase())) {
      accountByEmail.set(o.orderEmail.trim().toLowerCase(), a);
    }
  }
  const accountByName = new Map(accounts.map(a => [normalize(a.name), a]));
  const productByName = new Map(products.map(p => [p.name.trim().toLowerCase(), p]));

  const matched = [...carts.values()].map(c => ({
    ...c,
    account: accountByEmail.get(c.email) ?? accountByName.get(normalize(c.contact)) ?? null,
  }));

  // Same territory rule as Accounts (lib/territory): reps see carts for
  // accounts in their assigned states only; managers see everything,
  // including carts from customers not in the CRM yet.
  const myRegions = isManager ? [] : await assignedRegions(req.rep!.id);
  const visible = matched.filter(c => isManager || (c.account && myRegions.includes(c.account.region)));

  // ---- Ordered since: first order by that account after the cart ----
  const accountIds = [...new Set(visible.map(c => c.account?.id).filter(Boolean))] as string[];
  const earliest = visible.reduce((min, c) => (c.abandonedAt < min ? c.abandonedAt : min), new Date());
  const laterOrders = accountIds.length
    ? await prisma.quote.findMany({
        where: { accountId: { in: accountIds }, sentAt: { gte: earliest }, miscType: null },
        select: { id: true, number: true, sentAt: true, accountId: true, lines: { select: { sku: true, productName: true } } },
        orderBy: { sentAt: 'asc' },
      })
    : [];

  const result = visible.map(c => {
    const order = c.account
      ? laterOrders.find(o => o.accountId === c.account!.id && o.sentAt >= c.abandonedAt)
      : undefined;

    const items = c.lines.map(l => {
      const product = productByName.get(l.productName.trim().toLowerCase());
      return {
        productName: l.productName,
        sku: product?.sku ?? null,
        available: product ? product.available : null,
        quantity: l.quantity,
        price: l.price,
        total: Math.round(l.total * 100) / 100,
      };
    });

    // How many of the cart's items turned up in that later order.
    let itemsOrdered = 0;
    if (order) {
      const orderSkus = new Set(order.lines.map(l => l.sku));
      const orderNames = new Set(order.lines.map(l => l.productName.trim().toLowerCase()));
      itemsOrdered = items.filter(i => (i.sku && orderSkus.has(i.sku)) || orderNames.has(i.productName.trim().toLowerCase())).length;
    }

    return {
      id: `${c.abandonedAt.toISOString()}|${c.email}`,
      abandonedAt: c.abandonedAt,
      contact: c.contact,
      email: c.email,
      account: c.account ? { id: c.account.id, name: c.account.name, rep: c.account.rep?.name ?? null } : null,
      itemCount: items.length,
      units: items.reduce((s, i) => s + i.quantity, 0),
      value: Math.round(items.reduce((s, i) => s + i.total, 0) * 100) / 100,
      status: order ? 'ordered' : 'open',
      orderedSince: order ? { quoteId: order.id, number: order.number, date: order.sentAt, itemsOrdered } : null,
      items: items.sort((a, b) => b.total - a.total),
    };
  });

  const filtered = result.filter(c => status === 'all' || c.status === status);
  const open = result.filter(c => c.status === 'open');

  const latestImport = await prisma.abandonedCartLine.findFirst({ orderBy: { importedAt: 'desc' }, select: { importedAt: true } });

  res.json({
    summary: {
      openCarts: open.length,
      openValue: Math.round(open.reduce((s, c) => s + c.value, 0) * 100) / 100,
      orderedCarts: result.length - open.length,
      notInCrm: result.filter(c => !c.account).length,
    },
    lastImportedAt: latestImport?.importedAt ?? null,
    carts: filtered,
  });
});
