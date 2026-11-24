// Tests the plain rules behind reading a visitor badge photo into a lead: cleaning what Claude read, and working out the state from a postcode.
// No database, no Claude, no photo.
// Run:  npx tsx scripts/test-tradeshow-badge.ts
import { cleanReading, stateFromPostcode } from '../src/lib/tradeshowBadge';

let pass = 0, fail = 0;
const ok = (n: string, c: unknown, x = '') => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (x ? '  ' + x : '')); } };

console.log('--- the state from a postcode');
ok('Sydney, Melbourne, Brisbane, Adelaide, Perth, Hobart, Darwin, Canberra', ['12 Test St, Sydney NSW 2000', '5 Test Rd, Richmond 3121', '1 Test Ave, Brisbane 4000', '2 Test St, Adelaide 5000', '3 Test St, Perth 6000', '4 Test St, Hobart 7000', '5 Test St, Darwin 0800', '6 Test St, Canberra 2600']
  .map(stateFromPostcode).join() === 'NSW,VIC,QLD,SA,WA,TAS,NT,ACT');
ok('no postcode, or one in the middle of the address, gives nothing', stateFromPostcode('Shop 4, Test Plaza') === null && stateFromPostcode(null) === null && stateFromPostcode('3000 Test Street Sydney') === null);
ok('a trailing "Australia" is fine', stateFromPostcode('1 Test St, Melbourne 3000 Australia') === 'VIC');

console.log('--- cleaning what Claude read');
const good = cleanReading({ readable: true, company: '  Little   Gifts Co ', contact: 'Mia Chen', email: ' Mia@LittleGifts.test ', phone: '0400 000 000', address: '1 Test St, Richmond VIC 3121', state: 'vic' });
ok('spaces are tidied, the email is lower case, the state is kept', good.company === 'Little Gifts Co' && good.email === 'mia@littlegifts.test' && good.state === 'VIC' && good.stateFrom === 'badge' && good.readable);
ok('a bad email is dropped, and it says so', (() => { const r = cleanReading({ company: 'X Shop', email: 'mia at shop' }); return r.email === null && /does not look right/.test(r.note ?? ''); })());
ok('a too short phone number is dropped, and it says so', (() => { const r = cleanReading({ company: 'X Shop', phone: '123' }); return r.phone === null && /too short/.test(r.note ?? ''); })());
ok('mailto: is stripped', cleanReading({ company: 'X Shop', email: 'mailto:a@b.test' }).email === 'a@b.test');
ok('an unknown state is dropped, then the postcode is tried', (() => { const r = cleanReading({ company: 'X Shop', state: 'Narnia', address: '9 Test St 4000' }); return r.state === 'QLD' && r.stateFrom === 'postcode'; })());
ok('no state and no postcode: no state (the rep picks it)', cleanReading({ company: 'X Shop', address: 'Shop 4' }).state === null);
ok('nothing readable is not readable, even if Claude forgot to say so', !cleanReading({}).readable && !cleanReading({ readable: false, company: 'X' }).readable);
ok('anything Claude says is unclear is kept for the rep', /smudged/.test(cleanReading({ company: 'X Shop', note: 'The phone digits are smudged.' }).note ?? ''));
ok('text longer than the limits is cut, and non-text is ignored', (() => { const r = cleanReading({ company: 'A'.repeat(500), contact: 42, email: ['x'] }); return r.company!.length <= 120 && r.contact === null && r.email === null; })());

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
