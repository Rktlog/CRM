import ExcelJS from 'exceljs';
import { prisma } from './prisma';
import { wholesalePrice, retailPrice } from './pricing';

// The customer price list Rhino sends to stores: every product in the
// brands they stock, marked Current Range (they've bought it) or New, with
// retail and wholesale prices, order increments, availability and the next
// delivery date for preorders. Matches the format of the reports the team
// already sends (11 columns, Arial 10, header filters, colour-coded status).

export type PriceListStatus = 'new' | 'current' | 'other';
export type PriceListAvailability = 'available' | 'preorder' | 'discontinued';

export type PriceListFilters = {
  brands?: string[];                       // default: brands the store has bought
  statuses?: PriceListStatus[];            // default: all
  availability?: PriceListAvailability[];  // default: all
};

// Which DEAR product custom field holds what. DEAR calls them
// AdditionalAttribute1-10 on products and ProductCustomField1-10 on sale
// lines; sync-products stores whichever it receives. Change here if Rhino
// keeps these in a different field: no re-sync needed.
const INCREMENT_FIELDS = ['AdditionalAttribute1', 'ProductCustomField1', 'CustomField1'];
const IMAGE_FIELD_PATTERN = /^https?:\/\//i; // first custom field holding a link

const NEW_WINDOW_DAYS = 90;
const COLOURS = { current: 'FFC2F1C8', new: 'FFEAD1DC' }; // light green / light pink, as in the originals

type Row = {
  status: '' | 'Current Range' | 'New';
  sku: string;
  name: string;
  brand: string;
  barcode: string | number | null;
  retail: number | null;
  wholesale: number | null;
  increments: number | null;
  availability: 'Available' | 'Preorder' | 'Discontinued';
  nextAvailable: Date | null;
  image: string | null;
};

