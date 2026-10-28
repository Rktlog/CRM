import express, { Router } from 'express';
import { prisma } from '../lib/prisma';
import { assignedRegions, hiddenAccountIds } from '../lib/territory';

// DEAR statuses of a quote that is not yet an order, and of an order that no longer stands.
const QUOTE_STAGE = ['DRAFT', 'ESTIMATING', 'ESTIMATED', 'ORDERING'];
const NO_LONGER_STANDS = /^(VOIDED|CREDITED)/i;
const isQuoteStage = (status: string | null) => QUOTE_STAGE.includes((status ?? '').toUpperCase());
const isCancelled = (status: string | null) => NO_LONGER_STANDS.test((status ?? '').trim());
const SHOWN_BEFORE = 5;   // earlier orders and quotes listed under the order that replaced them

export const abandonedCartsRouter = Router();

// B2B portal abandoned carts. Cin7 has no API for these, so they come
// in from the portal's Abandoned Carts CSV export. Accounts, SKUs, stock
// and "ordered since" are all matched here at read time.
//
// "Ordered since" follows the order as it is NOW. When an order is fixed it is often voided and made again under a new
// number, or a quote becomes the real order, so a cart shows the standing order that came after it (the first one that is
// not voided and not still a quote), says which earlier orders or quotes it replaces, and, with no real order yet, shows
// the quote that has been prepared. People can also keep a log (notes, calls, emails) on each cart.

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

