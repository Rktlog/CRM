import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { apiGet } from '../lib/api';
import { FOCUS_PATH, LIGHT_TEXT, addDaysTo, changeText, dayShort, msg, num, usePeriodParams, type CalendarItem, type Overview, type Row, type Stockists } from '../lib/mkt';
import { LightPill, PeriodPicker, WaitingGoals } from '../components/MktBits';

// The marketing dashboard (managers only), inside Marketing & Sales Support. One look at whether each initiative is hitting its goal.
// Stockists here are counted by their FIRST ORDER (the marketing way). The main dashboard and the sales tracker count at the first quote (Ellen's rules) and are not changed by this page.
const CARDS: { key: keyof Stockists; title: string; rule: string }[] = [
  { key: 'new', title: 'New stockists', rule: 'First ever order placed in the period' },
  { key: 'existing', title: 'Existing stockists', rule: 'Has purchased before and ordered within the last 12 months' },
  { key: 'reactivated', title: 'Reactivated stockists', rule: 'Ordered again after 12 or more months with no order' },
];
const KIND_COLOUR: Record<Row['focus'], CSSProperties> = {
  edm: { background: '#E3EDF7', color: '#1f4e79' }, event: { background: 'var(--teal-bg)', color: 'var(--teal)' }, instagram: { background: '#EEE6F7', color: '#5b3a8c' }, giveaway: { background: 'var(--amber-bg)', color: 'var(--amber)' },
};
const KIND_NAME: Record<Row['focus'], string> = { edm: 'EDM', event: 'Event', instagram: 'Instagram', giveaway: 'Giveaway' };

