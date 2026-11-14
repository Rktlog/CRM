import { useEffect, useState } from 'react';
import { apiGet } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import SummarySheet from './SummarySheet';
import WeeklyActivitySummary from './WeeklyActivitySummary';

// Two sections on the Dashboard, each closed until opened, so a rep or a manager opens only what they need: the Summary (sales against budget, the team's Summary sheet)
// and the Weekly activity summary (visits, calls, emails and quotes against target). A rep sees their own figures. A manager picks a rep. Nothing loads until a section is opened.
type SectionKey = 'summary' | 'weekly';
type RepRow = { id: string; name: string; role: string };
const STORE = 'rr.dashboard.sections', REP_KEY = 'rr.dashboard.rep';
const loadOpen = (): Record<SectionKey, boolean> => { try { const v = JSON.parse(localStorage.getItem(STORE) ?? '{}'); return { summary: v.summary === true, weekly: v.weekly === true }; } catch { return { summary: false, weekly: false }; } };
const currentFy = (): number => { const m = new Date(new Date().toLocaleString('en-US', { timeZone: 'Australia/Melbourne' })); return m.getMonth() >= 6 ? m.getFullYear() : m.getFullYear() - 1; };   // the year the financial year starts: 2026 is FY 2026/27
const fyLabel = (fy: number) => `FY ${fy}/${String(fy + 1).slice(2)}`;

export default function DashboardSummaries() {
  const { role } = useAuth();
  const manager = role === 'manager';
  const [open, setOpen] = useState(loadOpen);
  const [reps, setReps] = useState<RepRow[] | null>(null);
  const [repId, setRepId] = useState(() => { try { return localStorage.getItem(REP_KEY) ?? ''; } catch { return ''; } });
  const [fy, setFy] = useState(currentFy);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (manager && (open.summary || open.weekly) && !reps) apiGet('/reports/reps').then((r: RepRow[]) => setReps(r)).catch((e: Error) => setError(e.message)); }, [manager, open.summary, open.weekly, reps]);
  function toggle(k: SectionKey) { const next = { ...open, [k]: !open[k] }; setOpen(next); try { localStorage.setItem(STORE, JSON.stringify(next)); } catch { /* it just forgets */ } }
  function pick(id: string) { setRepId(id); try { localStorage.setItem(REP_KEY, id); } catch { /* it just forgets */ } }

  const picker = manager && (
    <div style={{ margin: '4px 0 12px' }}>
      <label className="acct-region">Rep{' '}
        <select aria-label="Rep" value={repId} onChange={e => pick(e.target.value)}>
          <option value="">Choose a rep…</option>
          {reps?.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </label>
      {error && <span className="save-msg err" role="alert" style={{ marginLeft: 10 }}>Couldn't load the reps: {error}</span>}
    </div>
  );
  const ask = <div className="empty-state">Choose a rep to see their figures.</div>;
  const head = (k: SectionKey, title: string, about: string) => (
    <button type="button" aria-expanded={open[k]} aria-controls={`dash-${k}`} onClick={() => toggle(k)}
      style={{ display: 'flex', width: '100%', gap: 10, alignItems: 'baseline', textAlign: 'left', padding: '12px 14px', background: 'transparent', border: 0, cursor: 'pointer', font: 'inherit' }}>
      <span aria-hidden="true" style={{ width: 14, color: 'var(--muted)' }}>{open[k] ? '▾' : '▸'}</span>
      <span><b style={{ fontSize: 15 }}>{title}</b><span className="acct-region" style={{ marginLeft: 10 }}>{about}</span></span>
    </button>
  );
  const box = { border: '1px solid var(--line)', borderRadius: 6, margin: '10px 0' } as const;
  return (
    <div className="section" id="rep-summaries">
      <section style={box} aria-label="Summary">
        {head('summary', 'Summary', manager ? 'Sales against budget, for one rep' : 'Your sales against budget')}
        {open.summary && (
          <div id="dash-summary" style={{ padding: '0 14px 14px' }}>
            {picker}
            <label className="acct-region" style={{ display: 'block', marginBottom: 10 }}>Financial year{' '}
              <select aria-label="Financial year" value={fy} onChange={e => setFy(Number(e.target.value))}>
                {[currentFy(), currentFy() - 1, currentFy() - 2].map(y => <option key={y} value={y}>{fyLabel(y)}</option>)}
              </select>
            </label>
            {manager && !repId ? ask : <SummarySheet fy={fy} repId={manager ? repId : undefined} />}
          </div>
        )}
      </section>
      <section style={box} aria-label="Weekly activity summary">
        {head('weekly', 'Weekly activity summary', manager ? 'Visits, calls, emails and quotes against target, for one rep' : 'Your visits, calls, emails and quotes against target')}
        {open.weekly && (
          <div id="dash-weekly" style={{ padding: '0 14px 14px' }}>
            {picker}
            {manager && !repId ? ask : <WeeklyActivitySummary repId={manager ? repId : undefined} />}
          </div>
        )}
      </section>
    </div>
  );
}
