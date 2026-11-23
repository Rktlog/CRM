import { prisma } from './prisma';

// What happens to a trade show order after the rep confirms it: was it paid at the show (and how, and the customer's payment screenshot), and has
// the sales team dealt with it yet. One row per confirmed order, in crm.ts_handoffs (sql/tradeshow-handoffs.sql). This file only reads and writes
// that table; the rules (who may, what the amount is) are in tradeshow.ts. Nothing here touches DEAR.
export type Mode = 'later' | 'paid';
export type Method = 'bank' | 'card';
export type Handoff = { mode: Mode; method: Method | null; amount: number | null; hasProof: boolean; proofName: string | null; actionedAt: string | null; actionedBy: string | null; actionNote: string | null };
export const PROOF_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const PROOF_MAX_BYTES = 4 * 1024 * 1024;

export class HandoffInputError extends Error {}

/** The screenshot as the page sends it ({ name, mime, data } with the picture as base64). Checked here, never trusted. */
export function parseProof(p: any): { name: string; mime: string; data: Buffer } | null {
  if (p == null) return null;
  const mime = String(p.mime ?? '').toLowerCase();
  if (!PROOF_TYPES.includes(mime)) throw new HandoffInputError('The screenshot must be a photo or picture (JPEG, PNG or WebP).');
  const raw = typeof p.data === 'string' ? p.data.replace(/^data:[^,]*,/, '') : '';
  if (!raw || !/^[A-Za-z0-9+/=\s]+$/.test(raw)) throw new HandoffInputError('The screenshot did not come through. Try taking it again.');
  const data = Buffer.from(raw, 'base64');
  if (!data.length) throw new HandoffInputError('The screenshot is empty. Try taking it again.');
  if (data.length > PROOF_MAX_BYTES) throw new HandoffInputError('The screenshot is too big (4 MB at most).');
  // the first bytes must really be that kind of picture
  const ok = mime === 'image/jpeg' ? data[0] === 0xff && data[1] === 0xd8 : mime === 'image/png' ? data.subarray(0, 4).toString('hex') === '89504e47' : data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP';
  if (!ok) throw new HandoffInputError('That file is not the kind of picture it says it is.');
  const name = String(p.name ?? 'payment').replace(/[^\w.\- ]+/g, '_').slice(0, 80) || 'payment';
  return { name, mime, data };
}

const seen = new Map<string, { at: number; ok: boolean }>();
async function tableReady(name: 'crm.ts_handoffs' | 'crm.ts_show_stand'): Promise<boolean> {
  const c = seen.get(name);
  if (c && Date.now() - c.at < 60_000) return c.ok;
  let ok = false;
  try { const [r] = await prisma.$queryRaw<{ ok: boolean }[]>`select to_regclass(${name}) is not null as ok`; ok = !!r?.ok; } catch { ok = false; }
  seen.set(name, { at: Date.now(), ok });
  return ok;
}
/** Has sql/tradeshow-handoffs.sql been run? Asked at most once a minute. The payment step stays off until it has. */
export const handoffReady = () => tableReady('crm.ts_handoffs');
/** The same set-up step also makes the table for "range on the stand". */
export const standReady = () => tableReady('crm.ts_show_stand');
export const _forgetReady = () => seen.clear();

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
export async function getHandoff(orderId: string): Promise<Handoff | null> {
  if (!(await handoffReady())) return null;
  const [r] = await prisma.$queryRaw<any[]>`select mode, method, amount, proof is not null as has_proof, proof_name, actioned_at, actioned_by, action_note from crm.ts_handoffs where order_id = ${orderId}::uuid`;
  return r ? { mode: r.mode, method: r.method, amount: r.amount == null ? null : Number(r.amount), hasProof: r.has_proof, proofName: r.proof_name, actionedAt: iso(r.actioned_at), actionedBy: r.actioned_by, actionNote: r.action_note } : null;
}
/** The row the email is built from, with the picture itself. */
export async function getHandoffWithProof(orderId: string) {
  if (!(await handoffReady())) return null;
  const [r] = await prisma.$queryRaw<any[]>`select mode, method, amount, proof, proof_name, proof_mime from crm.ts_handoffs where order_id = ${orderId}::uuid`;
  return r ? { mode: r.mode as Mode, method: r.method as Method | null, amount: r.amount == null ? null : Number(r.amount), proof: r.proof ? Buffer.from(r.proof) : null, proofName: r.proof_name as string | null, proofMime: r.proof_mime as string | null } : null;
}
export async function proofOf(orderId: string): Promise<{ data: Buffer; mime: string; name: string } | null> {
  if (!(await handoffReady())) return null;
  const [r] = await prisma.$queryRaw<any[]>`select proof, proof_mime, proof_name from crm.ts_handoffs where order_id = ${orderId}::uuid and proof is not null`;
  return r ? { data: Buffer.from(r.proof), mime: r.proof_mime, name: r.proof_name ?? 'payment' } : null;
}

