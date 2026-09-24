import { useEffect, useState } from 'react';
import { apiGet, apiPut, apiPatch } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { fmtMoney } from '../lib/types';

type Rep = { id: string; name: string; role: string };
type Target = { id: string; repId: string; repName: string; year: number; quarter: number; amount: number };

const QUARTER_LABELS = ['Q1 (Jan–Mar)', 'Q2 (Apr–Jun)', 'Q3 (Jul–Sep)', 'Q4 (Oct–Dec)'];
const ALL_STATES = ['NSW', 'ACT', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'NT', 'NZ'];

export default function Settings() {
  const { role, session } = useAuth();
  const isManager = role === 'manager';
  const [reps, setReps] = useState<Rep[] | null>(null);
  const [selectedRep, setSelectedRep] = useState<string>('');
  const [year, setYear] = useState(new Date().getFullYear());
  const [targets, setTargets] = useState<Target[] | null>(null);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [saving, setSaving] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Rep's own planner settings
  const [dailyLimit, setDailyLimit] = useState<number | ''>('');
  const [dailyNewLeads, setDailyNewLeads] = useState<number | ''>('');
  const [dailyInactive, setDailyInactive] = useState<number | ''>('');
  const [plannerSaving, setPlannerSaving] = useState(false);

  // Manager: territory assignment
  const [territoryRep, setTerritoryRep] = useState<string>('');
  const [assignedRegions, setAssignedRegions] = useState<string[]>([]);
  const [territorySaving, setTerritorySaving] = useState(false);
  const [territorySummary, setTerritorySummary] = useState<{ repId: string; repName: string; regions: string[] }[] | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);

  useEffect(() => {
    apiGet('/me').then(me => {
      setDailyLimit(me.dailyColdCallLimit);
      setDailyNewLeads(me.dailyNewLeadCount);
      setDailyInactive(me.dailyInactiveCount);
      setLastSyncedAt(me.lastSyncedAt);
    }).catch(() => {});
  }, []);

  async function savePlannerSettings() {
    setPlannerSaving(true);
    try {
      const patch: any = {};
      if (dailyLimit !== '') patch.dailyColdCallLimit = Number(dailyLimit);
      if (dailyNewLeads !== '') patch.dailyNewLeadCount = Number(dailyNewLeads);
      if (dailyInactive !== '') patch.dailyInactiveCount = Number(dailyInactive);
      await apiPatch('/me', patch);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setPlannerSaving(false);
    }
  }

  useEffect(() => {
    if (isManager) {
      apiGet('/reports/reps').then(setReps).catch(e => setError(e.message));
    } else if (session) {
      setSelectedRep(session.user.id);
    }
  }, [isManager, session]);

  useEffect(() => {
    if (isManager && reps && reps.length) {
      if (!selectedRep) setSelectedRep(reps[0].id);
      if (!territoryRep) setTerritoryRep(reps[0].id);
    }
  }, [reps, isManager]);

  function load() {
    if (!selectedRep) return;
    apiGet(`/budget-targets?repId=${selectedRep}&year=${year}`)
      .then((t: Target[]) => {
        setTargets(t);
        const d: Record<number, string> = {};
        for (let q = 1; q <= 4; q++) {
          const existing = t.find(x => x.quarter === q);
          d[q] = existing ? String(existing.amount) : '';
        }
        setDrafts(d);
      })
      .catch(e => setError(e.message));
  }
  useEffect(load, [selectedRep, year]);

  async function saveQuarter(q: number) {
    const amount = Number(drafts[q]);
    if (isNaN(amount) || amount < 0) return;
    setSaving(q);
    try {
      await apiPut('/budget-targets', { repId: selectedRep, year, quarter: q, amount });
      load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(null);
    }
  }

  function loadTerritory() {
    if (!territoryRep) return;
    apiGet(`/rep-regions?repId=${territoryRep}`).then(setAssignedRegions).catch(e => setError(e.message));
  }
  useEffect(loadTerritory, [territoryRep]);

  function loadTerritorySummary() {
    if (!isManager) return;
    apiGet('/rep-regions/all').then(setTerritorySummary).catch(() => {});
  }
  useEffect(loadTerritorySummary, [isManager]);

  function toggleRegion(region: string) {
    setAssignedRegions(prev => prev.includes(region) ? prev.filter(r => r !== region) : [...prev, region]);
  }

  async function saveTerritory() {
    setTerritorySaving(true);
    try {
      await apiPut('/rep-regions', { repId: territoryRep, regions: assignedRegions });
      loadTerritorySummary();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setTerritorySaving(false);
    }
  }

  if (error) return <div className="empty-state">Couldn't load settings: {error}</div>;

  return (
    <>
      <h1>Settings</h1>

      <div className="section">
        <div className="panel-title">Data sync</div>
        {lastSyncedAt ? (
          <div style={{ fontSize: 13 }}>
            Last synced from DEAR: <span className="num">{new Date(lastSyncedAt).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</span>
            <span style={{ color: 'var(--muted)', marginLeft: 6 }}>
              ({Math.round((Date.now() - new Date(lastSyncedAt).getTime()) / 60000)} minutes ago)
            </span>
          </div>
        ) : (
          <div style={{ fontSize: 13, color: 'var(--muted)' }}>No sync has completed yet.</div>
        )}
        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>
          Runs automatically every 30 minutes via the background sync worker (npm run sync) —
          this only updates while that process is actually running.
        </div>
      </div>


      <div className="section">
        <div className="panel-title">Your planner</div>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 14, maxWidth: 560 }}>
          How much shows up on your Planner each day. Cold call limit caps manually scheduled tasks
          (anything left over rolls to tomorrow). New leads and inactive customers control the
          separate suggested-outreach list, pulled from your assigned territory.
        </div>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 10 }}>
          <label style={{ fontSize: 12, color: 'var(--muted)' }}>
            Daily cold call limit<br />
            <input type="number" min="1" value={dailyLimit} onChange={e => setDailyLimit(e.target.value === '' ? '' : Number(e.target.value))} style={{ width: 90, padding: '6px 10px', border: '1px solid var(--line)', borderRadius: 3, marginTop: 4 }} />
          </label>
          <label style={{ fontSize: 12, color: 'var(--muted)' }}>
            New leads suggested/day<br />
            <input type="number" min="0" value={dailyNewLeads} onChange={e => setDailyNewLeads(e.target.value === '' ? '' : Number(e.target.value))} style={{ width: 90, padding: '6px 10px', border: '1px solid var(--line)', borderRadius: 3, marginTop: 4 }} />
          </label>
          <label style={{ fontSize: 12, color: 'var(--muted)' }}>
            Inactive customers suggested/day<br />
            <input type="number" min="0" value={dailyInactive} onChange={e => setDailyInactive(e.target.value === '' ? '' : Number(e.target.value))} style={{ width: 90, padding: '6px 10px', border: '1px solid var(--line)', borderRadius: 3, marginTop: 4 }} />
          </label>
        </div>
        <button className="btn secondary" style={{ padding: '6px 14px', fontSize: 12.5 }} disabled={plannerSaving} onClick={savePlannerSettings}>
          {plannerSaving ? 'Saving…' : 'Save'}
        </button>
      </div>

      {isManager && (
        <div className="section">
          <div className="panel-title">Assign reps to states</div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 14, maxWidth: 560 }}>
            A rep can cover one state or several. This drives their suggested-outreach list on the
            Planner — it doesn't restrict what accounts they can otherwise see.
          </div>
          <select value={territoryRep} onChange={e => setTerritoryRep(e.target.value)} style={{ marginBottom: 14 }}>
            {reps?.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
            {ALL_STATES.map(s => (
              <label key={s} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 13, border: '1px solid var(--line)', borderRadius: 4, padding: '5px 10px', cursor: 'pointer' }}>
                <input type="checkbox" checked={assignedRegions.includes(s)} onChange={() => toggleRegion(s)} />
                {s}
              </label>
            ))}
          </div>
          <button className="btn secondary" style={{ padding: '6px 14px', fontSize: 12.5 }} disabled={territorySaving} onClick={saveTerritory}>
            {territorySaving ? 'Saving…' : 'Save territory'}
          </button>

          {territorySummary && territorySummary.length > 0 && (
            <div style={{ marginTop: 20 }}>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>Current assignments</div>
              <div className="manifest">
                <div className="m-row head" style={{ gridTemplateColumns: '1fr 2fr' }}>
                  <div>Rep</div><div>States</div>
                </div>
                {territorySummary.map(t => (
                  <div className="m-row" key={t.repId} style={{ gridTemplateColumns: '1fr 2fr', cursor: 'default' }}>
                    <div className="acct-name">{t.repName}</div>
                    <div>{t.regions.length > 0 ? t.regions.join(', ') : <span style={{ color: 'var(--muted)' }}>No states assigned</span>}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="section">
        <div className="panel-title">Quarterly budget targets</div>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 16, maxWidth: 560 }}>
          These are the numbers the sales team sets for themselves — DEAR has no concept of a
          target, so this is the one place that has to be typed in by hand. Once set, the Sales
          Ledger page compares real invoiced totals against these automatically.
        </div>

        <div style={{ display: 'flex', gap: 10, marginBottom: 20 }}>
          {isManager && (
            <select value={selectedRep} onChange={e => setSelectedRep(e.target.value)}>
              {reps?.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          )}
          <select value={year} onChange={e => setYear(Number(e.target.value))}>
            {[year - 1, year, year + 1].map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>

        {!targets ? (
          <div className="empty-state">Loading…</div>
        ) : (
          <div className="manifest" style={{ maxWidth: 560 }}>
            <div className="m-row head" style={{ gridTemplateColumns: '1.4fr 1fr 0.8fr' }}>
              <div>Quarter</div><div>Target</div><div></div>
            </div>
            {[1, 2, 3, 4].map(q => (
              <div className="m-row" key={q} style={{ gridTemplateColumns: '1.4fr 1fr 0.8fr', cursor: 'default' }}>
                <div>{QUARTER_LABELS[q - 1]}</div>
                <div>
                  <input
                    type="number"
                    min="0"
                    value={drafts[q] ?? ''}
                    onChange={e => setDrafts({ ...drafts, [q]: e.target.value })}
                    style={{ width: '100%', padding: '5px 8px', border: '1px solid var(--line)', borderRadius: 3 }}
                    placeholder="$0"
                  />
                </div>
                <div>
                  <button className="btn secondary" style={{ padding: '5px 12px', fontSize: 12 }} disabled={saving === q} onClick={() => saveQuarter(q)}>
                    {saving === q ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {targets && targets.length > 0 && (
          <div style={{ marginTop: 14, fontSize: 12.5, color: 'var(--muted)' }}>
            Year total set: {fmtMoney(targets.reduce((s, t) => s + t.amount, 0))}
          </div>
        )}
      </div>
    </>
  );
}