// Every cart in the window, matched to accounts, with stock and "ordered
// since", limited to what this person can see. Used by the Abandoned
// carts page and the email review queue.
export async function loadCarts(rep: { id: string; role: string }, days: string) {
  const isManager = rep.role === 'manager';

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
    prisma.account.findMany({ select: { id: true, name: true, email: true, phone: true, region: true, repId: true, rep: { select: { name: true } } } }),
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

  // The phone to show on a cart: the account's own, or when it has none the phone on that customer's most recent order.
  const needPhone = [...new Set(matched.map(m => m.account).filter((a): a is NonNullable<typeof a> => !!a && !a.phone?.trim()).map(a => a.id))];
  const orderPhone = new Map<string, string>();
  if (needPhone.length) {
    const rows = await prisma.quote.findMany({
      where: { accountId: { in: needPhone }, orderPhone: { not: null } },
      select: { accountId: true, orderPhone: true },
      orderBy: { sentAt: 'desc' },
    });
    for (const r of rows) if (r.orderPhone?.trim() && !orderPhone.has(r.accountId)) orderPhone.set(r.accountId, r.orderPhone.trim());
  }
  const phoneFor = (a: { id: string; phone: string | null }) => a.phone?.trim() || orderPhone.get(a.id) || null;

  // Same territory rule as Accounts (lib/territory): reps see carts for
  // accounts in their assigned states only; managers see everything,
  // including carts from customers not in the CRM yet.
  const myRegions = isManager ? [] : await assignedRegions(rep.id);
  const hidden = new Set(isManager ? [] : await hiddenAccountIds(rep.id));
  const visible = matched.filter(c => isManager || (c.account && myRegions.includes(c.account.region) && !hidden.has(c.account.id)));

  // ---- Ordered since: first order by that account after the cart ----
  const accountIds = [...new Set(visible.map(c => c.account?.id).filter(Boolean))] as string[];
  const earliest = visible.reduce((min, c) => (c.abandonedAt < min ? c.abandonedAt : min), new Date());
  const laterOrders = accountIds.length
    ? await prisma.quote.findMany({
        where: { accountId: { in: accountIds }, sentAt: { gte: earliest }, miscType: null, source: { not: 'rhino-history' } },
        select: { id: true, number: true, sentAt: true, accountId: true, fulfillmentStatus: true, total: true, amount: true, lines: { select: { sku: true, productName: true } } },
        orderBy: { sentAt: 'asc' },
      })
    : [];

  const result = visible.map(c => {
    // The orders and quotes this customer has had since the cart, oldest first.
    const after = c.account ? laterOrders.filter(o => o.accountId === c.account!.id && o.sentAt >= c.abandonedAt) : [];
    const order = after.find(o => !isCancelled(o.fulfillmentStatus) && !isQuoteStage(o.fulfillmentStatus));   // the one that stands
    const quote = order ? undefined : [...after].reverse().find(o => isQuoteStage(o.fulfillmentStatus));    // no order yet: the quote prepared
    const shown = order ?? quote;
    // Earlier versions the shown one has taken over from: a voided order, a quote that became the order.
    const replaces = after.filter(o => o !== shown && (isCancelled(o.fulfillmentStatus) || isQuoteStage(o.fulfillmentStatus)) && (!shown || o.sentAt <= shown.sentAt))
      .slice(-SHOWN_BEFORE).map(o => ({ quoteId: o.id, number: o.number, status: o.fulfillmentStatus ?? '' }));
    // Cancelled orders when nothing has taken their place.
    const cancelled = !shown ? after.filter(o => isCancelled(o.fulfillmentStatus)).slice(-SHOWN_BEFORE).map(o => ({ quoteId: o.id, number: o.number, status: o.fulfillmentStatus ?? '' })) : [];

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

    // How many of the cart's items turned up on the order, and how many items on it were not in the cart.
    const compare = (o: (typeof after)[number] | undefined) => {
      if (!o) return { itemsOrdered: 0, otherItems: 0 };
      const orderSkus = new Set(o.lines.map(l => l.sku));
      const orderNames = new Set(o.lines.map(l => l.productName.trim().toLowerCase()));
      const inCart = (sku: string, name: string) => items.some(i => (i.sku && i.sku === sku) || i.productName.trim().toLowerCase() === name.trim().toLowerCase());
      const itemsOrdered = items.filter(i => (i.sku && orderSkus.has(i.sku)) || orderNames.has(i.productName.trim().toLowerCase())).length;
      const otherItems = new Set(o.lines.filter(l => !inCart(l.sku, l.productName)).map(l => l.sku)).size;
      return { itemsOrdered, otherItems };
    };
    const money = (o: (typeof after)[number]) => Math.round((o.total ?? o.amount ?? 0) * 100) / 100;

    return {
      id: `${c.abandonedAt.toISOString()}|${c.email}`,
      abandonedAt: c.abandonedAt,
      contact: c.contact,
      email: c.email,
      account: c.account ? { id: c.account.id, name: c.account.name, rep: c.account.rep?.name ?? null, region: c.account.region ?? null, phone: phoneFor(c.account) } : null,   // region is the customer's state
      itemCount: items.length,
      units: items.reduce((s, i) => s + i.quantity, 0),
      value: Math.round(items.reduce((s, i) => s + i.total, 0) * 100) / 100,
      status: order ? 'ordered' : 'open',
      // The order as it stands now (kept as before: quoteId, number, date, itemsOrdered), with where it has got to and what it replaced.
      orderedSince: order ? { quoteId: order.id, number: order.number, date: order.sentAt, ...compare(order), status: order.fulfillmentStatus ?? '', total: money(order), replaces } : null,
      // Still open, but a quote has been prepared for them.
      quotePrepared: quote ? { quoteId: quote.id, number: quote.number, date: quote.sentAt, ...compare(quote), status: quote.fulfillmentStatus ?? '', total: money(quote), replaces } : null,
      cancelled,
      items: items.sort((a, b) => b.total - a.total),
    };
  });
  return result;
}

// ---------- The log on each cart ----------
// Notes, calls and emails, kept per cart and shown to everyone who can see the cart. A cart is identified by its page id
// (abandoned time, a bar, email). Stored in crm.abandoned_cart_logs (abandoned-cart-logs.sql).
const METHODS = ['note', 'called', 'emailed', 'left_message'];
const MAX_NOTE = 2000;
type LogRow = { id: string; cart_key: string; method: string | null; note: string; created_at: Date; rep_id: string; rep_name: string | null };
const shapeLog = (l: LogRow, me: string) => ({ id: l.id, method: l.method ?? 'note', note: l.note, at: new Date(l.created_at).toISOString(), by: l.rep_name, mine: l.rep_id === me });

async function loadLogs(keys: string[], me: string): Promise<{ logs: Map<string, ReturnType<typeof shapeLog>[]>; available: boolean }> {
  const logs = new Map<string, ReturnType<typeof shapeLog>[]>();
  if (!keys.length) return { logs, available: true };
  try {
    const rows = await prisma.$queryRaw<LogRow[]>`
      select l.id, l.cart_key, l.method, l.note, l.created_at, l.rep_id, r.name as rep_name
      from crm.abandoned_cart_logs l left join crm.reps r on r.id = l.rep_id
      where l.cart_key = any(${keys}::text[])
      order by l.created_at desc`;
    for (const r of rows) logs.set(r.cart_key, [...(logs.get(r.cart_key) ?? []), shapeLog(r, me)]);
    return { logs, available: true };
  } catch (e) {
    console.error('cart logs unavailable:', (e as Error).message);   // the table has not been added yet
    return { logs, available: false };
  }
}

