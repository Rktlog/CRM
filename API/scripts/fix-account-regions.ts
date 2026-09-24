/**
 * Corrects the region field, which the original import wrongly
 * defaulted to 'NSW' for any account with no real state on record
 * (either a blank State column in the spreadsheet, or an account
 * that only ever existed in the Daily Activity tab with no contact
 * record at all). Sets those to 'Unknown' instead of a wrong guess —
 * an honest "we don't know" beats a confident wrong answer.
 *
 * Real states from the spreadsheet (NSW/ACT) are also re-applied
 * here in case any got miscategorized, so this is safe to run more
 * than once.
 *
 * Usage:
 *   npx tsx scripts/fix-account-regions.ts "/path/to/NSW_ACT_SALES_MASTER.xlsx"
 */
import 'dotenv/config';
import * as XLSX from 'xlsx';
import { PrismaClient } from '@prisma/client';
import { normalize } from '../src/lib/normalize';

const prisma = new PrismaClient();
const [, , filePath] = process.argv;
if (!filePath) {
  console.error('Usage: npx tsx scripts/fix-account-regions.ts <path-to-xlsx>');
  process.exit(1);
}

async function main() {
  const wb = XLSX.readFile(filePath, { cellDates: true });
  const contactRows: any[] = XLSX.utils.sheet_to_json(wb.Sheets['NSW Contacts List'], { defval: null });

  const realStateByName = new Map<string, string>();
  const knownBlankNames = new Set<string>();
  for (const row of contactRows) {
    const rawName = row['Business Name'];
    if (!rawName || typeof rawName !== 'string') continue;
    const key = normalize(rawName);
    const state = row['State'];
    if (state && String(state).trim()) {
      realStateByName.set(key, String(state).trim());
    } else {
      knownBlankNames.add(key);
    }
  }

  const accounts = await prisma.account.findMany({ select: { id: true, name: true, region: true } });

  let setUnknown = 0;
  let correctedReal = 0;

  for (const account of accounts) {
    const key = normalize(account.name);
    const real = realStateByName.get(key);

    if (real) {
      if (account.region !== real) {
        await prisma.account.update({ where: { id: account.id }, data: { region: real } });
        correctedReal++;
      }
      continue;
    }

    // Either a known-blank contacts-list row, or an account that
    // never appeared in the contacts list at all (Daily Activity
    // only) — both were guessed as 'NSW' by the original import.
    if (account.region === 'NSW') {
      await prisma.account.update({ where: { id: account.id }, data: { region: 'Unknown' } });
      setUnknown++;
    }
  }

  console.log(`Corrected to a real state: ${correctedReal}`);
  console.log(`Set to 'Unknown' (no real data available): ${setUnknown}`);
  console.log(`Note: these will self-correct to a real state automatically once the Cin7 sync links that account to a DEAR customer record with a real address.`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());