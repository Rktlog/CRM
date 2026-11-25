// Pictures the marketing team upload from their computer for the Email Builder, and the product search the product block uses.
import { prisma } from '../prisma';
import { wholesalePrice, retailPrice } from '../pricing';

export const MAX_PICTURE_BYTES = 2_500_000;
export class PictureError extends Error { constructor(message: string, public status = 400) { super(message); } }

/** What the file really is, from its first bytes (not from what the browser says). Only the three kinds every email program shows. */
export function sniffPicture(b: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (b.length > 12 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 12 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}
const SETUP = 'Picture upload needs a one-time set-up. Ask Sushan to run API/sql/marketing-images.sql.';
const notSetUp = (e: any) => e?.code === 'P2010' && /42P01|marketing_images/.test(String(e?.meta?.code ?? '') + String(e?.message ?? ''));

export async function savePicture(body: unknown, name: unknown, repId: string): Promise<string> {
  if (!Buffer.isBuffer(body) || !body.length) throw new PictureError('Choose a picture to upload.');
  if (body.length > MAX_PICTURE_BYTES) throw new PictureError('That picture is too big. Use one under 2 MB.', 413);
  const type = sniffPicture(body);
  if (!type) throw new PictureError('Use a JPG, PNG or WebP picture.');
  const label = typeof name === 'string' ? name.replace(/[\r\n]/g, ' ').trim().slice(0, 120) || null : null;
  try {
    const [r] = await prisma.$queryRaw<{ id: string }[]>`insert into crm.marketing_images (content_type, bytes, name, created_by) values (${type}, ${body}, ${label}, ${repId}::uuid) returning id`;
    return r!.id;
  } catch (e: any) { if (notSetUp(e)) throw new PictureError(SETUP, 503); throw e; }
}
export async function readPicture(id: string): Promise<{ type: string; bytes: Buffer } | null> {
  try {
    const [r] = await prisma.$queryRaw<{ content_type: string; bytes: Buffer }[]>`select content_type, bytes from crm.marketing_images where id = ${id}::uuid`;
    return r ? { type: r.content_type, bytes: Buffer.from(r.bytes) } : null;
  } catch (e: any) { if (notSetUp(e)) return null; throw e; }
}

// ---------- product search by name ----------
export type PickProduct = { sku: string; name: string; brand: string | null; imageUrl: string | null; wholesale: number | null; retail: number | null };
type Row = { sku: string; name: string; brand: string | null; image_url: string | null; prices: Record<string, number> | null };
const toPick = (r: Row): PickProduct => ({ sku: r.sku, name: r.name, brand: r.brand, imageUrl: r.image_url, wholesale: wholesalePrice(r.prices), retail: retailPrice(r.prices) });

/** Every word typed has to be in the name, the product code or the brand, so "miffy lamp" finds "Miffy Lamp Large". Products that are discontinued are left out. */
export async function searchPickable(q: unknown): Promise<PickProduct[]> {
  const words = String(q ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 4);
  if (!words.length || words.join('').length < 2) return [];
  const pat = words.map(w => `%${w.slice(0, 40).replace(/[%_\\]/g, m => '\\' + m)}%`);
  while (pat.length < 4) pat.push('%');
  const [a, b, c, d] = pat;
  const rows = await prisma.$queryRaw<Row[]>`
    select sku, name, brand, image_url, prices from crm.products
    where (sku ilike ${a} or name ilike ${a} or brand ilike ${a}) and (sku ilike ${b} or name ilike ${b} or brand ilike ${b})
      and (sku ilike ${c} or name ilike ${c} or brand ilike ${c}) and (sku ilike ${d} or name ilike ${d} or brand ilike ${d})
      and coalesce(status, '') <> 'Deprecated' and coalesce(lifecycle, '') <> 'discontinued'
    order by (upper(sku) = upper(${words[0]!})) desc, (name ilike ${words[0]! + '%'}) desc, name limit 20`;
  return rows.map(toPick);
}
/** The names for product codes a block already holds, so the editor can show names instead of codes. */
export async function lookupPickable(skus: unknown): Promise<PickProduct[]> {
  const list = (Array.isArray(skus) ? skus : []).filter((s): s is string => typeof s === 'string').slice(0, 60);
  if (!list.length) return [];
  const rows = await prisma.$queryRaw<Row[]>`select sku, name, brand, image_url, prices from crm.products where sku = any(${list}::text[])`;
  return rows.map(toPick);
}
