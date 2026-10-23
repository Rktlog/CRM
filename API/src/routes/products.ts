import express, { Router } from 'express';
import { prisma } from '../lib/prisma';
import { HISTORY_SOURCE, LIVE_ORDER, isHistory } from '../lib/orderSource';
import { pickPrice, WHOLESALE, RETAIL } from '../lib/pricing';
import { parseDay, parseFile, planImport, productTemplate, MAX_IMPORT_CHANGES } from '../lib/productImport';
import { loadStatuses, listStatuses, matchStatus, normName, clearStatusCache, labelProblem, slugKey, TONES, SYSTEM_KEYS, MAX_STATUSES } from '../lib/productStatuses';
import { chooseEta, incomingFor } from '../lib/eta';
import { melDay } from '../lib/receivables';

const dayOf = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

export const productsRouter = Router();

// Reads only from our own tables, never DEAR:
//   crm.products        stock + price tiers  (sync-products)
//   crm.purchases/lines incoming POs, history (sync-purchases)
//   crm.quotes/lines    sales, open orders    (sync-sales)
// Company-wide like Sales Data: every rep sees the same picture.

const MAX_RESULTS = 25;
const CANDIDATES = 200; // fetched before ranking, then trimmed
const HISTORY_SHOWN = 8;

// Order statuses that never hold stock.
const CLOSED_ORDER_STATUSES = ['COMPLETED', 'VOIDED', 'CREDITED', 'DRAFT', 'ESTIMATING', 'ESTIMATED'];
// DEAR releases allocated stock when the order is picked (not when it
// ships), so "allocated" means authorised and not yet fully picked.
const OPEN_PICKING_STATUSES = ['NOT PICKED', 'PARTIALLY PICKED'];
// Fallback for orders synced before picking status was captured.
const OPEN_SHIPPING_STATUSES = ['NOT SHIPPED', 'PARTIALLY SHIPPED'];
const DEAD_PURCHASE_STATUSES = ['VOIDED', 'CREDITED', 'DRAFT'];
// Order statuses where nothing has necessarily shipped yet. Used for
// older orders synced before per-SKU ship quantities were captured.
const UNSHIPPED_ORDER_STATUSES = ['DRAFT', 'ESTIMATING', 'ESTIMATED', 'ORDERING', 'ORDERED', 'BACKORDERED'];
const PURCHASES_SHOWN = 10;

// DEAR's own receiving status is the source of truth for "is anything
// still to come", even if the line-level received qty didn't parse.
function fullyReceived(status: string | null, receivingStatus: string | null): boolean {
  const r = (receivingStatus ?? '').toUpperCase();
  const s = (status ?? '').toUpperCase();
  // e.g. 'COMPLETED' or 'COMPLETED / CREDIT NOTE CLOSED'
  return r.includes('FULLY RECEIVED') || s.startsWith('COMPLETED') || s === 'RECEIVED';
}

type Location = { location: string; onHand: number; allocated: number; available: number; onOrder: number };

// Split into words; every word must match the SKU, name or brand, in
// any order. "miffy offwhite" finds "Miffy ECO Corduroy Offwhite - 23 cm".
export function searchWords(q: string): string[] {
  return q.split(/\s+/).map(w => w.trim()).filter(Boolean).slice(0, 8);
}

function rank(sku: string, name: string, q: string, words: string[]): number {
  const s = sku.toLowerCase();
  const n = name.toLowerCase();
  if (s === q) return 0;
  if (s.startsWith(q)) return 1;
  if (n.startsWith(words[0])) return 2;
  if (n.includes(q)) return 3; // words appear together, in order
  return 4;
}

// The product description DEAR holds, as plain text (filled by the sync), for the Products page. The catalogue does not show it. A separate read, so product search keeps working
// even before the column has been added.
async function descriptionsFor(skus: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!skus.length) return out;
  try {
    const rows = await prisma.$queryRaw<{ sku: string; description: string | null }[]>`select sku, description from crm.products where sku = any(${skus}::text[]) and description is not null`;
    for (const r of rows) if (r.description) out.set(r.sku, r.description);
  } catch (e) { console.error('product descriptions unavailable:', (e as Error).message); }
  return out;
}

// Weight (kg) and size (cm) from DEAR, saved by the sync. A separate read, so the pages keep working before product-dimensions.sql
// has added the columns.
type Specs = { weightKg: number | null; lengthCm: number | null; widthCm: number | null; heightCm: number | null };
async function specsFor(skus: string[]): Promise<Map<string, Specs>> {
  const out = new Map<string, Specs>();
  if (!skus.length) return out;
  try {
    const rows = await prisma.$queryRaw<{ sku: string; weight_kg: number | null; length_cm: number | null; width_cm: number | null; height_cm: number | null }[]>`
      select sku, weight_kg, length_cm, width_cm, height_cm from crm.products where sku = any(${skus}::text[])
        and (weight_kg is not null or length_cm is not null or width_cm is not null or height_cm is not null)`;
    const n = (v: number | null) => (v == null ? null : Number(v));
    for (const r of rows) out.set(r.sku, { weightKg: n(r.weight_kg), lengthCm: n(r.length_cm), widthCm: n(r.width_cm), heightCm: n(r.height_cm) });
  } catch (e) { console.error('product weights and sizes unavailable:', (e as Error).message); }
  return out;
}

