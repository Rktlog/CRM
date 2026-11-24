// The Liewood range (Products, Liewood, Range): one row per Liewood SKU, kept in crm.lw_range.
// - Started by importing the Product Range List tab of the Liewood Master File once.
// - Each season, Liewood's Product Data file and the Customer Forecast Form are added (crm.lw_catalogue). When a sales order is uploaded,
//   its SKUs are filled into the range from them (the rules are in liewoodRangeCore.ts). Adding a season file after the order does the same.
// - Shown with what DEAR has (RRP, stock) and how many of each SKU are on the uploaded sales orders.
// Liewood's EUR prices are costs: only managers see them. Nothing here writes to DEAR.
import * as XLSX from 'xlsx';
import { prisma } from './prisma';
import { LiewoodError } from './liewoodCore';
import { retailPrice } from './pricing';
import { parseRangeList, parseSeasonFile, priceCheck, type PriceCheck } from './liewoodRangeCore';

export const MAX_RANGE_FILE = 25 * 1024 * 1024;
const NOT_SET_UP = 'The Liewood range is not set up in the database yet. Ask whoever looks after Radar to run liewood-range.sql.';
const missing = (e: any) => e?.code === '42P01' || (/lw_(range|catalogue)/.test(String(e?.message ?? e)) && /does not exist|relation/i.test(String(e?.message ?? e)));
async function guard<T>(f: () => Promise<T>): Promise<T> { try { return await f(); } catch (e) { if (missing(e)) throw new LiewoodError(NOT_SET_UP, 503); throw e; } }
const dec = (v: number | null) => (v === null ? null : String(v));

// ---------- reading a file: Excel (every tab, or only the ones asked for) or a CSV of one tab ----------
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** A date cell as the sheets write it: "January 2026" for the first of a month, otherwise 2026-01-15. */
const dateText = (d: Date) => { const x = new Date(d.getTime() + 12 * 3600_000); return x.getUTCDate() === 1 ? `${MONTHS[x.getUTCMonth()]} ${x.getUTCFullYear()}` : x.toISOString().slice(0, 10); };
/** A CSV file (as Google Sheets downloads one tab): commas, double quotes around a cell that has commas, quotes or line breaks in it. */
export function parseCsv(s: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false, i = 0;
  if (s.charCodeAt(0) === 0xfeff) i = 1;   // a byte order mark at the start
  for (; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) { if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += c; continue; }
    if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
export function readSheets(buf: Buffer, want?: (name: string) => boolean): { name: string; rows: unknown[][] }[] {
  if (!buf.length) throw new LiewoodError('That file is empty.');
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') throw new LiewoodError('That is a PDF. Add the Excel file (or a CSV of the tab).');
  const zip = buf.subarray(0, 2).toString('latin1') === 'PK';
  if (!zip) {   // not an Excel file: read as a CSV of one tab. (SheetJS's own CSV reader splits some long rows, so this one is used.)
    const text = buf.toString('utf8');
    if (text.includes('\u0000')) throw new LiewoodError('That file could not be opened. Use the Excel file (.xlsx), or a CSV of the tab (File, Download, CSV in Google Sheets).');
    return [{ name: 'CSV', rows: parseCsv(text).slice(0, 20000) }];
  }
  let wb: XLSX.WorkBook;
  try {
    if (want) {
      const names = XLSX.read(buf, { type: 'buffer', bookSheets: true }).SheetNames;
      const pick = names.filter(want);
      if (!pick.length && names.length !== 1) throw new LiewoodError(`That Excel file has no tab Radar is looking for. Its tabs are: ${names.slice(0, 12).join(', ')}${names.length > 12 ? '…' : ''}.`);
      wb = XLSX.read(buf, { type: 'buffer', cellDates: true, sheets: pick.length ? pick : names });
    } else wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
  } catch (e) { if (e instanceof LiewoodError) throw e; throw new LiewoodError('That file could not be opened. Use the Excel file, or a CSV of the tab (File, Download, CSV in Google Sheets).'); }
  return wb.SheetNames.filter(n => wb.Sheets[n]).map(name => ({ name, rows: XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name]!, { header: 1, raw: true, defval: null }).slice(0, 20000)
    .map(r => (Array.isArray(r) ? r.map(c => (c instanceof Date ? dateText(c) : c)) : r)) }));
}

