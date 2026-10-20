import { decodeEntities } from '../lib/htmlText';
import { prisma } from '../lib/prisma';
import { fetchAllProducts } from './dearClient';
import { wholeNumber } from './incrementFields';

// Copies each product's Description from DEAR onto crm.products.description (DEAR's ShortDescription is ignored), so the
// Products page, the catalogue and the assistant can show it. It only updates products the CRM already has (the stock and
// price sync creates them), and only where the text differs. Plain text: DEAR's tags and entities are stripped, so it can
// be shown safely anywhere.
//
// The order increment (crm.products.order_increment) comes from DEAR's custom attribute "Order Increment", which is
// AdditionalAttribute1 on this account (set ORDER_INCREMENT_FIELD to use another). Only when a product has no value there,
// an "ORDER INCREMENT: 4" line in its description is used instead: the descriptions are often out of date.
//
// A description that says "end of line" (or EOL) moves the product to the EOL stage. That happens when the description
// BEGINS to say it, not on every run, so a stage someone sets by hand afterwards is never taken back. Products already
// EOL or Discontinued are left alone. (An EOL product with no stock left then becomes Discontinued by the database rule.)
// Descriptions that were saved BEFORE this rule existed never "begin" to say it, so for those there is a one-off catch-up
// (catchUpEol): it treats every description that says it as new, once.
export const MAX_DESCRIPTION = 4000;

export function cleanDescription(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const text = decodeEntities(v
    .replace(/\r\n?/g, '\n')                                          // DEAR's Windows line endings
    .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6])\s*\/?>/gi, '\n')       // line breaks and the end of a paragraph
    .replace(/<[^>]*>/g, ''))                                         // every other tag; then &rsquo; &bull; &amp; and the rest become real characters
    .replace(/[ \t\u00a0]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return text ? text.slice(0, MAX_DESCRIPTION) : null;
}

// Weight and size from DEAR (Weight, Length, Width, Height, with their units), saved in kilograms and centimetres whatever DEAR holds
// them in. DEAR holds 0 for "not set": that is stored as empty. If the units are missing or not recognised, kg and cm are assumed.
const POSITIVE = (v: unknown): number => { const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.trim()) : NaN; return Number.isFinite(n) && n > 0 ? n : 0; };
const unitOf = (p: any, names: string[]): string => {
  for (const k of names) if (typeof p?.[k] === 'string' && p[k].trim()) return p[k].trim().toLowerCase().replace(/[.\s]+$/g, '');
  return '';
};
const TO_KG: Record<string, number> = { kg: 1, kgs: 1, kilogram: 1, kilograms: 1, g: 0.001, gm: 0.001, gram: 0.001, grams: 0.001, lb: 0.45359237, lbs: 0.45359237, pound: 0.45359237, pounds: 0.45359237, oz: 0.028349523125, ounce: 0.028349523125, ounces: 0.028349523125 };
const TO_CM: Record<string, number> = { cm: 1, centimetre: 1, centimetres: 1, centimeter: 1, centimeters: 1, mm: 0.1, millimetre: 0.1, millimetres: 0.1, millimeter: 0.1, millimeters: 0.1, m: 100, metre: 100, metres: 100, meter: 100, meters: 100, in: 2.54, inch: 2.54, inches: 2.54, '"': 2.54, ft: 30.48, foot: 30.48, feet: 30.48 };
export const SPEC_FIELDS = ['Weight', 'Length', 'Width', 'Height'];
export type Specs = { weightKg: number; lengthCm: number; widthCm: number; heightCm: number };   // 0 = not set
export function specsOf(p: any): Specs {
  const kg = TO_KG[unitOf(p, ['WeightUnits', 'WeightUnit'])] ?? 1;
  const cm = TO_CM[unitOf(p, ['DimensionsUnits', 'DimensionUnits', 'DimensionsUnit', 'DimensionUnit', 'LengthUnits'])] ?? 1;
  const r = (n: number, d: number) => (n > 0 ? Math.round(n * 10 ** d) / 10 ** d : 0);
  return { weightKg: r(POSITIVE(p?.Weight) * kg, 3), lengthCm: r(POSITIVE(p?.Length) * cm, 2), widthCm: r(POSITIVE(p?.Width) * cm, 2), heightCm: r(POSITIVE(p?.Height) * cm, 2) };
}

