import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { createAccountSchema } from '../schemas';
import { territoryWhere, canSeeAccount } from '../lib/territory';
import { priceListOptions } from '../lib/priceList';
import { LIVE_ORDER } from '../lib/orderSource';
import { orderNoteSummary } from '../lib/orderNotes';
import { councilsFor } from '../lib/council';
import { mergeCheck, mergeAccounts, MergeError, COLD_LEAD_REASON } from '../lib/accountMerge';
import type { Db } from '../lib/accountMerge';

export const accountsRouter = Router();

// A bad id (for example a route that isn't deployed yet, so "inactive-stockists"
// lands on /:id) must be a 404, not a Prisma error that takes the whole API down.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
accountsRouter.param('id', (_req, res, next, id) => {
  if (!UUID.test(id)) return res.status(404).json({ error: 'Account not found' });
  next();
});

// Status from the crm.account_status view: Prospect, New Lead, Active or Inactive.
async function statusFor(ids: string[]) {
  if (!ids.length) return new Map<string, string>();
  const rows = await prisma.$queryRaw<{ account_id: string; status: string }[]>`
    select account_id, status from crm.account_status
    where account_id = any(${ids}::uuid[])`;
  return new Map(rows.map(r => [r.account_id, r.status]));
}

// Former names (from accounts merged into this one), so searching an old name still finds the account. Empty until account-merges.sql has been run.
async function aliasesFor(ids: string[]) {
  const out = new Map<string, string[]>();
  if (!ids.length) return out;
  try {
    const rows = await prisma.$queryRaw<{ account_id: string; aliases: string[] }[]>`
      select account_id::text as account_id, array_agg(alias order by alias) as aliases from crm.account_aliases
      where account_id = any(${ids}::uuid[]) group by 1`;
    for (const r of rows) out.set(r.account_id, r.aliases);
  } catch { /* the table does not exist until account-merges.sql has been run */ }
  return out;
}

// Registered before '/:id' — otherwise Express would treat
// "backorders" as an :id value and this route would never match.
accountsRouter.get('/backorders', async (req, res) => {
  const accounts = await prisma.account.findMany({
    where: {
      AND: [
        await territoryWhere(req.rep!),
        { quotes: { some: { fulfillmentStatus: 'BACKORDERED', ...LIVE_ORDER } } },
      ],
    },
    include: {
      rep: { select: { name: true } },
      quotes: { where: { fulfillmentStatus: 'BACKORDERED', ...LIVE_ORDER }, orderBy: { sentAt: 'desc' } },
    },
    orderBy: { updatedAt: 'desc' },
  });

  const flattened = accounts.map(({ rep, ...a }) => ({ ...a, repName: rep?.name ?? null }));
  res.json(flattened);
});

// Accounts this person can see (lib/territory: managers everything,
// reps their assigned states plus their own accounts). ?region= narrows
// further. Archived accounts (one-off buyers, sports clubs, not real
// sales targets) are excluded by default; pass ?archived=true to see
// them. ?scope=all is still accepted from older pages but no longer
// widens a rep's view beyond their territory.
accountsRouter.get('/', async (req, res) => {
  const showArchived = req.query.archived === 'true';
  const region = req.query.region as string | undefined;
  const accounts = await prisma.account.findMany({
    where: {
      AND: [
        await territoryWhere(req.rep!),
        ...(region ? [{ region: { in: region.split(',') } }] : []),
        {
          archived: showArchived,
          misc: false, // manual "Mark as Misc" override, always respected
          // An account is hidden automatically only if EVERY order it has
          // is marketing/warranty-tagged. One real order is enough to keep
          // it visible, and a fresh account with no orders always shows.
          OR: [
            { quotes: { none: {} } },
            { quotes: { some: { miscType: null } } },
          ],
        },
      ],
    },
    include: {
      rep: { select: { name: true } },
      // Just enough to know if this account has any order that came
      // from the old spreadsheet import, without pulling all of them.
      quotes: { where: { source: 'rhino-history' }, take: 1, select: { id: true } },
    },
    orderBy: { updatedAt: 'desc' },
  });

  // Flatten rep.name onto repName, matching the rest of the API's flat shape.
  const statuses = await statusFor(accounts.map(a => a.id));
  const aliases = await aliasesFor(accounts.map(a => a.id));
  const councils = await councilsFor(accounts.map(a => a.id));   // from the postcode in the address (council.sql)
  const flattened = accounts.map(({ rep, quotes, ...a }) => ({
    ...a,
    council: councils.get(a.id)?.council ?? null,
    postcode: councils.get(a.id)?.postcode ?? null,
    repName: rep?.name ?? null,
    hasHistoricalOrders: quotes.length > 0,
    formerNames: aliases.get(a.id) ?? [],
    status: a.type === 'cold_lead' ? 'Cold lead' : (statuses.get(a.id) ?? 'Prospect'),   // the status view knows nothing about cold leads
  }));
  res.json(flattened);
});

