// The words an email starts with. The abandoned cart email follows the team's template: greeted by first name, with the brands in the cart named.
// Everything is editable before it is sent. Nothing here sends anything.
import { prisma } from './prisma';

export const CART_SUBJECT = 'Items waiting in your Rhino Rhino B2B cart';
const PORTAL = 'https://rhinorhino.dearportal.com/', CATALOGUE = 'https://www.rhinorhino.com.au/rhino-rhino-catalogue';
/** "Austin", "Austin and Lachlan", "Austin, Lachlan and Sam". */
export const joinAnd = (l: string[]): string => (l.length <= 1 ? (l[0] ?? '') : `${l.slice(0, -1).join(', ')} and ${l[l.length - 1]}`);
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
/** The abandoned cart email, filled in. */
export function cartBody(names: string[], brands: string[]): string {
  const what = brands.length ? `some great ${joinAnd(brands.slice(0, 3))} Items` : 'some great items';
  return `${greeting(names)}

Hope all's well!

Just a friendly reminder that you have ${what} waiting in your B2B cart.

With new stock arriving daily and our warehouse busy receiving fresh arrivals across our latest collections, now is a great time to get your order underway!

Can we help you check out?

If you're still interested in these favourites, simply jump back into the [Rhino Rhino B2B Portal](${PORTAL}) to complete your order.

You can also explore what's new in our [RR AW2026 Catalogue.](${CATALOGUE})

If you have any questions about availability, need a hand with your selection or would like us to help finalise your order, just reply to this email. We're always happy to help!

Look forward to seeing your order come through!`;
}
export type Template = { subject: string; body: string };
/** The cart's contacts and the brands of what is in it, from the cart's own lines. */
export async function cartTemplate(cartKey: string): Promise<Template> {
  const [at, email] = [cartKey.split('|')[0] ?? '', (cartKey.split('|')[1] ?? '').toLowerCase()];
  const lines = await prisma.$queryRaw<{ contact: string; product_name: string }[]>`select contact, product_name from crm.abandoned_cart_lines where abandoned_at = ${at}::timestamp and lower(btrim(email)) = ${email}`;
  const names = [...new Set(lines.flatMap(l => firstNames(l.contact)))].slice(0, 4);
  const found = lines.length ? await prisma.$queryRaw<{ brand: string | null }[]>`select distinct brand from crm.products where lower(name) = any(${lines.map(l => l.product_name.toLowerCase())}::text[]) and brand is not null and btrim(brand) <> '' order by brand` : [];
  return { subject: CART_SUBJECT, body: cartBody(names, found.map(f => String(f.brand).trim())) };
}
/** An email about an order starts with the order number, and a greeting if the order has a contact. */
export function orderTemplate(number: string, contact: string | null | undefined): Template {
  return { subject: `Order ${number}`, body: `${greeting(firstNames(contact))}\n\n` };
}