// DEAR's tags: one line, separated by commas ("Pantone, Sleeve, 13 inch"). Each is tidied (HTML codes decoded, stray spaces and control
// characters removed), a tag that repeats (in any case) is kept once, a tag is cut at 100 characters and a product at 50 tags.
export const MAX_TAGS = 50, MAX_TAG_LENGTH = 100;
export function tagsOf(p: any): string[] {
  const v = p?.Tags;
  const parts: unknown[] = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [];
  const seen = new Set<string>(), out: string[] = [];
  for (const raw of parts) {
    if (typeof raw !== 'string') continue;
    const tag = decodeEntities(raw).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TAG_LENGTH).trim();
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase()); out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

// DEAR's Description. The short one is not used.
export const descriptionOf = (p: any): string | null => cleanDescription(p?.Description);

// "End of line", "end-of-line", "END OF LINE", or EOL as a word on its own. (Not "protocol", "Eolian" or "baseline".)
export const END_OF_LINE = /\bend[\s_-]*of[\s_-]*line\b|\beol\b/i;
export const saysEndOfLine = (text: string | null | undefined): boolean => !!text && END_OF_LINE.test(text);
const REASON = 'Description says end of line';

// "ORDER INCREMENT: 4", "Order increment - 6", "order increment 12". The first one in the text; a whole number from 1 up.
export function orderIncrementOf(text: string | null | undefined): number | null {
  const m = text ? /\border[\s_-]*increment\b\s*[:=\-\u2013]?\s*(\d{1,5})\b/i.exec(text) : null;
  const n = m ? Number(m[1]) : 0;
  return n >= 1 ? n : null;
}
// Which DEAR field holds the order increment. Read when used, so it can be changed without a restart in tests.
export const incrementField = () => process.env.ORDER_INCREMENT_FIELD || 'AdditionalAttribute1';
// The attribute if it has a whole number in it, otherwise the line in the description.
export const orderIncrementFrom = (p: any): number | null => wholeNumber(p?.[incrementField()]) ?? orderIncrementOf(descriptionOf(p));
let noTagColumn = false;         // the column is added by product-tags.sql; until then, the rest is still saved
let noSpecColumns = false;       // the columns are added by product-dimensions.sql; until then, the rest is still saved
let noIncrementColumn = false;   // the column is added by product-increment.sql; until then, descriptions are still saved