// ---------- the Product Range List import ----------
export type RangeImport = { rows: number; added: number; updated: number; noSku: number; duplicates: string[]; problems: string[] };
/** Imports the Product Range List tab. Each SKU in the file is added, or replaced with what the file has. SKUs not in the file are left as they are. */
export async function importRangeList(repId: string, buf: Buffer): Promise<RangeImport> {
  const sheets = readSheets(buf, n => /product range list/i.test(n));
  const list = parseRangeList(sheets[0]!.rows), R = list.rows;
  return guard(async () => {
    const r = await prisma.$queryRaw<{ added: boolean }[]>`
      insert into crm.lw_range as r (sku, ean, name, colour, season, essential, subbrand, category, sub_category, product_type, order_increment, drop_eur, drop_aus, ranged, status, wsp_eur, proposed_rrp, source, updated_by)
      select t.*, 'master', ${repId}::uuid from unnest(${R.map(x => x.sku)}::text[], ${R.map(x => x.ean)}::text[], ${R.map(x => x.name)}::text[], ${R.map(x => x.colour)}::text[], ${R.map(x => x.season)}::text[],
        ${R.map(x => x.essential)}::text[], ${R.map(x => x.subbrand)}::text[], ${R.map(x => x.category)}::text[], ${R.map(x => x.subCategory)}::text[], ${R.map(x => x.productType)}::text[],
        ${R.map(x => x.orderIncrement)}::int[], ${R.map(x => x.dropEur)}::text[], ${R.map(x => x.dropAus)}::text[], ${R.map(x => x.ranged)}::text[], ${R.map(x => x.status)}::text[],
        ${R.map(x => dec(x.wspEur))}::numeric[], ${R.map(x => dec(x.proposedRrp))}::numeric[])
        as t(sku, ean, name, colour, season, essential, subbrand, category, sub_category, product_type, order_increment, drop_eur, drop_aus, ranged, status, wsp_eur, proposed_rrp)
      on conflict (sku) do update set ean = excluded.ean, name = excluded.name, colour = excluded.colour, season = excluded.season, essential = excluded.essential, subbrand = excluded.subbrand,
        category = excluded.category, sub_category = excluded.sub_category, product_type = excluded.product_type, order_increment = excluded.order_increment, drop_eur = excluded.drop_eur,
        drop_aus = excluded.drop_aus, ranged = excluded.ranged, status = excluded.status, wsp_eur = excluded.wsp_eur, proposed_rrp = excluded.proposed_rrp, source = 'master',
        updated_at = now(), updated_by = excluded.updated_by
      returning (xmax = 0) as added`;
    const added = r.filter(x => x.added).length;
    return { rows: R.length, added, updated: R.length - added, noSku: list.noSku, duplicates: list.duplicates.slice(0, 20), problems: list.problems };
  });
}

// ---------- a season file ----------
export type FeedResult = { added: number; updated: number };
/**
 * Fills SKUs into the range from the season files (crm.lw_catalogue). A SKU new to the range gets a row; one already there is brought up to date:
 *   from the files, when they have it:  EAN, EUR price (STOCK, else PRE), order increment (Forecast Form), drop delivery (Product Data, column M),
 *                                       category, sub-category and product type (Forecast Form)
 *   only when the range has nothing:    name, colour, season, Essential, proposed RRP (the Forecast Form's RRP inc GST)
 *   never:                              drop delivery to Australia (column O), ranged, status, notes. Those are typed in.
 */
