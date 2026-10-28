import { useEffect, useMemo, useState } from 'react';
import { apiGet } from '../lib/api';
import SummarySheet from './SummarySheet';

// Managers: every rep's Summary, folded away on the Dashboard. The reps are grouped by their states (NSW / ACT, VIC, ...). Click a state group to fold
// or open it, and click a rep to open their summary. A rep's sheet is only fetched when it is first opened (working one out goes through every order
// of their states), and stays once loaded.
export type RepRow = { id: string; name: string; regions: string[] };
export type RepGroup = { label: string; reps: RepRow[] };

const STATE_ORDER = ['NSW', 'ACT', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'NT', 'NZ'];
const rank = (s: string) => (STATE_ORDER.indexOf(s) < 0 ? 100 : STATE_ORDER.indexOf(s));

/** Reps with the same states sit together under that label (for example "NSW / ACT"); the groups run in state order, the reps by name. */
export function groupReps(reps: RepRow[]): RepGroup[] {
  const groups = new Map<string, RepRow[]>();
  for (const r of reps) {
    const label = [...r.regions].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).join(' / ') || 'No states';
    groups.set(label, [...(groups.get(label) ?? []), r]);
  }
  const first = (label: string) => rank(label.split(' / ')[0]);
  return [...groups.entries()]
    .sort(([a], [b]) => first(a) - first(b) || a.localeCompare(b))
    .map(([label, rs]) => ({ label, reps: [...rs].sort((a, b) => a.name.localeCompare(b.name)) }));
}

export default function RepSummaries({ fy }: { fy: number }) {
  const [reps, setReps] = useState<RepRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<Set<string>>(new Set());   // reps whose summary has been opened

  useEffect(() => { apiGet('/summary-sheet/reps').then(setReps).catch(e => setError(e.message)); }, []);
  const groups = useMemo(() => groupReps(reps ?? []), [reps]);

  return (
    <>
      <div className="ledger-section-head">
        <h2>Rep summaries</h2>
        <span className="ledger-note">FY {fy}/{String(fy + 1).slice(2)}</span>
      </div>
      {error && <div className="empty-state">Couldn't load the reps: {error}</div>}
      {!error && !reps && <div className="empty-state">Loading…</div>}
      {reps && reps.length === 0 && <div className="empty-state">No rep has states assigned yet.</div>}
      {groups.length > 0 && <div className="acct-region" style={{ marginBottom: 8 }}>Click a state group to fold it, and a rep to open their summary.</div>}
      {groups.map(g => (
        <details key={g.label} open style={{ marginBottom: 8, border: '1px solid var(--line)', borderRadius: 6, background: 'var(--panel)' }}>
          <summary style={{ cursor: 'pointer', padding: '8px 12px', fontWeight: 600 }}>
            {g.label} <span className="plan-count">{g.reps.length} {g.reps.length === 1 ? 'rep' : 'reps'}</span>
          </summary>
          <div style={{ padding: '0 12px 8px' }}>
            {g.reps.map(r => (
              <details key={r.id} style={{ borderTop: '1px solid var(--line)' }}
                onToggle={e => { if ((e.currentTarget as HTMLDetailsElement).open) setOpened(prev => (prev.has(r.id) ? prev : new Set(prev).add(r.id))); }}>
                <summary style={{ cursor: 'pointer', padding: '8px 0' }}>
                  <b>{r.name}</b> <span className="acct-region">{r.regions.join(', ')}</span>
                </summary>
                {opened.has(r.id) && <div style={{ paddingBottom: 12 }}><SummarySheet fy={fy} repId={r.id} heading={false} /></div>}
              </details>
            ))}
          </div>
        </details>
      ))}
    </>
  );
}