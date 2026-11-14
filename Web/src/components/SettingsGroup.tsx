import { useEffect, useState, type ReactNode } from 'react';

// One heading on the Settings page that opens and closes, so a manager sees a short list of headings instead of every setting at once.
// It remembers (in this browser) which headings were left open. A closed group is only hidden, never taken away, so what is typed into it is not lost.
const read = (key: string, fallback: boolean): boolean => { try { const v = localStorage.getItem(key); return v === null ? fallback : v === '1'; } catch { return fallback; } };
export default function SettingsGroup({ id, title, summary, defaultOpen = false, children }: { id: string; title: string; summary?: string; defaultOpen?: boolean; children: ReactNode }) {
  const key = `rr.settings.group.${id}`;
  const saved = (): boolean | null => { try { const v = localStorage.getItem(key); return v === null ? null : v === '1'; } catch { return null; } };
  const [open, setOpen] = useState(() => read(key, defaultOpen));
  // "Open to start with" can only be known once the page knows who is signed in, so it is applied then, and only if the person has not chosen yet.
  useEffect(() => { if (saved() === null) setOpen(defaultOpen); }, [defaultOpen]);   // eslint-disable-line react-hooks/exhaustive-deps
  function toggle() { const next = !open; setOpen(next); try { localStorage.setItem(key, next ? '1' : '0'); } catch { /* private browsing: it just forgets */ } }
  return (
    <section style={{ border: '1px solid var(--line)', borderRadius: 6, margin: '10px 0', background: 'var(--card, #fff)' }} aria-label={title}>
      <button type="button" aria-expanded={open} aria-controls={`sg-${id}`} onClick={toggle}
        style={{ display: 'flex', width: '100%', gap: 10, alignItems: 'baseline', textAlign: 'left', padding: '12px 14px', background: 'transparent', border: 0, cursor: 'pointer', font: 'inherit' }}>
        <span aria-hidden="true" style={{ width: 14, color: 'var(--muted)' }}>{open ? '▾' : '▸'}</span>
        <span><b style={{ fontSize: 15 }}>{title}</b>{summary && <span className="acct-region" style={{ marginLeft: 10 }}>{summary}</span>}</span>
      </button>
      <div id={`sg-${id}`} hidden={!open} style={{ padding: open ? '0 14px 10px' : 0 }}>{children}</div>
    </section>
  );
}