export async function feedRange(skus: string[]): Promise<FeedResult> {
  const list = [...new Set(skus.map(s => s.trim().toUpperCase()).filter(Boolean))];
  if (!list.length) return { added: 0, updated: 0 };
  const [r] = await prisma.$queryRaw<{ added: number; updated: number }[]>`
    with src as (
      select c.sku, c.ean, coalesce(c.f_style_name, c.style_name) as name, coalesce(c.f_colour, c.colour) as colour, c.season_code as season,
        case when c.essentials ~* '^(true|yes|essentials?)$' then 'YES' when c.essentials ~* '^(false|no)$' then 'NO' else c.essentials end as essential,
        c.f_category, c.f_sub_category, c.f_product_type, c.lw_category, c.lw_sub_category, c.lw_product_type, c.f_increment, c.sales_multiple, c.drop_delivery,
        case when c.wsp_eur_stock > 0 then c.wsp_eur_stock when c.wsp_eur_pre > 0 then c.wsp_eur_pre end as wsp, c.rrp_aud
      from crm.lw_catalogue c where c.sku = any(${list}::text[])
    ), upd as (
      update crm.lw_range r set ean = coalesce(s.ean, r.ean), name = coalesce(r.name, s.name), colour = coalesce(r.colour, s.colour), season = coalesce(r.season, s.season),
        essential = coalesce(r.essential, s.essential), category = coalesce(s.f_category, r.category, s.lw_category), sub_category = coalesce(s.f_sub_category, r.sub_category, s.lw_sub_category),
        product_type = coalesce(s.f_product_type, r.product_type, s.lw_product_type), order_increment = coalesce(s.f_increment, r.order_increment, s.sales_multiple),
        drop_eur = coalesce(s.drop_delivery, r.drop_eur), wsp_eur = coalesce(s.wsp, r.wsp_eur), proposed_rrp = coalesce(r.proposed_rrp, s.rrp_aud), updated_at = now()
      from src s where r.sku = s.sku returning r.sku
    ), ins as (
      insert into crm.lw_range (sku, ean, name, colour, season, essential, category, sub_category, product_type, order_increment, drop_eur, wsp_eur, proposed_rrp, source)
      select s.sku, s.ean, s.name, s.colour, s.season, s.essential, coalesce(s.f_category, s.lw_category), coalesce(s.f_sub_category, s.lw_sub_category), coalesce(s.f_product_type, s.lw_product_type),
        coalesce(s.f_increment, s.sales_multiple), s.drop_delivery, s.wsp, s.rrp_aud, 'season files'
      from src s where s.sku not in (select sku from upd)
      on conflict (sku) do nothing returning sku
    )
    select (select count(*) from ins)::int as added, (select count(*) from upd)::int as updated`;
  return r ?? { added: 0, updated: 0 };
}
/** After a sales order is saved: fills its SKUs in. Never stops the upload: if the range is not set up yet, it says nothing. */
export async function feedAfterOrder(skus: string[]): Promise<FeedResult | null> {
  try { return await feedRange(skus); } catch (e) { if (!missing(e)) console.error('liewood range feed failed', String((e as Error)?.message ?? e).slice(0, 200)); return null; }
}