function incrementsOf(attrs: Record<string, string>): number | null {
  for (const key of INCREMENT_FIELDS) {
    const n = Number(attrs[key]);
    if (attrs[key] != null && Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function imageOf(attrs: Record<string, string>): string | null {
  return Object.values(attrs).find(v => IMAGE_FIELD_PATTERN.test(v)) ?? null;
}

// Long numeric barcodes stay numbers (as in the originals, shown in full),
// anything else stays text.
function barcodeCell(b: string | null): string | number | null {
  if (!b) return null;
  return /^\d{8,15}$/.test(b) && Number.isSafeInteger(Number(b)) ? Number(b) : b;
}

// Brands this store has bought, with how many products each brand has, for
// the filter screen before downloading.
export async function priceListOptions(accountId: string) {
  const bought = await prisma.$queryRaw<{ brand: string }[]>`
    select distinct coalesce(p.brand, l.brand) as brand
    from crm.quote_lines l
    join crm.quotes q on q.id = l.quote_id
    left join crm.products p on p.sku = l.sku
    where q.account_id = ${accountId}::uuid and q.misc_type is null
      and coalesce(p.brand, l.brand) is not null`;
  const boughtSet = new Set(bought.map(b => b.brand));

  const brands = await prisma.product.groupBy({
    by: ['brand'],
    where: { brand: { not: null }, OR: [{ status: null }, { status: { not: 'Deprecated' } }] },
    _count: true,
  });
  return {
    brands: brands
      .filter(b => b.brand)
      .map(b => ({ brand: b.brand!, products: b._count, bought: boughtSet.has(b.brand!) }))
      .sort((a, b) => Number(b.bought) - Number(a.bought) || a.brand.localeCompare(b.brand)),
  };
}

export async function buildPriceList(accountId: string, filters: PriceListFilters): Promise<{ rows: Row[]; brands: string[] }> {
  // Everything this store has ever bought (sales, not marketing/warranty).
  const lines = await prisma.quoteLine.findMany({
    where: { quote: { accountId, miscType: null } },
    select: { sku: true, brand: true },
  });
  const boughtSkus = new Set(lines.map(l => l.sku));

  const boughtProducts = await prisma.product.findMany({ where: { sku: { in: [...boughtSkus] } }, select: { sku: true, brand: true } });
  const defaultBrands = new Set<string>();
  for (const p of boughtProducts) if (p.brand) defaultBrands.add(p.brand);
  for (const l of lines) if (l.brand && !boughtProducts.some(p => p.sku === l.sku)) defaultBrands.add(l.brand);

  const brands = filters.brands?.length ? filters.brands : [...defaultBrands];
  if (!brands.length) return { rows: [], brands };

  // Every product in those brands. Discontinued ones only if the store has
  // bought them (so they know a line they stock is ending).
  const products = await prisma.product.findMany({
    where: {
      brand: { in: brands },
      OR: [{ status: null }, { status: { not: 'Deprecated' } }, { sku: { in: [...boughtSkus] } }],
    },
  });
  const skus = products.map(p => p.sku);

  // "New" = first stock received in the last 90 days, and nobody bought it
  // before then. Same rule as the stocklist.
  const newCutoff = new Date(Date.now() - NEW_WINDOW_DAYS * 86400000);
  const firstSeen = skus.length
    ? await prisma.$queryRaw<{ sku: string; first_received: Date | null; first_sold: Date | null }[]>`
        select s.sku,
          (select min(pl.last_received_at) from crm.purchase_lines pl where pl.sku = s.sku and pl.quantity_received > 0) as first_received,
          (select min(q.sent_at) from crm.quote_lines l join crm.quotes q on q.id = l.quote_id where l.sku = s.sku) as first_sold
        from unnest(${skus}::text[]) as s(sku)`
    : [];
  const isNew = new Set(firstSeen
    .filter(f => f.first_received && f.first_received >= newCutoff && (!f.first_sold || f.first_sold >= newCutoff))
    .map(f => f.sku));

  // Next expected delivery, for anything not in stock now.
  const openPOs = skus.length
    ? await prisma.purchaseLine.findMany({
        where: { sku: { in: skus }, purchase: { status: { notIn: ['VOIDED', 'CREDITED', 'DRAFT', 'COMPLETED'] } } },
        select: { sku: true, quantityOrdered: true, quantityReceived: true, purchase: { select: { requiredBy: true } } },
      })
    : [];
  const nextDue = new Map<string, Date>();
  for (const po of openPOs) {
    if (po.quantityOrdered - po.quantityReceived <= 0 || !po.purchase.requiredBy) continue;
    const cur = nextDue.get(po.sku);
    if (!cur || po.purchase.requiredBy < cur) nextDue.set(po.sku, po.purchase.requiredBy);
  }

  const statusWanted = new Set(filters.statuses?.length ? filters.statuses : ['new', 'current', 'other']);
  const availabilityWanted = new Set(filters.availability?.length ? filters.availability : ['available', 'preorder', 'discontinued']);

  const rows: Row[] = [];
  for (const p of products) {
    const current = boughtSkus.has(p.sku);
    const status: Row['status'] = current ? 'Current Range' : isNew.has(p.sku) ? 'New' : '';
    const statusKey: PriceListStatus = current ? 'current' : status === 'New' ? 'new' : 'other';
    if (!statusWanted.has(statusKey)) continue;

    const availability: Row['availability'] =
      p.status === 'Deprecated' ? 'Discontinued' : p.available > 0 ? 'Available' : 'Preorder';
    if (!availabilityWanted.has(availability.toLowerCase() as PriceListAvailability)) continue;

    const prices = p.prices as Record<string, number>;
    const attrs = (p.attributes ?? {}) as Record<string, string>;
    rows.push({
      status,
      sku: p.sku,
      name: p.name,
      brand: p.brand ?? '',
      barcode: barcodeCell(p.barcode),
      retail: retailPrice(prices),
      wholesale: wholesalePrice(prices),
      increments: incrementsOf(attrs),
      availability,
      nextAvailable: availability === 'Preorder' ? nextDue.get(p.sku) ?? null : null,
      image: imageOf(attrs),
    });
  }

  // Brand, then product name, as in the originals.
  rows.sort((a, b) => a.brand.localeCompare(b.brand) || a.name.localeCompare(b.name));
  return { rows, brands };
}

export async function priceListWorkbook(rows: Row[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1', { views: [{ state: 'frozen', ySplit: 1 }] });

  ws.columns = [
    { header: 'Status', key: 'status', width: 13 },
    { header: 'SKU', key: 'sku', width: 34 },
    { header: 'Product Name', key: 'name', width: 68.8 },
    { header: 'Brand', key: 'brand', width: 15 },
    { header: 'Barcode', key: 'barcode', width: 14.7 },
    { header: 'Retail (ex GST)', key: 'retail', width: 14.4 },
    { header: 'Wholesale (ex GST)', key: 'wholesale', width: 18.9 },
    { header: 'Increments', key: 'increments', width: 11.2 },
    { header: 'Available/PreOrder', key: 'availability', width: 18.6 },
    { header: 'Next Availabillity', key: 'nextAvailable', width: 16.1 }, // spelling as in the originals
    { header: 'Image Links', key: 'image', width: 19.9 },
  ];

  const font = { name: 'Arial', size: 10 };
  ws.getRow(1).font = { ...font, bold: true };

  for (const r of rows) {
    const row = ws.addRow({
      status: r.status || null,
      sku: r.sku,
      name: r.name,
      brand: r.brand,
      barcode: r.barcode,
      retail: r.retail,
      wholesale: r.wholesale,
      increments: r.increments,
      availability: r.availability,
      nextAvailable: r.nextAvailable,
      image: r.image ? { text: r.image, hyperlink: r.image } : null,
    });
    row.font = font;
    row.getCell('barcode').numFmt = '0';
    row.getCell('nextAvailable').numFmt = 'mm-dd-yy'; // Excel shows this in the reader's local date format
    if (r.image) row.getCell('image').font = { ...font, color: { argb: 'FF0563C1' }, underline: true };

    const fill = r.status === 'Current Range' ? COLOURS.current : r.status === 'New' ? COLOURS.new : null;
    if (fill) {
      for (let c = 1; c <= 4; c++) {
        row.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
      }
    }
  }

  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, rows.length + 1), column: 11 } };
  return Buffer.from(await wb.xlsx.writeBuffer());
}