// POST /abandoned-carts/log   { cart: '<page id>', note: '...', method?: 'note' | 'called' | 'emailed' | 'left_message' }
abandonedCartsRouter.post('/log', async (req, res) => {
  const cart = String(req.body?.cart ?? ''), note = String(req.body?.note ?? '').trim();
  const method = req.body?.method == null || req.body.method === '' ? 'note' : String(req.body.method);
  if (!note) return res.status(400).json({ error: 'Write something to log' });
  if (note.length > MAX_NOTE) return res.status(400).json({ error: `That note is too long (the most is ${MAX_NOTE.toLocaleString('en-AU')} characters)` });
  if (!METHODS.includes(method)) return res.status(400).json({ error: `Method must be one of ${METHODS.join(', ')}` });
  const at = new Date(cart.split('|')[0]);
  if (!cart.includes('|') || Number.isNaN(at.getTime())) return res.status(404).json({ error: 'That cart was not found' });
  // Only carts this person can see: the same territory rule as the list.
  const visible = (await loadCarts(req.rep!, String(Math.ceil((Date.now() - at.getTime()) / 86400000) + 1))).find(c => c.id === cart);
  if (!visible) return res.status(404).json({ error: 'That cart was not found' });
  try {
    const [row] = await prisma.$queryRaw<LogRow[]>`
      with ins as (insert into crm.abandoned_cart_logs (cart_key, rep_id, method, note) values (${cart}, ${req.rep!.id}::uuid, ${method}, ${note}) returning *)
      select ins.id, ins.cart_key, ins.method, ins.note, ins.created_at, ins.rep_id, r.name as rep_name from ins left join crm.reps r on r.id = ins.rep_id`;
    res.status(201).json(shapeLog(row, req.rep!.id));
  } catch (e) {
    if (/abandoned_cart_logs/.test((e as Error).message)) return res.status(503).json({ error: 'Cart logs are not set up yet. Run abandoned-cart-logs.sql in the database.' });
    throw e;
  }
});

// DELETE /abandoned-carts/log/:id   the person who wrote it, or a manager
abandonedCartsRouter.delete('/log/:id', async (req, res) => {
  const id = String(req.params.id);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return res.status(404).json({ error: 'That entry was not found' });
  try {
    const [row] = await prisma.$queryRaw<{ rep_id: string }[]>`select rep_id from crm.abandoned_cart_logs where id = ${id}::uuid`;
    if (!row) return res.status(404).json({ error: 'That entry was not found' });
    if (row.rep_id !== req.rep!.id && req.rep!.role !== 'manager') return res.status(403).json({ error: 'You can only delete your own entries' });
    await prisma.$queryRaw`delete from crm.abandoned_cart_logs where id = ${id}::uuid`;
    res.json({ ok: true });
  } catch (e) {
    if (/abandoned_cart_logs/.test((e as Error).message)) return res.status(503).json({ error: 'Cart logs are not set up yet. Run abandoned-cart-logs.sql in the database.' });
    throw e;
  }
});

// ---------- GET /abandoned-carts ----------
// ?status=open|ordered|all  ?days=30|90|365|all
abandonedCartsRouter.get('/', async (req, res) => {
  const status = String(req.query.status ?? 'open');
  const days = String(req.query.days ?? '90');
  const result = await loadCarts(req.rep!, days);

  const filtered = result.filter(c => status === 'all' || c.status === status);
  const open = result.filter(c => c.status === 'open');

  const latestImport = await prisma.abandonedCartLine.findFirst({ orderBy: { importedAt: 'desc' }, select: { importedAt: true } });
  const { logs, available: logsAvailable } = await loadLogs(filtered.map(c => c.id), req.rep!.id);

  res.json({
    summary: {
      openCarts: open.length,
      openValue: Math.round(open.reduce((s, c) => s + c.value, 0) * 100) / 100,
      orderedCarts: result.length - open.length,
      notInCrm: result.filter(c => !c.account).length,
    },
    lastImportedAt: latestImport?.importedAt ?? null,
    logsAvailable,
    carts: filtered.map(c => ({ ...c, logs: logs.get(c.id) ?? [] })),
  });
});