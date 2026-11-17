import { useEffect, useState, type CSSProperties } from 'react';
import { apiGet, apiPost } from '../lib/api';
import { errMsg, plusDaysLocal, shortDay, todayLocal, type FollowUp, type LogEntry } from '../lib/tradeshow';

// The log and follow-ups on a trade show order, quote or lead. Same rule as unpaid quotes: the 1st follow-up is a week after the show, for the
// sales team; whoever does it writes what happened and sets the next one (a date, and who: a rep, Ellen, or the sales team).
const field: CSSProperties = { padding: '6px 9px', border: '1px solid var(--line)', borderRadius: 3, font: 'inherit', fontSize: 14 };
const KIND_LABEL: Record<LogEntry['kind'], string> = { call: 'Call', email: 'Email', visit: 'Visit', note: 'Note', system: 'Radar' };
type Rep = { id: string; name: string };
let repsCache: Rep[] | null = null;

export default function TsLogFollowUps({ target, log, followUps, closed, closedNote, onChange }: {
  target: { orderId?: string; leadId?: string }; log: LogEntry[]; followUps: FollowUp[]; closed: boolean; closedNote: string; onChange: () => void;
}) {
  const [reps, setReps] = useState<Rep[]>(repsCache ?? []);
  const [kind, setKind] = useState<'call' | 'email' | 'visit' | 'note'>('call');
  const [note, setNote] = useState('');
  const [doing, setDoing] = useState<string | null>(null);   // the follow-up being marked done
  const [nextOn, setNextOn] = useState(plusDaysLocal(14));
  const [nextWho, setNextWho] = useState('');
  const [setNext, setSetNext] = useState(true);
  const [bookOn, setBookOn] = useState(plusDaysLocal(7));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { if (!repsCache) apiGet('/tradeshow/reps').then((d: { reps: Rep[] }) => { repsCache = d.reps; setReps(d.reps); }).catch(() => {}); }, []);
  const open = followUps.find(f => !f.doneOn);

  async function run(f: () => Promise<unknown>, ok: string) {
    if (busy) return;
    setBusy(true); setMsg(null);
    try { await f(); setMsg({ ok: true, text: ok }); setNote(''); setDoing(null); onChange(); } catch (e) { setMsg({ ok: false, text: errMsg(e) }); } finally { setBusy(false); }
  }
  const addEntry = () => run(() => apiPost('/tradeshow/log', { ...target, kind, note }), 'Added to the log and the account history.');
  const done = (id: string) => run(() => apiPost(`/tradeshow/followups/${id}/done`, { kind, note, next: setNext ? { date: nextOn, repId: nextWho || null } : null }), setNext ? 'Done, and the next follow-up is set.' : 'Done.');
  const book = () => run(() => apiPost('/tradeshow/followups', { ...target, date: bookOn, repId: nextWho || null }), 'Follow-up booked.');

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
      <div className="card" style={{ marginBottom: 0 }}>
        <div className="panel-title">Follow-ups</div>
        {closed && <div className="acct-region" style={{ marginBottom: 8 }}>{closedNote}</div>}
        {!closed && open && (
          <div style={{ border: '1px solid var(--line)', borderRadius: 6, padding: '10px 12px', marginBottom: 10, background: open.dueOn < todayLocal() ? 'var(--rust-bg)' : 'var(--paper)' }}>
            <div style={{ fontSize: 14 }}><b>Next: {shortDay(open.dueOn)}</b> for {open.who?.name ?? 'the sales team'}{open.dueOn < todayLocal() && <span className="pill rust" style={{ marginLeft: 6 }}>Overdue</span>}</div>
            {doing !== open.id ? <button type="button" className="btn secondary" style={{ marginTop: 8 }} onClick={() => { setDoing(open.id); setMsg(null); }}>Mark done</button> : (
              <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
                <div style={{ display: 'flex', gap: 6 }}>{(['call', 'email', 'visit', 'note'] as const).map(k => <label key={k} style={{ fontSize: 13, display: 'flex', gap: 4, alignItems: 'center' }}><input type="radio" checked={kind === k} onChange={() => setKind(k)} />{KIND_LABEL[k]}</label>)}</div>
                <textarea style={{ ...field, minHeight: 60 }} placeholder="What happened?" value={note} onChange={e => setNote(e.target.value)} />
                <label style={{ fontSize: 13, display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={setNext} onChange={e => setSetNext(e.target.checked)} /> Set the next follow-up</label>
                {setNext && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <input type="date" style={field} value={nextOn} min={plusDaysLocal(1)} onChange={e => setNextOn(e.target.value)} />
                  <select style={field} value={nextWho} onChange={e => setNextWho(e.target.value)}><option value="">Sales team</option>{reps.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
                </div>}
                <div style={{ display: 'flex', gap: 8 }}><button type="button" className="btn" disabled={busy || !note.trim()} onClick={() => done(open.id)}>{busy ? 'Saving…' : 'Save'}</button><button type="button" className="link-btn" onClick={() => setDoing(null)}>Cancel</button></div>
              </div>
            )}
          </div>
        )}
        {!closed && !open && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
            <span style={{ fontSize: 13 }}>No follow-up booked.</span>
            <input type="date" style={field} value={bookOn} min={todayLocal()} onChange={e => setBookOn(e.target.value)} />
            <select style={field} value={nextWho} onChange={e => setNextWho(e.target.value)}><option value="">Sales team</option>{reps.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
            <button type="button" className="btn secondary" disabled={busy} onClick={book}>Book</button>
          </div>
        )}
        {followUps.filter(f => f.doneOn).map(f => (
          <div key={f.id} style={{ fontSize: 13, padding: '5px 0', borderTop: '1px solid var(--line)' }}>
            <span className="pill teal" style={{ fontSize: 12 }}>Done {shortDay(f.doneOn)}</span> due {shortDay(f.dueOn)} for {f.who?.name ?? 'sales team'}{f.doneBy ? `, by ${f.doneBy}` : ''}{f.doneNote ? `: ${f.doneNote}` : ''}
          </div>
        ))}
        {msg && <div className={msg.ok ? 'save-msg ok' : 'save-msg err'} role={msg.ok ? 'status' : 'alert'}>{msg.text}</div>}
      </div>

      <div className="card" style={{ marginBottom: 0 }}>
        <div className="panel-title">Log</div>
        <div style={{ display: 'grid', gap: 8, marginBottom: 12 }}>
          <div style={{ display: 'flex', gap: 10 }}>{(['call', 'email', 'visit', 'note'] as const).map(k => <label key={k} style={{ fontSize: 13, display: 'flex', gap: 4, alignItems: 'center' }}><input type="radio" name="logkind" checked={kind === k} onChange={() => setKind(k)} />{KIND_LABEL[k]}</label>)}</div>
          <textarea style={{ ...field, minHeight: 54 }} placeholder="Add to the log (it also goes in the customer's history)" value={doing ? '' : note} disabled={!!doing} onChange={e => setNote(e.target.value)} />
          <div><button type="button" className="btn secondary" disabled={busy || !!doing || !note.trim()} onClick={addEntry}>Add</button></div>
        </div>
        {log.length === 0 && <div className="acct-region">Nothing yet.</div>}
        {log.map(l => (
          <div key={l.id} style={{ fontSize: 13.5, padding: '7px 0', borderTop: '1px solid var(--line)' }}>
            <span className={`pill ${l.kind === 'system' ? 'neutral' : 'teal'}`} style={{ fontSize: 12 }}>{KIND_LABEL[l.kind]}</span>{' '}
            <span className="acct-region" style={{ fontSize: 12.5 }}>{new Date(l.at).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}{l.by ? ` · ${l.by}` : ''}</span>
            <div style={{ whiteSpace: 'pre-wrap', marginTop: 3 }}>{l.note}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
