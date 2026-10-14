import crypto from 'crypto';
import { prisma } from './prisma';
import { calendarConfigured, connectionOf, createEvent, updateEvent, deleteEvent, CalendarEvent } from './googleCalendar';

// Keeps a rep's Google Calendar in line with their Planner for the next 30
// days. Rather than hooking every way a task can change (scheduling,
// dragging, completing, auto-planning, unfinished tasks rolling over), it
// compares what the calendar should show with what it last sent, and only
// creates, updates or deletes the differences. Safe to run any number of times.
//
//   - each visit: its own all-day event, store address as the location
//   - calls: one all-day event per day listing them, so the calendar isn't buried
//   - all marked "free", so they don't block availability; done items get ✓

const DAYS_AHEAD = 30;
const APP_URL = (process.env.APP_URL
  ?? (process.env.ALLOWED_ORIGINS ?? '').split(',').map(s => s.trim()).find(o => o && !o.includes('localhost'))
  ?? '').replace(/\/$/, '');

const melbourneDate = (offsetDays = 0) => {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne' }).format(d); // YYYY-MM-DD
};
const nextDay = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};
const hash = (ev: CalendarEvent) => crypto.createHash('sha1').update(JSON.stringify(ev)).digest('hex');
const link = (accountId: string) => (APP_URL ? `${APP_URL}/accounts/${accountId}` : '');

