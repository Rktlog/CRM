// Turning what a rep types into a proper email, safely: the HTML version (with real links), the plain-text version, the Gmail signature cleaned of anything unsafe,
// and the whole message (text and HTML, with attachments). Pure: no database, no Gmail. Tested in scripts/test-email-html.ts.
export const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const safeUrl = (u: string): string | null => { try { const x = new URL(u); return (x.protocol === 'http:' || x.protocol === 'https:') && !x.username && !x.password ? x.href : null; } catch { return null; } };
const LINK = /\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]{1,2000})\)/g;   // [words](https://address): how a link is typed in the email box
const wordChar = /[A-Za-z0-9]/;

function plainPart(s: string): string {   // escape, and make bare web addresses into links
  return s.split(/(https?:\/\/[^\s<>"']+)/).map((seg, i) => {
    if (i % 2 === 0) return escapeHtml(seg);
    const trail = /[.,;:!?)\]]+$/.exec(seg)?.[0] ?? '', url = seg.slice(0, seg.length - trail.length), ok = safeUrl(url);
    return ok ? `<a href="${escapeHtml(ok)}" style="color:#1155cc" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>${escapeHtml(trail)}` : escapeHtml(seg);
  }).join('');
}
function inline(p: string): string {
  const out: string[] = []; let last = 0;
  for (const m of p.matchAll(LINK)) {
    const at = m.index ?? 0; out.push(plainPart(p.slice(last, at)));
    const url = safeUrl(m[2]!);
    out.push(url ? `<a href="${escapeHtml(url)}" style="color:#1155cc" target="_blank" rel="noopener noreferrer">${escapeHtml(m[1]!.trim())}</a>` : escapeHtml(m[0]));
    last = at + m[0].length; if (wordChar.test(p[last] ?? '')) out.push(' ');   // "[link](url)to complete" reads as "link to complete"
  }
  out.push(plainPart(p.slice(last))); return out.join('');
}
/** The HTML of what was typed: paragraphs, line breaks, links made with [words](https://address), and bare web addresses made into links. Everything else is escaped. */
export function bodyToHtml(body: string): string {
  const paras = body.replace(/\r\n?/g, '\n').trim().split(/\n{2,}/).map(p => inline(p).replace(/\n/g, '<br>'));
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222222">${paras.map(p => `<p style="margin:0 0 12px">${p}</p>`).join('')}</div>`;
}
/** The plain-text version: a link typed [words](https://address) reads "words (https://address)". */
export function bodyToText(body: string): string {
  return body.replace(/\r\n?/g, '\n').replace(LINK, (m, t: string, u: string, off: number, whole: string) => `${t.trim()} (${u})${wordChar.test(whole[off + m.length] ?? '') ? ' ' : ''}`).trim();
}
const ENT: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", colon: ':', tab: ' ', newline: ' ' };
const decodeEntities = (v: string): string => v
  .replace(/&#x([0-9a-f]+);?/gi, (_, h: string) => { try { return String.fromCodePoint(parseInt(h, 16) || 32); } catch { return ' '; } })
  .replace(/&#(\d+);?/g, (_, d: string) => { try { return String.fromCodePoint(Number(d) || 32); } catch { return ' '; } })
  .replace(/&([a-z]+);/gi, (m, n: string) => ENT[n.toLowerCase()] ?? m);
/** Plain text from some HTML (for the plain-text copy of a signature). */
export function htmlToText(html: string): string {
  return decodeEntities(html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|h[1-6]|li|table)>/gi, '\n').replace(/<[^>]*>/g, ''))
    .replace(/[ \t\u00a0]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------- the Gmail signature, cleaned ----------
const SKIP_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'template', 'noscript', 'title', 'head', 'form', 'textarea', 'select', 'button', 'audio', 'video', 'canvas', 'applet', 'frameset']);
const TAGS = new Set(['a', 'b', 'i', 'u', 's', 'em', 'strong', 'br', 'p', 'div', 'span', 'img', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'ul', 'ol', 'li', 'font', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'small', 'sub', 'sup', 'center', 'pre', 'code']);
const VOID = new Set(['br', 'hr', 'img']);
const GLOBAL_ATTRS = new Set(['style', 'align', 'valign', 'width', 'height', 'border', 'cellpadding', 'cellspacing', 'colspan', 'rowspan', 'bgcolor', 'color', 'face', 'size', 'title', 'dir', 'lang']);
const STYLE_OK = /^(color|background-color|background|font-family|font-size|font-weight|font-style|text-decoration|text-align|line-height|margin(-top|-bottom|-left|-right)?|padding(-top|-bottom|-left|-right)?|width|height|max-width|max-height|border(-top|-bottom|-left|-right)?(-width|-style|-color)?|border-collapse|vertical-align|display|white-space|letter-spacing)$/;
const STYLE_BAD = /url\s*\(|expression|javascript:|@import|behavior|binding|[\\<>]/i;
function cleanStyle(v: string): string {
  return v.split(';').map(d => d.trim()).filter(d => {
    const i = d.indexOf(':'); if (i < 1) return false;
    const prop = d.slice(0, i).trim().toLowerCase(), val = d.slice(i + 1).trim();
    return STYLE_OK.test(prop) && val.length > 0 && val.length <= 200 && !STYLE_BAD.test(decodeEntities(val));
  }).join('; ');
}
function cleanAttrs(tag: string, src: string): string | null {
  const out: string[] = []; let hasSrc = false;
  for (const m of src.matchAll(/([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    const name = m[1]!.toLowerCase(); if (name.startsWith('on')) continue;
    const raw = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
    if (tag === 'a' && name === 'href') { const v = raw.replace(/[\u0000-\u0020]/g, ''); if (/^(https?:|mailto:|tel:)/i.test(v) && v.length < 2000) out.push(`href="${escapeHtml(v)}"`); }
    else if (tag === 'img' && name === 'src') { const u = safeUrl(raw.replace(/[\u0000-\u0020]/g, '')); if (u) { out.push(`src="${escapeHtml(u)}"`); hasSrc = true; } }
    else if (tag === 'img' && name === 'alt') out.push(`alt="${escapeHtml(raw.slice(0, 200))}"`);
    else if (name === 'style') { const s = cleanStyle(raw); if (s) out.push(`style="${escapeHtml(s)}"`); }
    else if (GLOBAL_ATTRS.has(name)) { if (/^[0-9A-Za-z%.\s#,'-]{0,80}$/.test(raw)) out.push(`${name}="${escapeHtml(raw)}"`); }
  }
  if (tag === 'img' && !hasSrc) return null;
  if (tag === 'a') out.push('target="_blank"', 'rel="noopener noreferrer"');
  return out.length ? ' ' + out.join(' ') : '';
}
/** HTML from somewhere else (a Gmail signature), kept to plain formatting, links and pictures on the web. Scripts, forms, frames, event handlers, odd web addresses and style tricks are all removed. Tags are balanced. null if it is too big. */
export function sanitizeHtml(html: unknown, max = 60_000): string | null {
  if (typeof html !== 'string' || html.length > max * 3) return null;
  const out: string[] = [], stack: string[] = []; let skip: string | null = null, depth = 0;
  for (const tok of html.match(/<!--[\s\S]*?-->|<\/?[a-zA-Z][^>]*>|[^<]+|</g) ?? []) {
    if (tok.startsWith('<!--')) continue;
    if (tok === '<') { if (!skip) out.push('&lt;'); continue; }
    if (tok[0] !== '<') { if (!skip) out.push(tok.replace(/>/g, '&gt;')); continue; }
    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)([\s\S]*?)(\/?)>$/.exec(tok); if (!m) continue;
    const closing = m[1] === '/', name = m[2]!.toLowerCase(), selfClosing = m[4] === '/';
    if (skip) { if (name === skip && !selfClosing) { depth += closing ? -1 : 1; if (depth <= 0) skip = null; } continue; }
    if (!closing && SKIP_CONTENT.has(name)) { if (!selfClosing) { skip = name; depth = 1; } continue; }
    if (!TAGS.has(name)) continue;
    if (closing) { if (VOID.has(name)) continue; const at = stack.lastIndexOf(name); if (at >= 0) { while (stack.length > at) out.push(`</${stack.pop()}>`); } continue; }
    const attrs = cleanAttrs(name, m[3] ?? ''); if (attrs === null) continue;
    out.push(`<${name}${attrs}${VOID.has(name) ? ' /' : ''}>`); if (!VOID.has(name)) stack.push(name);
  }
  while (stack.length) out.push(`</${stack.pop()}>`);
  const s = out.join('').trim();
  return s.length > max ? null : s;
}

// ---------- the whole message ----------
export type Attachment = { name: string; mime: string; data: Buffer };
const b64 = (b: Buffer) => b.toString('base64'), wrap = (s: string) => (s.match(/.{1,76}/g) ?? []).join('\r\n');
const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
/** A header with accents or other non-ASCII characters, written the way mail programs expect. */
export function encodeHeader(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const words: string[] = []; let cur = '';
  for (const ch of s) { if (Buffer.byteLength(cur + ch) > 42) { words.push(cur); cur = ''; } cur += ch; }
  if (cur) words.push(cur);
  return words.map(w => `=?UTF-8?B?${b64(Buffer.from(w, 'utf8'))}?=`).join('\r\n ');
}
const headerSafe = (s: string) => !/[\r\n]/.test(s);
export const BLOCKED_FILE = /\.(exe|bat|cmd|com|cpl|dll|js|jse|jar|msi|msp|scr|vbs|vbe|wsf|wsh|ps1|lnk|reg|sh|apk|iso|dmg|hta|pif|scf)$/i;   // the kinds Gmail itself refuses to deliver
export const safeFileName = (n: string): string => n.replace(/[\u0000-\u001f\u007f"\\/:*?<>|]+/g, '_').replace(/^\.+/, '').trim().slice(0, 150) || 'file';
const part = (type: string, body: string, extra: string[] = []) => [`Content-Type: ${type}`, ...extra, '', body].join('\r\n');
/** The whole email as Gmail wants it (base64url): the plain text and the HTML as two versions of the same message, with any attachments, and the headers that make it a reply when one is asked for. Refuses a line break inside a header. */
export function buildMime(o: { to: string[]; cc?: string[]; subject: string; text: string; html: string; attachments?: Attachment[]; inReplyTo?: string | null; references?: string | null }): string {
  const cc = o.cc ?? [];
  if (!o.to.length || [...o.to, ...cc].some(a => !a || !headerSafe(a) || /[<>,;]/.test(a))) throw new Error('Check the email addresses');
  if (!headerSafe(o.subject)) throw new Error('The subject cannot have a line break');
  for (const v of [o.inReplyTo, o.references]) if (v && (!headerSafe(v) || v.length > 2000)) throw new Error('Check the reply headers');
  const rnd = () => `rr_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const alt = rnd(), mixed = rnd();
  const text = part('text/plain; charset=UTF-8', wrap(b64(Buffer.from(o.text.replace(/\r\n|\r|\n/g, '\r\n'), 'utf8'))), ['Content-Transfer-Encoding: base64']);
  const html = part('text/html; charset=UTF-8', wrap(b64(Buffer.from(o.html, 'utf8'))), ['Content-Transfer-Encoding: base64']);
  const alternative = `Content-Type: multipart/alternative; boundary="${alt}"\r\n\r\n--${alt}\r\n${text}\r\n--${alt}\r\n${html}\r\n--${alt}--`;
  const head = [`To: ${o.to.join(', ')}`, ...(cc.length ? [`Cc: ${cc.join(', ')}`] : []), `Subject: ${encodeHeader(o.subject)}`, 'MIME-Version: 1.0', ...(o.inReplyTo ? [`In-Reply-To: ${o.inReplyTo}`] : []), ...(o.references ? [`References: ${o.references}`] : [])];
  let body = alternative;
  if (o.attachments?.length) {
    const files = o.attachments.map(a => {
      const name = safeFileName(a.name), mime = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(a.mime) ? a.mime : 'application/octet-stream';
      return part(`${mime}; name="${encodeHeader(name)}"`, wrap(b64(a.data)), ['Content-Transfer-Encoding: base64', `Content-Disposition: attachment; filename="${encodeHeader(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`]);
    });
    body = `Content-Type: multipart/mixed; boundary="${mixed}"\r\n\r\n--${mixed}\r\n${alternative}\r\n${files.map(f => `--${mixed}\r\n${f}`).join('\r\n')}\r\n--${mixed}--`;
  }
  return b64url(Buffer.from(`${head.join('\r\n')}\r\n${body}\r\n`, 'utf8'));
}
export const decodeRaw = (raw: string): string => Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
