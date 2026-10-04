import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { createAccountSchema } from '../schemas';
import { territoryWhere, canSeeAccount } from '../lib/territory';
import { priceListOptions } from '../lib/priceList';
import { LIVE_ORDER } from '../lib/orderSource';

export const accountsRouter = Router();

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
  const flattened = accounts.map(({ rep, quotes, ...a }) => ({ ...a, repName: rep?.name ?? null, hasHistoricalOrders: quotes.length > 0 }));
  res.json(flattened);
});

// Existing customers for the Customers board, with what a rep needs on
// each card: reorder pace, spend, and whether there's an open quote, an
// unpaid balance or a backorder right now. Same territory rule as
// everything else. Reorder health (recent / due / overdue / lapsed) is
// worked out in the page from lastOrderAt and avgOrderGapDays.
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
          and source <> 'rhino-history' and number not like 'Q%' and misc_type is null
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
        include: { rep: { select: { name: true } } },
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

  const flattened = {
    ...rest,
    repName: rep?.name ?? null,
    activity: activity.map(({ rep: activityRep, ...a }) => ({ ...a, repName: activityRep?.name ?? null })),
    productBreakdown,
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