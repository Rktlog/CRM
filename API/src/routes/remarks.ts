import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { territoryWhere, canSeeAccount } from '../lib/territory';

// Remarks: any comment or feedback on an activity log, an account or an order. Anyone who can see the thing can read its remarks and add
// one (a manager gives feedback, the rep replies). You can edit your own words; you or a manager can delete one.
//   POST   /remarks/summary             { kind, ids }   how many remarks each has, and the latest (what lists show)
//   GET    /remarks/:kind/:id                           the remarks on one, oldest first
//   POST   /remarks/:kind/:id           { body }
//   PATCH  /remarks/item/:remarkId      { body }        the author only
//   DELETE /remarks/item/:remarkId                      the author, or a manager
// kind is activity, account or order. Needs remarks.sql: until it has been run, reading says there are none and writing says to run it.
export const remarksRouter = Router();

const COLUMN = { activity: 'activity_id', account: 'account_id', order: 'quote_id' } as const;
type Kind = keyof typeof COLUMN;
const KIND_NAME: Record<Kind, string> = { activity: 'Activity', account: 'Account', order: 'Order' };
const isKind = (k: unknown): k is Kind => typeof k === 'string' && Object.prototype.hasOwnProperty.call(COLUMN, k);
const col = (k: Kind) => Prisma.raw(COLUMN[k]);   // a fixed name from the list above, never from the request

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LENGTH = 2000;
const MAX_IDS = 500;
const NOT_SET_UP = 'Remarks are not set up yet: run remarks.sql in the database first.';

let ready: { at: number; ok: boolean } | null = null;
export const clearRemarksCache = () => { ready = null; };   // so the table is noticed at once after the SQL is run
async function tableReady(): Promise<boolean> {
  if (ready && Date.now() - ready.at < (ready.ok ? 60_000 : 10_000)) return ready.ok;
  let ok = false;
  try {
    const r = await prisma.$queryRaw<{ ok: boolean }[]>`select to_regclass('crm.remarks') is not null as ok`;
    ok = !!r[0]?.ok;
  } catch { ok = false; }
  ready = { at: Date.now(), ok };
  return ok;
}

type RemarkRow = { id: string; rep_id: string | null; author_name: string; body: string; created_at: Date; updated_at: Date | null };
type ItemRow = RemarkRow & { activity_id: string | null; account_id: string | null; quote_id: string | null };
const shape = (r: RemarkRow, me: { id: string; role: string }) => ({
  id: r.id, repId: r.rep_id, author: r.author_name, body: r.body, createdAt: r.created_at, updatedAt: r.updated_at,
  mine: r.rep_id === me.id, canEdit: r.rep_id === me.id, canDelete: r.rep_id === me.id || me.role === 'manager',
});

// The store a thing belongs to: what decides who may see it.
async function accountOf(kind: Kind, id: string): Promise<{ id: string; region: string } | null> {
  if (kind === 'account') return prisma.account.findUnique({ where: { id }, select: { id: true, region: true } });
  if (kind === 'activity') return (await prisma.activity.findUnique({ where: { id }, select: { account: { select: { id: true, region: true } } } }))?.account ?? null;
  return (await prisma.quote.findUnique({ where: { id }, select: { account: { select: { id: true, region: true } } } }))?.account ?? null;
}

// The thing, if this person may see it (a store in their states, or a manager).
async function visible(req: any, res: any, kind: Kind, id: string): Promise<boolean> {
  if (!UUID.test(id)) { res.status(404).json({ error: `${KIND_NAME[kind]} not found` }); return false; }
  const account = await accountOf(kind, id);
  if (!account) { res.status(404).json({ error: `${KIND_NAME[kind]} not found` }); return false; }
  if (!(await canSeeAccount(req.rep!, account))) { res.status(403).json({ error: `This ${kind} is outside your states` }); return false; }
  return true;
}

const cleanBody = (v: unknown): { body?: string; error?: string } => {
  if (typeof v !== 'string' || !v.trim()) return { error: 'Write a remark first' };
  const body = v.trim();
  if (body.length > MAX_LENGTH) return { error: `A remark can be at most ${MAX_LENGTH} characters` };
  return { body };
};

remarksRouter.post('/summary', async (req, res) => {
  try {
    const { kind, ids } = req.body ?? {};
    if (!isKind(kind)) return res.status(400).json({ error: 'kind must be activity, account or order' });
    if (!Array.isArray(ids) || ids.length > MAX_IDS || !ids.every((i: unknown) => typeof i === 'string' && UUID.test(i))) {
      return res.status(400).json({ error: `Send up to ${MAX_IDS} ids` });
    }
    const isReady = await tableReady();
    if (!ids.length || !isReady) return res.json({ ready: isReady, summary: {} });
    // only things this person may see (the ids come from a list they already have, but are checked anyway)
    const terr = await territoryWhere(req.rep!);
    const allowed = (kind === 'activity' ? await prisma.activity.findMany({ where: { id: { in: ids }, account: terr }, select: { id: true } })
      : kind === 'account' ? await prisma.account.findMany({ where: { AND: [{ id: { in: ids } }, terr] }, select: { id: true } })
      : await prisma.quote.findMany({ where: { id: { in: ids }, account: terr }, select: { id: true } })).map(x => x.id);
    if (!allowed.length) return res.json({ ready: true, summary: {} });
    const rows = await prisma.$queryRaw<{ id: string; n: number; author: string; body: string; at: Date }[]>(Prisma.sql`
      select r.${col(kind)}::text as id, count(*)::int as n,
             (array_agg(r.author_name order by r.created_at desc))[1] as author, (array_agg(r.body order by r.created_at desc))[1] as body, max(r.created_at) as at
      from crm.remarks r where r.${col(kind)} = any(${allowed}::uuid[]) group by r.${col(kind)}`);
    res.json({ ready: true, summary: Object.fromEntries(rows.map(r => [r.id, { count: r.n, last: { author: r.author, body: r.body, at: r.at } }])) });
  } catch (e) {
    console.error('remarks summary failed:', (e as Error).message);
    res.status(500).json({ error: 'Could not load the remarks' });
  }
});

