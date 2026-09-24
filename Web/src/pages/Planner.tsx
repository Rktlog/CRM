import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiGet, apiPatch, apiPost } from '../lib/api';
import AddTaskModal from '../components/AddTaskModal';

type TaskAccount = { id: string; name: string; region: string; phone: string | null };
type Task = { id: string; note: string | null; account: TaskAccount };
type TodayData = { fixedVisits: Task[]; coldCalls: Task[]; limit: number };
type SuggestedAccount = { id: string; name: string; region: string; phone: string | null };
type Suggested = { newLeads: SuggestedAccount[]; inactive: SuggestedAccount[]; regions: string[] };

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

export default function Planner() {
  const [data, setData] = useState<TodayData | null>(null);
  const [suggested, setSuggested] = useState<Suggested | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [addingId, setAddingId] = useState<string | null>(null);
  const navigate = useNavigate();

  function load() {
    apiGet('/tasks/today').then(setData).catch(e => setError(e.message));
    apiGet('/tasks/suggested').then(setSuggested).catch(() => {});
  }
  useEffect(load, []);

  async function complete(id: string) {
    await apiPatch(`/tasks/${id}`, { completed: true });
    load();
  }

  async function addSuggestion(accountId: string) {
    setAddingId(accountId);
    try {
      await apiPost('/tasks', { accountId, type: 'cold_call', scheduledDate: todayISO() });
      load();
    } finally {
      setAddingId(null);
    }
  }

  if (error) return <div className="empty-state">Couldn't load planner: {error}</div>;

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h1>Today's plan</h1>
        <button className="btn" onClick={() => setShowAdd(true)}>+ Schedule task</button>
      </div>

      {!data ? (
        <div className="empty-state">Loading…</div>
      ) : (
        <>
          <div className="section">
            <div className="panel-title">Fixed visits</div>
            {data.fixedVisits.length === 0 ? (
              <div className="empty-state">No visits scheduled today.</div>
            ) : (
              <div className="manifest">
                {data.fixedVisits.map(t => (
                  <div className="m-row" key={t.id} style={{ gridTemplateColumns: '30px 1.5fr 1fr' }}>
                    <input type="checkbox" onChange={() => complete(t.id)} />
                    <div onClick={() => navigate(`/accounts/${t.account.id}`)} style={{ cursor: 'pointer' }}>
                      <div className="acct-name">{t.account.name}</div>
                      <div className="acct-region">{t.account.region}{t.note ? ` · ${t.note}` : ''}</div>
                    </div>
                    <div>{t.account.phone ?? '—'}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="section">
            <div className="panel-title">Cold calls — {data.coldCalls.length} of {data.limit} today</div>
            {data.coldCalls.length === 0 ? (
              <div className="empty-state">Nothing queued. Schedule one, or add a suggestion below.</div>
            ) : (
              <div className="manifest">
                {data.coldCalls.map(t => (
                  <div className="m-row" key={t.id} style={{ gridTemplateColumns: '30px 1.5fr 1fr' }}>
                    <input type="checkbox" onChange={() => complete(t.id)} />
                    <div onClick={() => navigate(`/accounts/${t.account.id}`)} style={{ cursor: 'pointer' }}>
                      <div className="acct-name">{t.account.name}</div>
                      <div className="acct-region">{t.account.region}{t.note ? ` · ${t.note}` : ''}</div>
                    </div>
                    <div>{t.account.phone ?? '—'}</div>
                  </div>
                ))}
              </div>
            )}
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 10 }}>
              Anything left unchecked tonight rolls to tomorrow automatically — adjust the daily limit in Settings.
            </div>
          </div>

          {suggested && (
            <div className="section">
              <div className="panel-title">
                Suggested outreach {suggested.regions.length > 0 ? `— ${suggested.regions.join(', ')}` : '— no territory assigned yet'}
              </div>
              {suggested.newLeads.length === 0 && suggested.inactive.length === 0 ? (
                <div className="empty-state">Nothing suggested right now.</div>
              ) : (
                <>
                  {suggested.newLeads.length > 0 && (
                    <>
                      <div style={{ fontSize: 12, color: 'var(--muted)', margin: '10px 0 4px' }}>New leads</div>
                      <div className="manifest">
                        {suggested.newLeads.map(a => (
                          <div className="m-row" key={a.id} style={{ gridTemplateColumns: '1.5fr 1fr 90px' }}>
                            <div onClick={() => navigate(`/accounts/${a.id}`)} style={{ cursor: 'pointer' }}>
                              <div className="acct-name">{a.name}</div>
                              <div className="acct-region">{a.region}</div>
                            </div>
                            <div>{a.phone ?? '—'}</div>
                            <div>
                              <button className="btn secondary" style={{ padding: '4px 10px', fontSize: 11.5 }} disabled={addingId === a.id} onClick={() => addSuggestion(a.id)}>
                                {addingId === a.id ? '…' : '+ Add'}
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                  {suggested.inactive.length > 0 && (
                    <>
                      <div style={{ fontSize: 12, color: 'var(--muted)', margin: '14px 0 4px' }}>Overdue customers</div>
                      <div className="manifest">
                        {suggested.inactive.map(a => (
                          <div className="m-row" key={a.id} style={{ gridTemplateColumns: '1.5fr 1fr 90px' }}>
                            <div onClick={() => navigate(`/accounts/${a.id}`)} style={{ cursor: 'pointer' }}>
                              <div className="acct-name">{a.name}</div>
                              <div className="acct-region">{a.region}</div>
                            </div>
                            <div>{a.phone ?? '—'}</div>
                            <div>
                              <button className="btn secondary" style={{ padding: '4px 10px', fontSize: 11.5 }} disabled={addingId === a.id} onClick={() => addSuggestion(a.id)}>
                                {addingId === a.id ? '…' : '+ Add'}
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          )}
        </>
      )}

      {showAdd && <AddTaskModal onCreated={load} onClose={() => setShowAdd(false)} />}
    </>
  );
}