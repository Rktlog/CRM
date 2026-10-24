import { Component, ReactNode, useEffect, useRef, useState } from 'react';
import { apiGet, apiPost, apiPut } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import DictationTextarea from '../components/DictationTextarea';

// Ask the CRM a question in plain words and get an answer from your own data: customers, open quotes, stock and ETAs.
// It can only read what you can already see, and it changes nothing. You can talk to it with the microphone.
// Managers set the limits (per person per day, team per month) under Limits.

type Msg = { role: 'user' | 'assistant'; content: string; tools?: string[] };
type Settings = { enabled: boolean; maxReplyTokens: number; perRequestTokens: number; userDailyTokens: number; monthlyTokens: number; monthlyUsd: number; usdPerMInput: number; usdPerMOutput: number };
type Status = { configured: boolean; settings: Settings; usage: { userDayTokens: number; monthTokens: number; monthCostUsd: number | null }; blocked: string | null };

const TOOL_WORDS: Record<string, string> = { find_accounts: 'accounts', account_summary: 'an account', open_quotes: 'open quotes', product_lookup: 'products' };
const SUGGESTIONS = [
  'Which open quotes are older than 30 days?',
  'Brief me on Little Whimsy before my call',
  'Which EOL products are still in stock?',
  'What is the ETA on Rubbabu stock?',
];
const FIELDS: { key: keyof Settings; label: string; hint: string }[] = [
  { key: 'userDailyTokens', label: 'Tokens per person per day', hint: 'Everything one person asks, added up' },
  { key: 'monthlyTokens', label: 'Tokens per month (team)', hint: 'The whole team, per calendar month' },
  { key: 'perRequestTokens', label: 'Tokens per question', hint: 'Stops one question running away' },
  { key: 'maxReplyTokens', label: 'Longest reply', hint: 'In tokens' },
  { key: 'monthlyUsd', label: 'Monthly dollar limit', hint: '0 = none. Needs the two prices below' },
  { key: 'usdPerMInput', label: 'Price per million input tokens ($)', hint: 'Use the dearest model you use' },
  { key: 'usdPerMOutput', label: 'Price per million output tokens ($)', hint: 'Use the dearest model you use' },
];
const DEFAULT_SETTINGS: Settings = { enabled: true, maxReplyTokens: 1000, perRequestTokens: 40_000, userDailyTokens: 150_000, monthlyTokens: 3_000_000, monthlyUsd: 0, usdPerMInput: 0, usdPerMOutput: 0 };
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const n = (v: unknown) => num(v).toLocaleString('en-AU');

// Whatever the server sends, the page copes: a missing number counts as 0, a missing block is left out. Before this, one missing
// number (an older or half-deployed API, a null where a number should be) crashed the whole page and left it blank.
function cleanStatus(raw: unknown): Status | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, any>;
  const settings: Settings | null = r.settings && typeof r.settings === 'object' ? { ...DEFAULT_SETTINGS, ...Object.fromEntries(Object.entries(r.settings).filter(([k, v]) => k in DEFAULT_SETTINGS && (typeof v === 'number' || typeof v === 'boolean'))) } as Settings : null;
  const usage = r.usage && typeof r.usage === 'object' ? { userDayTokens: num(r.usage.userDayTokens), monthTokens: num(r.usage.monthTokens), monthCostUsd: typeof r.usage.monthCostUsd === 'number' && Number.isFinite(r.usage.monthCostUsd) ? r.usage.monthCostUsd : null } : null;
  return { configured: r.configured !== false, settings: settings as Settings, usage: usage as Status['usage'], blocked: typeof r.blocked === 'string' && r.blocked ? r.blocked : null };
}

// If anything in the page ever fails again, this shows what went wrong instead of a blank screen.
class Guard extends Component<{ children: ReactNode }, { error: Error | null; tries: number }> {
  state = { error: null as Error | null, tries: 0 };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { console.error('Assistant page failed', error); }
  render() {
    if (!this.state.error) return <div key={this.state.tries}>{this.props.children}</div>;
    return (
      <div className="section">
        <h1>Assistant</h1>
        <div className="save-msg err" style={{ marginBottom: 10 }}>The Assistant page hit a problem and stopped: {this.state.error.message}</div>
        <button className="btn" onClick={() => this.setState({ error: null, tries: this.state.tries + 1 })}>Try again</button>
        <div className="acct-region" style={{ marginTop: 8 }}>If it keeps happening, send that message to whoever looks after the CRM.</div>
      </div>
    );
  }
}

