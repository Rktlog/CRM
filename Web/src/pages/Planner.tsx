import { DragEvent, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiGet, apiPatch, apiPost } from '../lib/api';
import { ACTIVITY_LABEL } from '../lib/activityLabels';
import AddTaskModal from '../components/AddTaskModal';
import { addDays, fromISO, localISO, startOfWeek } from '../lib/dates';
import { STAGE_LABELS, fmtMoney, fmtDateWithYear } from '../lib/types';

type TaskAccount = { id: string; name: string; region: string; phone: string | null };
type PlanAccount = TaskAccount & {
  email: string | null; contactName: string | null; lastOrderAt: string | null;
  spend365: number; stage: string; type: 'prospect' | 'customer';
  lastActivity: { type: string; note: string; occurredAt: string } | null;
};
type PlanTask = {
  id: string; type: 'cold_call' | 'visit'; fixed: boolean; reason: 'new_lead' | 'inactive' | null;
  completed: boolean; note: string | null; account: PlanAccount;
};
type TodayData = { tasks: PlanTask[]; limit: number; counts: { newLeads: number; inactive: number }; regions: string[] };
type CalTask = {
  id: string; date: string; type: 'cold_call' | 'visit'; fixed: boolean;
  completed: boolean; note: string | null; account: TaskAccount;
};
type View = 'today' | 'calendar';

const VIEW_KEY = 'planner-view';
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const CHIPS_PER_DAY = 3;

