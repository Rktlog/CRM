import { useRef, useState } from 'react';
import { apiPost } from '../lib/api';
import { errMsg } from '../lib/tradeshow';
import { sel } from '../lib/tsExtra';

// Ask Claude about a show: how it compares with last year, who needs a follow-up, what is unpaid, whether to take it, and drafts of follow-up emails.
// It answers only from the show's data in Radar.
type Msg = { role: 'user' | 'assistant'; content: string };
const IDEAS = ['How did this show compare with the same show last year?', 'Which orders are unpaid, and who should we chase first?', 'Which leads still need a follow-up? Draft an email for the first one.', 'Should we take this show again? Give me the figures.'];
export default function TsAsk({ showId }: { showId: string | null }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  async function ask(text: string) {
    const question = text.trim(); if (!question || busy) return;
    setBusy(true); setErr(null); setQ('');
    const history = msgs;
    setMsgs([...history, { role: 'user', content: question }]);
    try { const r = await apiPost('/tradeshow/ask', { showId, question, history }); setMsgs(m => [...m, { role: 'assistant', content: r.answer }]); setTimeout(() => end.current?.scrollIntoView({ behavior: 'smooth' }), 50); }
    catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  }
  return (
    <div style={{ maxWidth: 820 }}>
      <div className="acct-region" style={{ fontSize: 13, marginBottom: 10 }}>Claude answers from this show's orders, leads, payments, offers, appointments, feedback and the same show in other years. It can also write follow-up emails.</div>
      {!msgs.length && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>{IDEAS.map(i => <button key={i} type="button" className="btn secondary" style={{ fontSize: 13 }} disabled={busy} onClick={() => ask(i)}>{i}</button>)}</div>}
      {msgs.map((m, i) => (
        <div key={i} style={{ margin: '10px 0', padding: '10px 12px', borderRadius: 6, background: m.role === 'user' ? 'var(--panel)' : 'transparent', border: m.role === 'user' ? '1px solid var(--line)' : 'none', whiteSpace: 'pre-wrap', fontSize: 14.5, lineHeight: 1.55 }}>
          {m.role === 'user' ? <b>{m.content}</b> : m.content}
          {m.role === 'assistant' && <div><button type="button" className="link-btn" style={{ fontSize: 12.5 }} onClick={() => navigator.clipboard?.writeText(m.content).catch(() => {})}>Copy</button></div>}
        </div>
      ))}
      {busy && <div className="acct-region">Claude is working it out…</div>}
      {err && <div className="save-msg err" role="alert">{err}</div>}
      <form style={{ display: 'flex', gap: 8, marginTop: 10 }} onSubmit={e => { e.preventDefault(); ask(q); }}>
        <input style={{ ...sel, flex: 1 }} placeholder="Ask about this show" value={q} onChange={e => setQ(e.target.value)} disabled={busy} />
        <button type="submit" className="btn" disabled={busy || !q.trim()}>Ask</button>
        {msgs.length > 0 && <button type="button" className="btn secondary" disabled={busy} onClick={() => { setMsgs([]); setErr(null); }}>New chat</button>}
      </form>
      <div ref={end} />
    </div>
  );
}
