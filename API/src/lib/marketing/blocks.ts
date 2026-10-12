import { createHmac } from 'crypto';

// Turns a list of blocks into an email: HTML, plain text and the subject, with merge tags
// ({{first_name}}) filled in, every link wrapped so clicks can be counted, a 1x1 picture
// for opens, and a footer with the business address and an unsubscribe link.

export type Block =
  | { id: string; type: 'heading'; text: string; align?: 'left' | 'center' }
  | { id: string; type: 'text'; text: string }
  | { id: string; type: 'image'; url: string; alt?: string; link?: string }
  | { id: string; type: 'button'; label: string; url: string }
  | { id: string; type: 'products'; skus: string[]; showPrice?: boolean; columns?: 2 | 3; link?: string }
  | { id: string; type: 'divider' }
  | { id: string; type: 'spacer'; size?: number }
  | { id: string; type: 'items' }       // automatic emails: the cart or order lines
  | { id: string; type: 'details' };    // automatic emails: the key facts (quote number, amount...)

// What a person can drop into a subject or text. `sample` is what the preview shows.
export const MERGE_TAGS: { tag: string; label: string; sample: string; group: 'Contact' | 'Order' | 'Cart' | 'Delivery' | 'Links' }[] = [
  { tag: 'first_name', label: 'First name', sample: 'Sam', group: 'Contact' },
  { tag: 'last_name', label: 'Last name', sample: 'Lee', group: 'Contact' },
  { tag: 'company', label: 'Store name', sample: 'Toy World Chermside', group: 'Contact' },
  { tag: 'email', label: 'Email address', sample: 'sam@toyworld.com.au', group: 'Contact' },
  { tag: 'quote_number', label: 'Quote number', sample: 'SQ37512', group: 'Order' },
  { tag: 'order_number', label: 'Order number', sample: 'SQ37512', group: 'Order' },
  { tag: 'invoice_number', label: 'Invoice number', sample: 'INVC39900', group: 'Order' },
  { tag: 'invoice_date', label: 'Invoice date', sample: '9 Oct 2026', group: 'Order' },
  { tag: 'due_date', label: 'Due date', sample: '23 Oct 2026', group: 'Order' },
  { tag: 'amount', label: 'Order amount', sample: '$1,240.50', group: 'Order' },
  { tag: 'amount_due', label: 'Amount due', sample: '$1,240.50', group: 'Order' },
  { tag: 'cart_total', label: 'Cart total', sample: '$480.00', group: 'Cart' },
  { tag: 'carrier', label: 'Carrier', sample: 'Australia Post', group: 'Delivery' },
  { tag: 'tracking_number', label: 'Tracking number', sample: '36AB1234567', group: 'Delivery' },
  { tag: 'tracking_link', label: 'Tracking link', sample: 'https://auspost.com.au/mypost/track/#/details/36AB1234567', group: 'Delivery' },
  { tag: 'portal_link', label: 'Ordering portal link', sample: 'https://rhinorhino.com.au/portal', group: 'Links' },
  { tag: 'cart_link', label: 'Link back to the cart', sample: 'https://rhinorhino.com.au/portal/cart', group: 'Links' },
  { tag: 'unsubscribe_url', label: 'Unsubscribe link', sample: 'https://example.com/m/u/token', group: 'Links' },
];
export const SAMPLE_VALUES = Object.fromEntries(MERGE_TAGS.map(t => [t.tag, t.sample]));

