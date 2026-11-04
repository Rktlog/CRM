import { useState, type ReactNode } from 'react';

// A section of the Dashboard that folds away with a click, like the managers' rep summaries do.
// - The heading is the click target, with an arrow that shows whether it is open.
// - It starts FOLDED. Whether it has been opened is remembered in this browser (like the Ordering and Planner settings): a rep who opens it finds it open next time, and one who folds it again finds it folded.
// - What is inside is only loaded once it is open: a section that is still folded does not fetch its figures at all, so the Dashboard is lighter until someone opens it.
export default function Collapsible({ id, title, note, defaultOpen = false, children }: { id: string; title: string; note?: string; defaultOpen?: boolean; children: ReactNode }) {
  const key = `radar-fold-${id}`;
  const [open, setOpen] = useState<boolean>(() => {
    try { const v = localStorage.getItem(key); return v === null ? defaultOpen : v === '1'; } catch { return defaultOpen; }
  });
  const [everOpened, setEverOpened] = useState(open);
  const toggle = (now: boolean) => {
    setOpen(now);
    if (now) setEverOpened(true);
    try { localStorage.setItem(key, now ? '1' : '0'); } catch { /* storage off: it just is not remembered */ }
  };
  return (
    <details open={open} onToggle={e => { const now = (e.currentTarget as HTMLDetailsElement).open; if (now !== open) toggle(now); }}>
      <summary className="ledger-section-head" style={{ cursor: 'pointer', userSelect: 'none' }} aria-label={`${title}, ${open ? 'open' : 'folded'}. Click to ${open ? 'fold' : 'open'} it.`}>
        <h2><span aria-hidden="true" style={{ display: 'inline-block', width: 18 }}>{open ? '▾' : '▸'}</span>{title}</h2>
        {note && <span className="ledger-note">{note}</span>}
      </summary>
      {everOpened && <div>{children}</div>}
    </details>
  );
}