// The order increment from the DEAR description ("ORDER INCREMENT: 4"): customers order in multiples of it. Saved by the
// sync. A separate read, so the pages keep working before the column has been added.
async function incrementsFor(skus: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!skus.length) return out;
  try {
    const rows = await prisma.$queryRaw<{ sku: string; order_increment: number | null }[]>`select sku, order_increment from crm.products where sku = any(${skus}::text[]) and order_increment is not null`;
    for (const r of rows) if (r.order_increment) out.set(r.sku, Number(r.order_increment));
  } catch (e) { console.error('order increments unavailable:', (e as Error).message); }
  return out;
}

// ---------- Product status (EOL, Discontinued, Pre-order, New, Confirmed for Ranging, For Customer Only Then Cease, Preorder Only) and photo links ----------
// Set one product by hand, or many from a spreadsheet. Managers only. Everything else about a product comes from DEAR.
const managersOnly = (req: any, res: any) => {
  if (req.rep!.role === 'manager') return true;
  res.status(403).json({ error: 'Only a manager can change product statuses and photos' });
  return false;
};

// GET /products/template            every product with its current photo link and status, to edit and import back
// GET /products/template?blank=1    just the headings and one example row
productsRouter.get('/template', async (req, res) => {
  if (!managersOnly(req, res)) return;
  const blank = req.query.blank === '1';
  const products = blank ? [] : await prisma.product.findMany({
    where: { OR: [{ status: null }, { status: { not: 'Deprecated' } }] },
    select: { sku: true, name: true, brand: true, imageUrl: true, lifecycle: true, eta: true },
    orderBy: [{ brand: 'asc' }, { sku: 'asc' }],
  });
  const buffer = await productTemplate(products.map(p => ({ ...p, eta: dayOf(p.eta) })), blank, await listStatuses());
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="product-import-${blank ? 'blank-' : ''}template.xlsx"`);
  res.send(buffer);
});

// POST /products/import   body: the file as base64 text (.xlsx or .csv)
//   no query  -> shows what would change, changes nothing
//   ?apply=1&expect=N  -> makes the N changes the preview showed (refuses if the file or products have moved on)
productsRouter.post('/import', express.text({ type: '*/*', limit: '20mb' }), async (req, res) => {
  if (!managersOnly(req, res)) return;
  try {
    const file = parseFile(String(req.body ?? ''));
    const products = (await prisma.product.findMany({ select: { sku: true, name: true, imageUrl: true, lifecycle: true, eta: true } })).map(p => ({ ...p, eta: dayOf(p.eta) }));
    const plan = planImport(file, products, await listStatuses());
    if (req.query.apply !== '1') return res.json({ applied: false, ...plan });

    if (plan.changes.length > MAX_IMPORT_CHANGES) return res.status(400).json({ error: `That would change ${plan.changes.length} products. The most in one import is ${MAX_IMPORT_CHANGES}.` });
    if (Number(req.query.expect) !== plan.changes.length) return res.status(409).json({ error: 'The file or the products changed since the preview. Check the file again, then apply.' });

    const withImage = plan.changes.filter(c => c.image);
    const withStatus = plan.changes.filter(c => c.status);
    const withEta = plan.changes.filter(c => c.eta);
    await prisma.$transaction([
      prisma.$executeRaw`update crm.products p set image_url = v.url
        from unnest(${withImage.map(c => c.sku)}::text[], ${withImage.map(c => c.image!.to)}::text[]) as v(sku, url)
        where p.sku = v.sku`,
      prisma.$executeRaw`update crm.products p set lifecycle = nullif(v.status, '')
        from unnest(${withStatus.map(c => c.sku)}::text[], ${withStatus.map(c => c.status!.to ?? '')}::text[]) as v(sku, status)
        where p.sku = v.sku`,
      prisma.$executeRaw`update crm.products p set eta = nullif(v.eta, '')::date
        from unnest(${withEta.map(c => c.sku)}::text[], ${withEta.map(c => c.eta!.to ?? '')}::text[]) as v(sku, eta)
        where p.sku = v.sku`,
    ]);
    res.json({ applied: true, ...plan });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// ---- The statuses themselves. Anyone signed in can read them; managers add and remove them. ----
// EOL and Discontinued cannot be removed (the automatic EOL rule uses them). Removing a status that products have clears it on
// them, but only when asked to (?clear=1), after being told how many there are; each one is written to the stage log.
async function statusCounts(): Promise<Map<string, number>> {
  const rows = await prisma.$queryRaw<{ lifecycle: string; n: number }[]>`select lifecycle, count(*)::int as n from crm.products where lifecycle is not null group by lifecycle`;
  return new Map(rows.map(r => [r.lifecycle, r.n]));
}
async function statusReply() {
  const { list, fromDb } = await loadStatuses();
  const counts = await statusCounts();
  return { tableReady: fromDb, statuses: list.map(s => ({ ...s, count: counts.get(s.key) ?? 0 })) };
}

// GET /products/statuses -> every status, in order, with how many products have it
productsRouter.get('/statuses', async (_req, res) => {
  try { res.json(await statusReply()); }
  catch (e) { console.error('statuses failed:', (e as Error).message); res.status(500).json({ error: 'Could not load the statuses' }); }
});

// POST /products/statuses   { label, meaning?, tone? }   managers only
productsRouter.post('/statuses', async (req, res) => {
  if (!managersOnly(req, res)) return;
  try {
    const { list, fromDb } = await loadStatuses();
    if (!fromDb) return res.status(503).json({ error: 'Statuses cannot be added yet: run product-statuses.sql in the database first.' });
    const label = typeof req.body?.label === 'string' ? req.body.label.trim().replace(/\s+/g, ' ') : '';
    const problem = labelProblem(label);
    if (problem) return res.status(400).json({ error: problem });
    if (list.length >= MAX_STATUSES) return res.status(400).json({ error: `There can be at most ${MAX_STATUSES} statuses` });
    if (list.some(s => normName(s.label) === normName(label))) return res.status(409).json({ error: `There is already a status called "${list.find(s => normName(s.label) === normName(label))!.label}"` });
    const meaning = typeof req.body?.meaning === 'string' && req.body.meaning.trim() ? req.body.meaning.trim().replace(/\s+/g, ' ') : null;
    if (meaning && meaning.length > 120) return res.status(400).json({ error: 'The description can be at most 120 characters' });
    const tone = req.body?.tone ?? 'neutral';
    if (!(TONES as readonly string[]).includes(tone)) return res.status(400).json({ error: `Colour must be one of ${TONES.join(', ')}` });
    let key = slugKey(label);
    if (key === 'none') return res.status(400).json({ error: '"None" is reserved for products with no status. Choose another name' });
    const base = key; let n = 2;
    while (list.some(s => s.key === key)) key = `${base.slice(0, 36)}_${n++}`;
    const sort = Math.max(0, ...list.map(s => s.sortOrder)) + 10;
    await prisma.$executeRaw`insert into crm.product_statuses (key, label, meaning, tone, system, sort_order) values (${key}, ${label}, ${meaning}, ${tone}, false, ${sort})`;
    clearStatusCache();
    res.status(201).json({ added: key, ...(await statusReply()) });
  } catch (e) {
    clearStatusCache();
    if (/duplicate key|unique/i.test((e as Error).message)) return res.status(409).json({ error: 'There is already a status with that name' });
    console.error('add status failed:', (e as Error).message);
    res.status(500).json({ error: 'Could not add the status' });
  }
});

// PATCH /products/statuses/:key   { label?, meaning?, tone? }   managers only. Only what is sent is changed. The key never changes, so
// products, saved reports and imports keep working; the new name shows everywhere at once. EOL and Discontinued can be renamed,
// recoloured and described like any other (the EOL rule goes by their keys, not their names).
productsRouter.patch('/statuses/:key', async (req, res) => {
  if (!managersOnly(req, res)) return;
  try {
    const { list, fromDb } = await loadStatuses();
    if (!fromDb) return res.status(503).json({ error: 'Statuses cannot be edited yet: run product-statuses.sql in the database first.' });
    const st = list.find(s => s.key === req.params.key);
    if (!st) return res.status(404).json({ error: 'There is no such status' });
    const b = req.body ?? {};
    const has = (k: string) => Object.prototype.hasOwnProperty.call(b, k);
    if (!has('label') && !has('meaning') && !has('tone')) return res.status(400).json({ error: 'Say what to change: the name, the description or the colour' });
    let label = st.label, meaning = st.meaning, tone = st.tone;
    if (has('label')) {
      const l = typeof b.label === 'string' ? b.label.trim().replace(/\s+/g, ' ') : '';
      const problem = labelProblem(l);
      if (problem) return res.status(400).json({ error: problem });
      const clash = list.find(s => s.key !== st.key && normName(s.label) === normName(l));
      if (clash) return res.status(409).json({ error: `There is already a status called "${clash.label}"` });
      label = l;
    }
    if (has('meaning')) {
      const m = b.meaning === null || b.meaning === undefined ? '' : typeof b.meaning === 'string' ? b.meaning.trim().replace(/\s+/g, ' ') : null;
      if (m === null) return res.status(400).json({ error: 'The description must be text' });
      if (m.length > 120) return res.status(400).json({ error: 'The description can be at most 120 characters' });
      meaning = m || null;
    }
    if (has('tone')) {
      if (!(TONES as readonly string[]).includes(b.tone)) return res.status(400).json({ error: `Colour must be one of ${TONES.join(', ')}` });
      tone = b.tone;
    }
    if (label === st.label && meaning === st.meaning && tone === st.tone) return res.json({ updated: st.key, changed: false, ...(await statusReply()) });
    await prisma.$executeRaw`update crm.product_statuses set label = ${label}, meaning = ${meaning}, tone = ${tone} where key = ${st.key}`;
    clearStatusCache();
    res.json({ updated: st.key, changed: true, ...(await statusReply()) });
  } catch (e) {
    clearStatusCache();
    if (/duplicate key|unique/i.test((e as Error).message)) return res.status(409).json({ error: 'There is already a status with that name' });
    console.error('edit status failed:', (e as Error).message);
    res.status(500).json({ error: 'Could not save the change' });
  }
});

// DELETE /products/statuses/:key                    refused (409, with how many) if products have it
// DELETE /products/statuses/:key?clear=1            removes it and clears the status on those products
// DELETE /products/statuses/:key?moveTo=<status>    removes it and gives those products another status instead
productsRouter.delete('/statuses/:key', async (req, res) => {
  if (!managersOnly(req, res)) return;
  try {
    const { list, fromDb } = await loadStatuses();
    if (!fromDb) return res.status(503).json({ error: 'Statuses cannot be removed yet: run product-statuses.sql in the database first.' });
    const key = req.params.key;
    const st = list.find(s => s.key === key);
    if (!st) return res.status(404).json({ error: 'There is no such status' });
    if (st.system || (SYSTEM_KEYS as readonly string[]).includes(key)) return res.status(400).json({ error: `${st.label} cannot be removed: the automatic EOL rule depends on it` });
    const clear = req.query.clear === '1';
    const moveToKey = typeof req.query.moveTo === 'string' && req.query.moveTo ? req.query.moveTo : null;
    if (clear && moveToKey) return res.status(400).json({ error: 'Choose either to clear the status or to move the products to another one, not both' });
    const target = moveToKey ? list.find(s => s.key === moveToKey) : null;
    if (moveToKey && !target) return res.status(400).json({ error: 'There is no such status to move the products to' });
    if (moveToKey && moveToKey === key) return res.status(400).json({ error: 'Choose a different status to move the products to' });
    const used = (await statusCounts()).get(key) ?? 0;
    if (used > 0 && !clear && !target) return res.status(409).json({ error: `${used} product${used === 1 ? ' has' : 's have'} the status "${st.label}". Removing it clears the status on ${used === 1 ? 'it' : 'them'}, or ${used === 1 ? 'it' : 'they'} can be moved to another status.`, inUse: used });
    if (used > 0) {
      const who = String((req.rep as any)?.name ?? 'a manager');
      const reason = target ? `Status "${st.label}" was removed by ${who}: moved to "${target.label}"` : `Status "${st.label}" was removed by ${who}`;
      try {
        await prisma.$executeRaw`insert into crm.product_stage_log (sku, from_stage, to_stage, reason) select sku, lifecycle, ${target ? target.key : 'none'}, ${reason} from crm.products where lifecycle = ${key}`;
      } catch { /* the log is a courtesy: never the reason a removal fails */ }
    }
    await prisma.$transaction([
      target ? prisma.$executeRaw`update crm.products set lifecycle = ${target.key} where lifecycle = ${key}` : prisma.$executeRaw`update crm.products set lifecycle = null where lifecycle = ${key}`,
      prisma.$executeRaw`delete from crm.product_statuses where key = ${key}`,
    ]);
    clearStatusCache();
    res.json({ removed: key, cleared: target ? 0 : used, moved: target ? used : 0, movedTo: target?.key ?? null, ...(await statusReply()) });
  } catch (e) {
    clearStatusCache();
    console.error('remove status failed:', (e as Error).message);
    res.status(500).json({ error: 'Could not remove the status' });
  }
});

// PATCH /products/:sku   { lifecycle: the key (or name) of one of the statuses in crm.product_statuses | null, imageUrl: 'https://...' | null, eta: '2026-12-01' | null }
// An EOL product with no stock anywhere (none available, on hand, on order, or in any location) for 24 hours is moved to
// Discontinued by the database itself, whichever job changed the stock. The reply says (note) when that has just happened,
// or when it is about to because there is none left now.
productsRouter.patch('/:sku', async (req, res) => {
  if (!managersOnly(req, res)) return;
  const data: { lifecycle?: string | null; imageUrl?: string | null; eta?: Date | null } = {};
  if ('lifecycle' in (req.body ?? {})) {
    const v = req.body.lifecycle;
    if (v === null || v === '') data.lifecycle = null;
    else {
      const list = await listStatuses();
      const st = matchStatus(list, v);   // its key, or its name
      if (!st) return res.status(400).json({ error: `Status must be one of ${list.map(s => s.key).join(', ')}, or empty` });
      data.lifecycle = st.key;
    }
  }
  if ('imageUrl' in (req.body ?? {})) {
    const v = typeof req.body.imageUrl === 'string' ? req.body.imageUrl.trim() : '';
    if (!v) data.imageUrl = null;
    else if (/^https?:\/\//i.test(v)) data.imageUrl = v;
    else return res.status(400).json({ error: 'The photo link must start with http:// or https://' });
  }
  if ('eta' in (req.body ?? {})) {
    const d = typeof req.body.eta === 'string' ? parseDay(req.body.eta) : null;
    if (d === 'invalid') return res.status(400).json({ error: 'The ETA must be a date like 2026-12-01, or empty' });
    data.eta = d ? new Date(`${d}T00:00:00Z`) : null;
  }
  if (!Object.keys(data).length) return res.status(400).json({ error: 'Nothing to change' });
  const p = await prisma.product.update({ where: { sku: req.params.sku }, data, select: { sku: true, imageUrl: true, lifecycle: true, eta: true, onOrder: true } }).catch(() => null);
  if (!p) return res.status(404).json({ error: 'Product not found' });
  const incoming = await incomingFor([p.sku]);
  const moved = data.lifecycle === 'eol' && p.lifecycle === 'discontinued';
  let waiting = false;   // set to EOL with no stock left: it becomes Discontinued after 24 hours of that
  if (data.lifecycle === 'eol' && p.lifecycle === 'eol') {
    try { const [r] = await prisma.$queryRaw<{ gone: boolean }[]>`select not crm.product_has_stock(p) as gone from crm.products p where p.sku = ${p.sku}`; waiting = !!r?.gone; } catch { /* the stage rule is not installed yet */ }
  }
  res.json({
    sku: p.sku, imageUrl: p.imageUrl, lifecycle: p.lifecycle, etaManual: dayOf(p.eta), eta: chooseEta(p.eta, p.onOrder, incoming.get(p.sku) ?? [], melDay()),
    ...(moved ? { note: 'There is no stock left (none available, on hand, on order or in any location), so it was set to Discontinued instead of EOL.' }
      : waiting ? { note: 'There is no stock left (none available, on hand, on order or in any location). It will change to Discontinued by itself after 24 hours with none.' } : {}),
  });
});

// ---------- GET /products/catalogue ----------
// The photo catalogue: products by brand with stock and price, a page at a time.
//   ?q= words (any order)  &brand=A,B  &category=  &inStock=1  &withPhoto=1  &limit=48  &offset=0
// Also returns the brands and categories to filter by (with counts), each ignoring its
// own filter so choosing a brand doesn't make the other brands vanish.
productsRouter.get('/catalogue', async (req, res) => {
  try {
    const q = String(req.query.q ?? '').trim().toLowerCase();
    const brands = String(req.query.brand ?? '').split(',').map(b => b.trim()).filter(Boolean);
    const category = String(req.query.category ?? '').trim();
    const statuses = String(req.query.status ?? '').split(',').map(x => x.trim()).filter(Boolean);   // eol, discontinued, preorder, new, none
    const limit = Math.min(Math.max(Number(req.query.limit) || 48, 1), 96);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const common: any[] = [{ OR: [{ status: null }, { status: { not: 'Deprecated' } }] }];
    for (const w of searchWords(q)) {
      common.push({ OR: [
        { sku: { contains: w, mode: 'insensitive' } },
        { name: { contains: w, mode: 'insensitive' } },
        { brand: { contains: w, mode: 'insensitive' } },
      ] });
    }
    if (req.query.inStock === '1') common.push({ available: { gt: 0 } });
    if (req.query.withPhoto === '1') common.push({ AND: [{ imageUrl: { not: null } }, { imageUrl: { not: '' } }] });
    const byBrand = brands.length ? [{ brand: { in: brands } }] : [];
    const byCategory = category ? [{ category }] : [];
    const statusList = await listStatuses();
    const keys = statuses.filter(k => statusList.some(s => s.key === k));
    const byStatus = statuses.length ? [{ OR: [...(keys.length ? [{ lifecycle: { in: keys } }] : []), ...(statuses.includes('none') ? [{ lifecycle: null }] : [])] }] : [];

    const [total, rows, brandRows, categoryRows, statusRows] = await Promise.all([
      prisma.product.count({ where: { AND: [...common, ...byBrand, ...byCategory, ...byStatus] } }),
      prisma.product.findMany({
        where: { AND: [...common, ...byBrand, ...byCategory, ...byStatus] },
        orderBy: [{ brand: 'asc' }, { name: 'asc' }],
        skip: offset, take: limit,
        select: { sku: true, name: true, brand: true, category: true, uom: true, imageUrl: true, lifecycle: true, eta: true, available: true, onHand: true, onOrder: true, prices: true },
      }),
      prisma.product.groupBy({ by: ['brand'], where: { AND: [...common, ...byCategory, ...byStatus] }, _count: { _all: true } }),
      prisma.product.groupBy({ by: ['category'], where: { AND: [...common, ...byBrand, ...byStatus] }, _count: { _all: true } }),
      prisma.product.groupBy({ by: ['lifecycle'], where: { AND: [...common, ...byBrand, ...byCategory] }, _count: { _all: true } }),
    ]);
    const incoming = await incomingFor(rows.map(r => r.sku));
    const increments = await incrementsFor(rows.map(r => r.sku));
    const today = melDay();

    const facet = (rows: { _count: { _all: number } }[], key: 'brand' | 'category') =>
      (rows as any[]).filter(r => r[key]).map(r => ({ name: r[key] as string, count: r._count._all }))
        .sort((a, b) => a.name.localeCompare(b.name));

    res.json({
      total,
      items: rows.map(p => {
        const prices = (p.prices as Record<string, number>) ?? {};
        return {
          sku: p.sku, name: p.name, brand: p.brand, category: p.category, uom: p.uom, imageUrl: p.imageUrl, lifecycle: p.lifecycle, orderIncrement: increments.get(p.sku) ?? null,
          eta: chooseEta(p.eta, p.onOrder, incoming.get(p.sku) ?? [], today), etaManual: dayOf(p.eta),
          available: p.available, onHand: p.onHand, onOrder: p.onOrder,
          wholesale: pickPrice(prices, WHOLESALE)?.price ?? null,
          retail: pickPrice(prices, RETAIL)?.price ?? null,
        };
      }),
      brands: facet(brandRows, 'brand'),
      categories: facet(categoryRows, 'category'),
      // how many products have each status (brand and category filters applied), for the status filter
      statuses: [
        ...statusList.map(st => ({ key: st.key as string, label: st.label, count: (statusRows as any[]).find(r => r.lifecycle === st.key)?._count._all ?? 0 })),
        { key: 'none', label: 'No status', count: (statusRows as any[]).find(r => r.lifecycle == null)?._count._all ?? 0 },
      ],
    });
  } catch (e) {
    console.error('catalogue failed', e);
    res.status(500).json({ error: (e as Error).message });
  }
});

productsRouter.get('/search', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (q.length < 2) return res.status(400).json({ error: 'Search needs at least 2 characters' });
  const qLower = q.toLowerCase();
  const words = searchWords(qLower);

  const [candidates, stockState] = await Promise.all([
    prisma.product.findMany({
      where: {
        AND: [
          ...words.map(w => ({
            OR: [
              { sku: { contains: w, mode: 'insensitive' as const } },
              { name: { contains: w, mode: 'insensitive' as const } },
              { brand: { contains: w, mode: 'insensitive' as const } },
            ],
          })),
          { OR: [{ status: null }, { status: { not: 'Deprecated' } }] },
        ],
      },
      take: CANDIDATES,
    }),
    prisma.syncState.findUnique({ where: { key: 'stock' } }),
  ]);

  const products = candidates
    .sort((a, b) => rank(a.sku, a.name, qLower, words) - rank(b.sku, b.name, qLower, words) || b.available - a.available)
    .slice(0, MAX_RESULTS);
  const skus = products.map(p => p.sku);

  if (!skus.length) {
    return res.json({ query: q, stockSyncedAt: stockState?.lastSyncedAt ?? null, results: [] });
  }

  const since12m = new Date(Date.now() - 365 * 86400000);

  const [salesTotals, allocatedLines, purchaseLines, recentBySku] = await Promise.all([
    // Sales totals per SKU, all time and last 12 months. Like DEAR, a
    // sale counts when it ships, fulfilment by fulfilment: an order for 48
    // with 24 shipped counts 24. Orders synced before per-SKU ship qty was
    // captured count in full unless their status says nothing has gone.
    // Marketing and warranty orders aren't sales, so they're left out.
    prisma.$queryRaw<{ sku: string; units_all: number; value_all: number; units_12m: number; value_12m: number }[]>`
      with lines as (
        select l.sku, l.quantity, l.line_total, q.sent_at,
          case
            when q.source = ${HISTORY_SOURCE} or q.number like 'Q%' then 1  -- spreadsheet history: counts in full, as stored
            when q.line_fulfilment ? l.sku then least(1, greatest(0,
              coalesce((q.line_fulfilment -> l.sku ->> 'shipped')::float8, 0)
              / nullif(sum(l.quantity) over (partition by l.quote_id, l.sku), 0)))
            when upper(coalesce(q.fulfillment_status, '')) = any(${UNSHIPPED_ORDER_STATUSES})
              and upper(coalesce(q.shipping_status, '')) <> 'SHIPPED' then 0
            else 1
          end as shipped_share
        from crm.quote_lines l
        join crm.quotes q on q.id = l.quote_id
        where l.sku = any(${skus}) and q.misc_type is null
      )
      select sku,
        coalesce(sum(quantity * shipped_share), 0)::float8 as units_all,
        coalesce(sum(line_total * shipped_share), 0)::float8 as value_all,
        coalesce(sum(quantity * shipped_share) filter (where sent_at >= ${since12m}), 0)::float8 as units_12m,
        coalesce(sum(line_total * shipped_share) filter (where sent_at >= ${since12m}), 0)::float8 as value_12m
      from lines
      group by sku
    `,

    // Candidate orders for "reserved for orders": not closed and not
    // fully shipped. The exact per-SKU qty still to go is worked out below
    // from each order's own pick/ship progress.
    prisma.quoteLine.findMany({
      where: {
        sku: { in: skus },
        quote: {
          AND: [
            LIVE_ORDER, // spreadsheet history never holds stock
            { OR: [{ shippingStatus: null }, { shippingStatus: { not: 'SHIPPED' } }] },
            { OR: [{ fulfillmentStatus: null }, { fulfillmentStatus: { notIn: CLOSED_ORDER_STATUSES } }] },
          ],
        },
      },
      select: {
        sku: true,
        quantity: true,
        quote: { select: {
          id: true, number: true, sentAt: true, miscType: true, fulfillmentStatus: true,
          pickingStatus: true, shippingStatus: true, lineFulfilment: true, paid: true,
          account: { select: { id: true, name: true } },
        } },
      },
      orderBy: { quote: { sentAt: 'asc' } },
    }),

    prisma.purchaseLine.findMany({
      where: { sku: { in: skus } },
      include: { purchase: true },
    }),

    // Per SKU, so one fast seller can't crowd out the others' history.
    Promise.all(skus.map(sku =>
      prisma.quoteLine.findMany({
        where: { sku, quote: { miscType: null } },
        select: {
          quantity: true,
          quote: { select: {
            id: true, number: true, sentAt: true, lineFulfilment: true, fulfillmentStatus: true, shippingStatus: true, source: true,
            account: { select: { id: true, name: true } },
          } },
        },
        orderBy: { quote: { sentAt: 'desc' } },
        take: HISTORY_SHOWN * 4,
      }),
    )),
  ]);

  const totalsBySku = new Map(salesTotals.map(t => [t.sku, t]));
  const round2 = (n: number) => Math.round(n * 100) / 100;

  // Recent completed stock adjustments for these products (write-offs,
  // recounts, returns, new stock entered by adjustment).
  const adjustmentRows = skus.length
    ? await prisma.$queryRaw<{ sku: string; number: string | null; date: Date | null; reference: string | null; quantity: number | null; location: string | null; kind: string }[]>`
        select l.sku, a.number, coalesce(l.received_date, a.effective_date) as date, a.reference, l.quantity, l.location, l.kind
        from crm.stock_adjustment_lines l
        join crm.stock_adjustments a on a.id = l.adjustment_id
        where l.sku = any(${skus}::text[]) and upper(coalesce(a.status, '')) like 'COMPLETED%'
        order by coalesce(l.received_date, a.effective_date) desc nulls last`
    : [];
  const adjustmentsBySku = new Map<string, typeof adjustmentRows>();
  for (const r of adjustmentRows) {
    const list = adjustmentsBySku.get(r.sku) ?? [];
    if (list.length < PURCHASES_SHOWN) list.push(r);
    adjustmentsBySku.set(r.sku, list);
  }

  const descriptions = await descriptionsFor(skus);
  const increments = await incrementsFor(skus);
  const specs = await specsFor(skus);
  const results = products.map((p, idx) => {
    const prices = (p.prices as Record<string, number>) ?? {};
    const totals = totalsBySku.get(p.sku);

    // Per order, how much of THIS item is still to go out. An order can
    // be backordered on another item while this one is already allocated
    // or picked, so this is judged per SKU, not by the order's status.
    const ordersForSku = new Map<string, { quote: (typeof allocatedLines)[number]['quote']; ordered: number }>();
    for (const l of allocatedLines.filter(l => l.sku === p.sku)) {
      const o = ordersForSku.get(l.quote.id);
      if (o) o.ordered += l.quantity;
      else ordersForSku.set(l.quote.id, { quote: l.quote, ordered: l.quantity });
    }

    // Allocated = ordered minus shipped, for whatever reason it's held
    // (unpaid, waiting to pick, waiting on another item). Other customers
    // can't have this stock.
    // Draft orders (DEAR status ORDERING) aren't authorised yet, so DEAR
    // doesn't reserve stock for them. They're listed separately as demand,
    // and left out of "allocated" so the list matches DEAR's Allocated figure.
    const isDraft = (s: string | null) => (s ?? '').toUpperCase() === 'ORDERING';
    const draftOrders = [...ordersForSku.values()]
      .filter(({ quote }) => isDraft(quote.fulfillmentStatus))
      .map(({ quote, ordered }) => ({
        quoteId: quote.id, number: quote.number, date: quote.sentAt,
        accountId: quote.account.id, accountName: quote.account.name,
        miscType: quote.miscType, status: quote.fulfillmentStatus, paid: quote.paid, qty: ordered,
      }));

    const allocatedOrders = [...ordersForSku.values()].filter(({ quote }) => !isDraft(quote.fulfillmentStatus)).flatMap(({ quote, ordered }) => {
      const progress = (quote.lineFulfilment as Record<string, { picked: number; shipped: number }>)?.[p.sku];
      let allocated: number;
      if (progress) {
        allocated = ordered - Math.min(progress.shipped, ordered);
      } else {
        // Nothing of this item shipped yet. For orders synced before
        // per-SKU progress was captured, trust the order-level status.
        const shippedAll = (quote.shippingStatus ?? '').toUpperCase() === 'SHIPPED';
        allocated = shippedAll ? 0 : ordered;
      }
      if (allocated <= 0) return [];
      return [{
        quoteId: quote.id,
        number: quote.number,
        date: quote.sentAt,
        accountId: quote.account.id,
        accountName: quote.account.name,
        miscType: quote.miscType,
        status: quote.fulfillmentStatus,
        paid: quote.paid,
        qty: allocated,
      }];
    });

    const skuPurchases = purchaseLines.filter(l => l.sku === p.sku);
    // One list of POs for this SKU, newest first: incoming ones show
    // what's still to come, received ones show what arrived.
    const purchaseOrders = skuPurchases
      .filter(l => !DEAD_PURCHASE_STATUSES.includes((l.purchase.status ?? '').toUpperCase()))
      .map(l => {
        const done = fullyReceived(l.purchase.status, l.purchase.receivingStatus);
        const received = done ? Math.max(l.quantityReceived, l.quantityOrdered) : l.quantityReceived;
        const outstanding = done ? 0 : Math.max(0, l.quantityOrdered - l.quantityReceived);
        return {
          number: l.purchase.number,
          supplier: l.purchase.supplier,
          orderDate: l.purchase.orderDate,
          expected: l.purchase.requiredBy,
          receivedAt: l.lastReceivedAt,
          ordered: l.quantityOrdered,
          received,
          outstanding,
          state: outstanding > 0 ? (received > 0 ? 'partial' : 'incoming') : 'received',
        };
      })
      .sort((a, b) => {
        const t = (x: typeof a) => (x.receivedAt ?? x.expected ?? x.orderDate)?.getTime() ?? 0;
        return t(b) - t(a);
      });
    const incomingRefs = purchaseOrders.filter(po => po.outstanding > 0).map(po => po.number).filter(Boolean);
    const incomingQty = purchaseOrders.reduce((sum, po) => sum + po.outstanding, 0);

    // Recent sales = what actually shipped, newest first.
    const orderedOnQuote = new Map<string, number>();
    for (const l of recentBySku[idx]) orderedOnQuote.set(l.quote.id, (orderedOnQuote.get(l.quote.id) ?? 0) + l.quantity);
    const recentOrders: any[] = [];
    for (const [quoteId, ordered] of orderedOnQuote) {
      if (recentOrders.length >= HISTORY_SHOWN) break;
      const q = recentBySku[idx].find(l => l.quote.id === quoteId)!.quote;
      const progress = (q.lineFulfilment as Record<string, { picked: number; shipped: number }>)?.[p.sku];
      const unshipped = UNSHIPPED_ORDER_STATUSES.includes((q.fulfillmentStatus ?? '').toUpperCase())
        && (q.shippingStatus ?? '').toUpperCase() !== 'SHIPPED';
      const shipped = isHistory(q) ? ordered : progress ? Math.min(progress.shipped, ordered) : unshipped ? 0 : ordered;
      if (shipped <= 0) continue;
      recentOrders.push({
        quoteId,
        number: q.number,
        date: q.sentAt,
        accountId: q.account.id,
        accountName: q.account.name,
        qty: shipped,
        partial: shipped < ordered,
      });
    }

    return {
      sku: p.sku,
      name: p.name,
      brand: p.brand,
      category: p.category,
      imageUrl: p.imageUrl,   // the photo link (shown small, large on click)
      lifecycle: p.lifecycle, // one of the stages (EOL, discontinued, pre-order, new, confirmed for ranging, ...); null = none
      description: descriptions.get(p.sku) ?? null,   // DEAR's description, plain text
      orderIncrement: increments.get(p.sku) ?? null,  // customers order in multiples of this
      weightKg: specs.get(p.sku)?.weightKg ?? null,   // from DEAR: weight in kilograms, size in centimetres
      lengthCm: specs.get(p.sku)?.lengthCm ?? null,
      widthCm: specs.get(p.sku)?.widthCm ?? null,
      heightCm: specs.get(p.sku)?.heightCm ?? null,
      eta: chooseEta(p.eta, p.onOrder, purchaseOrders, melDay()),   // when the next delivery should arrive
      etaManual: dayOf(p.eta),                                       // the date set by hand, if any
      uom: p.uom,
      onHand: p.onHand,
      allocated: p.allocated,
      available: p.available,
      onOrder: p.onOrder,
      locations: (p.locations as Location[]) ?? [],
      wholesale: pickPrice(prices, WHOLESALE),
      retail: pickPrice(prices, RETAIL),
      prices,
      sales: {
        units12m: totals?.units_12m ?? 0,
        value12m: round2(totals?.value_12m ?? 0),
        unitsAll: totals?.units_all ?? 0,
        valueAll: round2(totals?.value_all ?? 0),
      },
      allocatedOrders: [...allocatedOrders.values()],
      draftOrders,
      purchaseOrders: purchaseOrders.slice(0, PURCHASES_SHOWN),
      adjustments: (adjustmentsBySku.get(p.sku) ?? []).map(a => ({
        number: a.number, date: a.date, reference: a.reference, quantity: a.quantity, location: a.location, kind: a.kind,
      })),
      incomingRefs,
      incomingQty,
      recentOrders,
    };
  });

  res.json({ query: q, stockSyncedAt: stockState?.lastSyncedAt ?? null, results });
});