export type RenderCtx = {
  values: Record<string, string>;
  items?: { name: string; qty?: number; price?: number }[];
  facts?: { label: string; value: string }[];
  products?: Record<string, { name: string; imageUrl: string | null; price?: number | null }>;
};
export type RenderOpts = {
  subject: string; preview?: string; blocks: Block[]; ctx: RenderCtx;
  footer: { address: string; unsubscribe: boolean; business?: string };
  track?: { baseUrl: string; token: string; secret: string } | null;
};

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const money = (n: number) => '$' + n.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// {{first_name}} -> Sam. A tag with no value becomes nothing, never the raw tag.
export function fill(template: string, values: Record<string, string>): string {
  return (template ?? '').replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_m, k) => values[String(k).toLowerCase()] ?? '');
}
// Dropbox share links open a web page, not the picture: raw=1 asks for the picture itself.
export function directImage(link: string | null | undefined): string | null {
  const raw = (link ?? '').trim();
  if (!/^https?:\/\//i.test(raw)) return null;
  try {
    const u = new URL(raw);
    if (/(^|\.)dropbox\.com$/i.test(u.hostname)) { u.searchParams.delete('dl'); u.searchParams.set('raw', '1'); return u.toString(); }
    return raw;
  } catch { return null; }
}

const b64u = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
export const fromB64u = (s: string) => Buffer.from(s, 'base64url').toString('utf8');
export const signLink = (secret: string, token: string, url: string) => createHmac('sha256', secret).update(`${token}|${url}`).digest('hex').slice(0, 20);
export const verifyLink = (secret: string, token: string, url: string, sig: string) => !!sig && signLink(secret, token, url) === sig;

// The tracked version of a link: it goes to our server, which counts the click and sends them on.
// The signature stops anyone using the redirect to send people to other sites.
export function trackedUrl(url: string, track: RenderOpts['track']): string {
  if (!track || !/^https?:\/\//i.test(url)) return url;
  return `${track.baseUrl}/m/c/${track.token}?u=${b64u(url)}&s=${signLink(track.secret, track.token, url)}`;
}

// Plain text with web addresses in it becomes text with links.
function linkify(text: string, track: RenderOpts['track']): string {
  return text.split(/(https?:\/\/[^\s<]+)/g).map((part, i) => {
    if (i % 2 === 0) return esc(part).replace(/\r?\n/g, '<br>');
    const url = part.replace(/[.,;:!?)]+$/, ''); const rest = part.slice(url.length);
    return `<a href="${esc(trackedUrl(url, track))}" style="color:#2f6b5e">${esc(url)}</a>${esc(rest)}`;
  }).join('');
}

const font = "font-family:Helvetica,Arial,sans-serif;color:#1d2530;";

function blockHtml(b: Block, o: RenderOpts, v: Record<string, string>): string {
  const t = (s: string) => fill(s, v);
  switch (b.type) {
    case 'heading':
      return `<tr><td style="padding:18px 28px 6px;${font}font-size:24px;line-height:30px;font-weight:700;text-align:${b.align ?? 'left'}">${esc(t(b.text))}</td></tr>`;
    case 'text':
      return `<tr><td style="padding:8px 28px;${font}font-size:15px;line-height:23px">${linkify(t(b.text), o.track)}</td></tr>`;
    case 'image': {
      const src = directImage(t(b.url)); if (!src) return '';
      const img = `<img src="${esc(src)}" alt="${esc(t(b.alt ?? ''))}" width="544" style="display:block;width:100%;max-width:544px;height:auto;border:0">`;
      const link = b.link ? t(b.link) : '';
      return `<tr><td style="padding:10px 28px">${link ? `<a href="${esc(trackedUrl(link, o.track))}">${img}</a>` : img}</td></tr>`;
    }
    case 'button': {
      const url = t(b.url); if (!url) return '';
      return `<tr><td style="padding:14px 28px" align="left"><a href="${esc(trackedUrl(url, o.track))}" style="display:inline-block;background:#2f6b5e;color:#ffffff;${font}font-size:15px;font-weight:600;text-decoration:none;padding:12px 24px;border-radius:6px">${esc(t(b.label))}</a></td></tr>`;
    }
    case 'products': {
      const cols = b.columns === 3 ? 3 : 2; const items = (b.skus ?? []).map(s => ({ sku: s, p: o.ctx.products?.[s] })).filter(x => x.p);
      if (!items.length) return '';
      const link = b.link ? t(b.link) : '';
      const cell = (x: (typeof items)[number]) => {
        const src = directImage(x.p!.imageUrl);
        const pic = src ? `<img src="${esc(src)}" alt="${esc(x.p!.name)}" width="${cols === 3 ? 160 : 250}" style="display:block;width:100%;height:auto;border:0;border-radius:4px">` : '';
        const inner = `${pic}<div style="${font}font-size:13px;line-height:18px;padding-top:6px;font-weight:600">${esc(x.p!.name)}</div>${b.showPrice && x.p!.price != null ? `<div style="${font}font-size:13px;color:#5b6573">${money(x.p!.price!)}</div>` : ''}`;
        return `<td width="${Math.floor(100 / cols)}%" valign="top" style="padding:6px">${link ? `<a href="${esc(trackedUrl(link, o.track))}" style="text-decoration:none;color:inherit">${inner}</a>` : inner}</td>`;
      };
      const rows: string[] = [];
      for (let i = 0; i < items.length; i += cols) {
        const slice = items.slice(i, i + cols).map(cell); while (slice.length < cols) slice.push(`<td width="${Math.floor(100 / cols)}%"></td>`);
        rows.push(`<tr>${slice.join('')}</tr>`);
      }
      return `<tr><td style="padding:8px 22px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0">${rows.join('')}</table></td></tr>`;
    }
    case 'divider':
      return `<tr><td style="padding:10px 28px"><div style="border-top:1px solid #dfe2d8;line-height:1px;font-size:1px">&nbsp;</div></td></tr>`;
    case 'spacer':
      return `<tr><td style="height:${Math.min(80, Math.max(4, b.size ?? 20))}px;line-height:1px;font-size:1px">&nbsp;</td></tr>`;
    case 'items': {
      const items = o.ctx.items ?? []; if (!items.length) return '';
      const rows = items.map(i => `<tr><td style="padding:6px 0;${font}font-size:14px;border-bottom:1px solid #eceee6">${esc(i.name)}</td><td align="right" style="padding:6px 0;${font}font-size:14px;border-bottom:1px solid #eceee6;white-space:nowrap">${i.qty != null ? `× ${esc(i.qty)}` : ''}${i.price != null ? `  ${money(i.price)}` : ''}</td></tr>`).join('');
      return `<tr><td style="padding:8px 28px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0">${rows}</table></td></tr>`;
    }
    case 'details': {
      const facts = (o.ctx.facts ?? []).filter(f => f.value); if (!facts.length) return '';
      const rows = facts.map(f => `<tr><td style="padding:6px 12px;${font}font-size:14px;color:#5b6573;width:42%">${esc(f.label)}</td><td style="padding:6px 12px;${font}font-size:14px;font-weight:600">${esc(f.value)}</td></tr>`).join('');
      return `<tr><td style="padding:8px 28px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f4ef;border-radius:6px">${rows}</table></td></tr>`;
    }
  }
}

function blockText(b: Block, o: RenderOpts, v: Record<string, string>): string {
  const t = (s: string) => fill(s, v);
  switch (b.type) {
    case 'heading': return t(b.text).toUpperCase();
    case 'text': return t(b.text).replace(/(https?:\/\/[^\s]+)/g, m => trackedUrl(m.replace(/[.,;:!?)]+$/, ''), o.track) + (/[.,;:!?)]+$/.test(m) ? m.match(/[.,;:!?)]+$/)![0] : ''));
    case 'image': return b.alt ? `[${t(b.alt)}]` : '';
    case 'button': return t(b.url) ? `${t(b.label)}: ${trackedUrl(t(b.url), o.track)}` : '';
    case 'products': return (b.skus ?? []).map(s => o.ctx.products?.[s]?.name).filter(Boolean).map(n => `- ${n}`).join('\n');
    case 'items': return (o.ctx.items ?? []).map(i => `- ${i.name}${i.qty != null ? ` x ${i.qty}` : ''}`).join('\n');
    case 'details': return (o.ctx.facts ?? []).filter(f => f.value).map(f => `${f.label}: ${f.value}`).join('\n');
    default: return '';
  }
}

