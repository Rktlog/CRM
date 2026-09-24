/**
 * Archives prospects that are clearly not real sales targets — one-off
 * individual buyers and sports club/umpiring merchandise orders. Only
 * ever touches type='prospect' accounts, never a real customer, no
 * matter how the name looks — a real paying customer is never archived
 * by this script.
 *
 * This does NOT delete anything. Archived accounts keep their DEAR
 * link and history; they're just filtered out of the default view.
 *
 * Usage:
 *   npx tsx scripts/archive-non-leads.ts        (preview only)
 *   npx tsx scripts/archive-non-leads.ts --apply
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const apply = process.argv.includes('--apply');

const BUSINESS_WORDS = [
  'pty', 'ltd', 'llc', 'inc', 'co', 'store', 'shop', 'group', 'trading', 'gifts', 'gift',
  'toys', 'toy', 'pharmacy', 'cafe', 'florist', 'books', 'book', 'home', 'homewares', 'kids',
  'boutique', 'design', 'designs', 'studio', 'collective', 'company', 'living', 'house',
  'market', 'gallery', 'museum', 'school', 'college', 'hospital', 'centre', 'center',
  'newsagency', 'nextra', 'chemist', 'chemmart', 'apparel', 'fashion', 'interiors', 'flowers',
  'florals', 'party', 'partyware', 'wholesale', 'imports', 'distributors', 'agency', 'agencies',
];

const SPORTS_KEYWORDS = [
  'afl', 'vfl', 'sanfl', 'nwua', 'football club', 'netball', 'umpire', 'umpiring',
  'umpires', 'cricket club', ' fc', 'fc ', 'athletic club', 'sporting club', 'football league',
  'football netball', 'racing', 'sport inclusion',
];

function looksLikeIndividual(name: string): boolean {
  const words = name.trim().split(/\s+/);
  if (words.length < 2 || words.length > 4) return false;
  if (/\d/.test(name)) return false;
  const lower = name.toLowerCase();
  if (BUSINESS_WORDS.some(w => lower.includes(w))) return false;
  // Every word capitalized-first-letter and otherwise lowercase — the
  // classic shape of a personal name as typed into an order form.
  return words.every(w => /^[A-Z][a-zà-ÿ'’.-]*$/.test(w) || /^[A-Z]+$/.test(w));
}

function looksLikeSportsOrg(name: string): boolean {
  const lower = ` ${name.toLowerCase()} `;
  return SPORTS_KEYWORDS.some(k => lower.includes(k));
}

async function main() {
  const prospects = await prisma.account.findMany({
    where: { type: 'prospect', archived: false },
    select: { id: true, name: true },
  });

  const sportsMatches = prospects.filter(a => looksLikeSportsOrg(a.name));
  const individualMatches = prospects.filter(a => !looksLikeSportsOrg(a.name) && looksLikeIndividual(a.name));

  console.log(`Checked ${prospects.length} prospects.`);
  console.log(`\nSports/club/umpiring orgs (safe to auto-archive — no real gift retailer is named this): ${sportsMatches.length}`);
  console.log(`Sample: ${sportsMatches.slice(0, 15).map(a => a.name).join(', ')}`);
  console.log(`\nLooks like an individual name (NOT auto-archived — too many real boutique brand names have this exact shape, e.g. "Blue Jaam", "Humble Haven"): ${individualMatches.length}`);
  console.log(`These are written to individual-name-candidates.csv for you to review yourself — a script can't reliably tell a person's name from a quirky small-business name.`);

  const fs = await import('fs');
  fs.writeFileSync(
    'individual-name-candidates.csv',
    'id,name\n' + individualMatches.map(a => `${a.id},"${a.name.replace(/"/g, '""')}"`).join('\n')
  );

  if (!apply) {
    console.log('\nPreview only — rerun with --apply to archive the sports/club matches (individual-name candidates are never auto-archived by this script).');
    return;
  }

  const ids = sportsMatches.map(a => a.id);
  const chunkSize = 500;
  for (let i = 0; i < ids.length; i += chunkSize) {
    await prisma.account.updateMany({
      where: { id: { in: ids.slice(i, i + chunkSize) } },
      data: { archived: true },
    });
  }

  console.log(`\nArchived ${sportsMatches.length} sports/club accounts.`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
