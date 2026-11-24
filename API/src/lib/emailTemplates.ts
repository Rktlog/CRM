// The words an email starts with. The abandoned cart email follows the team's template: greeted by first name, with the brands in the cart named.
// Everything is editable before it is sent. Nothing here sends anything.
import { prisma } from './prisma';
import { DEFAULTS, fill, joinAnd as join } from './salesToolsCore';
import { renderBuiltIn } from './salesTools';

export const CART_SUBJECT = 'Items waiting in your Rhino Rhino B2B cart';
/** "Austin", "Austin and Lachlan", "Austin, Lachlan and Sam". */
export const joinAnd = join;
/** First names from how a contact is written in DEAR: "Austin Smith & Lachlan Jones" gives Austin and Lachlan. Nothing sensible gives an empty list (the greeting is then "Hi there,"). */
export function firstNames(contact: string | null | undefined): string[] {
  const out: string[] = [];
  for (const part of String(contact ?? '').split(/\s*(?:&|\+|\/|;|,|\band\b)\s*/i)) {
    const w = part.trim().split(/\s+/)[0] ?? '';
    if (!/^[\p{L}][\p{L}'’-]{0,29}$/u.test(w) || /@/.test(part)) continue;
    const n = w.charAt(0).toUpperCase() + w.slice(1); if (!out.includes(n)) out.push(n);
    if (out.length >= 4) break;
  }
  return out;
}
export const greeting = (names: string[]): string => `Hi ${names.length ? joinAnd(names) : 'there'},`;
/** The abandoned cart email as the team first wrote it (the saved template replaces this once a manager changes it: see lib/salesTools.ts). */
export function cartBody(names: string[], brands: string[]): string { return fill(DEFAULTS.abandoned_cart.body, { names, brands }).text; }
export type Template = { subject: string; body: string };
/** The cart's contacts and the brands of what is in it, from the cart's own lines. */
export async function cartTemplate(cartKey: string): Promise<Template> {
  const [at, email] = [cartKey.split('|')[0] ?? '', (cartKey.split('|')[1] ?? '').toLowerCase()];
  const lines = await prisma.$queryRaw<{ contact: string; product_name: string }[]>`select contact, product_name from crm.abandoned_cart_lines where abandoned_at = ${at}::timestamp and lower(btrim(email)) = ${email}`;
  const names = [...new Set(lines.flatMap(l => firstNames(l.contact)))].slice(0, 4);
  const found = lines.length ? await prisma.$queryRaw<{ brand: string | null }[]>`select distinct brand from crm.products where lower(name) = any(${lines.map(l => l.product_name.toLowerCase())}::text[]) and brand is not null and btrim(brand) <> '' order by brand` : [];
  const brands = found.map(f => String(f.brand).trim());
  try { const t = await renderBuiltIn('abandoned_cart', { names, brands }); return { subject: t.subject, body: t.body }; }   // the saved template, or today's wording
  catch { return { subject: CART_SUBJECT, body: cartBody(names, brands) }; }
}
/** An email about an order starts with the order number, and a greeting if the order has a contact. (Today's wording; see orderTemplateSaved.) */
export function orderTemplate(number: string, contact: string | null | undefined): Template {
  return { subject: `Order ${number}`, body: `${greeting(firstNames(contact))}\n\n` };
}
/** The same, from the saved template if a manager has changed it. */
export async function orderTemplateSaved(number: string, contact: string | null | undefined): Promise<Template> {
  try { const t = await renderBuiltIn('order_email', { names: firstNames(contact), number }); return { subject: t.subject, body: t.body }; }
  catch { return orderTemplate(number, contact); }
}