// Existing customers for the Customers board, with what a rep needs on
// each card: reorder pace, spend, and whether there's an open quote, an
// unpaid balance or a backorder right now. Same territory rule as
// everything else. Reorder health (recent / due / overdue / lapsed) is
// worked out in the page from lastOrderAt and avgOrderGapDays.
// Stockists set up in DEAR that have never placed an order, or haven't ordered
// for 12 months or more. Counts are for the whole list so the tabs can show
// them; ?kind=never|lapsed picks one, ?q= searches by name, ?limit&offset page.
accountsRouter.get('/inactive-stockists', async (req, res) => {
  // Any failure comes back as a message, never as a crash of the whole API.
  try {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '10'), 10) || 0, 0), 100);
    const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const kind = req.query.kind === 'never' || req.query.kind === 'lapsed' ? req.query.kind : 'all';
    const cutoff = new Date(Date.now() - 365 * 86400000);

    const base: any = {
      AND: [
        await territoryWhere(req.rep!),
        {
          archived: false, misc: false, dearCustomerId: { not: null }, type: { not: 'cold_lead' },   // a cold lead is not offered for outreach
          // same visibility rule as the Accounts list
          OR: [{ quotes: { none: {} } }, { quotes: { some: { miscType: null } } }],
        },
      ],
    };
    const never: any = { lastOrderAt: null };
    const lapsed: any = { lastOrderAt: { lt: cutoff } };
    const pick: any = kind === 'never' ? never : kind === 'lapsed' ? lapsed : { OR: [never, lapsed] };
    const where: any = { AND: [base, pick, ...(q ? [{ name: { contains: q, mode: 'insensitive' } }] : [])] };

    const [neverCount, lapsedCount, matches, rows] = await Promise.all([
      prisma.account.count({ where: { AND: [base, never] } }),
      prisma.account.count({ where: { AND: [base, lapsed] } }),
      prisma.account.count({ where }),
      limit
        ? prisma.account.findMany({
            where,
            // never ordered first (newest first), then the most recently lapsed
            orderBy: [{ lastOrderAt: 'desc' }, { createdAt: 'desc' }],
            skip: offset,
            take: limit,
            select: {
              id: true, name: true, region: true, contactName: true, phone: true, email: true,
              paymentTerms: true, createdAt: true, lastOrderAt: true, rep: { select: { name: true } },
            },
          })
        : Promise.resolve([] as any[]),
    ]);

    res.json({
      neverCount, lapsedCount, matches,
      rows: rows.map(({ rep, ...a }: any) => ({ ...a, repName: rep?.name ?? null })),
    });
  } catch (e) {
    console.error('inactive-stockists failed', e);
    res.status(500).json({ error: (e as Error).message });
  }
});