export type Preview = { sku: string; from: string | null };
// dryRun: work out what would change and change nothing. `examples` are the first products that would move to EOL.
export async function syncProductDetails(products?: any[], o: { dryRun?: boolean; catchUpEol?: boolean } = {}): Promise<{ checked: number; updated: number; markedEol: number; specsUpdated?: number; tagsUpdated?: number; skipped?: string; examples?: Preview[]; fromStages?: Record<string, number> }> {
  const list = products ?? await fetchAllProducts();
  const rows = list.filter(p => p && p.SKU != null && String(p.SKU).trim() !== '').map(p => ({ sku: String(p.SKU).trim(), text: descriptionOf(p) ?? '', inc: orderIncrementFrom(p) ?? 0, specs: specsOf(p), tags: tagsOf(p) }));
  // If DEAR's answer carries no Description field at all, something is different about it: leave what we have, never wipe it.
  if (!list.some(p => p && 'Description' in p)) {
    console.warn('Product details: DEAR\'s product list has no Description field, so descriptions were left as they are.');
    return { checked: rows.length, updated: 0, markedEol: 0, skipped: 'no Description field in the DEAR product list' };
  }
  // If DEAR's answer carries no such attribute at all, an increment is only ever set from a description, never cleared.
  const clearIncrements = list.some(p => p && incrementField() in p);
  if (!clearIncrements) console.warn(`Product details: DEAR's product list has no ${incrementField()} field, so order increments are only taken from descriptions and never cleared.`);
  // If DEAR's answer carries none of the weight and size fields at all, they are left as they are, never wiped.
  const specsPresent = list.some(p => p && SPEC_FIELDS.some(f => f in p));
  if (!specsPresent) console.warn('Product details: DEAR\'s product list has no Weight, Length, Width or Height fields, so weights and sizes were left as they are.');
  // If DEAR's answer carries no Tags field at all, tags are left as they are, never wiped.
  const tagsPresent = list.some(p => p && 'Tags' in p);
  if (!tagsPresent) console.warn('Product details: DEAR\'s product list has no Tags field, so tags were left as they are.');
  let updated = 0, markedEol = 0, specsUpdated = 0, tagsUpdated = 0;
  const examples: Preview[] = [];
  const fromStages: Record<string, number> = {};   // preview: the stage these products are in now
  for (let i = 0; i < rows.length; i += 1000) {
    const batch = rows.slice(i, i + 1000);
    // What the CRM has now, read before it changes, to tell a description that has just begun to say "end of line".
    type Before = { sku: string; description: string | null; lifecycle: string | null };
    const before = new Map<string, Before>((await prisma.$queryRaw<Before[]>`
      select sku, description, lifecycle from crm.products where sku = any(${batch.map(r => r.sku)}::text[])`).map((r): [string, Before] => [r.sku, r]));
    if (o.dryRun) updated += batch.filter(r => before.has(r.sku) && (before.get(r.sku)!.description ?? '') !== r.text).length;
    else {
      const skus = batch.map(r => r.sku), texts = batch.map(r => r.text), incs = batch.map(r => r.inc);
      const descriptionOnly = () => prisma.$queryRaw<{ n: number }[]>`
        update crm.products p set description = nullif(v.text, '')
        from unnest(${skus}::text[], ${texts}::text[]) as v(sku, text)
        where p.sku = v.sku and p.description is distinct from nullif(v.text, '')
        returning 1 as n`;
      let changed: { n: number }[];
      if (noIncrementColumn) changed = await descriptionOnly();
      else {
        try {
          changed = await prisma.$queryRaw<{ n: number }[]>`
            update crm.products p set description = nullif(v.text, ''),
              order_increment = case when v.inc > 0 then v.inc when ${clearIncrements}::boolean then null else p.order_increment end
            from unnest(${skus}::text[], ${texts}::text[], ${incs}::int[]) as v(sku, text, inc)
            where p.sku = v.sku and (p.description is distinct from nullif(v.text, '')
              or p.order_increment is distinct from (case when v.inc > 0 then v.inc when ${clearIncrements}::boolean then null else p.order_increment end))
            returning 1 as n`;
        } catch (e) {
          if (!/order_increment/.test(String((e as Error).message))) throw e;
          console.warn('Product details: crm.products has no order_increment column yet (run product-increment.sql). Saving descriptions only.');
          noIncrementColumn = true;
          changed = await descriptionOnly();
        }
      }
      updated += changed.length;
    }

    if (!o.dryRun && specsPresent && !noSpecColumns) {
      try {
        const sk = batch.map(r => r.sku), w = batch.map(r => r.specs.weightKg), l = batch.map(r => r.specs.lengthCm), wd = batch.map(r => r.specs.widthCm), h = batch.map(r => r.specs.heightCm);
        const changedSpecs = await prisma.$queryRaw<{ n: number }[]>`
          update crm.products p set weight_kg = nullif(v.w, 0), length_cm = nullif(v.l, 0), width_cm = nullif(v.wd, 0), height_cm = nullif(v.h, 0)
          from unnest(${sk}::text[], ${w}::float8[], ${l}::float8[], ${wd}::float8[], ${h}::float8[]) as v(sku, w, l, wd, h)
          where p.sku = v.sku and (p.weight_kg is distinct from nullif(v.w, 0) or p.length_cm is distinct from nullif(v.l, 0)
            or p.width_cm is distinct from nullif(v.wd, 0) or p.height_cm is distinct from nullif(v.h, 0))
          returning 1 as n`;
        specsUpdated += changedSpecs.length;
      } catch (e) {
        if (!/weight_kg|length_cm|width_cm|height_cm/.test(String((e as Error).message))) throw e;
        console.warn('Product details: crm.products has no weight and size columns yet (run product-dimensions.sql). Everything else was saved.');
        noSpecColumns = true;
      }
    }

    if (!o.dryRun && tagsPresent && !noTagColumn) {
      try {
        // One line per product, the tags joined by an unprintable separator (chr(31), which a tag can never hold), cut apart again in SQL.
        const sk = batch.map(r => r.sku), joined = batch.map(r => r.tags.join('\u001f'));
        const changedTags = await prisma.$queryRaw<{ n: number }[]>`
          update crm.products p set tags = case when v.t = '' then null else string_to_array(v.t, chr(31)) end
          from unnest(${sk}::text[], ${joined}::text[]) as v(sku, t)
          where p.sku = v.sku and p.tags is distinct from (case when v.t = '' then null else string_to_array(v.t, chr(31)) end)
          returning 1 as n`;
        tagsUpdated += changedTags.length;
      } catch (e) {
        if (!/\btags\b/.test(String((e as Error).message))) throw e;
        console.warn('Product details: crm.products has no tags column yet (run product-tags.sql). Everything else was saved.');
        noTagColumn = true;
      }
    }

    const toEol = batch.filter(r => { const b = before.get(r.sku); return !!b && saysEndOfLine(r.text) && (o.catchUpEol || !saysEndOfLine(b.description)) && b.lifecycle !== 'eol' && b.lifecycle !== 'discontinued'; });
    if (o.dryRun) { markedEol += toEol.length; for (const r of toEol) { const from = before.get(r.sku)!.lifecycle; fromStages[from ?? '(no stage)'] = (fromStages[from ?? '(no stage)'] ?? 0) + 1; if (examples.length < 25) examples.push({ sku: r.sku, from }); } continue; }
    if (toEol.length) {
      const skus = toEol.map(r => r.sku), froms = toEol.map(r => before.get(r.sku)!.lifecycle ?? '');
      // The log entry first, then the move: the stock rule may move an EOL product with no stock on to Discontinued the
      // moment it becomes EOL, and the log should read in the order it happened.
      await prisma.$queryRaw`
        insert into crm.product_stage_log (sku, from_stage, to_stage, reason)
        select sku, nullif(from_stage, ''), 'eol', ${REASON} from unnest(${skus}::text[], ${froms}::text[]) as v(sku, from_stage)
        returning 1 as n`;
      const moved = await prisma.$queryRaw<{ n: number }[]>`
        update crm.products p set lifecycle = 'eol'
        where p.sku = any(${skus}::text[]) and p.lifecycle is distinct from 'eol' and p.lifecycle is distinct from 'discontinued'
        returning 1 as n`;
      markedEol += moved.length;
    }
  }
  console.log(`Product details${o.dryRun ? ' (preview, nothing changed)' : ''}: ${rows.length} products read from DEAR (${rows.filter(r => r.inc).length} with an order increment, ${rows.filter(r => r.specs.weightKg).length} with a weight, ${rows.filter(r => r.specs.lengthCm && r.specs.widthCm && r.specs.heightCm).length} with a full size, ${rows.filter(r => r.tags.length).length} with tags${o.dryRun ? '' : `; ${specsUpdated} weights and sizes and ${tagsUpdated} tag lists updated`}, ${updated} ${o.dryRun ? 'would be' : ''} updated, ${markedEol} ${o.dryRun ? 'would be' : ''} moved to EOL because the description says end of line.`);
  return { checked: rows.length, updated, markedEol, ...(o.dryRun ? { examples, fromStages } : { specsUpdated, tagsUpdated }) };
}