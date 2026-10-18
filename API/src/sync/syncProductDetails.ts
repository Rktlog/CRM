import { prisma } from '../lib/prisma';
import { fetchAllProducts } from './dearClient';

// Copies each product's Description from DEAR onto crm.products.description (DEAR's ShortDescription is ignored), so the
// Products page, the catalogue and the assistant can show it. It only updates products the CRM already has (the stock and
// price sync creates them), and only where the text differs. Plain text: DEAR's tags and entities are stripped, so it can
// be shown safely anywhere.
//
// A description that says "end of line" (or EOL) moves the product to the EOL stage. That happens when the description
// BEGINS to say it, not on every run, so a stage someone sets by hand afterwards is never taken back. Products already
// EOL or Discontinued are left alone. (An EOL product with no stock left then becomes Discontinued by the database rule.)
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

export async function syncProductDetails(products?: any[]): Promise<{ checked: number; updated: number; markedEol: number; skipped?: string }> {
  const list = products ?? await fetchAllProducts();
  const rows = list.filter(p => p && p.SKU != null && String(p.SKU).trim() !== '').map(p => ({ sku: String(p.SKU).trim(), text: descriptionOf(p) ?? '' }));
  // If DEAR's answer carries no Description field at all, something is different about it: leave what we have, never wipe it.
  if (!list.some(p => p && 'Description' in p)) {
    console.warn('Product details: DEAR\'s product list has no Description field, so descriptions were left as they are.');
    return { checked: rows.length, updated: 0, markedEol: 0, skipped: 'no Description field in the DEAR product list' };
  }
  let updated = 0, markedEol = 0;
  for (let i = 0; i < rows.length; i += 1000) {
    const batch = rows.slice(i, i + 1000);
    // What the CRM has now, read before it changes, to tell a description that has just begun to say "end of line".
    type Before = { sku: string; description: string | null; lifecycle: string | null };
    const before = new Map<string, Before>((await prisma.$queryRaw<Before[]>`
      select sku, description, lifecycle from crm.products where sku = any(${batch.map(r => r.sku)}::text[])`).map((r): [string, Before] => [r.sku, r]));
    const changed = await prisma.$queryRaw<{ n: number }[]>`
      update crm.products p set description = nullif(v.text, '')
      from unnest(${batch.map(r => r.sku)}::text[], ${batch.map(r => r.text)}::text[]) as v(sku, text)
      where p.sku = v.sku and p.description is distinct from nullif(v.text, '')
      returning 1 as n`;
    updated += changed.length;

    const toEol = batch.filter(r => { const b = before.get(r.sku); return !!b && saysEndOfLine(r.text) && !saysEndOfLine(b.description) && b.lifecycle !== 'eol' && b.lifecycle !== 'discontinued'; });
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
  console.log(`Product details: ${rows.length} products read from DEAR, ${updated} descriptions updated, ${markedEol} moved to EOL because the description says end of line.`);
  return { checked: rows.length, updated, markedEol };
}