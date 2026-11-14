// Tests how an email is put together: the HTML and plain text from what a rep types (links, escaping), the Gmail signature cleaner (with the usual tricks for sneaking in scripts),
// the whole message with attachments, and the words the cart email starts with. No database, no Gmail, no internet.  Run:  npx tsx scripts/test-email-html.ts
import { BLOCKED_FILE, bodyToHtml, bodyToText, buildMime, decodeRaw, encodeHeader, escapeHtml, htmlToText, safeFileName, sanitizeHtml } from '../src/lib/emailHtml';
import { CART_SUBJECT, cartBody, firstNames, greeting, joinAnd, orderTemplate } from '../src/lib/emailTemplates';

let pass = 0, fail = 0;
const ok = (n: string, c: unknown, x = '') => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (x ? '  ' + x : '')); } };

console.log('--- the HTML version of what was typed');
let h = bodyToHtml('Hi Sam,\n\nSee our [Rhino Rhino B2B Portal](https://rhinorhino.dearportal.com/) today.');
ok('paragraphs become paragraphs, and [words](address) becomes a real link with the words as its text', (h.match(/<p /g) ?? []).length === 2 && /<a href="https:\/\/rhinorhino\.dearportal\.com\/"[^>]*>Rhino Rhino B2B Portal<\/a>/.test(h), h);
ok('a link opens in a new tab and cannot reach back into the page', /target="_blank" rel="noopener noreferrer"/.test(h));
ok('spaces inside the brackets are tidied, and a link followed straight by a word gets a space (your template has both)', /<a [^>]*>Rhino Rhino B2B Portal<\/a> to complete/.test(bodyToHtml('[Rhino Rhino B2B Portal ](https://x.com/)to complete')));
ok('a single line break stays a line break', /Line one<br>Line two/.test(bodyToHtml('Line one\nLine two')));
ok('a bare web address becomes a link, without the full stop after it', /<a href="https:\/\/www\.example\.com\/page"[^>]*>https:\/\/www\.example\.com\/page<\/a>\./.test(bodyToHtml('See https://www.example.com/page.')));
ok('what looks like HTML in the message is shown as text, never run: there is no real tag in it', !/<script|<img/i.test(bodyToHtml('<script>alert(1)</script> <img src=x onerror=alert(1)>')) && /&lt;script&gt;/.test(bodyToHtml('<script>alert(1)</script>')) && /&lt;img src=x onerror=alert\(1\)&gt;/.test(bodyToHtml('<img src=x onerror=alert(1)>')));
ok('a link that is not a web address stays as plain text', !/<a /.test(bodyToHtml('[click](javascript:alert(1))')) && !/<a /.test(bodyToHtml('[x](ftp://a.com)')) && !/<a /.test(bodyToHtml('[x](https://user:pw@a.com/)')));
ok('an address in a link cannot break out of its quotes: the quote is encoded inside the address, so there is no attribute', !/\sonmouseover=/.test(bodyToHtml('[x](https://a.com/"onmouseover="alert(1))')) && /%22onmouseover=%22/.test(bodyToHtml('[x](https://a.com/"onmouseover="alert(1))')));
ok('accents, ampersands and quotes are kept', /Café &amp; &quot;Co&quot;/.test(bodyToHtml('Café & "Co"')));
ok('Windows line endings are fine', (bodyToHtml('a\r\n\r\nb').match(/<p /g) ?? []).length === 2);
ok('the plain-text version reads "words (address)", with a space when a word follows', bodyToText('See [Portal](https://a.com/) now and [Cat](https://b.com/)x') === 'See Portal (https://a.com/) now and Cat (https://b.com/) x');
ok('escaping is complete', escapeHtml(`<a href="x">'&'</a>`) === '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');