accountsRouter.get('/customers', async (req, res) => {
  const accounts = await prisma.account.findMany({
    where: {
      AND: [
        await territoryWhere(req.rep!),
        { type: 'customer', archived: false, misc: false },
      ],
    },
    select: {
      id: true, name: true, region: true, contactName: true, phone: true,
      lastOrderAt: true, avgOrderGapDays: true, spend90: true, spend365: true,
      rep: { select: { name: true } },
    },
  });
  const ids = accounts.map(a => a.id);

  // Live DEAR orders only (not spreadsheet history, marketing or warranty).
  const flags = ids.length
    ? await prisma.$queryRaw<{ account_id: string; open_quote: boolean; backordered: boolean; owing: number }[]>`
        select account_id,
          bool_or(upper(coalesce(fulfillment_status, '')) in ('DRAFT', 'ESTIMATING', 'ESTIMATED', 'ORDERING')
                  and sent_at > now() - interval '90 days') as open_quote,
          bool_or(upper(coalesce(fulfillment_status, '')) = 'BACKORDERED') as backordered,
          -- Balance as DEAR shows it: owed on invoices minus credit on account.
          coalesce(sum(case
            when amount_due is not null then amount_due
            when not paid and invoice_date is not null then coalesce(total, amount)
            else 0 end), 0)::float8
            - coalesce(sum(unapplied_credit), 0)::float8 as owing
        from crm.quotes
        where account_id = any(${ids}::uuid[])
          and source <> 'rhino-history' and number not like 'Q%'
          and (misc_type is null or amount_due > 0.005) -- warranty/marketing only if DEAR invoiced them
          and upper(coalesce(fulfillment_status, '')) not in ('VOIDED', 'CREDITED')
        group by account_id`
    : [];
  const flagsById = new Map(flags.map(f => [f.account_id, f]));

  res.json(accounts.map(({ rep, ...a }) => {
    const f = flagsById.get(a.id);
    return {
      ...a,
      repName: rep?.name ?? null,
      openQuote: f?.open_quote ?? false,
      backordered: f?.backordered ?? false,
      owing: Math.round((f?.owing ?? 0) * 100) / 100,
    };
  }));
});

// Filter choices for the customer price list: every brand, with the ones
// this store has bought first and ticked by default.
accountsRouter.get('/:id/pricelist-options', async (req, res) => {
  const account = await prisma.account.findUnique({ where: { id: req.params.id }, select: { id: true, repId: true, region: true } });
  if (!account) return res.status(404).json({ error: 'Account not found' });
  if (!(await canSeeAccount(req.rep!, account))) return res.status(403).json({ error: 'This account is outside your states' });
  res.json(await priceListOptions(account.id));
});

accountsRouter.get('/:id', async (req, res) => {
  const account = await prisma.account.findUnique({
    where: { id: req.params.id },
    include: {
      rep: { select: { name: true } },
      activity: {
        orderBy: { occurredAt: 'desc' },
        include: { rep: { select: { name: true } }, quote: { select: { id: true, number: true } } },
      },
      quotes: { orderBy: { sentAt: 'desc' }, include: { lines: true } },
    },
  });

  if (!account) return res.status(404).json({ error: 'Account not found' });

  if (!(await canSeeAccount(req.rep!, account))) {
    return res.status(403).json({ error: 'This account is outside your states' });
  }

  const { rep, activity, ...rest } = account;

  // Aggregate every product/brand this account has ever bought,
  // across all their orders — real line-item history.
  const productTotals = new Map<string, { productName: string; brand: string | null; quantity: number; total: number }>();
  for (const q of rest.quotes) {
    for (const l of (q as any).lines ?? []) {
      const existing = productTotals.get(l.sku) ?? { productName: l.productName, brand: l.brand, quantity: 0, total: 0 };
      existing.quantity += l.quantity;
      existing.total += l.lineTotal;
      productTotals.set(l.sku, existing);
    }
  }
  const productBreakdown = [...productTotals.entries()]
    .map(([sku, v]) => ({ sku, ...v, total: Math.round(v.total * 100) / 100 }))
    .sort((a, b) => b.total - a.total);

  const notes = await orderNoteSummary(rest.quotes.map(q => q.id));   // what the team has said about each order

  const council = (await councilsFor([rest.id])).get(rest.id);   // the council worked out from its postcode (council.sql)

  const flattened = {
    ...rest,
    council: council?.council ?? null,
    postcode: council?.postcode ?? null,
    quotes: rest.quotes.map(q => ({ ...q, ...(notes.get(q.id) ?? {}) })),
    repName: rep?.name ?? null,
    activity: activity.map(({ rep: activityRep, quote, ...a }) => ({ ...a, repName: activityRep?.name ?? null, orderId: quote?.id ?? null, orderNumber: quote?.number ?? null })),
    productBreakdown,
    formerNames: (await aliasesFor([rest.id])).get(rest.id) ?? [],
    status: rest.type === 'cold_lead' ? 'Cold lead' : ((await statusFor([rest.id])).get(rest.id) ?? 'Prospect'),
  };

  res.json(flattened);
});