function AssistantPage() {
  const { role } = useAuth();
  const isManager = role === 'manager';
  const [messages, setMessages] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [showLimits, setShowLimits] = useState(false);
  const [form, setForm] = useState<Settings | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);

  const loadStatus = () => apiGet('/ai/status').then((raw: unknown) => {
    const s = cleanStatus(raw);
    if (!s) { setError('The assistant\'s status came back in a form this page does not know. Reload the page. If it keeps happening, the API may need updating.'); return; }
    setStatus(s); setForm(f => f ?? s.settings);
  }).catch(e => setError(e instanceof Error ? e.message : String(e)));
  useEffect(() => { loadStatus(); }, []);
  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, busy]);

  async function send(q?: string) {
    const question = (q ?? text).trim();
    if (!question || busy) return;
    const next: Msg[] = [...messages, { role: 'user', content: question }];
    setMessages(next); setText(''); setError(null); setBusy(true);
    try {
      const r = await apiPost('/ai/chat', { messages: next.map(m => ({ role: m.role, content: m.content })) });
      setMessages([...next, { role: 'assistant', content: typeof r?.reply === 'string' ? r.reply : '', tools: Array.isArray(r?.tools) ? r.tools.filter((t: unknown) => typeof t === 'string') : [] }]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      loadStatus();
    }
  }

  async function saveLimits() {
    if (!form) return;
    setSaved(null); setError(null);
    try { await apiPut('/ai/settings', form); setSaved('Saved'); loadStatus(); }
    catch (e) { setError((e as Error).message); }
  }

  const u = status?.usage, s = status?.settings;
  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <h1>Assistant</h1>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {messages.length > 0 && <button className="btn secondary" onClick={() => { setMessages([]); setError(null); }}>New chat</button>}
          {isManager && <button className="btn secondary" onClick={() => setShowLimits(v => !v)}>{showLimits ? 'Hide limits' : 'Limits'}</button>}
        </div>
      </div>
      <div className="acct-region" style={{ marginBottom: 10, maxWidth: 720 }}>
        Ask about customers, open quotes, stock and ETAs. It reads your own data and only what you can already see. It changes nothing.
      </div>

      {status && !status.configured && <div className="save-msg err" style={{ marginBottom: 10 }}>Claude isn't set up yet. The API needs <b>ANTHROPIC_API_KEY</b>.</div>}
      {status?.blocked && <div className="save-msg err" style={{ marginBottom: 10 }}>{status.blocked}</div>}
      {u && s && (
        <div className="acct-region" style={{ marginBottom: 12 }}>
          Today you've used {n(u.userDayTokens)} of {n(s.userDailyTokens)} tokens. The team has used {n(u.monthTokens)} of {n(s.monthlyTokens)} this month
          {u.monthCostUsd != null ? `, about $${n(u.monthCostUsd)}${s.monthlyUsd > 0 ? ` of $${n(s.monthlyUsd)}` : ''}` : ''}.
        </div>
      )}

      {isManager && showLimits && form && (
        <div className="section">
          <div className="panel-title">Limits <span className="plan-count">on top of the spend limit set in the Claude Console</span></div>
          <label className="acct-region" style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 10 }}>
            <input type="checkbox" checked={form.enabled} onChange={e => setForm({ ...form, enabled: e.target.checked })} /> Assistant on
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
            {FIELDS.map(f => (
              <label key={f.key} className="modal-field">
                {f.label}
                <input type="number" min={0} step="any" value={Number(form[f.key])} onChange={e => setForm({ ...form, [f.key]: Number(e.target.value) })} />
                <span className="acct-region">{f.hint}</span>
              </label>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 10 }}>
            <button className="btn" onClick={saveLimits}>Save limits</button>
            {saved && <span className="save-msg ok">{saved}</span>}
          </div>
        </div>
      )}

      <div className="section" style={{ minHeight: 260 }}>
        {messages.length === 0 && (
          <div>
            <div className="stat-label" style={{ marginBottom: 8 }}>Try asking</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {SUGGESTIONS.map(q => <button key={q} type="button" className="pill neutral" style={{ cursor: 'pointer', border: 'none', fontSize: 13, padding: '6px 12px' }} onClick={() => send(q)}>{q}</button>)}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start', margin: '10px 0' }}>
            <div style={{ maxWidth: '82%', padding: '9px 13px', borderRadius: 8, whiteSpace: 'pre-wrap', lineHeight: 1.45, background: m.role === 'user' ? 'var(--teal)' : 'var(--paper, #f6f4ef)', color: m.role === 'user' ? '#fff' : 'inherit', border: m.role === 'user' ? 'none' : '1px solid var(--line)' }}>
              {m.content}
              {Array.isArray(m.tools) && m.tools.length > 0 && <div className="acct-region" style={{ marginTop: 6, fontSize: 11.5 }}>Looked up: {m.tools.map(t => TOOL_WORDS[t] ?? t).join(', ')}</div>}
            </div>
          </div>
        ))}
        {busy && <div className="acct-region" style={{ margin: '10px 0' }}>Looking that up…</div>}
        <div ref={end} />
      </div>

      {error && <div className="save-msg err" style={{ marginBottom: 8 }}>{error}</div>}
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <DictationTextarea
            value={text}
            onChange={setText}
            tidy={false}
            rows={2}
            placeholder="Ask a question, or press the microphone and say it"
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          />
        </div>
        <button className="btn" disabled={busy || !text.trim() || !!status?.blocked || status?.configured === false} onClick={() => send()}>{busy ? '…' : 'Ask'}</button>
      </div>
      <div className="acct-region" style={{ marginTop: 4 }}>Enter to send, Shift+Enter for a new line. Answers come from Claude using your CRM data, so check anything important.</div>
    </>
  );
}

export default function Assistant() {
  return <Guard><AssistantPage /></Guard>;
}