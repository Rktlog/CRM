// Sales Tools, the plain rules (no database): the words a saved email template can use, how they are filled in, and the checks on a saved link.
// A template is written once and used every time: the payment reminder, the abandoned cart email, the order email, and any the team adds.
// Words in square brackets are filled in for each email:
//   [Name]          the contact's first name (or "there" if there is none)       [Number]   the quote or order number
//   [Brands]        for the abandoned cart: "some great Brand and Brand Items"    [Link: Name]  a saved link, shown as its name
//   [Link: Name | some words]   a saved link, shown as "some words" (the address is still changed in one place, on the Links tab)
// A link already written as [words](https://address) is left alone.

export const joinAnd = (l: string[]): string => (l.length <= 1 ? (l[0] ?? '') : `${l.slice(0, -1).join(', ')} and ${l[l.length - 1]}`);

export const PLACEHOLDER_HELP: { tag: string; means: string }[] = [
  { tag: '[Name]', means: "the contact's first name, or \"there\" when there is none" },
  { tag: '[Number]', means: 'the quote or order number' },
  { tag: '[Brands]', means: 'abandoned cart: "some great (brands) Items", from what is in the cart' },
  { tag: '[Link: name]', means: 'a link saved on the Links tab, shown as its name' },
  { tag: '[Link: name | words]', means: 'the same link, shown as the words you choose' },
];

export type BuiltInKey = 'payment_reminder' | 'abandoned_cart' | 'order_email';
export const BUILT_IN_KEYS: BuiltInKey[] = ['payment_reminder', 'abandoned_cart', 'order_email'];
export const isBuiltIn = (k: string): k is BuiltInKey => (BUILT_IN_KEYS as string[]).includes(k);
export const isCustomKey = (k: string) => /^c-[0-9a-f]{8}$/.test(k);

const PORTAL = 'https://rhinorhino.dearportal.com/', CATALOGUE = 'https://www.rhinorhino.com.au/rhino-rhino-catalogue';
// Today's wording, exactly as the team wrote it. Used until a manager saves a change, and whenever a saved one cannot be used.
export const DEFAULTS: Record<BuiltInKey, { label: string; when: string; subject: string; body: string }> = {
  payment_reminder: {
    label: 'Payment reminder', when: 'The daily draft for a quote whose payment is past due.',
    subject: 'Friendly Reminder: Payment Due for Sales Quote [Number]',
    body: [
      'Hi [Name],', '', "Hope you're keeping well.", '',
      'Just to follow up and bump this email back up into your inbox with a friendly reminder that payment is past due to secure your stock on Sales Quote [Number] attached for your reference.', '',
      'Please advise if you would like us to reactivate this sales quote and allocate stock for delivery once payment is made?', '',
      'If payment has already been processed, please disregard this message.', '',
      'Regardless of the status, we would greatly appreciate your response or prompt payment at your earliest convenience.', '',
      'Thank you for your attention to this matter.',
    ].join('\n'),
  },
  abandoned_cart: {
    label: 'Abandoned cart', when: 'The email window opened from the Abandoned Carts page.',
    subject: 'Items waiting in your Rhino Rhino B2B cart',
    body: `Hi [Name],

Hope all's well!

Just a friendly reminder that you have [Brands] waiting in your B2B cart.

With new stock arriving daily and our warehouse busy receiving fresh arrivals across our latest collections, now is a great time to get your order underway!

Can we help you check out?

If you're still interested in these favourites, simply jump back into the [Rhino Rhino B2B Portal](${PORTAL}) to complete your order.

You can also explore what's new in our [RR AW2026 Catalogue.](${CATALOGUE})

If you have any questions about availability, need a hand with your selection or would like us to help finalise your order, just reply to this email. We're always happy to help!

Look forward to seeing your order come through!`,
  },
  order_email: { label: 'Order email', when: 'The email window opened from an order.', subject: 'Order [Number]', body: 'Hi [Name],\n\n' },
};