export async function syncRepCalendar(repId: string) {
  const rep = await prisma.rep.findUnique({ where: { id: repId }, select: { id: true, calendarSync: true } });
  if (!calendarConfigured()) return { skipped: 'Google Calendar is not set up on the server yet' };
  if (!rep?.calendarSync) return { skipped: 'Calendar sync is off for this rep' };
  // The rep has to have connected their own Google Calendar, and Google has to still accept it.
  const conn = await connectionOf(repId);
  if (!conn) return { skipped: 'Google Calendar is not connected. Press Connect Google Calendar in Settings.' };
  if (conn.status === 'needs_reconnect') return { skipped: 'Google Calendar needs reconnecting. Press Connect Google Calendar again in Settings.' };

  try {
    const from = melbourneDate(-1);
    const to = melbourneDate(DAYS_AHEAD);
    const tasks = await prisma.task.findMany({
      where: { repId, scheduledDate: { gte: new Date(from), lte: new Date(to) } },
      include: { account: { select: { id: true, name: true, address: true, phone: true, contactName: true } } },
      orderBy: { createdAt: 'asc' },
    });

    // What the calendar should show.
    const desired = new Map<string, { date: string; ev: CalendarEvent }>();
    const callsByDay = new Map<string, typeof tasks>();
    for (const t of tasks) {
      const date = t.scheduledDate.toISOString().slice(0, 10);
      if (t.type === 'visit') {
        const a = t.account;
        const lines = [
          a.contactName ? `Contact: ${a.contactName}` : '',
          a.phone ? `Phone: ${a.phone}` : '',
          t.note ? `Note: ${t.note}` : '',
          link(a.id) ? `Open in the CRM: ${link(a.id)}` : '',
        ].filter(Boolean);
        desired.set(`task:${t.id}`, {
          date,
          ev: {
            summary: `${t.completed ? '✓ ' : ''}Visit: ${a.name}`,
            description: lines.join('\n'),
            location: a.address ?? undefined,
            start: { date }, end: { date: nextDay(date) },
            transparency: 'transparent',
            colorId: t.completed ? '8' : '10', // grey when done, green to do
            extendedProperties: { private: { rhinoCrm: '1' } },
            ...(link(a.id) ? { source: { title: 'Rhino CRM', url: link(a.id) } } : {}),
          },
        });
      } else {
        callsByDay.set(date, [...(callsByDay.get(date) ?? []), t]);
      }
    }
    for (const [date, calls] of callsByDay) {
      const done = calls.filter(c => c.completed).length;
      const open = calls.length - done;
      const lines = calls.map(c =>
        `${c.completed ? '✓' : '•'} ${c.account.name}${c.account.phone ? `, ${c.account.phone}` : ''}${c.note ? ` (${c.note})` : ''}`);
      if (APP_URL) lines.push('', `Planner: ${APP_URL}/planner`);
      desired.set(`day:${date}`, {
        date,
        ev: {
          summary: open ? `📞 Calls: ${open} to do${done ? `, ${done} done` : ''}` : `📞 Calls: all ${done} done ✓`,
          description: lines.join('\n'),
          start: { date }, end: { date: nextDay(date) },
          transparency: 'transparent',
          colorId: open ? '9' : '8',
          extendedProperties: { private: { rhinoCrm: '1' } },
        },
      });
    }

    // What was sent before, inside the same window.
    const stored = await prisma.$queryRaw<{ key: string; google_event_id: string; hash: string | null }[]>`
      select key, google_event_id, hash from crm.calendar_events
      where rep_id = ${repId}::uuid and event_date between ${from}::date and ${to}::date`;
    const storedByKey = new Map(stored.map(s => [s.key, s]));

    let created = 0, updated = 0, deleted = 0;
    for (const [key, { date, ev }] of desired) {
      const h = hash(ev);
      const prev = storedByKey.get(key);
      if (prev && prev.hash === h) continue;
      let eventId = prev?.google_event_id;
      if (eventId) {
        try {
          await updateEvent(repId, eventId, ev);
          updated++;
        } catch (e: any) {
          if (e.status !== 404 && e.status !== 410) throw e;
          eventId = undefined; // deleted in Google: make it again
        }
      }
      if (!eventId) {
        eventId = (await createEvent(repId, ev)).id as string;
        created++;
      }
      await prisma.$executeRaw`
        insert into crm.calendar_events (rep_id, key, event_date, google_event_id, hash, updated_at)
        values (${repId}::uuid, ${key}, ${date}::date, ${eventId}, ${h}, now())
        on conflict (rep_id, key) do update set
          event_date = excluded.event_date, google_event_id = excluded.google_event_id,
          hash = excluded.hash, updated_at = now()`;
    }
    for (const s of stored) {
      if (desired.has(s.key)) continue;
      await deleteEvent(repId, s.google_event_id);
      await prisma.$executeRaw`delete from crm.calendar_events where rep_id = ${repId}::uuid and key = ${s.key}`;
      deleted++;
    }

    await prisma.$executeRaw`update crm.reps set calendar_synced_at = now(), calendar_error = null where id = ${repId}::uuid`;
    return { created, updated, deleted };
  } catch (e: any) {
    const message = String(e?.message ?? e).slice(0, 500);
    await prisma.$executeRaw`update crm.reps set calendar_error = ${message} where id = ${repId}::uuid`;
    throw e;
  }
}

// Removes every event the CRM put in a rep's calendar (when they turn it off).
export async function clearRepCalendar(repId: string) {
  const rows = await prisma.$queryRaw<{ key: string; google_event_id: string }[]>`
    select key, google_event_id from crm.calendar_events where rep_id = ${repId}::uuid`;
  // Only possible while Google still accepts their sign-in; the CRM's own record is cleared either way.
  const conn = calendarConfigured() ? await connectionOf(repId) : null;
  if (conn && conn.status === 'ok') {
    for (const r of rows) await deleteEvent(repId, r.google_event_id).catch(() => {});
  }
  await prisma.$executeRaw`delete from crm.calendar_events where rep_id = ${repId}::uuid`;
}

// After a Planner change: sync shortly after, once, even if several changes
// arrive together. Never blocks or fails the change itself.
const pending = new Map<string, NodeJS.Timeout>();
const running = new Set<string>();
export function syncSoon(repId: string) {
  if (!calendarConfigured()) return;
  clearTimeout(pending.get(repId));
  pending.set(repId, setTimeout(async () => {
    pending.delete(repId);
    if (running.has(repId)) { syncSoon(repId); return; }
    running.add(repId);
    try { await syncRepCalendar(repId); } catch (e) { console.error('Calendar sync failed', repId, e); }
    finally { running.delete(repId); }
  }, 3000));
}