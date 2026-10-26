import { useState } from 'react';
import { apiDelete } from '../lib/api';

// A "Delete" link for one logged activity, shown next to Edit. It asks first, then deletes for good. The API only allows it for the
// rep who logged it, or a manager; if it refuses, the reason is shown here and the log is kept.
export default function DeleteLogLink({ id, onDeleted }: { id: string; onDeleted: () => void }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function remove() {
    setBusy(true);
    setProblem(null);
    try { await apiDelete(`/activity/${id}`); onDeleted(); }
    catch (e) { setProblem(e instanceof Error ? e.message : String(e)); setBusy(false); setAsking(false); }
  }

  // This sits inside rows that open something when clicked, so a click here must not reach the row.
  return (
    <span onClick={e => e.stopPropagation()} style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 6, alignItems: 'baseline' }}>
      {problem && <span className="acct-region" role="alert" style={{ color: 'var(--rust)' }}>{problem}</span>}
      {asking ? (
        <span role="alertdialog" aria-label="Delete this log" style={{ display: 'inline-flex', gap: 6, alignItems: 'baseline' }}>
          <span className="acct-region">Delete this log?</span>
          <button type="button" className="edit-link" style={{ color: 'var(--rust)', fontWeight: 600 }} disabled={busy} onClick={remove}>{busy ? 'Deleting…' : 'Yes, delete'}</button>
          <button type="button" className="edit-link" disabled={busy} onClick={() => setAsking(false)}>Keep</button>
        </span>
      ) : (
        <button type="button" className="edit-link" style={{ color: 'var(--rust)' }} onClick={() => setAsking(true)}>Delete</button>
      )}
    </span>
  );
}