accountsRouter.post('/', async (req, res) => {
  const parsed = createAccountSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const account = await prisma.account.create({ data: parsed.data });
  res.status(201).json(account);
});

// Set the account's usual reorder gap by hand ({ days: 30 }), or back to the
// calculated value ({ days: null }). For accounts where the calculation
// doesn't fit, e.g. several branches ordering through one account.
accountsRouter.patch('/:id/reorder-gap', async (req, res) => {
  const account = await prisma.account.findUnique({ where: { id: req.params.id } });
  if (!account) return res.status(404).json({ error: 'Account not found' });
  if (!(await canSeeAccount(req.rep!, account))) {
    return res.status(403).json({ error: 'This account is outside your states' });
  }
  const raw = req.body?.days;
  const days = raw === null || raw === '' || raw === undefined ? null : Math.round(Number(raw));
  if (days !== null && (!Number.isFinite(days) || days < 1 || days > 365)) {
    return res.status(400).json({ error: 'Enter a number of days between 1 and 365, or leave it blank for automatic' });
  }
  const updated = await prisma.account.update({
    where: { id: account.id },
    data: { reorderGapOverride: days, avgOrderGapDays: days ?? account.reorderGapAuto },
  });
  res.json(updated);
});

// Managers: change an account's state, e.g. move a head office (NSW/HO,
// VIC/HO) back to a normal state, or the other way. The customer sync only
// fills a state when it's missing, so the change sticks.
const ACCOUNT_STATES = ['NSW', 'ACT', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'NT', 'NZ', 'NSW/HO', 'VIC/HO', 'INTL', 'Unknown'];
accountsRouter.patch('/:id/region', async (req, res) => {
  if (req.rep!.role !== 'manager') return res.status(403).json({ error: 'Only a manager can change an account\'s state' });
  const region = String(req.body?.region ?? '');
  if (!ACCOUNT_STATES.includes(region)) return res.status(400).json({ error: `State must be one of: ${ACCOUNT_STATES.join(', ')}` });
  const account = await prisma.account.findUnique({ where: { id: req.params.id } });
  if (!account) return res.status(404).json({ error: 'Account not found' });
  const updated = await prisma.account.update({ where: { id: account.id }, data: { region } });
  res.json(updated);
});

