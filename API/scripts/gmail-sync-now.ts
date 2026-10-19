/**
 * Checks everyone's connected Gmail once, now, and prints what happened for each person. The same thing the sync worker does
 * every 15 minutes, handy for testing.
 *
 * Usage (from the API folder):
 *   npx tsx scripts/gmail-sync-now.ts
 */
import 'dotenv/config';
import { prisma } from '../src/lib/prisma';
import { syncAll } from '../src/lib/gmail/sync';
import { gmailConfigured, missingSetup } from '../src/lib/gmail/google';

async function main() {
  if (!gmailConfigured()) { console.log(`Gmail is not set up here. Missing: ${missingSetup().join(', ')}`); return; }
  const results = await syncAll(120_000);
  const names = new Map((await prisma.$queryRaw<{ id: string; name: string }[]>`select id, name from crm.reps where id = any(${results.map(r => r.rep)}::uuid[])`).map(r => [r.id, r.name]));
  console.log(`${results.length} mailbox${results.length === 1 ? '' : 'es'} checked\n`);
  for (const r of results) {
    console.log(`${(names.get(r.rep) ?? r.rep).padEnd(22)} ${r.status.padEnd(16)} looked at ${r.newMessages}, saved ${r.saved}, removed ${r.removed ?? 0}, still to do ${r.remaining}${r.failed ? `, ${r.failed} could not be saved` : ''}${r.error ? `, ${r.error}` : ''}`);
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });