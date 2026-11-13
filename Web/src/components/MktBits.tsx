import { Fragment, useState, type CSSProperties } from 'react';
import { apiPost, apiPut } from '../lib/api';
import { LIGHT_CLASS, LIGHT_MARK, LIGHT_TEXT, OUTCOME_LABEL, day, msg, num, type Cell, type Light, type Outcome, type Period, type Waiting } from '../lib/mkt';

// The pieces the marketing dashboard pages are built from. Managers only.
const small: CSSProperties = { padding: '3px 10px', fontSize: 12.5 };
const input: CSSProperties = { padding: '4px 8px', border: '1px solid var(--line)', borderRadius: 3, font: 'inherit', fontSize: 13 };

/** The colour of a result: ▲ green on track, ● amber behind pace, ▼ red at or below the failure line, – no approved goal. */
export function LightPill({ light, text }: { light: Light; text?: string }) {
  return <span className={`pill ${LIGHT_CLASS[light]}`} title={LIGHT_TEXT[light]}>{LIGHT_MARK[light]} {text ?? LIGHT_TEXT[light]}</span>;
}

/** The period for every page: the last 30 days by default, or a custom range. The one before it, of the same length, is what everything is compared with. */
export function PeriodPicker({ period, from, to, onChange }: { period: Period | null; from: string; to: string; onChange: (from: string, to: string) => void }) {
  const [f, setF] = useState(from), [t, setT] = useState(to);
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap', margin: '8px 0 14px' }}>
      <label className="acct-region" style={{ display: 'grid', gap: 2 }}>From<input type="date" aria-label="From" value={f || period?.from || ''} onChange={e => setF(e.target.value)} style={input} /></label>
      <label className="acct-region" style={{ display: 'grid', gap: 2 }}>To<input type="date" aria-label="To" value={t || period?.to || ''} onChange={e => setT(e.target.value)} style={input} /></label>
      <button type="button" className="btn secondary" style={small} onClick={() => onChange(f || period?.from || '', t || period?.to || '')}>Apply</button>
      {(from || to) && <button type="button" className="btn secondary" style={small} onClick={() => { setF(''); setT(''); onChange('', ''); }}>Last 30 days</button>}
      {period && <span className="acct-region">{day(period.from)} to {day(period.to)} ({period.days} days), compared with {day(period.prevFrom)} to {day(period.prevTo)}</span>}
    </div>
  );
}

/** Propose a goal and a failure line. A different manager approves it before it counts. */
export function GoalForm({ kind, initiativeId, scope, cell, onDone, onCancel }: { kind: string; initiativeId?: string; scope?: string; cell: Cell; onDone: () => void; onCancel: () => void }) {
  const [goal, setGoal] = useState(String(cell.pending?.goal ?? cell.goal ?? '')), [failure, setFailure] = useState(String(cell.pending?.failure ?? cell.failure ?? ''));
  const [outcome, setOutcome] = useState<Outcome>(cell.outcome ?? 'sales');
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  async function save() {
    setBusy(true); setError(null);
    try { await apiPost('/mkt/goals', { kind, initiativeId, scope, metric: cell.metric, goal, failure, outcome }); onDone(); } catch (e) { setError(msg(e)); } finally { setBusy(false); }
  }
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap', padding: '6px 0' }}>
      <label className="acct-region" style={{ display: 'grid', gap: 2 }}>Goal (the number that means it worked)<input aria-label={`Goal for ${cell.label}`} inputMode="decimal" value={goal} onChange={e => setGoal(e.target.value)} style={{ ...input, width: 110 }} /></label>
      <label className="acct-region" style={{ display: 'grid', gap: 2 }}>Failure line (stop or change course)<input aria-label={`Failure line for ${cell.label}`} inputMode="decimal" value={failure} onChange={e => setFailure(e.target.value)} style={{ ...input, width: 110 }} /></label>
      <label className="acct-region" style={{ display: 'grid', gap: 2 }}>Serves<select aria-label="Marketing outcome" value={outcome} onChange={e => setOutcome(e.target.value as Outcome)} style={input}>{(Object.keys(OUTCOME_LABEL) as Outcome[]).map(o => <option key={o} value={o}>{OUTCOME_LABEL[o]}</option>)}</select></label>
      <button type="button" className="btn" style={small} disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Propose'}</button>
      <button type="button" className="btn secondary" style={small} disabled={busy} onClick={onCancel}>Cancel</button>
      {error && <span className="save-msg err" role="alert">{error}</span>}
    </div>
  );
}

/** A table of numbers, each against its goal and failure line, with last time beside it. A number that is typed in by hand can be typed in here. */
export function MetricTable({ cells, kind, initiativeId, scope, onChanged }: { cells: Cell[]; kind: string; initiativeId?: string; scope?: string; onChanged: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function save(c: Cell, raw: string) {
    if (!initiativeId) return;
    const current = c.entered ? String(c.value) : '';
    if (raw.trim() === current) return;
    setError(null);
    try { await apiPut(`/mkt/initiatives/${initiativeId}/results`, { metric: c.metric, value: raw.trim() === '' ? null : raw.trim() }); onChanged(); } catch (e) { setError(`${c.label}: ${msg(e)}`); }
  }
  return (
    <div className="table-scroll">
      {error && <div className="save-msg err" role="alert" style={{ marginBottom: 6 }}>{error}</div>}
      <table style={{ width: '100%', fontSize: 13.5 }}>
        <thead><tr style={{ textAlign: 'left', color: 'var(--muted)' }}><th>Number</th><th>Current</th><th>Previous</th><th>Goal</th><th>Failure line</th><th>Result</th><th /></tr></thead>
        <tbody>
          {cells.map(c => (
            <Fragment key={c.metric}>
              <tr style={{ borderTop: '1px solid var(--line)' }}>
                <td style={{ padding: '5px 8px 5px 0' }}>{c.label}</td>
                <td>
                  {c.manual && initiativeId
                    ? <input aria-label={`${c.label} now`} defaultValue={c.entered ? String(c.value) : ''} placeholder="not entered" inputMode="decimal" onBlur={e => save(c, e.target.value)} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} style={{ ...input, width: 100 }} />
                    : <b>{c.entered ? num(c.value, c.money) : '–'}</b>}
                </td>
                <td>{c.prev === null ? '–' : num(c.prev, c.money)}</td>
                <td>{c.goal === null ? '–' : num(c.goal, c.money)}</td>
                <td>{c.failure === null ? '–' : num(c.failure, c.money)}</td>
                <td>{c.goal === null ? <span className="acct-region">{c.pending ? 'goal waiting for approval' : 'no goal yet'}</span> : <LightPill light={c.light} />}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {c.pending
                    ? <span className="acct-region" title={`Proposed by ${c.pending.by ?? 'a manager'}`}>Proposed {num(c.pending.goal, c.money)} / {num(c.pending.failure, c.money)}: waiting for approval</span>
                    : <button type="button" className="link-btn" aria-label={`${c.goal === null ? 'Set goal for' : 'Change goal for'} ${c.label}`} onClick={() => setOpen(open === c.metric ? null : c.metric)}>{c.goal === null ? 'Set goal' : 'Change goal'}</button>}
                </td>
              </tr>
              {open === c.metric && !c.pending && <tr><td colSpan={7}><GoalForm kind={kind} initiativeId={initiativeId} scope={scope} cell={c} onDone={() => { setOpen(null); onChanged(); }} onCancel={() => setOpen(null)} /></td></tr>}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Goals that have been proposed and are waiting for a manager. The one who proposed a goal cannot approve it (unless they are the only manager); anyone can reject or withdraw one. */
export function WaitingGoals({ items, onChanged }: { items: Waiting[]; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null), [error, setError] = useState<string | null>(null);
  async function decide(id: string, approve: boolean) {
    setBusy(id); setError(null);
    try { await apiPost(`/mkt/goals/${id}/decision`, { approve }); onChanged(); } catch (e) { setError(msg(e)); } finally { setBusy(null); }
  }
  if (!items.length) return null;
  return (
    <div className="card" id="waiting">
      <h3>Goals waiting for approval <span className="acct-region">{items.length}</span></h3>
      <div className="acct-region" style={{ marginBottom: 8 }}>Marketing proposes a goal and a failure line, and a different manager approves them. Until then the old numbers (if any) stay in force.</div>
      {error && <div className="save-msg err" role="alert">{error}</div>}
      {items.map(w => (
        <div key={w.id} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '6px 0', borderTop: '1px solid var(--line)' }}>
          <div style={{ flex: '1 1 320px' }}>
            <b>{w.what}</b>: {w.metric}<br />
            <span className="acct-region">Goal {num(w.goal)}, failure line {num(w.failure)}{w.liveGoal !== null ? ` (now ${num(w.liveGoal)} and ${num(w.liveFailure ?? 0)})` : ' (a new goal)'}. Proposed by {w.by ?? 'a manager'}.</span>
          </div>
          {w.canApprove
            ? <button type="button" className="btn" style={small} disabled={busy === w.id} onClick={() => decide(w.id, true)}>Approve</button>
            : <span className="acct-region">A different manager has to approve this one</span>}
          <button type="button" className="btn secondary" style={small} disabled={busy === w.id} onClick={() => decide(w.id, false)}>{w.canApprove ? 'Reject' : 'Withdraw'}</button>
        </div>
      ))}
    </div>
  );
}