// Managers: change an account's type: Customer, Lead, Prospect or Cold lead.
//   Customer  kept up to date from DEAR (contact details, payment terms, orders); gets reorder follow-ups in the Planner.
//   Lead      someone who has shown interest. Details stay with the rep, DEAR does not update them, and the Planner does not offer
//             it as a cold outreach (it is already being worked).
//   Prospect  not yet approached. Details stay with the rep, DEAR does not update them, and the Planner can offer it for outreach.
//   Cold lead someone who does not want to be contacted (often an existing customer). The Planner never suggests them and no task can be
//             scheduled for them, they are left out of Inactive stockists, and every email address they have is added to the marketing
//             suppression list so no campaign or automation reaches them. Their orders still sync from DEAR. Changing the type back lifts it.
// The customer sync only looks at accounts that are customers, so this is what starts or stops it for one account.
accountsRouter.patch('/:id/type', async (req, res) => {
  if (req.rep!.role !== 'manager') return res.status(403).json({ error: 'Only a manager can change an account\'s type' });
  const raw = req.body?.type, type = typeof raw === 'string' ? raw.toLowerCase() : '';
  if (type !== 'customer' && type !== 'lead' && type !== 'prospect' && type !== 'cold_lead') return res.status(400).json({ error: 'Type must be customer, lead, prospect or cold_lead' });
  const account = await prisma.account.findUnique({ where: { id: req.params.id } });
  if (!account) return res.status(404).json({ error: 'Account not found' });
  if (account.type === type) return res.json(account);
  // Going to or from Cold lead also switches marketing off or on for every address this account has (its own and any marketing contact linked to it).
  // Done in the same transaction as the type change, so a cold lead can never end up changed but still emailable.
  try {
    const touchesMarketing = type === 'cold_lead' || account.type === 'cold_lead';
    const emails = touchesMarketing
      ? (await prisma.$queryRaw<{ email: string }[]>`
          select lower(btrim(email)) as email from crm.accounts where id = ${account.id}::uuid and email is not null and btrim(email) <> ''
          union select lower(btrim(email)) from crm.marketing_contacts where account_id = ${account.id}::uuid and btrim(email) <> ''`).map(r => r.email)
      : [];
    const change = prisma.account.update({ where: { id: account.id }, data: { type } });
    if (!emails.length) return res.json(await change);
    const marketing = type === 'cold_lead'
      ? prisma.$executeRaw`insert into crm.marketing_suppressions (email, reason) select unnest(${emails}::text[]), ${COLD_LEAD_REASON} on conflict (email) do nothing`
      : prisma.$executeRaw`delete from crm.marketing_suppressions where email = any(${emails}::text[]) and reason = ${COLD_LEAD_REASON}`;
    const [updated] = await prisma.$transaction([change, marketing]);
    res.json(updated);
  } catch (e) {
    console.error('change account type failed', e);
    res.status(500).json({ error: `Could not change the type: ${(e as Error).message}` });
  }
});

// ---- Managers: delete an account, or archive it ----
// An account with orders is never deleted: its orders count in the sales figures, and the database would refuse anyway. Archive it instead
// (hidden from the lists and reports; the orders still count). An account with no orders can be deleted, together with its own logs and
// tasks (and its logged emails, which go with it). The customer in DEAR is not touched.
async function deleteFacts(id: string) {
  const [orders, logs, tasks] = await Promise.all([
    prisma.quote.count({ where: { accountId: id } }), prisma.activity.count({ where: { accountId: id } }), prisma.task.count({ where: { accountId: id } }),
  ]);
  const [x] = await prisma.$queryRaw<{ emails: number; reservations: number }[]>`
    select (select count(*) from crm.email_log where account_id = ${id}::uuid)::int as emails,
           (select count(*) from crm.credit_reservations where from_account_id = ${id}::uuid or to_account_id = ${id}::uuid)::int as reservations`;
  const reason = orders > 0
    ? `This account has ${orders} order${orders === 1 ? '' : 's'}. Deleting it would take ${orders === 1 ? 'it' : 'them'} out of the sales figures, so it can't be deleted. Archive it instead: it is hidden from the lists and reports and its orders still count.`
    : (x?.reservations ?? 0) > 0 ? "This account has credit reserved against it (see Credit), so it can't be deleted." : null;
  return { orders, logs, tasks, emails: x?.emails ?? 0, reservations: x?.reservations ?? 0, canDelete: !reason, reason };
}
const managerOnly = (req: any, res: any, what: string) => { if (req.rep!.role !== 'manager') { res.status(403).json({ error: `Only a manager can ${what}` }); return false; } return true; };   // (a bad id is already a 404 at the top of this file)

// What deleting would remove, and whether it is allowed, for the confirmation window.
accountsRouter.get('/:id/delete-check', async (req, res) => {
  if (!managerOnly(req, res, 'delete an account')) return;
  const account = await prisma.account.findUnique({ where: { id: req.params.id }, select: { id: true, name: true, dearCustomerId: true } });
  if (!account) return res.status(404).json({ error: 'Account not found' });
  res.json({ name: account.name, linkedToDear: !!account.dearCustomerId, ...(await deleteFacts(account.id)) });
});