export type SeasonImport = { kind: 'product_data' | 'forecast'; file: string; tabs: string[]; skus: number; onOrders: number; fed: FeedResult; problems: string[] };
/** Keeps what one season file says about each SKU (only that file's columns change), then fills in the SKUs already on uploaded sales orders. */
export async function importSeasonFile(buf: Buffer, fileName: string): Promise<SeasonImport> {
  const f = parseSeasonFile(readSheets(buf)), file = fileName.slice(0, 200) || (f.kind === 'forecast' ? 'Customer Forecast Form' : 'Product Data file');
  return guard(async () => {
    if (f.kind === 'product_data') {
      const P = f.rows;
      await prisma.$queryRaw`
        insert into crm.lw_catalogue as c (sku, ean, style_no, style_name, colour_code, colour, size, season_code, essentials, development, drop_delivery, sales_multiple, wsp_eur_stock, wsp_eur_pre, rrp_eur, brand, lw_category, lw_sub_category, lw_product_type, product_file, product_at)
        select t.*, ${file}, now() from unnest(${P.map(x => x.sku)}::text[], ${P.map(x => x.ean)}::text[], ${P.map(x => x.styleNo)}::text[], ${P.map(x => x.styleName)}::text[], ${P.map(x => x.colourCode)}::text[],
          ${P.map(x => x.colour)}::text[], ${P.map(x => x.size)}::text[], ${P.map(x => x.seasonCode)}::text[], ${P.map(x => x.essentials)}::text[], ${P.map(x => x.development)}::text[], ${P.map(x => x.dropDelivery)}::text[],
          ${P.map(x => x.salesMultiple)}::int[], ${P.map(x => dec(x.wspEurStock))}::numeric[], ${P.map(x => dec(x.wspEurPre))}::numeric[], ${P.map(x => dec(x.rrpEur))}::numeric[], ${P.map(x => x.brand)}::text[],
          ${P.map(x => x.category)}::text[], ${P.map(x => x.subCategory)}::text[], ${P.map(x => x.productType)}::text[])
          as t(sku, ean, style_no, style_name, colour_code, colour, size, season_code, essentials, development, drop_delivery, sales_multiple, wsp_eur_stock, wsp_eur_pre, rrp_eur, brand, lw_category, lw_sub_category, lw_product_type)
        on conflict (sku) do update set ean = coalesce(excluded.ean, c.ean), style_no = excluded.style_no, style_name = excluded.style_name, colour_code = excluded.colour_code, colour = excluded.colour,
          size = excluded.size, season_code = excluded.season_code, essentials = excluded.essentials, development = excluded.development, drop_delivery = excluded.drop_delivery,
          sales_multiple = excluded.sales_multiple, wsp_eur_stock = excluded.wsp_eur_stock, wsp_eur_pre = excluded.wsp_eur_pre, rrp_eur = excluded.rrp_eur, brand = excluded.brand,
          lw_category = excluded.lw_category, lw_sub_category = excluded.lw_sub_category, lw_product_type = excluded.lw_product_type, product_file = excluded.product_file, product_at = now()`;
    } else {
      const F = f.rows;
      await prisma.$queryRaw`
        insert into crm.lw_catalogue as c (sku, ean, f_style_name, f_colour, f_size, f_category, f_sub_category, f_product_type, f_eta, f_increment, rrp_aud, ws_aud, forecast_file, forecast_at)
        select t.*, ${file}, now() from unnest(${F.map(x => x.sku)}::text[], ${F.map(x => x.ean)}::text[], ${F.map(x => x.styleName)}::text[], ${F.map(x => x.colour)}::text[], ${F.map(x => x.size)}::text[],
          ${F.map(x => x.category)}::text[], ${F.map(x => x.subCategory)}::text[], ${F.map(x => x.productType)}::text[], ${F.map(x => x.eta)}::text[], ${F.map(x => x.increment)}::int[],
          ${F.map(x => dec(x.rrpAud))}::numeric[], ${F.map(x => dec(x.wsAud))}::numeric[])
          as t(sku, ean, f_style_name, f_colour, f_size, f_category, f_sub_category, f_product_type, f_eta, f_increment, rrp_aud, ws_aud)
        on conflict (sku) do update set ean = coalesce(c.ean, excluded.ean), f_style_name = excluded.f_style_name, f_colour = excluded.f_colour, f_size = excluded.f_size, f_category = excluded.f_category,
          f_sub_category = excluded.f_sub_category, f_product_type = excluded.f_product_type, f_eta = excluded.f_eta, f_increment = excluded.f_increment, rrp_aud = excluded.rrp_aud, ws_aud = excluded.ws_aud,
          forecast_file = excluded.forecast_file, forecast_at = now()`;
    }
    const skus = f.rows.map(r => r.sku);
    const hasOrders = !!(await prisma.$queryRaw<{ t: string | null }[]>`select to_regclass('crm.lw_order_lines')::text as t`)[0]?.t;   // no Liewood orders table: nothing to fill in yet
    const onOrders = hasOrders ? (await prisma.$queryRaw<{ sku: string }[]>`select distinct sku from crm.lw_order_lines where not display and sku = any(${skus}::text[])`).map(r => r.sku) : [];
    const fed = await feedRange(onOrders);
    return { kind: f.kind, file, tabs: f.tabs, skus: skus.length, onOrders: onOrders.length, fed, problems: f.problems };
  });
}

