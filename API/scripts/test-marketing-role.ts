// Tests the plain rules behind the marketing login: which pages its menu shows, which pages it may open, and who may approve a goal.
// No database, no login. Run:  npx tsx scripts/test-marketing-role.ts
import { visibleGroups, marketingMay, MARKETING_HOME } from '../../Web/src/lib/navMenu';
import { canDecide, canApprove } from '../src/lib/mktCore';

let pass = 0, fail = 0;
const ok = (n: string, c: unknown, x = '') => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (x ? '  ' + x : '')); } };
const menu = (role: string) => visibleGroups(role).map(g => `${g.label}: ${g.items.map(i => i.label).join(', ')}`);

console.log('--- the menu');
const m = menu('marketing');
ok('a marketing login sees exactly three tabs', m.length === 3, JSON.stringify(m));
ok('Products & Catalogue: Products, Catalogue, Trade Shows', m[0] === 'Products & Catalogue: Products, Catalogue, Trade Shows', m[0]);
ok('Marketing & Sales Support: Email Builder, Marketing Dashboard', m[1] === 'Marketing & Sales Support: Email Builder, Marketing Dashboard', m[1]);
ok('Tools & Administration: Assistant, Misc, Settings', m[2] === 'Tools & Administration: Assistant, Misc, Settings', m[2]);
ok('a marketing login does not see Orders, Customers, Sales Data, Ordering, Promos or Sales Tools', !m.join().match(/Orders|Customers|Sales Data|Order Forecast|Promos|Sales Tools|Credit|Pipeline/));
const rep = menu('rep').join(' | '), mgr = menu('manager').join(' | ');
ok('a rep does not see the Email Builder or the Marketing Dashboard (as before)', !/Email Builder|Marketing Dashboard/.test(rep));
ok('a rep still sees Planner, Orders and Promos (as before)', /Planner/.test(rep) && /Orders/.test(rep) && /Promos/.test(rep));
ok('a manager sees everything (as before)', /Email Builder/.test(mgr) && /Marketing Dashboard/.test(mgr) && /Order Forecast/.test(mgr) && /Ellen/.test(mgr));
ok('no role and an unknown role see no manager-only pages', !/Email Builder/.test(menu('').join()) && !/Email Builder/.test(menu('x').join()));

console.log('--- the pages a marketing login may open');
const may = (p: string) => marketingMay(p);
ok('its own pages, and the pages under them', ['/products', '/products/abc', '/catalogue', '/trade-shows', '/trade-shows/abc', '/marketing', '/marketing/campaigns', '/marketing/campaigns/1', '/marketing-dashboard', '/marketing-dashboard/edm', '/assistant', '/misc', '/settings'].every(may));
ok('not the Dashboard, customers, orders, reports, ordering or the other pages', ['/', '/customers', '/accounts', '/orders', '/credit', '/ordering', '/sales-data', '/reports', '/ellen', '/promos', '/sales-tools', '/planner', '/product-requests', '/liewood', '/pipeline'].every(p => !may(p)));
ok('a page that only starts with the same letters is not let in', !may('/marketingx') && !may('/productsx') && !may('/settings-admin'));
ok('it lands on the Marketing Dashboard, which it may open', MARKETING_HOME === '/marketing-dashboard' && may(MARKETING_HOME));

console.log('--- approving a goal');
ok('a manager can approve or reject any waiting goal', canDecide('manager', true, 'a', 'b') && canDecide('manager', false, 'a', 'b'));
ok('marketing cannot approve a goal, even one a manager proposed', !canDecide('marketing', true, 'a', 'b'));
ok('marketing cannot approve its own goal', !canDecide('marketing', true, 'b', 'b'));
ok('marketing cannot reject someone else\'s goal', !canDecide('marketing', false, 'a', 'b'));
ok('marketing can take back its own proposal', canDecide('marketing', false, 'b', 'b'));
ok('a rep cannot approve or reject', !canDecide('rep', true, 'a', 'b') && !canDecide('rep', false, 'a', 'b'));
ok('the rule that a different manager approves is unchanged', canApprove('a', 'b', 2) && !canApprove('a', 'a', 2) && canApprove('a', 'a', 1));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
