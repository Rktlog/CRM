/**
 * One-off: puts the abandoned-cart logs that were written BEFORE cart logs started to be saved in the activity log into the activity log too, so the
 * Team log, My log and each account's history show them.
 *
 *   npx tsx scripts/backfill-cart-activity.ts           shows what it WOULD add, writes nothing
 *   npx tsx scripts/backfill-cart-activity.ts --apply   adds them
 *
 * Run abandoned-cart-activity.sql first (it adds the link column, which is how this knows what it has already done: safe to re-run, nothing is added twice).
 *
 * Each entry is dated and credited as the cart log was (when it was written, and by whom). A cart is matched to an account the way the Abandoned carts
 * page does it (by email, then by name). A cart log for someone not in the CRM has no account to go on, and is left as it is. This only adds entries: it
 * does not move a lead to "approached" or set follow-up dates, because these are old logs, not new contact.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { loadCarts, cartLogAsActivity } from '../src/routes/Abandonedcarts';

const prisma = new PrismaClient();
const apply = process.argv.includes('--apply');

type LogRow = { id: string; cart_key: string; rep_id: string; method: string | null; note: string; created_at: Date };

async function main() {
  const logs = await prisma.$queryRaw<LogRow[]>`
    select id, cart_key, rep_id, method, note, created_at from crm.abandoned_cart_logs where activity_id is null order by created_at`;
  console.log(`${logs.length} cart log(s) not yet in the activity log.`);
  if (!logs.length) return;

  const carts = await loadCarts({ id: 'backfill', role: 'manager' }, 'all');   // every cart, as a manager sees them
  const accountOf = new Map(carts.map(c => [c.id, c.account?.id ?? null]));

  let added = 0, noAccount = 0, cartGone = 0;
  for (const l of logs) {
    const accountId = accountOf.get(l.cart_key);
    if (accountId === undefined) { cartGone++; continue; }   // the cart's lines are no longer in the data
    if (!accountId) { noAccount++; continue; }                // not in the CRM
    const entry = cartLogAsActivity(l.method, l.note);
    if (apply) {
      await prisma.$transaction(async tx => {
        const activity = await tx.activity.create({ data: { accountId, repId: l.rep_id, type: entry.type, note: entry.note, occurredAt: l.created_at, createdAt: l.created_at } });
        await tx.$queryRaw`update crm.abandoned_cart_logs set activity_id = ${activity.id}::uuid where id = ${l.id}::uuid`;
      });
    } else if (added < 10) {
      console.log(`  would add: ${l.created_at.toISOString().slice(0, 10)}  ${entry.type.padEnd(6)} ${entry.note.slice(0, 90)}`);
    }
    added++;
  }
  console.log(`\n${apply ? 'Added' : 'Would add'} ${added} entr${added === 1 ? 'y' : 'ies'} to the activity log.`);
  if (noAccount) console.log(`${noAccount} cart log(s) are for people not in the CRM yet: no account to put them on, left as they are.`);
  if (cartGone) console.log(`${cartGone} cart log(s) are for carts no longer in the data: left as they are.`);
  if (!apply && added) console.log('\nNothing has been written. Run again with --apply to add them.');
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());