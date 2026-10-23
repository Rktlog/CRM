import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { pickPrice, WHOLESALE, RETAIL } from '../lib/pricing';
import { chooseEta, incomingFor } from '../lib/eta';
import { melDay } from '../lib/receivables';
import { decodeEntities } from '../lib/htmlText';

// Read-only feeds for Google Sheets. A script in the sheet (google-sheet/crm-feed.gs) asks for a feed on a timer and writes it
// to a tab. This is NOT behind a login: it has its own secret, SHEET_FEED_TOKEN (at least 24 characters, set on the server),
// which the script sends in the X-Feed-Token header. Never in the address, so it cannot end up in a log or a browser history.
// Anyone holding the token can read the feed, so keep the sheet to the people who should see this data.
export const sheetFeedRouter = Router();

const sha = (s: string) => crypto.createHash('sha256').update(s).digest();
const failures = new Map<string, number[]>();   // wrong-token attempts per address, to slow guessing
const MAX_FAILURES = 10, WINDOW_MS = 60_000;
const clientOf = (req: Request) => String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim();

function allowed(req: Request, res: Response): boolean {
  res.setHeader('Cache-Control', 'no-store');
  const token = (process.env.SHEET_FEED_TOKEN ?? '').trim();
  if (token.length < 24) { res.status(503).json({ error: 'The sheet feed is not set up: SHEET_FEED_TOKEN must be set on the server, at least 24 characters long.' }); return false; }
  const who = clientOf(req), now = Date.now();
  const recent = (failures.get(who) ?? []).filter(t => now - t < WINDOW_MS);
  if (recent.length >= MAX_FAILURES) { res.status(429).json({ error: 'Too many wrong tries. Wait a minute.' }); return false; }
  const sent = String(req.headers['x-feed-token'] ?? '');
  if (!sent || !crypto.timingSafeEqual(sha(sent), sha(token))) {
    recent.push(now); failures.set(who, recent);
    if (failures.size > 5000) failures.clear();
    res.status(401).json({ error: 'Not allowed' });
    return false;
  }
  return true;
}
export const clearFeedState = () => { failures.clear(); cache.clear(); };

type Col = { name: string; type: 'text' | 'number' | 'money' | 'date' };
// The columns of the team's own product sheet, in its order (the headers are spelled exactly as in that sheet), then the dimensions
// and weight. `type` tells the script how to format each one.
export const PRODUCT_COLUMNS: Col[] = [
  { name: 'Discontinued', type: 'text' }, { name: 'SKU', type: 'text' }, { name: 'Product Name', type: 'text' }, { name: 'Brand', type: 'text' }, { name: 'Barcode', type: 'text' },
  { name: 'Retail (ex GST)', type: 'money' }, { name: 'Wholesale (ex GST)', type: 'money' }, { name: 'Trade (ex GST)', type: 'money' },
  { name: 'Increments', type: 'number' }, { name: 'Available', type: 'number' }, { name: 'Incoming', type: 'number' },
  { name: 'Available/PreOrder', type: 'text' }, { name: 'Next Availabillity', type: 'date' },
  { name: 'Description', type: 'text' }, { name: 'Image Links', type: 'text' }, { name: 'TAGS', type: 'text' },
  { name: 'Length (cm)', type: 'number' }, { name: 'Width (cm)', type: 'number' }, { name: 'Height (cm)', type: 'number' }, { name: 'Weight (kg)', type: 'number' },
];
const TRADE = /^trade\b/i;   // the price tier called Trade (or "Trade Price"), not "Trader ..."

// Discontinued: DEAR has the product as Deprecated, or its stage here is Discontinued. (An EOL product is still being sold, so it is not.)
export const isDiscontinued = (status: string | null | undefined, lifecycle: string | null | undefined): boolean => status === 'Deprecated' || lifecycle === 'discontinued';

// Available/PreOrder: "Available" when there is stock; "PreOrder" when it is not in stock but stock is on order, or when its stage here
// is Preorder Only; otherwise blank, meaning it can be neither bought now nor ordered ahead.
export function availabilityOf(lifecycle: string | null | undefined, available: number | null | undefined, incoming: number | null | undefined): '' | 'Available' | 'PreOrder' {
  if (lifecycle === 'preorder_only') return 'PreOrder';
  if (Number(available) > 0) return 'Available';
  if (Number(incoming) > 0) return 'PreOrder';
  return '';
}

const num = (v: unknown): number | null => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const text = (v: unknown): string | null => (v == null || String(v).trim() === '' ? null : String(v));
const melStamp = (d: Date | string | null | undefined): string | null => {
  if (!d) return null;
  const t = new Date(d); if (Number.isNaN(t.getTime())) return null;
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(t).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
};

