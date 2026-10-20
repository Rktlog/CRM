import { useEffect, useState } from 'react';
import { apiGet } from '../lib/api';
import { addDays, fromISO, localISO } from '../lib/dates';

// The person's own Google Calendar events in the Planner (read only; from /calendar/events). Events the CRM itself put in Google
// (visits and calls) are already left out by the server, since the Planner shows those.
export const GOOGLE_BLUE = '#4285f4';

export type GEvent = { id: string; title: string; allDay: boolean; start: string; end: string; location: string | null; link: string | null };
export type GState = { loading: boolean; connected: boolean; hidden: boolean; error: string | null; events: GEvent[] };

export function useGoogleEvents(from: string, to: string): GState {
  const [s, setS] = useState<GState>({ loading: true, connected: false, hidden: false, error: null, events: [] });
  useEffect(() => {
    let live = true;
    setS(x => ({ ...x, loading: true }));
    apiGet(`/calendar/events?from=${from}&to=${to}`)
      .then(d => { if (live) setS({ loading: false, connected: !!d.connected, hidden: !!d.hidden, error: d.error ?? null, events: d.events ?? [] }); })
      // Whatever goes wrong here must never take the rest of the Planner with it: say so, and carry on.
      .catch(e => { if (live) setS({ loading: false, connected: true, hidden: false, error: e?.message ?? 'Could not read Google Calendar', events: [] }); });
    return () => { live = false; };
  }, [from, to]);
  return s;
}

// The days (YYYY-MM-DD, the person's own) an event falls on. An all-day event ends on the day AFTER its last day in Google.
export function eventDays(e: GEvent): string[] {
  try {
    const out: string[] = [];
    if (e.allDay) {
      let d = fromISO(e.start.slice(0, 10));
      const end = fromISO((e.end || e.start).slice(0, 10));
      for (let i = 0; i < 31 && d < end; i++) { out.push(localISO(d)); d = addDays(d, 1); }
      return out.length ? out : [e.start.slice(0, 10)];
    }
    const s = new Date(e.start);
    const t = new Date(e.end || e.start);
    if (Number.isNaN(s.getTime())) return [];
    const last = localISO(new Date(Math.max(s.getTime(), t.getTime() - 60000)));   // an event ending at midnight does not spill onto the next day
    let d = new Date(s.getFullYear(), s.getMonth(), s.getDate());
    for (let i = 0; i < 14; i++) { const iso = localISO(d); out.push(iso); if (iso >= last) break; d = addDays(d, 1); }
    return out;
  } catch { return []; }
}

export function eventsByDay(events: GEvent[]): Map<string, GEvent[]> {
  const map = new Map<string, GEvent[]>();
  for (const e of events) for (const day of eventDays(e)) { const l = map.get(day) ?? []; l.push(e); map.set(day, l); }
  for (const l of map.values()) l.sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start));   // all day first, then by time
  return map;
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' }).replace(' ', '').toLowerCase();
export const eventTime = (e: GEvent) => (e.allDay ? 'All day' : `${clock(e.start)} to ${clock(e.end || e.start)}`);
export const eventChip = (e: GEvent) => (e.allDay ? e.title : `${clock(e.start)} ${e.title}`);

// Says why nothing is showing, instead of showing nothing.
export function GoogleNotice({ state }: { state: GState }) {
  if (state.loading) return null;
  if (state.error) {
    const setup = /does not exist|calendar_/i.test(state.error);
    return <div className="empty-state" role="status">Your Google Calendar could not be shown: {setup ? 'the calendar settings are not set up in the database yet (run calendar-setup.sql).' : state.error}</div>;
  }
  if (state.connected && state.hidden) return <div className="empty-state" role="status">Your Google events are hidden. Turn on "Show my Google Calendar in the Planner" in Settings.</div>;
  return null;
}

function EventRows({ events }: { events: GEvent[] }) {
  return (
    <div className="manifest">
      {events.map(e => (
        <div className="m-row" key={e.id} style={{ gridTemplateColumns: '130px 1fr', cursor: 'default' }}>
          <div className="num">{eventTime(e)}</div>
          <div>
            {e.link ? <a href={e.link} target="_blank" rel="noreferrer" className="acct-name">{e.title}</a> : <span className="acct-name">{e.title}</span>}
            {e.location && <div className="acct-region">{e.location}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

// The selected day in the Calendar view.
export function GoogleDayList({ events, state }: { events: GEvent[]; state: GState }) {
  if (state.loading || !state.connected || state.hidden || state.error) return null;
  return (
    <div style={{ marginTop: 14 }}>
      <div className="acct-region" style={{ marginBottom: 6 }}><i className="cal-dot" style={{ background: GOOGLE_BLUE }} /> In your Google Calendar</div>
      {events.length ? <EventRows events={events} /> : <div className="empty-state">Nothing in your Google Calendar.</div>}
    </div>
  );
}

// Today's plan: what is in their Google Calendar today.
export function TodayInGoogle() {
  const today = localISO();
  const g = useGoogleEvents(today, today);
  if (g.loading || !g.connected) return null;   // not connected: Settings has the button; no need to nag here
  if (g.error || g.hidden) return <div className="section"><GoogleNotice state={g} /></div>;
  const events = eventsByDay(g.events).get(today) ?? [];
  return (
    <div className="section" id="google-today">
      <div className="panel-title">Today in your Google Calendar {events.length > 0 && <span className="plan-count">{events.length}</span>}</div>
      {events.length ? <EventRows events={events} /> : <div className="empty-state">Nothing in your Google Calendar today.</div>}
    </div>
  );
}