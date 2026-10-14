import { OrderLastNote, fmtDate } from '../lib/types';

// The latest team note on an order, for lists: "2 notes" and what was last said, so anyone looking at the
// order can see what is going on (chasing payment, waiting on stock) without opening it. Shows nothing if there are none.
const SHORT = 90;

export default function OrderNoteChip({ noteCount, lastNote }: { noteCount?: number; lastNote?: OrderLastNote | null }) {
  if (!noteCount || !lastNote) return null;
  const text = lastNote.text.length > SHORT ? lastNote.text.slice(0, SHORT).trimEnd() + '…' : lastNote.text;
  return (
    <div className="order-note-chip" title={`${lastNote.by ?? 'Someone'}, ${fmtDate(lastNote.at)}: ${lastNote.text}`}
      style={{ display: 'flex', gap: 6, alignItems: 'baseline', marginTop: 3, fontSize: 12 }}>
      <span className="pill neutral" style={{ flexShrink: 0 }}>{noteCount === 1 ? '1 note' : `${noteCount} notes`}</span>
      <span style={{ color: 'var(--ink-soft)' }}>{lastNote.by ? `${lastNote.by}: ` : ''}{text}</span>
    </div>
  );
}