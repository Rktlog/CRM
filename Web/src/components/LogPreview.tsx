import { useState } from 'react';
import { apiPost } from '../lib/api';
import type { LogProposal } from '../lib/aiStream';

// The preview the assistant builds when someone asks it to fill in the Activity Log. Nothing is saved until Confirm is pressed. Each row can be
// unticked. Only ticked rows are sent, and the API checks every one again before saving it as the signed-in person.
type Result = { saved: number; skipped: { name: string; reason: string }[] };

export default function LogPreview({ proposal }: { proposal: LogProposal }) {
  const ready = proposal.rows.filter(r => r.status === 'ready');
  const repeats = proposal.rows.filter(r => r.status === 'duplicate');
  const [on, setOn] = useState<Set<number>>(() => new Set(proposal.rows.map((r, i) => (r.status === 'ready' ? i : -1)).filter(i => i >= 0)));
  const [state, setState] = useState<'idle' | 'saving' | 'done' | 'cancelled'>('idle');
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setState('saving'); setError(null);
    try {
      const entries = proposal.rows.filter((_, i) => on.has(i)).map(r => ({ accountId: r.accountId, type: r.type, date: r.date, note: r.note }));
      setResult(await apiPost('/ai/log/confirm', { entries }));
      setState('done');
    } catch (e) { setError((e as Error).message); setState('idle'); }   // nothing was saved, so Confirm can be pressed again
  };

  const done = state === 'done' || state === 'cancelled';
  const cell = { padding: '4px 8px', borderBottom: '1px solid var(--line)', verticalAlign: 'top' as const, fontSize: 13 };
  return (
    <div style={{ marginTop: 10, border: '1px solid var(--line)', borderRadius: 6, background: '#fff', color: '#111' }}>
      <div style={{ padding: '8px 10px', fontWeight: 600 }}>
        {state === 'done' ? `Saved ${result?.saved ?? 0} to the Activity Log` : state === 'cancelled' ? 'Not saved' : `Check these ${ready.length} Activity Log entries. Nothing is saved until you press Confirm.`}
      </div>
      {state !== 'done' && state !== 'cancelled' && (
        <div className="ledger-table-scroll tall" style={{ maxHeight: 360 }}>
          <table style={{ minWidth: 640 }}>
            <thead><tr><th /><th>Customer</th><th>Type</th><th>Date</th><th>Note</th><th>What it changes</th></tr></thead>
            <tbody>
              {proposal.rows.map((r, i) => (
                <tr key={i} style={r.status === 'duplicate' ? { color: 'var(--muted)' } : undefined}>
                  <td style={cell}>{r.status === 'ready' && <input type="checkbox" checked={on.has(i)} disabled={done} aria-label={`Log ${r.accountName}`} onChange={e => { const checked = e.target.checked; setOn(prev => { const n = new Set(prev); if (checked) n.add(i); else n.delete(i); return n; }); }} />}</td>
                  <td style={cell}>{r.accountName} <span className="acct-region">{r.state}</span></td>
                  <td style={cell}>{r.type}</td>
                  <td style={{ ...cell, whiteSpace: 'nowrap' }}>{r.date}</td>
                  <td style={cell} title={r.note}>{r.note.length > 90 ? `${r.note.slice(0, 90)}…` : r.note}</td>
                  <td style={cell}>{r.status === 'duplicate' ? `Already logged (a ${r.type} that day), skipped` : r.effects.join('. ') || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {proposal.problems.length > 0 && state !== 'done' && state !== 'cancelled' && (
        <div style={{ padding: '8px 10px', fontSize: 13 }}>
          <b>Not included ({proposal.problems.length}):</b>
          <ul style={{ margin: '4px 0 0 18px' }}>
            {proposal.problems.map((p, i) => <li key={i}>{p.name}: {p.reason}{p.choices?.length ? ` (${p.choices.map(c => `${c.name} ${c.state}`).join(', ')})` : ''}</li>)}
          </ul>
        </div>
      )}
      {state === 'done' && result && result.skipped.length > 0 && (
        <div style={{ padding: '8px 10px', fontSize: 13 }}>
          <b>Skipped ({result.skipped.length}):</b>
          <ul style={{ margin: '4px 0 0 18px' }}>{result.skipped.map((s, i) => <li key={i}>{s.name}: {s.reason}</li>)}</ul>
        </div>
      )}
      {error && <div className="save-msg err" style={{ margin: '0 10px 8px' }}>{error} Nothing was saved.</div>}
      {!done && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 10px' }}>
          <button type="button" className="btn" disabled={state === 'saving' || on.size === 0} onClick={confirm}>{state === 'saving' ? 'Saving…' : `Confirm ${on.size} ${on.size === 1 ? 'entry' : 'entries'}`}</button>
          <button type="button" className="btn secondary" disabled={state === 'saving'} onClick={() => setState('cancelled')}>Cancel</button>
          {repeats.length > 0 && <span className="acct-region">{repeats.length} already logged, skipped</span>}
        </div>
      )}
    </div>
  );
}