// ---------- reading the range back ----------
export type RangeItem = {
  sku: string; ean: string | null; name: string | null; colour: string | null; season: string | null; essential: string | null; subbrand: string | null; category: string | null; subCategory: string | null;
  productType: string | null; orderIncrement: number | null; dropEur: string | null; dropAus: string | null; ranged: string | null; status: string | null; wspEur?: number | null; proposedRrp: number | null;
  notes: string | null; source: string; inDear: boolean; dearRrp: number | null; available: number | null; onOrder: number | null; check: PriceCheck; ordered: { so: string; qty: number }[]; orderedTotal: number;
};
export type RangeView = { items: RangeItem[]; files: { kind: 'product_data' | 'forecast'; file: string; skus: number; at: string }[]; catalogueSkus: number; orderSkusNotInRange: number };
type Row = { sku: string; ean: string | null; name: string | null; colour: string | null; season: string | null; essential: string | null; subbrand: string | null; category: string | null; sub_category: string | null; product_type: string | null;
  order_increment: number | null; drop_eur: string | null; drop_aus: string | null; ranged: string | null; status: string | null; wsp_eur: string | null; proposed_rrp: string | null; notes: string | null; source: string;
  dear_sku: string | null; prices: Record<string, number> | null; available: number | null; on_order: number | null; ordered: { so: string; qty: number }[] | null };
const n = (v: string | null) => (v === null ? null : Number(v));
export async function listRange(isManager: boolean): Promise<RangeView> {
  return guard(async () => {
    const ordersTable = (await prisma.$queryRaw<{ t: string | null }[]>`select to_regclass('crm.lw_order_lines')::text as t`)[0]?.t;
    const ordered = ordersTable
      ? `left join (select sku, json_agg(json_build_object('so', so, 'qty', qty) order by first) as ordered from (select l.sku, o.so_number as so, sum(l.qty)::int as qty, min(o.created_at) as first
           from crm.lw_order_lines l join crm.lw_orders o on o.id = l.order_id where not l.display group by l.sku, o.so_number) x group by sku) q on q.sku = r.sku`
      : `left join (select null::text as sku, null::json as ordered) q on false`;
    const [rows, files, extra] = await Promise.all([
      prisma.$queryRawUnsafe<Row[]>(`select r.sku, r.ean, r.name, r.colour, r.season, r.essential, r.subbrand, r.category, r.sub_category, r.product_type, r.order_increment, r.drop_eur, r.drop_aus, r.ranged, r.status,
          r.wsp_eur::text, r.proposed_rrp::text, r.notes, r.source, p.sku as dear_sku, p.prices, p.available, p.on_order as on_order, q.ordered
        from crm.lw_range r left join crm.products p on upper(btrim(p.sku)) = r.sku ${ordered} order by r.sku limit 20000`),
      prisma.$queryRaw<{ kind: 'product_data' | 'forecast'; file: string; skus: number; at: Date }[]>`
        select 'product_data' as kind, product_file as file, count(*)::int as skus, max(product_at) as at from crm.lw_catalogue where product_file is not null group by product_file
        union all select 'forecast', forecast_file, count(*)::int, max(forecast_at) from crm.lw_catalogue where forecast_file is not null group by forecast_file order by at desc limit 20`,
      ordersTable
        ? prisma.$queryRaw<{ cat: number; missing: number }[]>`select (select count(*) from crm.lw_catalogue)::int as cat, (select count(distinct l.sku) from crm.lw_order_lines l where not l.display and not exists (select 1 from crm.lw_range r where r.sku = l.sku))::int as missing`
        : prisma.$queryRaw<{ cat: number; missing: number }[]>`select (select count(*) from crm.lw_catalogue)::int as cat, 0 as missing`,
    ]);
    const items = rows.map(r => {
      const rrp = retailPrice(r.prices), proposed = n(r.proposed_rrp), ord = r.ordered ?? [];
      const item: RangeItem = { sku: r.sku, ean: r.ean, name: r.name, colour: r.colour, season: r.season, essential: r.essential, subbrand: r.subbrand, category: r.category, subCategory: r.sub_category,
        productType: r.product_type, orderIncrement: r.order_increment, dropEur: r.drop_eur, dropAus: r.drop_aus, ranged: r.ranged, status: r.status, proposedRrp: proposed, notes: r.notes, source: r.source,
        inDear: !!r.dear_sku, dearRrp: rrp, available: r.available, onOrder: r.on_order, check: priceCheck(proposed, rrp, !!r.dear_sku), ordered: ord, orderedTotal: ord.reduce((t, o) => t + o.qty, 0) };
      if (isManager) item.wspEur = n(r.wsp_eur);
      return item;
    });
    return { items, files: files.map(f => ({ ...f, at: new Date(f.at).toISOString() })), catalogueSkus: extra[0]?.cat ?? 0, orderSkusNotInRange: extra[0]?.missing ?? 0 };
  });
}