export default function Planner() {
  const [view, setView] = useState<View>(() => {
    try { return localStorage.getItem(VIEW_KEY) === 'calendar' ? 'calendar' : 'today'; } catch { return 'today'; }
  });
  const [addDate, setAddDate] = useState<string | null>(null);
  // Bumped after any change, so whichever view is showing reloads.
  const [refresh, setRefresh] = useState(0);

  function switchView(v: View) {
    setView(v);
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* private mode: just don't remember */ }
  }

  return (
    <>
      <div className="planner-head">
        <h1>{view === 'today' ? "Today's plan" : 'Calendar'}</h1>
        <div className="planner-actions">
          <div className="seg">
            <button className={view === 'today' ? 'on' : ''} onClick={() => switchView('today')}>Today</button>
            <button className={view === 'calendar' ? 'on' : ''} onClick={() => switchView('calendar')}>Calendar</button>
          </div>
          <button className="btn" onClick={() => setAddDate(localISO())}>+ Schedule task</button>
        </div>
      </div>

      {view === 'today'
        ? <TodayView refresh={refresh} onChanged={() => setRefresh(r => r + 1)} />
        : <CalendarView refresh={refresh} onChanged={() => setRefresh(r => r + 1)} onSchedule={setAddDate} />}

      {addDate && (
        <AddTaskModal
          initialDate={addDate}
          onCreated={() => setRefresh(r => r + 1)}
          onClose={() => setAddDate(null)}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Today: the day's list. The planner fills it automatically each morning
// from the numbers in Settings. Click a row to see the account and log
// what happened; Update crosses it off (it stays on the list). Anything
// not done moves to the next day.
// ---------------------------------------------------------------------------
const SECTIONS: { key: string; title: string; match: (t: PlanTask) => boolean }[] = [
  { key: 'visits', title: 'F2F visits', match: t => t.type === 'visit' },
  { key: 'calls', title: 'Scheduled phone calls', match: t => t.type === 'cold_call' && !t.reason },
  { key: 'new', title: 'New leads', match: t => t.reason === 'new_lead' },
  { key: 'inactive', title: 'Overdue customers', match: t => t.reason === 'inactive' },
];

function TodayView({ refresh, onChanged }: { refresh: number; onChanged: () => void }) {
  const [data, setData] = useState<TodayData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const today = localISO();

  useEffect(() => {
    apiGet(`/tasks/today?date=${today}`).then(setData).catch(e => setError(e.message));
  }, [refresh]);

  if (error) return <div className="empty-state">Couldn't load planner: {error}</div>;
  if (!data) return <div className="empty-state">Planning your day…</div>;

  const done = data.tasks.filter(t => t.completed).length;

  return (
    <>
      <div className="plan-summary">
        <span><b>{done}</b> of {data.tasks.length} done today</span>
        <span className="plan-summary-note">
          {data.regions.length
            ? `Auto-planned from ${data.regions.join(', ')}: 5 new leads and 5 inactive customers at a time. Finish one and the next fills in. Anything not done moves to the next day.`
            : 'No states assigned yet, so nothing is auto-planned. Ask a manager to assign you in Settings.'}
        </span>
      </div>

      {SECTIONS.map(section => {
        const tasks = data.tasks.filter(section.match);
        if (!tasks.length) return null;
        const sectionDone = tasks.filter(t => t.completed).length;
        return (
          <div className="section" key={section.key}>
            <div className="panel-title">
              {section.title} <span className="plan-count">{sectionDone} of {tasks.length} done</span>
            </div>
            <div className="manifest">
              {tasks.map(t => (
                <PlanRow
                  key={t.id}
                  task={t}
                  open={openId === t.id}
                  onToggle={() => setOpenId(openId === t.id ? null : t.id)}
                  onDone={() => { setOpenId(null); onChanged(); }}
                />
              ))}
            </div>
          </div>
        );
      })}

      {data.tasks.length === 0 && (
        <div className="empty-state">Nothing planned today. Use "+ Schedule task" to add one.</div>
      )}
    </>
  );
}

function PlanRow({ task: t, open, onToggle, onDone }: {
  task: PlanTask; open: boolean; onToggle: () => void; onDone: () => void;
}) {
  const [logType, setLogType] = useState<'call' | 'email' | 'visit'>(t.type === 'visit' ? 'visit' : 'call');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const a = t.account;

  // Logs what happened (if anything was written), then crosses the task
  // off. Logging goes through the normal activity route, so it also
  // moves a new lead to "approached" and picks up "follow up in 3 weeks".
  async function update() {
    setSaving(true);
    setError(null);
    try {
      if (note.trim()) await apiPost('/activity', { accountId: a.id, type: logType, note: note.trim() });
      await apiPatch(`/tasks/${t.id}`, { completed: true });
      setNote('');
      onDone();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function undo() {
    setSaving(true);
    try {
      await apiPatch(`/tasks/${t.id}`, { completed: false });
      onDone();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={'plan-row' + (t.completed ? ' done' : '') + (open ? ' open' : '')}>
      <div className="plan-row-head" onClick={onToggle} aria-expanded={open}>
        <span className="plan-check">{t.completed ? '✓' : ''}</span>
        <div className="plan-row-main">
          <div className="acct-name">{a.name}</div>
          <div className="acct-region">
            {a.region}{a.contactName ? `, ${a.contactName}` : ''}{t.note ? `, ${t.note}` : ''}
          </div>
        </div>
        <div className="plan-row-phone" onClick={e => e.stopPropagation()}>
          {a.phone ? <a href={`tel:${a.phone}`} className="order-link">{a.phone}</a> : <span className="acct-region">No phone</span>}
        </div>
        <span className="plan-caret">{open ? '▾' : '▸'}</span>
      </div>

      {open && (
        <div className="plan-row-body">
          <div className="plan-facts">
            <div><span className="k">Stage</span>{STAGE_LABELS[a.stage as keyof typeof STAGE_LABELS] ?? a.stage}</div>
            <div><span className="k">Last order</span>{a.lastOrderAt ? fmtDateWithYear(a.lastOrderAt) : 'Never'}</div>
            <div><span className="k">Spend, 12 months</span>{fmtMoney(a.spend365)}</div>
            <div><span className="k">Email</span>{a.email ? <a href={`mailto:${a.email}`} className="order-link">{a.email}</a> : '—'}</div>
            <div className="wide">
              <span className="k">Last contact</span>
              {a.lastActivity ? `${fmtDateWithYear(a.lastActivity.occurredAt)} (${ACTIVITY_LABEL[a.lastActivity.type as keyof typeof ACTIVITY_LABEL] ?? a.lastActivity.type}): ${a.lastActivity.note}` : 'No contact logged yet'}
            </div>
          </div>

          {t.completed ? (
            <div className="plan-actions">
              <span className="acct-region">Done today.</span>
              <button className="btn secondary" onClick={undo} disabled={saving}>Undo</button>
              <Link to={`/accounts/${a.id}`} className="order-link">Open account</Link>
            </div>
          ) : (
            <>
              <div className="plan-log-types">
                {(['call', 'email', 'visit'] as const).map(k => (
                  <button key={k} type="button" className={'btn secondary' + (logType === k ? ' on' : '')} onClick={() => setLogType(k)}>
                    {ACTIVITY_LABEL[k]}
                  </button>
                ))}
              </div>
              <textarea
                value={note}
                onChange={e => setNote(e.target.value)}
                rows={2}
                placeholder="What happened? (optional, e.g. 'Interested, follow up in 2 weeks')"
              />
              {error && <div className="save-msg err">{error}</div>}
              <div className="plan-actions">
                <button className="btn" onClick={update} disabled={saving}>{saving ? 'Saving…' : 'Update'}</button>
                <Link to={`/accounts/${a.id}`} className="order-link">Open account</Link>
                <span className="acct-region">Not done today? Leave it and it moves to tomorrow.</span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Calendar: a month of visits and calls. Click a day for its details;
// drag a task onto another day to move it.
// ---------------------------------------------------------------------------
function CalendarView({ refresh, onChanged, onSchedule }: {
  refresh: number; onChanged: () => void; onSchedule: (date: string) => void;
}) {
  const [month, setMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const [tasks, setTasks] = useState<CalTask[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(localISO());
  const [dragOver, setDragOver] = useState<string | null>(null);
  const today = localISO();

  // Six full weeks, Monday first, so the grid never changes height.
  const days = useMemo(() => {
    const start = startOfWeek(month);
    return Array.from({ length: 42 }, (_, i) => addDays(start, i));
  }, [month]);

  useEffect(() => {
    setError(null);
    apiGet(`/tasks/range?from=${localISO(days[0])}&to=${localISO(days[41])}`)
      .then(setTasks)
      .catch(e => setError(e.message));
  }, [days, refresh]);

  const byDay = useMemo(() => {
    const map = new Map<string, CalTask[]>();
    for (const t of tasks ?? []) {
      const list = map.get(t.date) ?? [];
      list.push(t);
      map.set(t.date, list);
    }
    return map;
  }, [tasks]);

  function goToMonth(offset: number) {
    setMonth(m => new Date(m.getFullYear(), m.getMonth() + offset, 1));
  }

  function goToday() {
    const d = new Date();
    setMonth(new Date(d.getFullYear(), d.getMonth(), 1));
    setSelected(localISO(d));
  }

  async function move(taskId: string, date: string) {
    const task = tasks?.find(t => t.id === taskId);
    if (!task || task.date === date) return;
    // Move it on screen straight away; the reload confirms it.
    setTasks(prev => prev?.map(t => (t.id === taskId ? { ...t, date } : t)) ?? null);
    try {
      await apiPatch(`/tasks/${taskId}`, { scheduledDate: date });
    } finally {
      onChanged();
    }
  }

  async function toggleDone(t: CalTask) {
    setTasks(prev => prev?.map(x => (x.id === t.id ? { ...x, completed: !x.completed } : x)) ?? null);
    try {
      await apiPatch(`/tasks/${t.id}`, { completed: !t.completed });
    } finally {
      onChanged();
    }
  }

  function onDrop(e: DragEvent, date: string) {
    e.preventDefault();
    setDragOver(null);
    const id = e.dataTransfer.getData('text/plain');
    if (id) move(id, date);
  }

  const selectedTasks = byDay.get(selected) ?? [];
  const monthLabel = month.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });

  return (
    <>
      <div className="cal-toolbar">
        <button className="btn secondary" onClick={() => goToMonth(-1)} aria-label="Previous month">‹</button>
        <button className="btn secondary" onClick={goToday}>Today</button>
        <button className="btn secondary" onClick={() => goToMonth(1)} aria-label="Next month">›</button>
        <div className="cal-month">{monthLabel}</div>
        <div className="cal-legend">
          <span><i className="cal-dot visit" /> F2F visit</span>
          <span><i className="cal-dot cold_call" /> Phone</span>
        </div>
      </div>

      {error && <div className="empty-state">Couldn't load the calendar: {error}</div>}

      <div className="cal-grid">
        {WEEKDAYS.map(d => <div className="cal-weekday" key={d}>{d}</div>)}
        {days.map(d => {
          const iso = localISO(d);
          const dayTasks = byDay.get(iso) ?? [];
          const open = dayTasks.filter(t => !t.completed);
          const classes = [
            'cal-day',
            d.getMonth() !== month.getMonth() ? 'other' : '',
            iso === today ? 'today' : '',
            iso === selected ? 'selected' : '',
            iso === dragOver ? 'drop' : '',
          ].filter(Boolean).join(' ');
          return (
            <div
              key={iso}
              className={classes}
              onClick={() => setSelected(iso)}
              onDoubleClick={() => onSchedule(iso)}
              onDragOver={e => { e.preventDefault(); setDragOver(iso); }}
              onDragLeave={() => setDragOver(cur => (cur === iso ? null : cur))}
              onDrop={e => onDrop(e, iso)}
            >
              <div className="cal-date">
                <span>{d.getDate()}</span>
                {open.length > 0 && <span className="cal-count">{open.length}</span>}
              </div>
              {dayTasks.slice(0, CHIPS_PER_DAY).map(t => (
                <div
                  key={t.id}
                  className={`cal-chip ${t.type}${t.completed ? ' done' : ''}`}
                  draggable={!t.completed}
                  onDragStart={e => e.dataTransfer.setData('text/plain', t.id)}
                  title={`${t.type === 'visit' ? 'F2F visit' : 'Phone'}: ${t.account.name}${t.note ? `, ${t.note}` : ''}`}
                >
                  {t.account.name}
                </div>
              ))}
              {dayTasks.length > CHIPS_PER_DAY && (
                <div className="cal-more">+{dayTasks.length - CHIPS_PER_DAY} more</div>
              )}
            </div>
          );
        })}
      </div>
      <div className="cal-hint">Click a day to see its tasks. Double-click to schedule on that day. Drag a task to move it.</div>

      {/* ---- Details for the selected day ---- */}
      <div className="section cal-detail">
        <div className="cal-detail-head">
          <div className="panel-title" style={{ marginBottom: 0 }}>
            {fromISO(selected).toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' })}
            {selected === today && ' (today)'}
          </div>
          <button className="btn secondary" onClick={() => onSchedule(selected)}>+ Schedule on this day</button>
        </div>

        {!tasks ? (
          <div className="empty-state">Loading…</div>
        ) : selectedTasks.length === 0 ? (
          <div className="empty-state">Nothing scheduled.</div>
        ) : (
          <div className="manifest">
            {selectedTasks.map(t => (
              <div className={'m-row' + (t.completed ? ' cal-row-done' : '')} key={t.id} style={{ gridTemplateColumns: '30px 70px 1.6fr 1fr 150px', cursor: 'default' }}>
                <input type="checkbox" checked={t.completed} onChange={() => toggleDone(t)} aria-label="Done" />
                <div><span className={`pill ${t.type === 'visit' ? 'teal' : 'amber'}`}>{t.type === 'visit' ? 'F2F visit' : 'Phone'}</span></div>
                <div>
                  <Link to={`/accounts/${t.account.id}`} className="acct-name">{t.account.name}</Link>
                  <div className="acct-region">{t.account.region}{t.note ? `, ${t.note}` : ''}</div>
                </div>
                <div>{t.account.phone ? <a href={`tel:${t.account.phone}`} className="order-link">{t.account.phone}</a> : '—'}</div>
                <div>
                  {!t.completed && (
                    <input
                      type="date"
                      value={t.date}
                      onChange={e => e.target.value && move(t.id, e.target.value)}
                      aria-label="Move to date"
                    />
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}