export function renderEmail(o: RenderOpts): { html: string; text: string; subject: string } {
  const unsubUrl = o.track ? `${o.track.baseUrl}/m/u/${o.track.token}` : '';
  const v = { ...SAMPLE_VALUES, ...{}, ...o.ctx.values, ...(unsubUrl ? { unsubscribe_url: unsubUrl } : {}) };
  // Values not given are blank, not the sample text (samples are only for the preview).
  const values: Record<string, string> = o.ctx.values && Object.keys(o.ctx.values).length ? { ...Object.fromEntries(Object.keys(SAMPLE_VALUES).map(k => [k, ''])), ...o.ctx.values, ...(unsubUrl ? { unsubscribe_url: unsubUrl } : {}) } : v;
  const subject = fill(o.subject, values).trim();
  const body = o.blocks.map(b => blockHtml(b, o, values)).join('');
  const foot = `<tr><td style="padding:22px 28px 30px;${font}font-size:12px;line-height:18px;color:#7a8290;border-top:1px solid #eceee6">${esc(o.footer.business ?? '')}${o.footer.business ? '<br>' : ''}${esc(o.footer.address)}${o.footer.unsubscribe && unsubUrl ? `<br><a href="${esc(unsubUrl)}" style="color:#7a8290">Unsubscribe</a> from these emails.` : ''}</td></tr>`;
  const pixel = o.track ? `<img src="${o.track.baseUrl}/m/o/${o.track.token}.gif" width="1" height="1" alt="" style="display:block;border:0">` : '';
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(subject)}</title></head>`
    + `<body style="margin:0;padding:0;background:#f3f4ef"><div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(fill(o.preview ?? '', values))}</div>`
    + `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f4ef"><tr><td align="center" style="padding:20px 10px">`
    + `<table role="presentation" width="600" cellspacing="0" cellpadding="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:8px">${body}${foot}</table>${pixel}</td></tr></table></body></html>`;
  const text = [...o.blocks.map(b => blockText(b, o, values)).filter(Boolean), '', '--', [o.footer.business, o.footer.address].filter(Boolean).join('\n'),
    o.footer.unsubscribe && unsubUrl ? `Unsubscribe: ${unsubUrl}` : ''].filter(x => x !== undefined).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  return { html, text, subject };
}