accountsRouter.delete('/:id', async (req, res) => {
  if (!managerOnly(req, res, 'delete an account')) return;
  const account = await prisma.account.findUnique({ where: { id: req.params.id }, select: { id: true } });
  if (!account) return res.status(404).json({ error: 'Account not found' });
  const f = await deleteFacts(account.id);
  if (!f.canDelete) return res.status(409).json({ error: f.reason });
  try {
    await prisma.$transaction([
      prisma.task.deleteMany({ where: { accountId: account.id } }),
      prisma.activity.deleteMany({ where: { accountId: account.id } }),
      prisma.account.delete({ where: { id: account.id } }),
    ]);
  } catch (e: any) {
    if (e?.code === 'P2003') return res.status(409).json({ error: 'Something was added to this account while you were deleting it, so it was not deleted.' });   // an order arrived in the meantime
    throw e;
  }
  res.json({ ok: true, deleted: { logs: f.logs, tasks: f.tasks, emails: f.emails } });
});

// Archive an account (hidden from the lists and reports, and kept hidden: the automatic archiving rules will not bring it back), or restore it.
accountsRouter.patch('/:id/archive', async (req, res) => {
  if (!managerOnly(req, res, 'archive an account')) return;
  if (typeof req.body?.archived !== 'boolean') return res.status(400).json({ error: 'Say whether to archive or restore it' });
  const account = await prisma.account.findUnique({ where: { id: req.params.id }, select: { id: true } });
  if (!account) return res.status(404).json({ error: 'Account not found' });
  await prisma.$executeRaw`update crm.accounts set archived = ${req.body.archived}, keep_archived = ${req.body.archived}, updated_at = now() where id = ${account.id}::uuid`;
  res.json(await prisma.account.findUnique({ where: { id: account.id } }));
});

// ---- Managers: merge a duplicate account into this one ----
// A lead is often taken under the name the customer gave, and DEAR later sets them up under their trading name, so the CRM ends up with two accounts
// for one business. On the account to KEEP, a manager picks the duplicate: everything that points at it (logs, tasks, orders, emails, comments,
// credit reservations, marketing contacts and anything added later) moves here, its name is kept as a former name, and it is deleted. All in one
// transaction. lib/accountMerge.ts has the rules; account-merges.sql creates the two small tables it needs.
const dbOf = (c: any): Db => ({ query: (s, p = []) => c.$queryRawUnsafe(s, ...p), exec: (s, p = []) => c.$executeRawUnsafe(s, ...p) });

// What a merge would do (counts, what the account becomes, warnings), for the confirmation window. Changes nothing.
accountsRouter.get('/:id/merge-check', async (req, res) => {
  if (!managerOnly(req, res, 'merge accounts')) return;
  try {
    res.json(await mergeCheck(dbOf(prisma), req.params.id, String(req.query.from ?? '')));
  } catch (e) {
    if (e instanceof MergeError) return res.status(e.status).json({ error: e.message });
    throw e;
  }
});

accountsRouter.post('/:id/merge', async (req, res) => {
  if (!managerOnly(req, res, 'merge accounts')) return;
  try {
    const result = await prisma.$transaction(tx => mergeAccounts(dbOf(tx), req.params.id, String(req.body?.fromId ?? ''), req.rep!.id), { timeout: 60000, maxWait: 10000 });
    res.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof MergeError) return res.status(e.status).json({ error: e.message });
    console.error('merge accounts failed', e);
    res.status(500).json({ error: `The merge failed and nothing was changed: ${(e as Error).message}` });
  }
});

// Toggle the misc flag — marketing/warranty/internal orders that are
// real but shouldn't count toward a rep's sales performance. Unlike
// archived, a misc account stays fully visible everywhere except
// performance reporting specifically.
accountsRouter.patch('/:id/misc', async (req, res) => {
  const account = await prisma.account.findUnique({ where: { id: req.params.id } });
  if (!account) return res.status(404).json({ error: 'Account not found' });
  if (!(await canSeeAccount(req.rep!, account))) {
    return res.status(403).json({ error: 'This account is outside your states' });
  }

  const misc = typeof req.body.misc === 'boolean' ? req.body.misc : !account.misc;
  const updated = await prisma.account.update({ where: { id: req.params.id }, data: { misc } });
  res.json(updated);
});