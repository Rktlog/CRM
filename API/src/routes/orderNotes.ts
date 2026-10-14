import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { canSeeAccount } from '../lib/territory';

// The team's log for one order. Adding to it uses the normal POST /activity (with the order's id), so a log about an
// order is the very same record as a log about the account, and shows in both places.
export const orderNotesRouter = Router();

// GET /order-notes/:orderId -> everything logged about this order, newest first
orderNotesRouter.get('/:orderId', async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.orderId)) return res.status(400).json({ error: 'Bad order' });
  const [o] = await prisma.$queryRaw<any[]>`
    select q.id, q.number, a.id as "accountId", a.name as "accountName", a.region, a.rep_id as "repId"
    from crm.quotes q join crm.accounts a on a.id = q.account_id where q.id = ${req.params.orderId}::uuid`;
  if (!o) return res.status(404).json({ error: 'Order not found' });
  // Whoever can see the account can see its orders' notes. No one else can.
  if (!(await canSeeAccount(req.rep!, { id: o.accountId, repId: o.repId, region: o.region } as any))) return res.status(403).json({ error: 'This order is outside your states' });

  const rows = await prisma.$queryRaw<any[]>`
    select x.id, x.type::text as type, x.note, x.occurred_at as "occurredAt", x.created_at as "createdAt", x.updated_at as "updatedAt",
           x.rep_id as "repId", r.name as "repName"
    from crm.activity x left join crm.reps r on r.id = x.rep_id
    where x.quote_id = ${req.params.orderId}::uuid
    order by x.occurred_at desc, x.created_at desc limit 200`;
  const manager = req.rep!.role === 'manager';
  res.json({
    order: { id: o.id, number: o.number, accountId: o.accountId, accountName: o.accountName },
    notes: rows.map(n => ({ ...n, mine: n.repId === req.rep!.id, canEdit: manager || n.repId === req.rep!.id, edited: !!n.updatedAt })),
  });
});