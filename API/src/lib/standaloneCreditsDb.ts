// The database and DEAR side of the standalone credit notes sync (see standaloneCredits.ts for what it does and why).
import { prisma } from './prisma';
import { normalize } from './normalize';
import { dearGet } from '../sync/dearClient';
import { syncStandaloneCreditNotes, type Deps, type Get, type NoteRow, type Result } from './standaloneCredits';

const dayString = (d: Date) => d.toISOString().slice(0, 10);

// The shops a note can belong to: the same ones the sales sync matches orders to, by DEAR customer id first and then by name.
async function accountFinder(): Promise<Deps['findAccount']> {
  const rows = await prisma.$queryRaw<{ id: string; name: string; dear_customer_id: string | null }[]>`select id, name, dear_customer_id from crm.accounts where dear_customer_id is not null or type = 'customer'`;
  const byDear = new Map<string, string>(rows.filter(r => r.dear_customer_id).map(r => [String(r.dear_customer_id), String(r.id)] as [string, string]));
  const byName = new Map<string, string>(rows.map(r => [normalize(String(r.name)), String(r.id)] as [string, string]));
  return async (customerId, name): Promise<string | null> => (customerId ? byDear.get(customerId) : undefined) ?? (name ? byName.get(normalize(name)) : undefined) ?? null;
}

export function dbDeps(get: Get = dearGet): Promise<Deps> {
  return accountFinder().then(findAccount => ({
    get,
    findAccount,
    ordinarySaleIds: async ids => new Set((await prisma.$queryRaw<{ dear_sale_id: string }[]>`select dear_sale_id from crm.quotes where dear_sale_id = any(${ids}::text[])`).map(r => r.dear_sale_id)),
    stored: async () => {
      const rows = await prisma.$queryRaw<{ dear_sale_id: string; credit_note_number: string; dear_updated: Date | null; status: string | null }[]>`select dear_sale_id, credit_note_number, dear_updated, status from crm.standalone_credit_notes`;
      return new Map(rows.map(r => [`${r.dear_sale_id}|${r.credit_note_number.toUpperCase()}`, { updated: r.dear_updated ? r.dear_updated.toISOString() : null, status: r.status }]));
    },
    save: async (r: NoteRow) => {
      await prisma.$queryRaw`
        insert into crm.standalone_credit_notes (dear_sale_id, sale_number, credit_note_number, note_day, status, goods, charges, tax, total, memo, customer_name, dear_customer_id, account_id, dear_updated, synced_at)
        values (${r.dearSaleId}, ${r.saleNumber}, ${r.creditNoteNumber}, ${r.noteDay}::date, ${r.status}, ${r.goods}, ${r.charges}, ${r.tax}, ${r.total}, ${r.memo}, ${r.customerName}, ${r.dearCustomerId}, ${r.accountId}::uuid, ${r.dearUpdated}::timestamptz, now())
        on conflict (dear_sale_id, credit_note_number) do update set
          sale_number = excluded.sale_number, note_day = excluded.note_day, status = excluded.status, goods = excluded.goods, charges = excluded.charges, tax = excluded.tax, total = excluded.total,
          memo = excluded.memo, customer_name = excluded.customer_name, dear_customer_id = excluded.dear_customer_id,
          account_id = coalesce(excluded.account_id, crm.standalone_credit_notes.account_id), dear_updated = excluded.dear_updated, synced_at = now()
        returning id`;
    },
  }));
}

// The scheduled job: credit notes DEAR changed in the last 45 days.
export async function runStandaloneCreditNotes(opts: { sinceDaysAgo?: number; since?: string; maxDetails?: number; maxPages?: number } = {}, get: Get = dearGet): Promise<Result> {
  const since = opts.since ?? dayString(new Date(Date.now() - (opts.sinceDaysAgo ?? 45) * 86_400_000));
  // The routine run reads at most 10 pages (1,000 credit notes): if DEAR ever ignored the date it would not page through everything every 15 minutes.
  const result = await syncStandaloneCreditNotes(await dbDeps(get), { since, maxDetails: opts.maxDetails, maxPages: opts.maxPages ?? 10 });
  console.log(`Credit notes (DEAR lists ${result.listTotal ?? '?'} since ${since}): ${result.saved} saved, ${result.voidedUpdated} voided, ${result.alreadySaved} already up to date, ${result.left} left to read${result.problems.length ? `, ${result.problems.length} problems` : ''}.`);
  for (const p of result.problems.slice(0, 5)) console.warn('  credit note problem: ' + p);
  return result;
}

// The one-off catch-up from 1 Jan 2026 (DEAR ignores the date filter when it is older than about a year, so it cannot start earlier). Call it again until it reports 0 left.
export const BACKFILL_FROM = '2026-01-01';
export const runStandaloneCreditNotesBackfill = (get: Get = dearGet) => runStandaloneCreditNotes({ since: BACKFILL_FROM, maxPages: 60 }, get);