function Calendar({ from, to, items, today, query }: { from: string; to: string; items: CalendarItem[]; today: string; query: string }) {
  const first = new Date(`${from}T00:00:00Z`), back = (first.getUTCDay() + 6) % 7;   // weeks start on Monday
  const weeks: string[] = []; for (let d = addDaysTo(from, -back); d <= to && weeks.length < 26; d = addDaysTo(d, 7)) weeks.push(d);
  return (
    <div className="card" id="calendar">
      <h3>Calendar</h3>
      <div className="acct-region" style={{ marginBottom: 8, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        Every initiative, by week:
        {(Object.keys(KIND_NAME) as Row['focus'][]).map(k => <span key={k} style={{ ...KIND_COLOUR[k], padding: '1px 8px', borderRadius: 10, fontSize: 12 }}>{KIND_NAME[k]}</span>)}
        <span>Dashed: scheduled, not sent yet. Faded: finished.</span>
      </div>
      <div style={{ display: 'grid', gridAutoFlow: 'column', gridAutoColumns: 'minmax(150px, 1fr)', gap: 8, overflowX: 'auto', paddingBottom: 6 }} aria-label="Calendar strip">
        {weeks.map(w => {
          const end = addDaysTo(w, 6), here = items.filter(i => i.start <= end && i.end >= w);
          return (
            <div key={w} style={{ border: '1px solid var(--line)', borderRadius: 6, padding: 6, background: w <= today && today <= end ? 'var(--amber-bg)' : undefined, minHeight: 70 }}>
              <div className="acct-region" style={{ fontWeight: 600, marginBottom: 4 }}>{dayShort(w)} to {dayShort(end)}</div>
              {here.length === 0 && <div className="acct-region">Nothing</div>}
              {here.map((i, n) => (
                <Link key={`${i.kind}-${i.id ?? i.start}-${n}`} to={`/marketing-dashboard/${FOCUS_PATH[i.kind]}${query}`} title={`${KIND_NAME[i.kind]}: ${i.title}, ${dayShort(i.start)}${i.end !== i.start ? ` to ${dayShort(i.end)}` : ''}`}
                  style={{ ...KIND_COLOUR[i.kind], display: 'block', borderRadius: 4, padding: '2px 6px', fontSize: 12, marginBottom: 3, textDecoration: 'none', border: i.state === 'scheduled' ? '1px dashed currentColor' : '1px solid transparent', opacity: i.state === 'done' ? 0.65 : 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {i.title}
                </Link>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function MarketingDashboard() {
  const { from, to, query, set } = usePeriodParams();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const nav = useNavigate();
  const load = useCallback(() => apiGet(`/mkt/overview${query}`, { fresh: true }).then((d: Overview) => { setData(d); setError(null); }).catch((e: unknown) => setError(msg(e))), [query]);
  useEffect(() => { void load(); }, [load]);
  return (
    <>
      <h1>Marketing Dashboard</h1>
      <div className="acct-region" style={{ maxWidth: 760 }}>
        Whether each marketing initiative is hitting its goal. Every initiative has a goal (the number that means it worked) and a failure line (the number where you stop or change course). Marketing proposes them and a different manager approves them.
        Stockists are counted by their first order.
      </div>
      {error && <div className="save-msg err" role="alert" style={{ marginTop: 10 }}>{error}</div>}
      <PeriodPicker period={data?.period ?? null} from={from} to={to} onChange={set} />
      {!data && !error && <div className="acct-region">Loading…</div>}
      {data && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 12, marginBottom: 14 }}>
            {CARDS.map(c => {
              const ch = data.cards.change[c.key], cur = data.cards.current[c.key], prev = data.cards.previous[c.key];
              return (
                <div key={c.key} className="card" style={{ margin: 0 }} aria-label={c.title}>
                  <div className="acct-region" style={{ fontWeight: 600 }}>{c.title}</div>
                  <div style={{ fontSize: 34, fontWeight: 700, lineHeight: 1.1 }}>{num(cur)}</div>
                  <div className="acct-region" style={{ marginTop: 2 }}>
                    {ch === null ? '' : <span style={{ color: ch > 0 ? 'var(--teal)' : ch < 0 ? 'var(--rust)' : undefined, fontWeight: 600 }}>{ch > 0 ? '▲' : ch < 0 ? '▼' : '='} {changeText(ch)}</span>}
                    {' '}(previous period: {num(prev)})
                  </div>
                  <div className="acct-region" style={{ marginTop: 6, fontSize: 12 }}>{c.rule}</div>
                </div>
              );
            })}
          </div>
          <div className="card">
            <h3>Initiatives</h3>
            <div className="table-scroll">
              <table style={{ width: '100%' }}>
                <thead><tr style={{ textAlign: 'left', color: 'var(--muted)' }}><th>Focus area</th><th>Current period</th><th>Previous period</th><th /></tr></thead>
                <tbody>
                  {data.rows.map(r => (
                    <tr key={r.focus} onClick={() => nav(`/marketing-dashboard/${FOCUS_PATH[r.focus]}${query}`)} style={{ cursor: 'pointer', borderTop: '1px solid var(--line)' }} aria-label={r.label}>
                      <td style={{ padding: '10px 8px 10px 0' }}><Link to={`/marketing-dashboard/${FOCUS_PATH[r.focus]}${query}`} className="order-link" onClick={e => e.stopPropagation()}><b>{r.label}</b></Link></td>
                      <td>
                        <LightPill light={r.current} />{' '}
                        <span className="acct-region">{r.judged ? `${r.judged} judged` : ''}{r.unjudged ? `${r.judged ? ', ' : ''}${r.unjudged} waiting for a goal or results` : ''}</span>
                      </td>
                      <td>{r.previous === null ? <span className="acct-region">nothing to judge</span> : <span className={`pill ${r.previous ? 'teal' : 'rust'}`}>Met goal: {r.previous ? 'Yes' : 'No'}</span>}</td>
                      <td style={{ textAlign: 'right' }} aria-hidden="true">›</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="acct-region" style={{ marginTop: 8 }}>
              {(Object.keys(LIGHT_TEXT) as (keyof typeof LIGHT_TEXT)[]).filter(k => k !== 'none').map(k => <span key={k} style={{ marginRight: 14 }}><LightPill light={k} /></span>)}
              Green: on pace for the goal. Amber: behind pace but above the failure line. Red: at or below the failure line. A goal only counts once a manager has approved it.
            </div>
          </div>
          <Calendar from={data.calendar.from} to={data.calendar.to} items={data.calendar.items} today={data.today} query={query} />
          <WaitingGoals items={data.waiting} onChanged={load} />
        </>
      )}
    </>
  );
}
