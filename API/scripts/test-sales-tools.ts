// Tests for Sales Tools: the fill-in words, the checks on a saved template and link, and that the built-in templates still give exactly today's emails.
// No database and no internet. All names, numbers and links are made up.
// Run:  npx tsx scripts/test-sales-tools.ts
import { DEFAULTS, SAMPLE, checkTemplate, planTemplate, cleanLink, fill, isBuiltIn, isCustomKey, joinAnd } from '../src/lib/salesToolsCore';
import { bodyToHtml, bodyToText } from '../src/lib/emailHtml';

let pass = 0, fail = 0;
const ok = (name: string, cond: unknown, extra = '') => { if (cond) { pass++; console.log('PASS  ' + name); } else { fail++; console.log('FAIL  ' + name + (extra ? '  ' + extra : '')); } };
const eq = (name: string, got: unknown, want: unknown) => ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} wanted ${JSON.stringify(want)}`);

// ---- today's wording, copied from the code before Sales Tools, so the built-in templates can be proved identical ----
const PORTAL = 'https://rhinorhino.dearportal.com/', CATALOGUE = 'https://www.rhinorhino.com.au/rhino-rhino-catalogue';
const greeting = (names: string[]) => `Hi ${names.length ? joinAnd(names) : 'there'},`;
function oldCartBody(names: string[], brands: string[]): string {
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
function oldReminder(name: string | null, number: string) {
  return {
    subject: `Friendly Reminder: Payment Due for Sales Quote ${number}`,
    body: [`Hi ${name ?? 'there'},`, '', "Hope you're keeping well.", '',
      `Just to follow up and bump this email back up into your inbox with a friendly reminder that payment is past due to secure your stock on Sales Quote ${number} attached for your reference.`, '',
      'Please advise if you would like us to reactivate this sales quote and allocate stock for delivery once payment is made?', '',
      'If payment has already been processed, please disregard this message.', '',
      'Regardless of the status, we would greatly appreciate your response or prompt payment at your earliest convenience.', '',
      'Thank you for your attention to this matter.'].join('\n'),
  };
}

console.log('--- 1. the built-in templates give exactly today\'s emails');
for (const [names, brands] of [[['Morgana'], ['Engelite']], [[], []], [['Austin', 'Lachlan'], ['A', 'B', 'C', 'D']], [['Sam'], []]] as [string[], string[]][]) {
  eq(`abandoned cart: ${names.length} names, ${brands.length} brands`, fill(DEFAULTS.abandoned_cart.body, { names, brands }).text, oldCartBody(names, brands));
}
eq('abandoned cart subject', fill(DEFAULTS.abandoned_cart.subject, {}).text, 'Items waiting in your Rhino Rhino B2B cart');
for (const name of ['Pat', null]) {
  const r = oldReminder(name, 'SQ36721'), v = { names: name ? [name] : [], number: 'SQ36721' };
  eq(`payment reminder (${name ?? 'no name'}): subject`, fill(DEFAULTS.payment_reminder.subject, v).text, r.subject);
  eq(`payment reminder (${name ?? 'no name'}): body`, fill(DEFAULTS.payment_reminder.body, v).text, r.body);
}
eq('order email', [fill(DEFAULTS.order_email.subject, { number: 'SQ10001' }).text, fill(DEFAULTS.order_email.body, { names: ['Ann', 'Bo'] }).text], ['Order SQ10001', 'Hi Ann and Bo,\n\n']);
eq('the default templates pass their own checks', Object.values(DEFAULTS).map(d => checkTemplate(d.subject, d.body, [])), [[], [], []]);

console.log('--- 2. filling in');
const links = [{ name: 'Engelite preorder', url: 'https://docs.example.test/d/abc/edit' }];
eq('[Name] with no name says there', fill('Hi [Name],', {}).text, 'Hi there,');
eq('[name] in any case', fill('Hi [NAME],', { names: ['Pat'] }).text, 'Hi Pat,');
eq('[Link: name] becomes a link, any case or spacing', fill('See [Link:  engelite   PREORDER ].', {}, links).text, 'See [Engelite preorder](https://docs.example.test/d/abc/edit).');
eq('a link that is not saved shows its name and is reported', fill('See [Link: Gone].', {}, links), { text: 'See Gone.', missing: ['Gone'] });
eq('a link already written by hand is left alone', fill('[Name](https://x.example.test) and [Number](https://y.example.test)', { names: ['Pat'], number: '1' }).text, '[Name](https://x.example.test) and [Number](https://y.example.test)');
eq('the same template twice gives the same answer', fill(DEFAULTS.abandoned_cart.body, SAMPLE).text, fill(DEFAULTS.abandoned_cart.body, SAMPLE).text);
const sent = fill('Hi [Name], see [Link: Engelite preorder] now', { names: ['Pat'] }, links).text;
ok('in the HTML email the saved link is a clickable name', bodyToHtml(sent).includes('<a href="https://docs.example.test/d/abc/edit"') && bodyToHtml(sent).includes('>Engelite preorder</a>'), bodyToHtml(sent));
eq('in plain text (the reminder draft) it reads "name (address)"', bodyToText(sent), 'Hi Pat, see Engelite preorder (https://docs.example.test/d/abc/edit) now');

eq('[Link: name | words] shows the words, with the saved address', fill('Please [Link: Engelite preorder | see the presentation] today', {}, links).text, 'Please [see the presentation](https://docs.example.test/d/abc/edit) today');
eq('...in any case and spacing', fill('[link:engelite  PREORDER|  see it ]', {}, links).text, '[see it](https://docs.example.test/d/abc/edit)');
eq('words for a link that is not saved: the words are shown and the name is reported', fill('[Link: Gone | read this]', {}, links), { text: 'read this', missing: ['Gone'] });
eq('a changed address reaches every template that uses the link', fill('[Link: Engelite preorder | a] [Link: Engelite preorder]', {}, [{ name: 'Engelite preorder', url: 'https://new.example.test/x' }]).text, '[a](https://new.example.test/x) [Engelite preorder](https://new.example.test/x)');

console.log('--- 3. checking a template before it is saved');
eq('a good template', checkTemplate('Order [Number]', 'Hi [Name],\n\nSee [Link: Engelite preorder].', links), []);
ok('an empty subject and email are refused', checkTemplate('', '  ', links).length === 2);
ok('an unknown fill-in word is named', checkTemplate('x', 'Hi [Nmae]', links).join(' ').includes('[Nmae] is not one of the fill-in words'));
eq('[Link: name | words] passes when the link is saved', checkTemplate('x', 'Please [Link: Engelite preorder | see the presentation].', links), []);
ok('[Link: name | words] with an unsaved name is named', checkTemplate('x', '[Link: Nope | words]', links).join(' ').includes('[Link: Nope | words]'));
ok('a link that is not saved is named', checkTemplate('x', 'See [Link: Nope]', links).join(' ').includes('no saved link with that name'));
ok('a link in the subject is refused', checkTemplate('See [Link: Engelite preorder]', 'x', links).join(' ').includes('cannot be in the subject'));
ok('[Name](address) is not mistaken for a fill-in word', checkTemplate('x', 'Go [here](https://a.example.test)', links).length === 0);
ok('a subject with a line break is refused', checkTemplate('a\nb', 'x', links).length > 0);
ok('too long is refused', checkTemplate('x', 'y'.repeat(8001), links).length > 0);

console.log('--- 4. saving a link');
eq('a good link', cleanLink(' Engelite  preorder ', 'https://docs.google.com/document/d/abc/edit?rtpof=true&sd=true'), { name: 'Engelite preorder', url: 'https://docs.google.com/document/d/abc/edit?rtpof=true&sd=true' });
ok('http is refused', 'error' in cleanLink('a', 'http://x.example.test'));
ok('javascript: is refused', 'error' in cleanLink('a', 'javascript:alert(1)'));
ok('not a link is refused', 'error' in cleanLink('a', 'engelite preorder'));
ok('a password in the link is refused', 'error' in cleanLink('a', 'https://user:pw@x.example.test/'));
ok('brackets in the name are refused (they would break the link)', 'error' in cleanLink('a [b]', 'https://x.example.test'));
ok('no name is refused', 'error' in cleanLink('  ', 'https://x.example.test'));
const br = cleanLink('a', 'https://x.example.test/p_(1)') as { url: string };
ok('brackets in the address are made safe for [name](address)', br.url === 'https://x.example.test/p_%281%29', br.url);
ok('so a saved link with brackets still reads as one link', bodyToHtml(fill('[Link: a]', {}, [{ name: 'a', url: br.url }]).text).includes('href="https://x.example.test/p_%281%29"'));

console.log('--- 5. keys');
ok('built-in keys', isBuiltIn('payment_reminder') && isBuiltIn('abandoned_cart') && isBuiltIn('order_email') && !isBuiltIn('x'));
ok('custom keys', isCustomKey('c-0a1b2c3d') && !isCustomKey('c-xyz') && !isCustomKey('payment_reminder') && !isCustomKey("c-0a1b2c3d'; drop"));

console.log('--- 6. the assistant saving a NEW template (a preview only: planTemplate saves nothing)');
const taken = ['Payment reminder', 'Abandoned cart', 'Order email', 'Miffy tote'];
const good = { name: 'Engelite preorder', subject: 'NEW | Gifting Bears by Engelite', body: 'Hi [Name],\n\nSee the [Link: Engelite deck | presentation] for details.', links: [{ name: 'Engelite deck', url: 'https://docs.example.test/d/xyz/edit' }] };
const g = planTemplate(good, links, taken) as any;
ok('a good template gives a plan with the new link', g.plan && g.plan.newLinks.length === 1 && g.plan.newLinks[0].name === 'Engelite deck', JSON.stringify(g));
ok('the preview fills in the made-up customer and shows the link', g.plan.preview.body.startsWith('Hi Morgana,') && g.plan.preview.body.includes('[presentation](https://docs.example.test/d/xyz/edit)'), g.plan?.preview?.body);
eq('the wording is kept exactly', [g.plan.subject, g.plan.body], [good.subject, good.body]);
ok('an already saved link needs no new link', (planTemplate({ ...good, body: 'Hi [Name], [Link: Engelite preorder | see it]', links: [] }, links, taken) as any).plan.newLinks.length === 0);
ok('the same link sent again with the same address is not a second copy', (planTemplate({ ...good, links: [{ name: 'engelite PREORDER', url: 'https://docs.example.test/d/abc/edit' }], body: 'x [Link: Engelite preorder]' }, links, taken) as any).plan.newLinks.length === 0);
ok('a saved link name with a different address is refused', JSON.stringify(planTemplate({ ...good, links: [{ name: 'Engelite preorder', url: 'https://other.example.test/' }], body: 'x' }, links, taken)).includes('different address'));
ok('a name already used by a template is refused (the assistant only adds)', JSON.stringify(planTemplate({ ...good, name: 'payment REMINDER' }, links, taken)).includes('already a template'));
ok('a built-in name is refused too', JSON.stringify(planTemplate({ ...good, name: 'Miffy tote' }, links, taken)).includes('already a template'));
ok('no name, no subject, no body are all refused', 'problems' in (planTemplate({}, links, taken) as any) && (planTemplate({}, links, taken) as any).problems.length >= 3);
ok('a link name that is not given anywhere is refused', JSON.stringify(planTemplate({ ...good, links: [] }, links, taken)).includes('no saved link with that name'));
ok('a link that is not https is refused', JSON.stringify(planTemplate({ ...good, links: [{ name: 'Engelite deck', url: 'http://x.example.test' }] }, links, taken)).includes('https://'));
ok('a mistyped fill-in word is refused', JSON.stringify(planTemplate({ ...good, body: 'Hi [Nmae]', links: [] }, links, taken)).includes('[Nmae]'));
ok('more than 5 new links is refused', JSON.stringify(planTemplate({ ...good, links: Array.from({ length: 6 }, (_, i) => ({ name: 'L' + i, url: 'https://a.example.test/' + i })), body: 'x' }, links, taken)).includes('At most 5'));
ok('the same new link name twice is refused', JSON.stringify(planTemplate({ ...good, links: [{ name: 'A', url: 'https://a.example.test/1' }, { name: 'a', url: 'https://a.example.test/2' }], body: 'x [Link: A]' }, links, taken)).includes('used twice'));
ok('nothing in the input is changed (it saves nothing and keeps no state)', JSON.stringify(good).includes('Engelite deck') && links.length === 1);

console.log(`\npassed: ${pass}   failed: ${fail}`);
process.exit(fail ? 1 : 0);