export type Vars = { names?: string[]; number?: string | null; brands?: string[] };
export type LinkRef = { name: string; url: string };
const TOKEN = /\[(Name|Number|Brands)\](?!\()/gi;
const LINKTOKEN = /\[Link:\s*([^\]|\[\n]{1,80}?)\s*(?:\|\s*([^\]\[\n]{1,120}?)\s*)?\](?!\()/gi;
const ANY = /\[([^\]\n]{1,220})\](?!\()/g;
const LINKWORDS = /^link:\s*([^|]+?)\s*(?:\|\s*(.*?)\s*)?$/i;
const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

/** Fill in one piece of text. A [Link: name] that is not saved is shown as just the name, and is returned in `missing`. */
export function fill(text: string, v: Vars, links: LinkRef[] = []): { text: string; missing: string[] } {
  const names = v.names ?? [], brands = v.brands ?? [], missing: string[] = [];
  const out = String(text ?? '')
    .replace(TOKEN, (_m, k: string) => {
      const w = k.toLowerCase();
      if (w === 'name') return names.length ? joinAnd(names) : 'there';
      if (w === 'number') return v.number ?? '';
      return brands.length ? `some great ${joinAnd(brands.slice(0, 3))} Items` : 'some great items';
    })
    .replace(LINKTOKEN, (_m, n: string, words: string | undefined) => {
      const l = links.find(x => norm(x.name) === norm(n));
      const shown = words?.trim() || l?.name || n;
      if (!l) { missing.push(n); return shown; }
      return `[${shown}](${l.url})`;
    });
  return { text: out, missing };
}

/** What is wrong with a template, in words for the person writing it. Empty means it can be saved. */
export function checkTemplate(subject: string, body: string, links: LinkRef[]): string[] {
  const problems: string[] = [];
  if (!subject.trim()) problems.push('The subject is empty.');
  if (!body.trim()) problems.push('The email is empty.');
  if (subject.length > 200) problems.push('The subject is too long (200 characters at most).');
  if (body.length > 8000) problems.push('The email is too long (8000 characters at most).');
  if (/[\r\n]/.test(subject)) problems.push('The subject must be one line.');
  const seen = new Set<string>();
  const look = (text: string, inSubject: boolean) => {
    for (const m of text.matchAll(ANY)) {
      const inner = m[1]!.trim(), tag = `[${inner}]`;
      if (/^(name|number|brands)$/i.test(inner)) continue;
      const l = LINKWORDS.exec(inner);
      if (l) {
        if (inSubject) { if (!seen.has(tag)) problems.push(`${tag} cannot be in the subject. Links go in the email.`); }
        else if (!links.some(x => norm(x.name) === norm(l[1]!)) && !seen.has(tag)) problems.push(`${tag}: there is no saved link with that name. Add it on the Links tab first.`);
        seen.add(tag); continue;
      }
      if (!seen.has(tag)) problems.push(`${tag} is not one of the fill-in words. Use [Name], [Number], [Brands] or [Link: name].`);
      seen.add(tag);
    }
  };
  look(subject, true); look(body, false);
  return problems;
}

/** Made-up details for the preview, so nothing real is shown. */
export const SAMPLE: Vars = { names: ['Morgana'], number: 'SQ10001', brands: ['Engelite', 'Miffy'] };

// ---- saved links ----
/** A saved link's name and address, tidied, or the reason it cannot be saved. Only web addresses starting https:// are allowed. */
export function cleanLink(nameIn: unknown, urlIn: unknown): { name: string; url: string } | { error: string } {
  const name = String(nameIn ?? '').trim().replace(/\s+/g, ' ');
  if (!name) return { error: 'Give the link a name.' };
  if (name.length > 60) return { error: 'The name is too long (60 characters at most).' };
  if (/[\[\]()]/.test(name)) return { error: 'The name cannot have brackets in it.' };
  const raw = String(urlIn ?? '').trim();
  if (!raw) return { error: 'Paste the link.' };
  if (raw.length > 2000) return { error: 'That link is too long.' };
  let u: URL;
  try { u = new URL(raw); } catch { return { error: 'That does not look like a web link. Paste the whole address, starting with https://' }; }
  if (u.protocol !== 'https:') return { error: 'Only links starting with https:// can be saved.' };
  if (u.username || u.password) return { error: 'The link has a name or password in it. Use the plain link.' };
  return { name, url: u.href.replace(/\(/g, '%28').replace(/\)/g, '%29') };
}