type Base = { sku: string; name: string | null; brand: string | null; category: string | null; uom: string | null; status: string | null; on_hand: number | null; allocated: number | null; available: number | null; on_order: number | null; prices: Record<string, number> | null; barcode: string | null; image_url: string | null; eta: Date | null; lifecycle: string | null; stock_synced_at: Date | null };

// The columns that came later (description and increment, weight and size, tags) are separate reads, so the feed works before each
// has been added to the database, with those columns blank.
async function extras() {
  const description = new Map<string, string>(), increment = new Map<string, number>(), tags = new Map<string, string>();
  const specs = new Map<string, { w: number | null; l: number | null; wd: number | null; h: number | null }>();
  try {
    for (const r of await prisma.$queryRaw<{ sku: string; description: string | null; order_increment: number | null }[]>`select sku, description, order_increment from crm.products where description is not null or order_increment is not null`) {
      if (r.description) description.set(r.sku, decodeEntities(r.description));   // saved text may still hold codes like &rsquo;
      if (r.order_increment) increment.set(r.sku, Number(r.order_increment));
    }
  } catch { /* not there yet */ }
  try {
    for (const r of await prisma.$queryRaw<{ sku: string; weight_kg: number | null; length_cm: number | null; width_cm: number | null; height_cm: number | null }[]>`select sku, weight_kg, length_cm, width_cm, height_cm from crm.products where weight_kg is not null or length_cm is not null or width_cm is not null or height_cm is not null`)
      specs.set(r.sku, { w: num(r.weight_kg), l: num(r.length_cm), wd: num(r.width_cm), h: num(r.height_cm) });
  } catch { /* not there yet */ }
  try {
    for (const r of await prisma.$queryRaw<{ sku: string; tags: string[] | null }[]>`select sku, tags from crm.products where tags is not null`) if (r.tags?.length) tags.set(r.sku, r.tags.join(', '));
  } catch { /* not there yet */ }
  return { description, increment, specs, tags };
}

async function productsBody(activeOnly: boolean) {
  const base = await prisma.$queryRaw<Base[]>`
    select sku, name, brand, category, uom, status, on_hand, allocated, available, on_order, prices, barcode, image_url, eta, lifecycle, stock_synced_at
    from crm.products where (not ${activeOnly}::boolean or status is null or status <> 'Deprecated')   -- every product, with the Discontinued column saying which are; ?active=1 leaves out those DEAR has as Deprecated
    order by lower(coalesce(brand, '')), lower(coalesce(name, '')), sku`;
  const skus = base.map(p => p.sku);
  const [incoming, x] = await Promise.all([incomingFor(skus), extras()]);
  const today = melDay();
  const rows = base.map(p => {
    const prices = p.prices ?? {}, sp = x.specs.get(p.sku);
    const eta = chooseEta(p.eta, Number(p.on_order ?? 0), incoming.get(p.sku) ?? [], today);
    return [
      isDiscontinued(p.status, p.lifecycle) ? 'Yes' : null, p.sku, text(p.name), text(p.brand), text(p.barcode),
      pickPrice(prices, RETAIL)?.price ?? null, pickPrice(prices, WHOLESALE)?.price ?? null, pickPrice(prices, TRADE)?.price ?? null,
      x.increment.get(p.sku) ?? null, num(p.available), num(p.on_order),
      availabilityOf(p.lifecycle, num(p.available), num(p.on_order)) || null, eta?.date ?? null,
      x.description.get(p.sku) ?? null, text(p.image_url), x.tags.get(p.sku) ?? null,
      sp?.l ?? null, sp?.wd ?? null, sp?.h ?? null, sp?.w ?? null,
    ];
  });
  return { updatedAt: new Date().toISOString(), count: rows.length, columns: PRODUCT_COLUMNS.map(c => c.name), types: PRODUCT_COLUMNS.map(c => c.type), rows };
}

// A minute's rest, so a sheet refreshing (or several people pressing Refresh) does not rebuild it every time.
const cache = new Map<string, { at: number; body: unknown }>();
const CACHE_MS = 60_000;

// GET /sheet-feed/products             every product, the discontinued ones marked in the Discontinued column
// GET /sheet-feed/products?active=1    only the products DEAR does not have as Deprecated
sheetFeedRouter.get('/products', async (req, res) => {
  if (!allowed(req, res)) return;
  try {
    const activeOnly = ['1', 'true', 'yes'].includes(String(req.query.active ?? '').toLowerCase());
    const key = activeOnly ? 'products:active' : 'products';
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return res.json(hit.body);
    const body = await productsBody(activeOnly);
    cache.set(key, { at: Date.now(), body });
    res.json(body);
  } catch (e) {
    console.error('sheet feed (products) failed:', (e as Error).message);
    res.status(500).json({ error: 'The feed could not be built. Try again shortly.' });
  }
});