console.log('--- the Gmail signature, cleaned');
const SIG = '<div dir="ltr"><div>Sean Robertson<br><b>Rhino Rhino</b></div><a href="https://www.rhinorhino.com.au">rhinorhino.com.au</a><br><img src="https://ci3.googleusercontent.com/mail-sig/abc123=s0-d" alt="Rhino Rhino logo" width="120" height="40" style="display:block"></div>';
let s = sanitizeHtml(SIG)!;
ok('an ordinary signature with a logo comes through whole: text, link, the picture on the web, its size', /Sean Robertson<br \/>?|Sean Robertson<br/.test(s) && /<a href="https:\/\/www\.rhinorhino\.com\.au"/.test(s) && /<img src="https:\/\/ci3\.googleusercontent\.com\/mail-sig\/abc123=s0-d" alt="Rhino Rhino logo" width="120" height="40" style="display:block" \/>/.test(s), s);
const bad: [string, string][] = [
  ['a script', '<p>Hi</p><script>alert(1)</script><p>there</p>'], ['an event handler', '<img src="https://a.com/x.png" onerror="alert(1)">'], ['a javascript link', '<a href="javascript:alert(1)">x</a>'],
  ['a javascript link with a hidden tab', '<a href="jav&#x09;ascript:alert(1)">x</a>'], ['a javascript link in capitals with spaces', '<a href=" JaVaScRiPt:alert(1)">x</a>'], ['a link written with entities', '<a href="&#106;avascript:alert(1)">x</a>'],
  ['a data address', '<a href="data:text/html,<script>alert(1)</script>">x</a>'], ['a picture from a data address', '<img src="data:image/svg+xml,<svg onload=alert(1)>">'], ['an svg', '<svg onload="alert(1)"><circle/></svg>'],
  ['an iframe', '<iframe src="https://evil.com"></iframe>'], ['a form', '<form action="https://evil.com"><input name="x"></form>'], ['a style with a url', '<div style="background:url(https://evil.com/track.gif)">x</div>'],
  ['a style expression', '<div style="width:expression(alert(1))">x</div>'], ['a base tag', '<base href="https://evil.com/">'], ['a meta refresh', '<meta http-equiv="refresh" content="0;url=https://evil.com">'], ['an object', '<object data="x.swf"></object>'],
  ['a comment trick', '<!--><script>alert(1)</script>-->'], ['a style tag', '<style>body{display:none}</style>'], ['a link tag', '<link rel="stylesheet" href="https://evil.com/x.css">'],
];
for (const [what, html] of bad) { const out = sanitizeHtml(html) ?? ''; ok(`${what} is removed`, !/<script|<iframe|<svg|<form|<input|<object|<style|<base|<meta|<link|onerror|onload|javascript:|data:|url\(|expression|evil\.com\/track|http-equiv/i.test(out), out); }
ok('the words around a removed script are kept', /Hi/.test(sanitizeHtml('<p>Hi</p><script>alert(1)</script><p>there</p>')!) && /there/.test(sanitizeHtml('<p>Hi</p><script>alert(1)</script><p>there</p>')!) && !/alert/.test(sanitizeHtml('<p>Hi</p><script>alert(1)</script><p>there</p>')!));
ok('a picture with no usable web address is dropped altogether', sanitizeHtml('<img src="javascript:alert(1)">') === '' && sanitizeHtml('<img alt="x">') === '');
ok('plain colours, fonts and sizes in the style are kept; anything else in it is dropped', /color:#444444/.test(sanitizeHtml('<span style="color:#444444;position:fixed;font-family:Arial">x</span>')!) && !/position/.test(sanitizeHtml('<span style="color:#444444;position:fixed">x</span>')!));
ok('every link gets a safe opening and mailto and tel links are allowed', /rel="noopener noreferrer"/.test(sanitizeHtml('<a href="https://a.com">x</a>')!) && /href="mailto:a@b\.com"/.test(sanitizeHtml('<a href="mailto:a@b.com">x</a>')!) && /href="tel:0400000000"/.test(sanitizeHtml('<a href="tel:0400000000">x</a>')!));
ok('tags left open are closed, so a signature can never leak formatting into the email', sanitizeHtml('<div><b>Sean<table><tr><td>x')!.endsWith('</td></tr></table></b></div>'));
ok('a stray < or > is made safe', sanitizeHtml('1 < 2 and 3 > 2')!.includes('&lt;') && !/ > 2/.test(sanitizeHtml('1 < 2 and 3 > 2')!.replace(/&gt;/g, '')));
ok('too big, or not text, gives nothing', sanitizeHtml('x'.repeat(200_000)) === null && sanitizeHtml(null) === null && sanitizeHtml(42) === null && sanitizeHtml('') === '');
ok('plain text from a signature drops the tags and keeps the lines', htmlToText(SIG) === 'Sean Robertson\nRhino Rhino\nrhinorhino.com.au' || htmlToText(SIG).startsWith('Sean Robertson\nRhino Rhino'), JSON.stringify(htmlToText(SIG)));

console.log('--- the whole message');
const raw = buildMime({ to: ['a@shop.com'], cc: ['b@shop.com'], subject: 'Order SO-1', text: 'Hello world', html: '<p>Hello world</p>' }); const msg = decodeRaw(raw);
ok('the headers are there, and the message is the text and the HTML as two versions of one message', /^To: a@shop\.com\r\nCc: b@shop\.com\r\nSubject: Order SO-1\r\nMIME-Version: 1\.0\r\n/.test(msg) && /Content-Type: multipart\/alternative; boundary="/.test(msg) && /Content-Type: text\/plain; charset=UTF-8/.test(msg) && /Content-Type: text\/html; charset=UTF-8/.test(msg) && !/multipart\/mixed/.test(msg));
const b64Of = (type: string) => { const i = msg.indexOf(`Content-Type: ${type}`); const body = msg.slice(msg.indexOf('\r\n\r\n', i) + 4).split('\r\n--')[0]!; return Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8'); };
ok('both versions decode to what was given', b64Of('text/plain') === 'Hello world' && b64Of('text/html') === '<p>Hello world</p>');
ok('accents in the subject are written the way mail programs expect, and read back', /Subject: =\?UTF-8\?B\?/.test(decodeRaw(buildMime({ to: ['a@b.com'], subject: 'Café order ✓', text: 't', html: 'h' }))) && encodeHeader('Café') === '=?UTF-8?B?Q2Fmw6k=?=' && encodeHeader('Plain') === 'Plain');
ok('a long accented subject is split into several words, none too long', encodeHeader('é'.repeat(60)).split('\r\n ').every(w => w.length < 76) && encodeHeader('é'.repeat(60)).split('\r\n ').length > 1);
const pdf = Buffer.from('%PDF-1.4 fake pdf bytes'), png = Buffer.alloc(3000, 7);
const rawA = buildMime({ to: ['a@shop.com'], subject: 'With files', text: 'See attached', html: '<p>See attached</p>', attachments: [{ name: 'Price list 2026.pdf', mime: 'application/pdf', data: pdf }, { name: 'Café ✓.png', mime: 'image/png', data: png }] }); const mA = decodeRaw(rawA);
ok('with files it becomes a mixed message, the two versions first and then each file', /Content-Type: multipart\/mixed; boundary="/.test(mA) && mA.indexOf('multipart/alternative') > mA.indexOf('multipart/mixed') && (mA.match(/Content-Disposition: attachment/g) ?? []).length === 2 && mA.indexOf('text/html') < mA.indexOf('Content-Disposition: attachment'));
ok('each file is named, typed and carried whole', /Content-Type: application\/pdf; name="Price list 2026\.pdf"/.test(mA) && /filename="Price list 2026\.pdf"/.test(mA) && mA.includes(pdf.toString('base64')) && /Content-Type: image\/png/.test(mA) && /filename\*=UTF-8''Caf%C3%A9%20%E2%9C%93\.png/.test(mA));
ok('every line of a file is short enough for mail (76 characters)', mA.split('\r\n').every(l => l.length <= 998) && mA.split('\r\n').filter(l => /^[A-Za-z0-9+/=]{60,}$/.test(l)).every(l => l.length <= 76));
ok('the closing lines of each part are there', /--rr_[a-z0-9]+--\r\n$/.test(mA));
ok('a reply carries the headers that make it part of the conversation', /In-Reply-To: <abc@mail\.gmail\.com>\r\nReferences: <old@x> <abc@mail\.gmail\.com>\r\n/.test(decodeRaw(buildMime({ to: ['a@b.com'], subject: 'Re: x', text: 't', html: 'h', inReplyTo: '<abc@mail.gmail.com>', references: '<old@x> <abc@mail.gmail.com>' }))));
const refuses = (f: () => unknown, re: RegExp) => { try { f(); return false; } catch (e) { return re.test((e as Error).message); } };
ok('a line break in the subject, an address or a reply header is refused (it could add a hidden recipient)', refuses(() => buildMime({ to: ['a@b.com'], subject: 'x\r\nBcc: evil@x.com', text: 't', html: 'h' }), /line break/) && refuses(() => buildMime({ to: ['a@b.com\r\nBcc: evil@x.com'], subject: 'x', text: 't', html: 'h' }), /addresses/) && refuses(() => buildMime({ to: ['a@b.com'], subject: 'x', text: 't', html: 'h', inReplyTo: '<a>\r\nBcc: e@x.com' }), /reply/));
ok('no recipient, or an odd one, is refused', refuses(() => buildMime({ to: [], subject: 'x', text: 't', html: 'h' }), /addresses/) && refuses(() => buildMime({ to: ['a@b.com, c@d.com'], subject: 'x', text: 't', html: 'h' }), /addresses/));
ok('file names are made safe: no slashes, so a name can never point into another folder', !/[\\/]/.test(safeFileName('../../etc/passwd')), safeFileName('../../etc/passwd'));
ok('names with slashes, quotes and line breaks are cleaned', safeFileName('a"b\r\nc.pdf') === 'a_b_c.pdf' && safeFileName('') === 'file' && safeFileName('x'.repeat(300)).length === 150);
ok('the kinds of file Gmail refuses are blocked, and ordinary ones are not', ['a.exe', 'a.BAT', 'a.js', 'a.scr', 'a.vbs', 'a.ps1', 'a.msi', 'a.jar'].every(n => BLOCKED_FILE.test(n)) && ['a.pdf', 'a.png', 'a.xlsx', 'a.docx', 'a.jpg', 'a.csv', 'a.zip', 'exe.pdf'].every(n => !BLOCKED_FILE.test(n)));

console.log('--- the words the emails start with');
ok('a contact written the way DEAR writes it gives first names only', JSON.stringify(firstNames('Austin Smith & Lachlan Jones')) === '["Austin","Lachlan"]' && JSON.stringify(firstNames('austin and lachlan')) === '["Austin","Lachlan"]' && JSON.stringify(firstNames('Sam')) === '["Sam"]' && JSON.stringify(firstNames("Mary-Jane O'Neil, Tom")) === '["Mary-Jane","Tom"]');
ok('nothing usable gives nothing: an email address, numbers, blank', firstNames('sam@shop.com').length === 0 && firstNames('1234').length === 0 && firstNames('').length === 0 && firstNames(null).length === 0 && firstNames('Accounts Dept')[0] === 'Accounts');
ok('names are joined the way people say them, and the greeting falls back to "Hi there,"', joinAnd(['A']) === 'A' && joinAnd(['A', 'B']) === 'A and B' && joinAnd(['A', 'B', 'C']) === 'A, B and C' && greeting([]) === 'Hi there,' && greeting(['Austin', 'Lachlan']) === 'Hi Austin and Lachlan,');
const cart = cartBody(['Austin', 'Lachlan'], ['Miffy', 'Snoopy']);
ok('the cart email follows your template: the greeting, the brands, the portal and the catalogue', cart.startsWith("Hi Austin and Lachlan,\n\nHope all's well!") && /some great Miffy and Snoopy Items waiting in your B2B cart\./.test(cart) && /\[Rhino Rhino B2B Portal\]\(https:\/\/rhinorhino\.dearportal\.com\/\) to complete your order\./.test(cart) && /\[RR AW2026 Catalogue\.\]\(https:\/\/www\.rhinorhino\.com\.au\/rhino-rhino-catalogue\)/.test(cart) && cart.endsWith('Look forward to seeing your order come through!'));
ok('every other sentence of the template is there', ['With new stock arriving daily and our warehouse busy receiving fresh arrivals across our latest collections, now is a great time to get your order underway!', 'Can we help you check out?', "If you're still interested in these favourites", 'If you have any questions about availability, need a hand with your selection or would like us to help finalise your order, just reply to this email. We\'re always happy to help!'].every(t => cart.includes(t)));
ok('with no brands it says "some great items", and with no names "Hi there,"', /some great items waiting/.test(cartBody([], [])) && cartBody([], []).startsWith('Hi there,') && /some great A, B and C Items/.test(cartBody([], ['A', 'B', 'C', 'D'])));
ok('the template\'s links turn into real links in the email', (bodyToHtml(cart).match(/<a href="https:\/\/(rhinorhino\.dearportal\.com|www\.rhinorhino\.com\.au)/g) ?? []).length === 2 && /to complete your order/.test(bodyToHtml(cart)));
ok('an order email starts with the order number and a greeting', orderTemplate('SO-12345', 'Austin Smith').subject === 'Order SO-12345' && orderTemplate('SO-12345', 'Austin Smith').body.startsWith('Hi Austin,') && orderTemplate('SO-1', null).body.startsWith('Hi there,') && CART_SUBJECT.length > 0);
console.log(`\npassed: ${pass}   failed: ${fail}`); process.exit(fail ? 1 : 0);
