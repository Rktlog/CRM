import { prisma } from './prisma';
import { territoryWhere } from './territory';
import { effectsOf } from './activityLog';
import { parseFollowUp } from './followup';
import { melDay } from './receivables';

// Bulk logging for the assistant. It never saves on its own: log_activity (the tool) only builds a PREVIEW, which the chat shows as a table with a
// Confirm button. Pressing Confirm sends the entries to POST /ai/log/confirm, which checks every one again and saves them as the signed-in person.
// Nothing here deletes or edits anything. The rules are the same as the Activity Log page's: only accounts the person can see, no future dates,
// and a new lead becomes "approached" / a follow-up phrase sets the reminder (effectsOf in activityLog.ts, shared with that page).
export const MAX_ENTRIES = 100;
export const LOG_TYPES = ['call', 'email', 'visit', 'remark'] as const;
export type LogType = typeof LOG_TYPES[number];
export type LogEntry = { accountId: string; type: LogType; date: string; note: string };
export type LogRow = LogEntry & { accountName: string; state: string; effects: string[]; status: 'ready' | 'duplicate' };
export type Choice = { id: string; name: string; state: string };
export type Problem = { name: string; reason: string; choices?: Choice[] };
export type LogProposal = { rows: LogRow[]; problems: Problem[] };
type Rep = { id: string; role: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const norm = (s: string) => s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;
// A day with no time of its own is saved at midday in Melbourne's day (02:00 UTC is 12:00 or 13:00 in Melbourne), so it stays on that day all year.
export const dayToDate = (day: string) => new Date(`${day}T02:00:00Z`);

export function entryProblem(e: { type?: unknown; date?: unknown; note?: unknown }, today = melDay()): string | null {
  if (!LOG_TYPES.includes(e.type as LogType)) return 'The type must be call, email, visit or remark';
  if (!isDay(e.date)) return 'The date must look like 2026-11-19';
  if (e.date > today) return "A log can't be dated in the future";
  if (e.date < '2015-01-01') return 'That date looks wrong';
  const note = typeof e.note === 'string' ? e.note.trim() : '';
  if (!note) return 'There is no note';
  if (note.length > 4000) return 'That note is too long (4000 letters at most)';
  return null;
}

// Turns what was asked for into a preview. `asked` come from the assistant (a customer name or an id) or, at Confirm time, are already ids.
export async function previewEntries(rep: Rep, asked: { customer?: string; accountId?: string; type?: unknown; date?: unknown; note?: unknown }[], today = melDay()): Promise<LogProposal> {
  const problems: Problem[] = [];
  if (!asked.length) return { rows: [], problems: [{ name: '(none)', reason: 'No entries were given' }] };
  if (asked.length > MAX_ENTRIES) return { rows: [], problems: [{ name: '(too many)', reason: `At most ${MAX_ENTRIES} entries at a time. Split the list.` }] };

  // All the accounts the person can see, in one query, matched by name here: a name like "Petals Network / Interflora" would never match a database
  // "contains" once punctuation differs, and one round trip is cheaper than one per name.
  const found = await prisma.account.findMany({
    where: await territoryWhere(rep),
    select: { id: true, name: true, region: true, stage: true },
    take: 20000,
  });
  const byId = new Map(found.map(a => [a.id, a]));

  const resolved: { e: typeof asked[number]; acc: typeof found[number]; type: LogType; date: string; note: string }[] = [];
  for (const e of asked) {
    const label = (e.customer ?? e.accountId ?? '').toString().trim() || '(no customer)';
    let acc = e.accountId && UUID.test(e.accountId) ? byId.get(e.accountId) : undefined;
    if (!acc) {
      const want = norm(e.customer ?? '');
      if (!want) { problems.push({ name: label, reason: 'No customer was given' }); continue; }
      const exact = found.filter(a => norm(a.name) === want);
      if (exact.length === 1) acc = exact[0];
      else {
        const near = exact.length > 1 ? exact : found.filter(a => norm(a.name).includes(want) || want.includes(norm(a.name))).slice(0, 5);
        problems.push(near.length
          ? { name: label, reason: exact.length > 1 ? 'More than one customer has exactly this name' : 'No exact match. Which of these?', choices: near.map(a => ({ id: a.id, name: a.name, state: a.region })) }
          : { name: label, reason: 'Not found among the customers you can see' });
        continue;
      }
    }
    const bad = entryProblem(e, today);
    if (bad) { problems.push({ name: acc.name, reason: bad }); continue; }
    resolved.push({ e, acc, type: e.type as LogType, date: e.date as string, note: String(e.note).trim() });
  }

  // Already logged: the same customer, the same type, the same Melbourne day. Also repeats inside this list.
  const existing = resolved.length ? await prisma.activity.findMany({
    where: { accountId: { in: [...new Set(resolved.map(r => r.acc.id))] }, occurredAt: { gte: new Date(Date.parse(resolved.reduce((m, r) => (r.date < m ? r.date : m), '9999-12-31') + 'T00:00:00Z') - 2 * 86400000), lte: new Date(Date.parse(resolved.reduce((m, r) => (r.date > m ? r.date : m), '0000-01-01') + 'T00:00:00Z') + 3 * 86400000) } },
    select: { accountId: true, type: true, occurredAt: true },
  }) : [];
  const seen = new Set(existing.map(x => `${x.accountId}|${x.type}|${melDay(x.occurredAt)}`));

  const rows: LogRow[] = resolved.map(r => {
    const key = `${r.acc.id}|${r.type}|${r.date}`;
    const dup = seen.has(key);
    seen.add(key);
    const fx = effectsOf({ id: r.acc.id, stage: r.acc.stage }, { type: r.type, note: r.note, occurredAt: dayToDate(r.date) });
    const effects = [...(fx.stage ? ['Moves the lead to "approached"'] : []), ...(fx.nextFollowUpAt ? [`Sets the next follow-up to ${melDay(fx.nextFollowUpAt)}`] : [])];
    return { accountId: r.acc.id, accountName: r.acc.name, state: r.acc.region, type: r.type, date: r.date, note: r.note, effects, status: dup ? 'duplicate' : 'ready' };
  });
  return { rows, problems };
}

export type SaveResult = { saved: number; skipped: { name: string; reason: string }[] };

// Saves what the person confirmed. Everything is checked again here (the page could have been out of date, or the request changed), and an entry is
// saved only if the person could log it on the Activity Log page too. One transaction: all the ready entries, or none.
export async function saveEntries(rep: Rep, entries: unknown): Promise<SaveResult> {
  if (!Array.isArray(entries) || !entries.length) throw new LogInputError('There is nothing to save');
  if (entries.length > MAX_ENTRIES) throw new LogInputError(`At most ${MAX_ENTRIES} entries at a time`);
  const asked = entries.map((e: any) => ({ accountId: typeof e?.accountId === 'string' ? e.accountId : undefined, type: e?.type, date: e?.date, note: e?.note }));
  if (asked.some(a => !a.accountId || !UUID.test(a.accountId))) throw new LogInputError('Every entry needs a customer');
  const p = await previewEntries(rep, asked);
  const skipped = [...p.problems.map(x => ({ name: x.name, reason: x.reason })), ...p.rows.filter(r => r.status === 'duplicate').map(r => ({ name: r.accountName, reason: `Already logged: a ${r.type} on ${r.date}` }))];
  const ready = p.rows.filter(r => r.status === 'ready');
  if (!ready.length) return { saved: 0, skipped };

  // Visibility is already enforced: previewEntries only finds accounts inside the person's territory (the same rule POST /activity applies, in one query
  // instead of one per account). The stage is read again here, as it is right now.
  const final = ready;
  const visible = new Map((await prisma.account.findMany({ where: { id: { in: [...new Set(final.map(r => r.accountId))] } }, select: { id: true, stage: true } })).map(a => [a.id, a]));

  // The effects, worked out in memory from the stage each account has right now, then written in a few statements (a round trip to the database is slow).
  const toApproach = new Set<string>(), followUps = new Map<string, Date>();
  for (const r of final) {
    const fx = effectsOf(visible.get(r.accountId)!, { type: r.type, note: r.note, occurredAt: dayToDate(r.date) });
    if (fx.stage) toApproach.add(r.accountId);
    if (fx.nextFollowUpAt) followUps.set(r.accountId, fx.nextFollowUpAt);   // a later entry for the same account wins, as saving them one by one would
  }
  await prisma.$transaction([
    prisma.activity.createMany({ data: final.map(r => ({ accountId: r.accountId, repId: rep.id, type: r.type, note: r.note, occurredAt: dayToDate(r.date) })) }),
    ...(toApproach.size ? [prisma.account.updateMany({ where: { id: { in: [...toApproach] }, stage: 'new_lead' }, data: { stage: 'approached' } })] : []),
    ...[...followUps].map(([id, at]) => prisma.account.update({ where: { id }, data: { nextFollowUpAt: at } })),
  ]);
  return { saved: final.length, skipped };
}

export class LogInputError extends Error {}

// What the assistant is told after it builds a preview. It never sees "saved".
export function previewSummary(p: LogProposal) {
  const ready = p.rows.filter(r => r.status === 'ready'), dup = p.rows.filter(r => r.status === 'duplicate');
  return {
    previewShownToPerson: true, savedNothingYet: true,
    ready: ready.length, alreadyLogged: dup.map(r => ({ customer: r.accountName, type: r.type, date: r.date })), problems: p.problems,
    leadsThatWouldMoveToApproached: ready.filter(r => r.effects.some(e => e.includes('approached'))).length,
    followUpsThatWouldBeSet: ready.filter(r => r.effects.some(e => e.includes('follow-up'))).length,
    note: 'A table with a Confirm button is shown in the chat. NOTHING is saved until the person presses Confirm. Do not say it is saved. Tell them how many are ready, how many were skipped and why, and ask them to check the table and press Confirm. For a customer that needs a pick, ask which one, then call log_activity again with the COMPLETE list (using accountId for the ones already settled).',
  };
}

export const _test = { norm, parseFollowUp };