// Every merge tag used in a subject or the blocks that the preview knows nothing about.
export function unknownTags(subject: string, blocks: Block[]): string[] {
  const known = new Set(MERGE_TAGS.map(t => t.tag));
  const found = new Set<string>();
  const scan = (s: unknown) => { if (typeof s === 'string') for (const m of s.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/gi)) if (!known.has(m[1].toLowerCase())) found.add(m[1]); };
  scan(subject); for (const b of blocks) for (const v of Object.values(b)) scan(v);
  return [...found];
}

// ---- What the editor is allowed to save ----
const TYPES = ['heading', 'text', 'image', 'button', 'products', 'divider', 'spacer', 'items', 'details'] as const;
const safeUrl = (v: unknown): string => {
  const s = String(v ?? '').trim().slice(0, 1500);
  // a web address, an email link, or a merge tag such as {{portal_link}}. Never javascript: and the like.
  return /^(https?:\/\/|mailto:|\{\{\s*[a-z_]+\s*\}\})/i.test(s) || s === '' ? s : '';
};
export function cleanBlocks(input: unknown): Block[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 60).flatMap((b: any, i): Block[] => {
    if (!b || !TYPES.includes(b.type)) return [];
    const id = String(b.id || `b${i}`).slice(0, 40); const str = (v: unknown, n: number) => String(v ?? '').slice(0, n);
    switch (b.type) {
      case 'heading': return [{ id, type: 'heading', text: str(b.text, 300), align: b.align === 'center' ? 'center' : 'left' }];
      case 'text': return [{ id, type: 'text', text: str(b.text, 20000) }];
      case 'image': return [{ id, type: 'image', url: safeUrl(b.url), alt: str(b.alt, 200), link: safeUrl(b.link) }];
      case 'button': return [{ id, type: 'button', label: str(b.label, 80), url: safeUrl(b.url) }];
      case 'products': return [{ id, type: 'products', skus: (Array.isArray(b.skus) ? b.skus : []).map((s: unknown) => str(s, 60)).filter(Boolean).slice(0, 24), showPrice: !!b.showPrice, columns: b.columns === 3 ? 3 : 2, link: safeUrl(b.link) }];
      case 'spacer': return [{ id, type: 'spacer', size: Math.min(80, Math.max(4, Number(b.size) || 20)) }];
      default: return [{ id, type: b.type }];
    }
  });
}