import { useEffect, useState } from 'react';
import { apiGet } from '../lib/api';
import { fmtMoney } from '../lib/types';

// A rep's weekly activity, just under their Summary sheet on the Dashboard: what the team's "Weekly Activity Summary" sheet tracked by hand.
// Visits, calls and emails are the rep's own Activity Log; quotes and new customers follow the rep's states. A rep sees their own; a manager
// sees it for each rep inside that rep's folded summary (repId).
// The targets are kept but hidden for now (only the figures are wanted): set SHOW_TARGETS to true to bring them back.
const SHOW_TARGETS = false;
type Row = {
  period: string; f2f: number; phone: number; email: number; contacts: number; quotes: number; quoteValue: number;
  newCustomers: number; newValue: number; reactivated: number; reactivatedValue: number; totalNew: number; newInDear: number;
};
type Data = { targets: { f2fPerWeek: number; quotesPerWeek: number; newPerMonth: number }; today: string; regions: string[]; weeks: Row[]; months: Row[] };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayLabel = (iso: string) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;
const monthLabel = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
const addDays = (iso: string, n: number) => new Date(Date.parse(iso) + n * 86_400_000).toISOString().slice(0, 10);
const MET = 'var(--teal)', MISSED = 'var(--rust)';

export default function WeeklyActivitySummary({ repId, heading = true }: { repId?: string; heading?: boolean }) {
  const [weeks, setWeeks] = useState(12);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    apiGet(`/rep-summary/activity?weeks=${weeks}${repId ? `&repId=${repId}` : ''}`).then(setData).catch(e => setError(e.message));
  }, [weeks, repId]);

  const mine = !repId;   // a rep looking at their own, or a manager looking at one rep
  const Heading = mine ? 'h2' : 'h3';
  if (error) return <div className="empty-state">Couldn't load {mine ? 'your' : 'the'} weekly activity: {error}</div>;
  if (!data) return <div className="empty-state">Loading {mine ? 'your' : 'the'} weekly activity…</div>;

  const t = data.targets;
  const thisWeek = data.weeks[data.weeks.length - 1];
  const thisMonth = data.months[data.months.length - 1];
  const nothing = data.weeks.every(w => !w.contacts && !w.quotes && !w.totalNew && !w.newInDear);
  // A target is only marked met or missed once the week or month is over; until then it is just a number.
  const colour = (value: number, target: number, over: boolean) => (!SHOW_TARGETS || !over ? undefined : value >= target ? MET : MISSED);

  return (
    <>
      <div className="ledger-section-head">
        {heading ? <Heading>{mine ? 'My weekly activity' : 'Weekly activity'}</Heading> : <span />}
        <span className="ledger-note">
          <select value={weeks} onChange={e => setWeeks(Number(e.target.value))} aria-label="How many weeks to show">
            {[8, 12, 26].map(n => <option key={n} value={n}>Last {n} weeks</option>)}
          </select>
        </span>
      </div>
      <div className="territory-note" style={{ marginBottom: 10 }}>
        This week so far: <b>{thisWeek.f2f}</b>{SHOW_TARGETS && <> of {t.f2fPerWeek}</>} F2F visits, <b>{thisWeek.quotes}</b>{SHOW_TARGETS && <> of {t.quotesPerWeek}</>} sales quotes.
        {' '}This month so far: <b>{thisMonth.totalNew}</b>{SHOW_TARGETS && <> of {t.newPerMonth}</>} new or returning customers.
      </div>
      {data.regions.length === 0 && (
        <div className="territory-note" style={{ marginBottom: 10 }}>{mine ? 'You have' : 'This rep has'} no states assigned, so quotes and new customers show as zero. A manager can assign states in Settings.</div>
      )}
      {nothing ? (
        <div className="empty-state">No visits, calls, emails or orders in these weeks yet.</div>
      ) : (
        <>
          <div className="ledger-table-scroll tall">
            <table>
              <thead>
                <tr>
                  <th>Week starting</th><th className="num-col">F2F visits</th><th className="num-col">Phone</th><th className="num-col">Email</th>
                  <th className="num-col">Sales quotes</th><th className="num-col">Quote value</th><th className="num-col">New</th><th className="num-col">Returning</th>
                  <th className="num-col">New + returning</th><th className="num-col">New in DEAR</th>
                </tr>
              </thead>
              <tbody>
                {[...data.weeks].reverse().map(w => {
                  const over = addDays(w.period, 6) < data.today;
                  return (
                    <tr key={w.period}>
                      <td>{dayLabel(w.period)}{!over && <div className="cust-meta">this week</div>}</td>
                      <td className="num-col num" style={{ color: colour(w.f2f, t.f2fPerWeek, over) }}>{w.f2f}</td>
                      <td className="num-col num">{w.phone}</td>
                      <td className="num-col num">{w.email}</td>
                      <td className="num-col num" style={{ color: colour(w.quotes, t.quotesPerWeek, over) }}>{w.quotes}</td>
                      <td className="num-col num">{fmtMoney(w.quoteValue)}</td>
                      <td className="num-col num">{w.newCustomers}{w.newCustomers > 0 && <div className="cust-meta">{fmtMoney(w.newValue)}</div>}</td>
                      <td className="num-col num">{w.reactivated}{w.reactivated > 0 && <div className="cust-meta">{fmtMoney(w.reactivatedValue)}</div>}</td>
                      <td className="num-col num">{w.totalNew}</td>
                      <td className="num-col num">{w.newInDear}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="ledger-section-head" style={{ marginTop: 18 }}><h3>By month</h3>{SHOW_TARGETS && <span className="ledger-note">Target {t.newPerMonth}+ new or returning customers a month</span>}</div>
          <div className="ledger-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Month</th><th className="num-col">F2F visits</th><th className="num-col">Phone</th><th className="num-col">Email</th><th className="num-col">Sales quotes</th>
                  <th className="num-col">Quote value</th><th className="num-col">New</th><th className="num-col">Returning</th><th className="num-col">New + returning</th><th className="num-col">New in DEAR</th>
                </tr>
              </thead>
              <tbody>
                {[...data.months].reverse().map(m => {
                  const monthEnd = (() => { const d = new Date(`${m.period}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1); return addDays(d.toISOString().slice(0, 10), -1); })();
                  const finished = monthEnd < data.today;
                  return (
                    <tr key={m.period}>
                      <td>{monthLabel(m.period)}{!finished && <div className="cust-meta">so far</div>}</td>
                      <td className="num-col num">{m.f2f}</td><td className="num-col num">{m.phone}</td><td className="num-col num">{m.email}</td>
                      <td className="num-col num">{m.quotes}</td><td className="num-col num">{fmtMoney(m.quoteValue)}</td>
                      <td className="num-col num">{m.newCustomers}{m.newCustomers > 0 && <div className="cust-meta">{fmtMoney(m.newValue)}</div>}</td>
                      <td className="num-col num">{m.reactivated}{m.reactivated > 0 && <div className="cust-meta">{fmtMoney(m.reactivatedValue)}</div>}</td>
                      <td className="num-col num" style={{ color: colour(m.totalNew, t.newPerMonth, finished) }}>{m.totalNew}</td>
                      <td className="num-col num">{m.newInDear}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="territory-note" style={{ marginTop: 8 }}>
            {SHOW_TARGETS && <>Targets: {t.f2fPerWeek}+ F2F visits and {t.quotesPerWeek}+ sales quotes a week. Green means the target was met, red missed (once the week or month is over). </>}
            Visits, calls and emails are {mine ? 'your' : "the rep's"} Activity Log. Sales quotes are every quote or order raised in {mine ? 'your' : 'their'} states ({data.regions.join(', ') || 'none'}), ex GST and ex freight; voided,
            marketing and warranty orders are left out. New = first sales quote ever, returning = first after 12 months with no order; marketing and warranty never count.
          </div>
        </>
      )}
    </>
  );
}