remarksRouter.get('/:kind/:id', async (req, res) => {
  try {
    const { kind, id } = req.params;
    if (!isKind(kind)) return res.status(404).json({ error: 'Not found' });
    if (!(await visible(req, res, kind, id))) return;
    if (!(await tableReady())) return res.json({ ready: false, remarks: [] });
    const rows = await prisma.$queryRaw<RemarkRow[]>(Prisma.sql`
      select id::text as id, rep_id::text as rep_id, author_name, body, created_at, updated_at
      from crm.remarks where ${col(kind)} = ${id}::uuid order by created_at asc, id asc`);
    res.json({ ready: true, remarks: rows.map(r => shape(r, req.rep!)) });
  } catch (e) {
    console.error('remarks list failed:', (e as Error).message);
    res.status(500).json({ error: 'Could not load the remarks' });
  }
});

remarksRouter.post('/:kind/:id', async (req, res) => {
  try {
    const { kind, id } = req.params;
    if (!isKind(kind)) return res.status(404).json({ error: 'Not found' });
    if (!(await visible(req, res, kind, id))) return;
    if (!(await tableReady())) return res.status(503).json({ error: NOT_SET_UP });
    const { body, error } = cleanBody(req.body?.body);
    if (error) return res.status(400).json({ error });
    const me = await prisma.rep.findUnique({ where: { id: req.rep!.id }, select: { name: true } });
    const [row] = await prisma.$queryRaw<RemarkRow[]>(Prisma.sql`
      insert into crm.remarks (${col(kind)}, rep_id, author_name, body)
      values (${id}::uuid, ${req.rep!.id}::uuid, ${me?.name || 'Unknown'}, ${body})
      returning id::text as id, rep_id::text as rep_id, author_name, body, created_at, updated_at`);
    res.status(201).json(shape(row, req.rep!));
  } catch (e) {
    console.error('add remark failed:', (e as Error).message);
    res.status(500).json({ error: 'Could not add the remark' });
  }
});

// A remark, if this person may see the thing it is on.
async function visibleRemark(req: any, res: any): Promise<ItemRow | null> {
  const id = req.params.remarkId;
  if (!UUID.test(id)) { res.status(404).json({ error: 'Remark not found' }); return null; }
  if (!(await tableReady())) { res.status(503).json({ error: NOT_SET_UP }); return null; }
  const [row] = await prisma.$queryRaw<ItemRow[]>`
    select id::text as id, rep_id::text as rep_id, author_name, body, created_at, updated_at,
           activity_id::text as activity_id, account_id::text as account_id, quote_id::text as quote_id
    from crm.remarks where id = ${id}::uuid`;
  if (!row) { res.status(404).json({ error: 'Remark not found' }); return null; }
  const kind: Kind = row.activity_id ? 'activity' : row.account_id ? 'account' : 'order';
  if (!(await visible(req, res, kind, (row.activity_id ?? row.account_id ?? row.quote_id)!))) return null;
  return row;
}

remarksRouter.patch('/item/:remarkId', async (req, res) => {
  try {
    const row = await visibleRemark(req, res);
    if (!row) return;
    if (row.rep_id !== req.rep!.id) return res.status(403).json({ error: 'You can only edit your own remarks' });
    const { body, error } = cleanBody(req.body?.body);
    if (error) return res.status(400).json({ error });
    if (body === row.body) return res.json(shape(row, req.rep!));   // nothing changed: not marked as edited
    const [updated] = await prisma.$queryRaw<RemarkRow[]>`
      update crm.remarks set body = ${body}, updated_at = now() where id = ${row.id}::uuid
      returning id::text as id, rep_id::text as rep_id, author_name, body, created_at, updated_at`;
    res.json(shape(updated, req.rep!));
  } catch (e) {
    console.error('edit remark failed:', (e as Error).message);
    res.status(500).json({ error: 'Could not save the remark' });
  }
});

remarksRouter.delete('/item/:remarkId', async (req, res) => {
  try {
    const row = await visibleRemark(req, res);
    if (!row) return;
    if (row.rep_id !== req.rep!.id && req.rep!.role !== 'manager') return res.status(403).json({ error: 'You can only delete your own remarks' });
    await prisma.$queryRaw`delete from crm.remarks where id = ${row.id}::uuid`;
    res.json({ ok: true });
  } catch (e) {
    console.error('delete remark failed:', (e as Error).message);
    res.status(500).json({ error: 'Could not delete the remark' });
  }
});