/** What a manager types in on the range: the drop delivery to Australia (column O), ranged, status, the proposed RRP, notes. */
export async function updateRangeItem(repId: string, b: Record<string, unknown>): Promise<void> {
  const sku = typeof b.sku === 'string' ? b.sku.trim().toUpperCase() : '';
  if (!sku) throw new LiewoodError('Say which SKU to change.');
  const t = (v: unknown, max: number, what: string) => { if (v === undefined) return undefined; if (v !== null && typeof v !== 'string') throw new LiewoodError(`The ${what} must be text.`); const s = (v ?? '').trim(); if (s.length > max) throw new LiewoodError(`Keep the ${what} to ${max} characters.`); return s || null; };
  const dropAus = t(b.dropAus, 60, 'delivery to Australia'), ranged = t(b.ranged, 40, '"confirmed to range"'), status = t(b.status, 60, 'status'), notes = t(b.notes, 1000, 'notes');
  let rrp: number | null | undefined;
  if (b.proposedRrp !== undefined) {
    if (b.proposedRrp === null || b.proposedRrp === '') rrp = null;
    else { const x = typeof b.proposedRrp === 'number' ? b.proposedRrp : Number(String(b.proposedRrp).replace(/[$\s,]/g, '')); if (!Number.isFinite(x) || x < 0 || x > 100000) throw new LiewoodError('The proposed RRP must be a price, like 29.95.'); rrp = Math.round(x * 100) / 100; }
  }
  await guard(async () => {
    const r = await prisma.$queryRaw<{ sku: string }[]>`update crm.lw_range set
        drop_aus = case when ${dropAus !== undefined}::boolean then ${dropAus ?? null}::text else drop_aus end, ranged = case when ${ranged !== undefined}::boolean then ${ranged ?? null}::text else ranged end,
        status = case when ${status !== undefined}::boolean then ${status ?? null}::text else status end, notes = case when ${notes !== undefined}::boolean then ${notes ?? null}::text else notes end,
        proposed_rrp = case when ${rrp !== undefined}::boolean then ${dec(rrp ?? null)}::numeric else proposed_rrp end, updated_at = now(), updated_by = ${repId}::uuid
      where sku = ${sku} returning sku`;
    if (!r.length) throw new LiewoodError(`${sku} is not in the range.`, 404);
  });
}
