// Tests the plain rules behind "Remove from report": which SKUs a request holds. No database, no internet.
// Run:  npx tsx scripts/test-report-hidden.ts
import { parseSkus } from '../src/lib/reportHidden';

let pass = 0, fail = 0;
const ok = (n: string, c: unknown, x = '') => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (x ? '  ' + x : '')); } };
const eq = (n: string, got: unknown, want: unknown) => ok(n, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} wanted ${JSON.stringify(want)}`);

console.log('--- the SKUs in a request');
eq('a normal list', parseSkus(['LSB-219', 'LSB-223']), { skus: ['LSB-219', 'LSB-223'] });
eq('spaces around a SKU are removed', parseSkus(['  LSB-219 ']), { skus: ['LSB-219'] });
eq('the same SKU twice, in other capitals, counts once (the first spelling is kept)', parseSkus(['lsb-219', 'LSB-219', 'Lsb-219']), { skus: ['lsb-219'] });
eq('blank entries are dropped', parseSkus(['LSB-219', '', '   ']), { skus: ['LSB-219'] });
eq('nothing at all', parseSkus([]), { error: 'Give at least one SKU.' });
eq('only blanks', parseSkus(['', ' ']), { error: 'Give at least one SKU.' });
eq('not a list', parseSkus('LSB-219'), { error: 'Give at least one SKU.' });
eq('not text', parseSkus([5]), { error: 'Every SKU must be text.' });
eq('500 is allowed, 501 is not', [(parseSkus(Array.from({ length: 500 }, (_, i) => 'S' + i)) as { skus: string[] }).skus.length, parseSkus(Array.from({ length: 501 }, (_, i) => 'S' + i))], [500, { error: 'Give at most 500 SKUs at a time.' }]);
ok('a SKU with a control character is refused', 'error' in parseSkus(['A\u0000B']) && /does not look like a SKU/.test((parseSkus(['A\u0000B']) as { error: string }).error));
ok('a very long SKU is refused', 'error' in parseSkus(['x'.repeat(81)]));
eq('real-looking SKUs with dashes, underscores and digits only are fine', parseSkus(['MF_CAPNVY-S', '101062021', 'APC-031-G']), { skus: ['MF_CAPNVY-S', '101062021', 'APC-031-G'] });

console.log(`\npassed: ${pass}   failed: ${fail}`); process.exit(fail ? 1 : 0);
