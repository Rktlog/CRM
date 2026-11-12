// Tests the plain rules behind sending email from Radar: reading addresses, adding the signature, the short preview for the log, the log note, and which
// addresses are new for a customer. No database, no Gmail, no internet.  Run:  npx tsx scripts/test-email-send.ts
import { logNote, MAX_PEOPLE, parseAddresses, preview, PREVIEW_CHARS, unknownAddresses, withSignature } from '../src/lib/emailSend';

let pass = 0, fail = 0;
const ok = (n: string, c: unknown, x = '') => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (x ? '  ' + x : '')); } };

console.log('--- addresses');
let a = parseAddresses('anna@shop.com.au, Ben@Shop.com.au ; carl@x.co');
ok('commas and semicolons separate addresses, and blanks are ignored', a.list.join('|') === 'anna@shop.com.au|Ben@Shop.com.au|carl@x.co' && !a.bad && parseAddresses(' , ;; ').list.length === 0 && !parseAddresses(' , ;; ').bad);
ok('an address given twice (in any capitals) counts once', parseAddresses('a@x.com, A@X.COM, a@x.com').list.length === 1);
ok('anything that is not a plain address marks the whole list bad', parseAddresses('anna@shop.com.au, not an address').bad && parseAddresses('Anna <anna@shop.com.au>').bad && parseAddresses('anna@shop').bad && parseAddresses('a@b.co\r\nBcc: x@y.com').bad);
ok('an array works, and so does nothing at all', parseAddresses(['a@x.com', 'b@x.com']).list.length === 2 && parseAddresses(undefined).list.length === 0 && parseAddresses(42).list.length === 0);
ok('an address over 254 characters is refused', parseAddresses('a'.repeat(250) + '@x.com').bad);

console.log('--- the signature');
ok('the signature goes after the email with a blank line between', withSignature('Hi Anna,\n\nThanks.', 'Sean\nRhino Rhino') === 'Hi Anna,\n\nThanks.\n\nSean\nRhino Rhino');
ok('spaces and blank lines at the end of the email do not stack up', withSignature('Thanks.\n\n\n   ', 'Sean') === 'Thanks.\n\nSean');
ok('no signature, a blank one, or nothing leaves the email alone', withSignature('Thanks.', '') === 'Thanks.' && withSignature('Thanks.', '   \n ') === 'Thanks.' && withSignature('Thanks.', null) === 'Thanks.' && withSignature('Thanks.', undefined) === 'Thanks.');

console.log('--- the short preview for the log');
ok('a short email is kept whole', preview('Hi Anna,\nThanks for the order.') === 'Hi Anna,\nThanks for the order.');
ok('line endings are made the same, trailing spaces go and long gaps shrink', preview('Hi  \r\n\r\n\r\n\r\nBye\r\n') === 'Hi\n\nBye');
const long = 'word '.repeat(200); const p = preview(long);
ok(`a long email is cut near ${PREVIEW_CHARS} characters at a word, with ...`, p.endsWith('...') && p.length <= PREVIEW_CHARS + 3 && p.length > PREVIEW_CHARS - 12 && !/\s\.\.\.$/.test(p), String(p.length));
ok('an email of exactly the limit is not cut', preview('x'.repeat(PREVIEW_CHARS)) === 'x'.repeat(PREVIEW_CHARS) && preview('x'.repeat(PREVIEW_CHARS + 1)).endsWith('...'));
ok('an email with no spaces at all is still cut', preview('x'.repeat(1000)).length <= PREVIEW_CHARS + 3);

console.log('--- the log note');
ok('it says who it went to, the subject, and the start of the email', logNote(['anna@shop.com.au'], [], 'Your order', 'Hi Anna,\nThanks.') === 'Emailed anna@shop.com.au: Your order\n\nHi Anna,\nThanks.');
ok('several people and a copy are all named', logNote(['a@x.com', 'b@x.com'], ['c@x.com'], 'Hi', 'Body') === 'Emailed a@x.com, b@x.com (cc c@x.com): Hi\n\nBody');
ok('it is always short enough for a cart log (2,000 characters)', logNote(['a@x.com'], [], 'S'.repeat(300), 'word '.repeat(2000)).length < 2000);

console.log('--- which addresses are new for this customer');
ok('addresses already known (in any capitals) are not new', unknownAddresses(['Anna@Shop.com.au', 'ben@shop.com.au'], ['anna@shop.com.au']).join() === 'ben@shop.com.au');
ok('nothing known means everything is new, and nothing typed means nothing is new', unknownAddresses(['a@x.com'], []).join() === 'a@x.com' && unknownAddresses([], ['a@x.com']).length === 0);
ok(`the most people in one email is ${MAX_PEOPLE}`, MAX_PEOPLE === 10);
console.log(`\npassed: ${pass}   failed: ${fail}`); process.exit(fail ? 1 : 0);
