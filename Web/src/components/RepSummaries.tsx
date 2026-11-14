import { useEffect, useMemo, useState, type SyntheticEvent } from 'react';
import { apiGet } from '../lib/api';
import SummarySheet from './SummarySheet';
import WeeklyActivitySummary from './WeeklyActivitySummary';

// Managers: every rep's Summary and Weekly activity, folded away on the Dashboard. The reps are grouped by their states (NSW / ACT, VIC, ...).
// Click a state group to fold or open it, click a rep to open them, then open their Summary or their Weekly activity (each on its own).
// Each part is only fetched when it is first opened (working out a summary goes through every order of their states), and stays once loaded.
export type RepRow = { id: string; name: string; regions: string[] };
export type RepGroup = { label: string; reps: RepRow[] };
type Part = 'summary' | 'weekly';

const STATE_ORDER = ['NSW', 'ACT', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'NT', 'NZ'];
const rank = (s: string) => (STATE_ORDER.indexOf(s) < 0 ? 100 : STATE_ORDER.indexOf(s));

/** Reps with the same states sit together under that label (for example "NSW / ACT"); the groups run in state order, the reps by name. */
export function groupReps(reps: RepRow[]): RepGroup[] {
  const groups = new Map<string, RepRow[]>();
  for (const r of reps) {
    const label = [...r.regions].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).join(' / ') || 'No states';
    groups.set(label, [...(groups.get(label) ?? []), r]);
  }
  const first = (label: string) => rank(label.split(' / ')[0] ?? '');
  return [...groups.entries()]
    .sort(([a], [b]) => first(a) - first(b) || a.localeCompare(b))
    .map(([label, rs]) => ({ label, reps: [...rs].sort((a, b) => a.name.localeCompare(b.name)) }));
}

export default function RepSummaries({ fy }: { fy: number }) {
  const [reps, setReps] = useState<RepRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<Set<string>>(new Set());   // "repId:summary" and "repId:weekly" for the parts that have been opened

  useEffect(() => { apiGet('/summary-sheet/reps').then(setReps).catch(e => setError(e.message)); }, []);
  const groups = useMemo(() => groupReps(reps ?? []), [reps]);
  const mark = (key: string) => (e: SyntheticEvent<HTMLDetailsElement>) => { if (e.currentTarget.open) setOpened(prev => (prev.has(key) ? prev : new Set(prev).add(key))); };
  const part = (r: RepRow, p: Part, title: string) => {
    const key = `${r.id}:${p}`;
    return (
      <details key={p} onToggle={mark(key)} style={{ borderTop: '1px solid var(--line)', marginLeft: 18 }}>
        <summary style={{ cursor: 'pointer', padding: '6px 0' }}>{title}</summary>
        {opened.has(key) && (
          <div style={{ paddingBottom: 10 }}>
            {p === 'summary' ? <SummarySheet fy={fy} repId={r.id} heading={false} /> : <WeeklyActivitySummary repId={r.id} heading={false} />}
          </div>
        )}
      </details>
    );
  };

  return (
    <>
      <div className="ledger-section-head">
        <h2>Rep summaries</h2>
        <span className="ledger-note">FY {fy}/{String(fy + 1).slice(2)}</span>
      </div>
      {error && <div className="empty-state">Couldn't load the reps: {error}</div>}
      {!error && !reps && <div className="empty-state">Loading…</div>}
      {reps && reps.length === 0 && <div className="empty-state">No rep has states assigned yet.</div>}
      {groups.length > 0 && <div className="acct-region" style={{ marginBottom: 8 }}>Click a state group to fold it, a rep to open them, then their Summary or their Weekly activity.</div>}
      {groups.map(g => (
        <details key={g.label} open style={{ marginBottom: 8, border: '1px solid var(--line)', borderRadius: 6, background: 'var(--panel)' }}>
          <summary style={{ cursor: 'pointer', padding: '8px 12px', fontWeight: 600 }}>
            {g.label} <span className="plan-count">{g.reps.length} {g.reps.length === 1 ? 'rep' : 'reps'}</span>
          </summary>
          <div style={{ padding: '0 12px 8px' }}>
            {g.reps.map(r => (
              <details key={r.id} style={{ borderTop: '1px solid var(--line)' }}>
                <summary style={{ cursor: 'pointer', padding: '8px 0' }}>
                  <b>{r.name}</b> <span className="acct-region">{r.regions.join(', ')}</span>
                </summary>
                <div style={{ paddingBottom: 6 }}>
                  {part(r, 'summary', 'Summary')}
                  {part(r, 'weekly', 'Weekly activity')}
                </div>
              </details>
            ))}
          </div>
        </details>
      ))}
    </>
  );
}