/** Saves what the rep chose for a draft order. `keepProof` leaves the picture already saved when no new one is sent. */
export async function putHandoff(orderId: string, h: { mode: Mode; method: Method | null; amount: number | null; proof: { name: string; mime: string; data: Buffer } | null; keepProof: boolean }) {
  if (h.mode === 'later') {
    await prisma.$queryRaw`insert into crm.ts_handoffs (order_id, mode) values (${orderId}::uuid, 'later')
      on conflict (order_id) do update set mode = 'later', method = null, amount = null, proof = null, proof_name = null, proof_mime = null, updated_at = now()`;
    return;
  }
  if (h.proof) {
    await prisma.$queryRaw`insert into crm.ts_handoffs (order_id, mode, method, amount, proof, proof_name, proof_mime) values (${orderId}::uuid, 'paid', ${h.method}, ${h.amount}, ${h.proof.data}::bytea, ${h.proof.name}, ${h.proof.mime})
      on conflict (order_id) do update set mode = 'paid', method = ${h.method}, amount = ${h.amount}, proof = ${h.proof.data}::bytea, proof_name = ${h.proof.name}, proof_mime = ${h.proof.mime}, updated_at = now()`;
  } else if (h.keepProof) {
    const n = await prisma.$executeRaw`update crm.ts_handoffs set mode = 'paid', method = ${h.method}, amount = ${h.amount}, updated_at = now() where order_id = ${orderId}::uuid and proof is not null`;
    if (!n) throw new HandoffInputError('Add the payment screenshot.');
  } else throw new HandoffInputError('Add the payment screenshot.');
}
/** The total can move after the screenshot is taken (an edit before confirming), so confirming writes the final amount. */
export async function setAmount(orderId: string, amount: number) {
  await prisma.$queryRaw`update crm.ts_handoffs set amount = ${amount}, updated_at = now() where order_id = ${orderId}::uuid and mode = 'paid'`;
}
export async function setActioned(orderId: string, repId: string, done: boolean, note: string | null) {
  const n = done
    ? await prisma.$executeRaw`update crm.ts_handoffs set actioned_at = now(), actioned_by = ${repId}::uuid, action_note = ${note} where order_id = ${orderId}::uuid`
    : await prisma.$executeRaw`update crm.ts_handoffs set actioned_at = null, actioned_by = null, action_note = null where order_id = ${orderId}::uuid`;
  return n > 0;
}

// ---------- range on the stand: the brands that are physically at a show ----------
export async function getStandBrands(showId: string): Promise<string[]> {
  if (!(await standReady())) return [];
  const rows = await prisma.$queryRaw<{ brand: string }[]>`select brand from crm.ts_show_stand where show_id = ${showId}::uuid order by brand`;
  return rows.map(r => r.brand);
}
/** Replaces the show's list in one go: the brands ticked now. */
export async function putStandBrands(showId: string, brands: string[]) {
  await prisma.$transaction([
    prisma.$executeRaw`delete from crm.ts_show_stand where show_id = ${showId}::uuid`,
    ...(brands.length ? [prisma.$executeRaw`insert into crm.ts_show_stand (show_id, brand) select ${showId}::uuid, b from unnest(${brands}::text[]) as b on conflict do nothing`] : []),
  ]);
}
export async function allBrands(): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ brand: string }[]>`select distinct brand from crm.products where brand is not null and btrim(brand) <> '' and coalesce(status, '') not in ('Deprecated') order by brand`;
  return rows.map(r => r.brand);
}
