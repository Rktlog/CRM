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
const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' };
export const MAX_DESCRIPTION = 4000;

export function cleanDescription(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const text = v
    .replace(/\r\n?/g, '\n')                                          // DEAR's Windows line endings
    .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6])\s*\/?>/gi, '\n')       // line breaks and the end of a paragraph
    .replace(/<[^>]*>/g, '')                                          // every other tag
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, m => ENTITIES[m] ?? m)
    .replace(/[ \t\u00a0]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return text ? text.slice(0, MAX_DESCRIPTION) : null;
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
let noIncrementColumn = false;   // the column is added by product-increment.sql; until then, descriptions are still saved

export type Preview = { sku: string; from: string | null };
// dryRun: work out what would change and change nothing. `examples` are the first products that would move to EOL.
export async function syncProductDetails(products?: any[], o: { dryRun?: boolean; catchUpEol?: boolean } = {}): Promise<{ checked: number; updated: number; markedEol: number; skipped?: string; examples?: Preview[]; fromStages?: Record<string, number> }> {
  const list = products ?? await fetchAllProducts();
  const rows = list.filter(p => p && p.SKU != null && String(p.SKU).trim() !== '').map(p => ({ sku: String(p.SKU).trim(), text: descriptionOf(p) ?? '', inc: orderIncrementFrom(p) ?? 0 }));
  // If DEAR's answer carries no Description field at all, something is different about it: leave what we have, never wipe it.
  if (!list.some(p => p && 'Description' in p)) {
    console.warn('Product details: DEAR\'s product list has no Description field, so descriptions were left as they are.');
    return { checked: rows.length, updated: 0, markedEol: 0, skipped: 'no Description field in the DEAR product list' };
  }
  // If DEAR's answer carries no such attribute at all, an increment is only ever set from a description, never cleared.
  const clearIncrements = list.some(p => p && incrementField() in p);
  if (!clearIncrements) console.warn(`Product details: DEAR's product list has no ${incrementField()} field, so order increments are only taken from descriptions and never cleared.`);
  let updated = 0, markedEol = 0;
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
  console.log(`Product details${o.dryRun ? ' (preview, nothing changed)' : ''}: ${rows.length} products read from DEAR (${rows.filter(r => r.inc).length} with an order increment), ${updated} ${o.dryRun ? 'would be' : ''} updated, ${markedEol} ${o.dryRun ? 'would be' : ''} moved to EOL because the description says end of line.`);
  return { checked: rows.length, updated, markedEol, ...(o.dryRun ? { examples, fromStages } : {}) };
}