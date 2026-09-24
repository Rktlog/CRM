import { useEffect, useMemo, useState } from 'react';
import { apiGet } from '../lib/api';
import { Account, STAGES, STAGE_LABELS } from '../lib/types';
import { useAuth } from '../context/AuthContext';
import AccountTable, { SortKey } from '../components/AccountTable';
import NewLeadModal from '../components/NewLeadModal';

type Tab = 'customer' | 'prospect' | 'all' | 'archived';

const ALL_STATES = ['NSW', 'ACT', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'NT', 'NZ'];

export default function Accounts() {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [archived, setArchived] = useState<Account[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showNewLead, setShowNewLead] = useState(false);
  const { session } = useAuth();

  // Defaults to Customers — the smaller, actively-managed list —
  // rather than dumping everything on screen at once.
  const [tab, setTab] = useState<Tab>('customer');
  const [search, setSearch] = useState('');
  const [stageFilter, setStageFilter] = useState<string>('all');
  const [regionFilter, setRegionFilter] = useState<string>('');
  const [sortKey, setSortKey] = useState<SortKey>('spend90');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  function load() {
    // scope=all — Accounts is visible to every rep, same as Pipeline
    // and Sales Data, not just "your own" by default.
    apiGet('/accounts?scope=all').then(setAccounts).catch(e => setError(e.message));
    apiGet('/accounts?scope=all&archived=true').then(setArchived).catch(() => {});
  }

  useEffect(load, []);

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  const counts = useMemo(() => {
    if (!accounts) return { customer: 0, prospect: 0, all: 0, archived: 0 };
    return {
      customer: accounts.filter(a => a.type === 'customer').length,
      prospect: accounts.filter(a => a.type === 'prospect').length,
      all: accounts.length,
      archived: archived?.length ?? 0,
    };
  }, [accounts, archived]);

  const visible = useMemo(() => {
    const source = tab === 'archived' ? archived : accounts;
    if (!source) return [];
    const q = search.trim().toLowerCase();

    let list = source.filter(a => {
      if (tab !== 'all' && tab !== 'archived' && a.type !== tab) return false;
      if (stageFilter !== 'all' && a.stage !== stageFilter) return false;
      if (regionFilter && a.region !== regionFilter) return false;
      if (q) {
        const haystack = [a.name, a.contactName, a.phone, a.email, a.region].filter(Boolean).join(' ').toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });

    list = [...list].sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'name': cmp = a.name.localeCompare(b.name); break;
        case 'stage': cmp = STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage); break;
        case 'spend90': cmp = a.spend90 - b.spend90; break;
        case 'lastOrder': cmp = (a.lastOrderAt ? new Date(a.lastOrderAt).getTime() : 0) - (b.lastOrderAt ? new Date(b.lastOrderAt).getTime() : 0); break;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });

    return list;
  }, [accounts, archived, tab, search, stageFilter, regionFilter, sortKey, sortDir]);

  if (error) return <div className="empty-state">Couldn't load accounts: {error}</div>;
  if (!accounts) return <div className="empty-state">Loading…</div>;

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h1>Accounts</h1>
        <button className="btn" onClick={() => setShowNewLead(true)}>+ New lead</button>
      </div>

      <div className="tab-bar">
        <button className={'tab' + (tab === 'customer' ? ' active' : '')} onClick={() => setTab('customer')}>
          Customers <span className="tab-count">{counts.customer}</span>
        </button>
        <button className={'tab' + (tab === 'prospect' ? ' active' : '')} onClick={() => setTab('prospect')}>
          Prospects <span className="tab-count">{counts.prospect}</span>
        </button>
        <button className={'tab' + (tab === 'all' ? ' active' : '')} onClick={() => setTab('all')}>
          All <span className="tab-count">{counts.all}</span>
        </button>
        <button className={'tab' + (tab === 'archived' ? ' active' : '')} onClick={() => setTab('archived')} style={{ marginLeft: 'auto', opacity: 0.7 }}>
          Archived <span className="tab-count">{counts.archived}</span>
        </button>
      </div>

      {tab === 'archived' && (
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 12 }}>
          One-off buyers and non-lead records kept for history — not part of your working pipeline.
        </div>
      )}

      <div className="toolbar">
        <input
          className="search-input"
          placeholder="Search name, contact, phone, email…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <select value={stageFilter} onChange={e => setStageFilter(e.target.value)}>
          <option value="all">All stages</option>
          {STAGES.map(s => <option key={s} value={s}>{STAGE_LABELS[s]}</option>)}
        </select>
        <select value={regionFilter} onChange={e => setRegionFilter(e.target.value)}>
          <option value="">All states</option>
          {ALL_STATES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <span className="toolbar-count">{visible.length} shown</span>
      </div>

      <div className="section">
        {visible.length ? (
          <AccountTable accounts={visible} sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
        ) : (
          <div className="empty-state">No accounts match your search or filters.</div>
        )}
      </div>

      {showNewLead && session && (
        <NewLeadModal
          repId={session.user.id}
          existingNames={accounts.map(a => a.name)}
          onCreated={load}
          onClose={() => setShowNewLead(false)}
        />
      )}
    </>
  );
}