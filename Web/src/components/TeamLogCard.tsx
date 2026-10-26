import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiGet } from '../lib/api';

// Managers only: every log the team adds or edits, newest first, so a
// manager doesn't have to open each account. Refreshes itself every minute.
// The list sits in a panel of fixed height so the dashboard stays short, and it scrolls: the next page of entries loads by itself as
// you reach the bottom, so there is no "limited to 3" and no button to press. PANEL_HEIGHT is how tall the panel is.

type LogRow = {
  id: string; type: 'call' | 'email' | 'visit' | 'remark'; note: string; photoUrl: string | null; orderId?: string | null; orderNumber?: string | null;
  occurredAt: string; createdAt: string; updatedAt: string | null; sortAt: string; edited: boolean;
  accountId: string; accountName: string; accountRegion: string; repId: string; repName: string;
};

const TYPES = [
  { key: '', label: 'All' },
  { key: 'call', label: 'Phone' },
  { key: 'email', label: 'Email' },
  { key: 'visit', label: 'F2F visits' },
  { key: 'remark', label: 'Remarks' },
] as const;
const PERIODS = [
  { days: 1, label: 'Today' },
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
];
const TYPE_LABEL = { call: 'Phone', email: 'Email', visit: 'F2F visit', remark: 'Remark' } as const;
const REFRESH_MS = 60_000;
const PANEL_HEIGHT = 'min(70vh, 560px)';   // about six entries; change this to show more or fewer at once
const NEAR_BOTTOM = 120;                    // px from the bottom at which the next page starts loading

// What a refresh does once more pages have been loaded: the newest entries (and any edits or deletions among them) replace what was
// shown for that stretch of time, and the older pages already loaded are kept as they are.
export function mergeLatest(prev: { id: string; sortAt: string }[], fresh: { rows: { id: string; sortAt: string }[]; hasMore: boolean }) {
  const edge = fresh.rows.length ? new Date(fresh.rows[fresh.rows.length - 1].sortAt).getTime() : null;
  if (!fresh.hasMore || edge === null) return fresh.rows;
  return [...fresh.rows, ...prev.filter(r => new Date(r.sortAt).getTime() < edge)];
}

function when(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86400000);
  const time = d.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return `Today ${time}`;
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }) + ` ${time}`;
}
const sameDay = (a: string, b: string) => new Date(a).toDateString() === new Date(b).toDateString();

export default function TeamLogCard() {
  const [rows, setRows] = useState<LogRow[] | null>(null);
  const [reps, setReps] = useState<{ id: string; name: string }[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rep, setRep] = useState('');
  const [type, setType] = useState('');
  const [days, setDays] = useState(7);
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [loadingMore, setLoadingMore] = useState(false);
  const pagedRef = useRef(false); // more pages have been loaded: a refresh now merges instead of replacing
  const panel = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<LogRow[] | null>(null);
  rowsRef.current = rows;

  const query = (before?: string) => {
    const p = new URLSearchParams({ days: String(days) });
    if (rep) p.set('rep', rep);
    if (type) p.set('type', type);
    if (q) p.set('q', q);
    if (before) p.set('before', before);
    return `/activity/feed?${p.toString()}`;
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
        setReps(d.reps); setError(null);
      })
      .catch(e => !cancelled && setError(e.message));
    pagedRef.current = false;
    setRows(null);
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => { cancelled = true; clearInterval(t); };
  }, [rep, type, days, q]);

  // Search waits until typing stops for a moment.
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 400);
    return () => clearTimeout(t);
  }, [search]);

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

  // The next page loads as you near the bottom. If the entries do not even fill the panel (a tall screen, a short first page), keep going
  // until they do, so there is always something to scroll.
  const onScroll = () => {
    const el = panel.current;
    if (el && hasMore && !loadingMore && el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM) loadMore();
  };
  useEffect(() => {
    const el = panel.current;
    if (el && rows && rows.length && hasMore && !loadingMore && el.scrollHeight <= el.clientHeight + 4) loadMore();
  }, [rows, hasMore]);

  const toggle = (id: string) => setOpen(s => {
    const n = new Set(s);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  });

  return (
    <div className="card team-log">
      <div className="team-log-head">
        <h3>Team log</h3>
        <span className="acct-region">Every entry the team adds or edits, newest first. Updates every minute.</span>
      </div>

      <div className="team-log-filters">
        <div className="seg">
          {TYPES.map(t => (
            <button key={t.key} className={type === t.key ? 'on' : ''} onClick={() => setType(t.key)}>{t.label}</button>
          ))}
        </div>
        <select value={rep} onChange={e => setRep(e.target.value)} aria-label="Rep">
          <option value="">All reps</option>
          {reps.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        <select value={days} onChange={e => setDays(Number(e.target.value))} aria-label="Period">
          {PERIODS.map(p => <option key={p.days} value={p.days}>{p.label}</option>)}
        </select>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search notes or store" />
      </div>

      {error && <div className="empty-state">Couldn't load the team log: {error}</div>}
      {!error && !rows && <div className="acct-region" style={{ padding: '10px 0' }}>Loading…</div>}
      {rows && rows.length === 0 && <div className="acct-region" style={{ padding: '10px 0' }}>Nothing logged{q ? ` matching "${q}"` : ''} in this period.</div>}

      {rows && rows.length > 0 && (
        <div ref={panel} className="team-log-list" onScroll={onScroll} tabIndex={0} aria-label="Team log entries"
          style={{ maxHeight: PANEL_HEIGHT, overflowY: 'auto', overscrollBehavior: 'contain' }}>
          {rows.map(r => {
            const long = r.note.length > 220 || r.note.split('\n').length > 3;
            const expanded = open.has(r.id);
            return (
              <div className="team-log-row" key={r.id}>
                <div className="team-log-meta">
                  <div className="num">{when(r.sortAt)}</div>
                  <div className="acct-region">{r.repName}</div>
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
      {rows && rows.length > 0 && <div className="acct-region" style={{ marginTop: 6 }}>{rows.length} entr{rows.length === 1 ? 'y' : 'ies'}{hasMore ? ' so far, more as you scroll' : ''}.</div>}
    </div>
  );
}