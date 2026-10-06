import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiGet } from '../lib/api';

// Managers only: every log the team adds or edits, newest first, so a
// manager doesn't have to open each account. Refreshes itself every minute.

type LogRow = {
  id: string; type: 'call' | 'email' | 'visit'; note: string; photoUrl: string | null;
  occurredAt: string; createdAt: string; updatedAt: string | null; sortAt: string; edited: boolean;
  accountId: string; accountName: string; accountRegion: string; repId: string; repName: string;
};

const TYPES = [
  { key: '', label: 'All' },
  { key: 'call', label: 'Calls' },
  { key: 'email', label: 'Emails' },
  { key: 'visit', label: 'Visits' },
] as const;
const PERIODS = [
  { days: 1, label: 'Today' },
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
];
const TYPE_LABEL = { call: 'Call', email: 'Email', visit: 'Visit' } as const;
const REFRESH_MS = 60_000;

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
  const pagedRef = useRef(false); // stop auto-refresh replacing pages already loaded

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
        if (cancelled || pagedRef.current) return;
        setRows(d.rows); setHasMore(d.hasMore); setReps(d.reps); setError(null);
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
    if (!rows?.length) return;
    setLoadingMore(true);
    try {
      const d = await apiGet(query(rows[rows.length - 1].sortAt));
      pagedRef.current = true;
      setRows([...rows, ...d.rows]);
      setHasMore(d.hasMore);
    } finally {
      setLoadingMore(false);
    }
  }

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
        <div className="team-log-list">
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
                    <span className={`pill ${r.type === 'visit' ? 'teal' : r.type === 'email' ? 'neutral' : 'amber'}`}>{TYPE_LABEL[r.type]}</span>
                    <Link to={`/accounts/${r.accountId}`} className="acct-name">{r.accountName}</Link>
                    <span className="acct-region">{r.accountRegion}</span>
                    {r.edited && <span className="pill neutral" title={`Edited ${when(r.updatedAt!)}`}>Edited</span>}
                    {!sameDay(r.occurredAt, r.createdAt) && (
                      <span className="acct-region">for {new Date(r.occurredAt).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}</span>
                    )}
                  </div>
                  <div className={'team-log-note' + (long && !expanded ? ' clamped' : '')}>{r.note}</div>
                  {long && (
                    <button className="link-btn" onClick={() => toggle(r.id)}>{expanded ? 'Show less' : 'Show more'}</button>
                  )}
                  {r.photoUrl && <a href={r.photoUrl} target="_blank" rel="noreferrer" className="order-link team-log-photo">View photo</a>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {rows && hasMore && (
        <button className="btn secondary" style={{ marginTop: 10 }} onClick={loadMore} disabled={loadingMore}>
          {loadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  );
}