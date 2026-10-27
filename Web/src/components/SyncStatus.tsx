import { useEffect, useState } from 'react';
import { apiGet } from '../lib/api';

// Settings: when each DEAR sync last ran, and whether a run has been missed. Each runs every 30 minutes from Supabase's scheduler.
type Item = { key: string; label: string; lastSyncedAt: string | null; minutesAgo: number | null; state: 'ok' | 'late' | 'stopped' | 'none' };
type Data = { items: Item[]; lateAfterMinutes: number; stoppedAfterMinutes: number };

const when = (iso: string) => new Date(iso).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
export const ago = (m: number) => (m < 1 ? 'just now' : m < 90 ? `${m} minute${m === 1 ? '' : 's'} ago` : m < 2880 ? `${Math.round(m / 6) / 10} hours ago` : `${Math.round(m / 144) / 10} days ago`);
const PILL: Record<Item['state'], { cls: string; text: string }> = { ok: { cls: 'teal', text: 'Up to date' }, late: { cls: 'amber', text: 'Late: a run was missed' }, stopped: { cls: 'rust', text: 'Not running' }, none: { cls: 'neutral', text: 'No sync recorded' } };

export default function SyncStatus() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { apiGet('/sync-status', { fresh: true }).then(setData).catch((e: Error) => setError(e.message)); }, []);

  const behind = data ? data.items.filter(i => i.state !== 'ok') : [];
  return (
    <div className="section">
      <div className="panel-title">Data sync</div>
      {error && <div className="save-msg err" role="alert">Could not check the syncs: {error}</div>}
      {!data && !error && <div className="acct-region">Checking…</div>}
      {data && (
        <>
          <div style={{ fontSize: 13, marginBottom: 8 }}>
            {behind.length === 0 ? 'Everything from DEAR is up to date.' : <b style={{ color: behind.some(i => i.state !== 'late') ? 'var(--rust)' : undefined }}>{behind.length === 1 ? 'One sync is behind.' : `${behind.length} syncs are behind.`}</b>}
          </div>
          {data.items.map(i => (
            <div key={i.key} style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '4px 0', borderTop: '1px solid var(--line)', fontSize: 13, flexWrap: 'wrap' }}>
              <span style={{ minWidth: 150 }}>{i.label}</span>
              <span className="num">{i.lastSyncedAt ? when(i.lastSyncedAt) : '—'}</span>
              {i.minutesAgo !== null && <span style={{ color: 'var(--muted)' }}>({ago(i.minutesAgo)})</span>}
              <span className={`pill ${PILL[i.state].cls}`}>{PILL[i.state].text}</span>
            </div>
          ))}
          <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 8, maxWidth: 620 }}>
            Each one runs every 30 minutes from Supabase's scheduler. A run that is missed or does not finish is not recorded, so a time more than {data.lateAfterMinutes} minutes old
            means one was missed. A manager can find out why with check-syncs.sql in the Supabase SQL editor.
          </div>
        </>
      )}
    </div>
  );
}