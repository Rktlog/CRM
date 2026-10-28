import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiGet } from '../lib/api';
import { mergeLatest, when, sameDay, TYPES, TYPE_LABEL, type LogRow } from './TeamLogCard';

// "My log" on the Dashboard: every entry the signed-in person has added or edited, newest first (the team log, for managers, is the same list for
// everyone). Only the latest three are in view; the panel is cut to exactly the height of three entries, and the rest are a scroll away. Older
// entries load by themselves as you reach the bottom. It updates every minute.
const VISIBLE = 3;
const REFRESH_MS = 60_000;
const NEAR_BOTTOM = 80;   // px from the bottom at which the next page starts loading
const PERIODS = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: 'Year' },
];

export default function MyLogCard() {
  const [rows, setRows] = useState<LogRow[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [type, setType] = useState('');
  const [days, setDays] = useState(30);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [loadingMore, setLoadingMore] = useState(false);
  const [panelH, setPanelH] = useState<number | null>(null);   // the height of the first three entries; null = fewer than three, show them all
  const pagedRef = useRef(false);   // more pages have been loaded: a refresh now merges instead of replacing
  const panel = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<LogRow[] | null>(null);
  rowsRef.current = rows;

  const query = (before?: string) => {
    const p = new URLSearchParams({ days: String(days) });
    if (type) p.set('type', type);
    if (before) p.set('before', before);
    return `/activity/mine?${p.toString()}`;
  };

  useEffect(() => {
    let cancelled = false;
    const load = () => apiGet(query())
      .then(d => {
        if (cancelled) return;
        if (pagedRef.current && rowsRef.current) {
          const merged = mergeLatest(rowsRef.current, d) as LogRow[];
          setRows(merged);
          if (merged.length === d.rows.length) { pagedRef.current = false; setHasMore(d.hasMore); }   // nothing older is kept: back to one page
        } else { setRows(d.rows); setHasMore(d.hasMore); }
        setError(null);
      })
      .catch(e => !cancelled && setError(e.message));
    pagedRef.current = false;
    setRows(null);
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => { cancelled = true; clearInterval(t); };
  }, [type, days]);

  // Cut the panel to the height of the first three entries (measured, because entries are different heights). Measured again when the entries
  // change or the window is resized, but not when one is expanded, so opening a long note scrolls inside the panel instead of growing it.
  useLayoutEffect(() => {
    const measure = () => {
      const el = panel.current;
      if (!el) return setPanelH(null);
      const first = Array.from(el.children).filter(c => c.classList.contains('team-log-row')).slice(0, VISIBLE) as HTMLElement[];
      if (first.length < VISIBLE) return setPanelH(null);
      const total = first.reduce((s, k) => s + k.offsetHeight, 0);
      setPanelH(total > 0 ? total : null);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [rows]);

  async function loadMore() {
    if (!rows?.length || loadingMore) return;
    setLoadingMore(true);
    try {
      const d = await apiGet(query(rows[rows.length - 1].sortAt));
      pagedRef.current = true;
      const have = new Set(rows.map(r => r.id)), added: LogRow[] = d.rows.filter((n: LogRow) => !have.has(n.id));
      setRows(cur => [...(cur ?? rows), ...added.filter(n => !(cur ?? []).some(r => r.id === n.id))]);
      setHasMore(d.hasMore && added.length > 0);   // a page with nothing new would otherwise be asked for again and again
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoadingMore(false);
    }
  }

  const onScroll = () => {
    const el = panel.current;
    if (el && hasMore && !loadingMore && el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM) loadMore();
  };

  const toggle = (id: string) => setOpen(s => {
    const n = new Set(s);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  });

  return (
    <div className="card team-log">
      <div className="team-log-head">
        <h3>My log</h3>
        <span className="acct-region">What you have logged or edited, newest first. Updates every minute.</span>
      </div>

      <div className="team-log-filters">
        <div className="seg">
          {TYPES.map(t => (
            <button key={t.key} className={type === t.key ? 'on' : ''} onClick={() => setType(t.key)}>{t.label}</button>
          ))}
        </div>
        <select value={days} onChange={e => setDays(Number(e.target.value))} aria-label="Period">
          {PERIODS.map(p => <option key={p.days} value={p.days}>{p.label}</option>)}
        </select>
      </div>

      {error && <div className="empty-state">Couldn't load your log: {error}</div>}
      {!error && !rows && <div className="acct-region" style={{ padding: '10px 0' }}>Loading…</div>}
      {rows && rows.length === 0 && <div className="acct-region" style={{ padding: '10px 0' }}>You haven't logged anything in this period.</div>}

      {rows && rows.length > 0 && (
        <div ref={panel} className="team-log-list" onScroll={onScroll} tabIndex={0} aria-label="My log entries"
          style={{ maxHeight: panelH ?? undefined, overflowY: panelH ? 'auto' : undefined, overscrollBehavior: 'contain' }}>
          {rows.map(r => {
            const long = r.note.length > 220 || r.note.split('\n').length > 3;
            const expanded = open.has(r.id);
            return (
              <div className="team-log-row" key={r.id}>
                <div className="team-log-meta">
                  <div className="num">{when(r.sortAt)}</div>
                </div>
                <div className="team-log-body">
                  <div className="team-log-title">
                    <span className={`pill ${r.type === 'visit' ? 'teal' : r.type === 'email' || r.type === 'remark' ? 'neutral' : 'amber'}`}>{TYPE_LABEL[r.type]}</span>
                    <Link to={`/accounts/${r.accountId}`} className="acct-name">{r.accountName}</Link>
                    <span className="acct-region">{r.accountRegion}</span>
                    {r.orderNumber && r.orderId && <Link to={`/orders/${r.orderId}`} className="order-link">on {r.orderNumber}</Link>}
                    {r.edited && <span className="pill neutral" title={`Edited ${when(r.updatedAt!)}`}>Edited</span>}
                    {!sameDay(r.occurredAt, r.createdAt) && (
                      <span className="acct-region">for {new Date(r.occurredAt).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}</span>
                    )}
                  </div>
                  <div className={'team-log-note' + (long && !expanded ? ' clamped' : '')}>{r.note}</div>
                  {long && (
                    <button className="link-btn" onClick={() => toggle(r.id)}>{expanded ? 'Show less' : 'Show more'}</button>
                  )}
                  {r.photoUrl && (
                    <a href={r.photoUrl} target="_blank" rel="noreferrer" className="ti-photo" title="Open the full-size photo">
                      <img src={r.photoUrl} alt="Visit photo" loading="lazy" />
                    </a>
                  )}
                </div>
              </div>
            );
          })}
          {hasMore && (
            <div style={{ padding: '10px 0', textAlign: 'center' }}>
              <button className="btn secondary" onClick={loadMore} disabled={loadingMore}>{loadingMore ? 'Loading…' : 'Load more'}</button>
            </div>
          )}
        </div>
      )}
      {rows && rows.length > 0 && (
        <div className="acct-region" style={{ marginTop: 6 }}>
          {rows.length > VISIBLE || hasMore
            ? `Your latest ${VISIBLE} are showing. Scroll for older entries (${rows.length} so far${hasMore ? ', more as you scroll' : ''}).`
            : `${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}.`}
        </div>
      )}
    </div>
  );
}