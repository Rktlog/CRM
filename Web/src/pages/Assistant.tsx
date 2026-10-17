import { useEffect, useRef, useState } from 'react';
import { apiGet, apiPut, apiPatch, apiDelete, apiDownload } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import DictationTextarea from '../components/DictationTextarea';
import { Markdown } from '../lib/markdown';
import { streamChat, MadeFile, SendMessage, Step, Chart } from '../lib/aiStream';
import { ACCEPT, Pending, acceptFiles, readFile, sizeLabel } from '../lib/attachments';
import { chartSrc, downloadSvg, downloadPng } from '../lib/chartDownload';

// Claude, inside the CRM. Ask anything, in words or with the microphone. It looks things up in your data, summarises,
// forecasts, prices, draws charts, writes reports (Excel, CSV, Word, PDF) and reads files you attach. It reads only what you
// can already see and changes nothing. Chats are saved for you alone, in the list on the left, and you can search, rename,
// reopen and delete them. Managers set the limits and the company's instructions under Limits.

type Att = { name: string; type: string; size: number; data?: string };   // data is there only for files attached in this visit
type Msg = { role: 'user' | 'assistant'; content: string; attachments?: Att[]; files?: MadeFile[]; tools?: string[]; steps?: Step[]; charts?: Chart[]; stopped?: boolean; thinking?: boolean };
type ChatSummary = { id: string; title: string; updatedAt: string; messages: number };
type Settings = { enabled: boolean; maxReplyTokens: number; perRequestTokens: number; userDailyTokens: number; monthlyTokens: number; monthlyUsd: number; usdPerMInput: number; usdPerMOutput: number; thinkingBudgetTokens: number; chatRetentionDays: number; instructions: string };
type Status = { configured: boolean; settings: Settings; instructionsSet: boolean; usage: { userDayTokens: number; monthTokens: number; monthCostUsd: number | null }; blocked: string | null };

const TOOL_WORDS: Record<string, string> = { find_accounts: 'Accounts', account_details: 'The customer', order_details: 'The order', open_quotes: 'Open quotes', product_lookup: 'Products', run_report: 'Report data', create_file: 'A file', query_data: 'CRM data', calculate: 'Calculation', make_chart: 'A chart' };
const SUGGESTIONS = [
  'Summarise our open quotes older than 30 days and tell me who to chase first',
  'Who owes us money, and how overdue is it?',
  'Chart our sales by month for the last 12 months',
  'Forecast the next 3 months of sales by brand, and what I should reorder',
  'Compare the attached supplier price list with our prices',
  'Tell me everything about Little Whimsy before my call',
  'Write a one-page Word report on our open quotes for the Monday meeting',
];
const FIELDS: { key: Exclude<keyof Settings, 'enabled' | 'instructions'>; label: string; hint: string }[] = [
  { key: 'userDailyTokens', label: 'Tokens per person per day', hint: 'Everything one person asks, added up' },
  { key: 'monthlyTokens', label: 'Tokens per month (team)', hint: 'The whole team, per calendar month' },
  { key: 'perRequestTokens', label: 'Tokens per question', hint: 'Stops one question running away' },
  { key: 'maxReplyTokens', label: 'Longest reply', hint: 'In tokens, up to 16,000. Raise it for long reports' },
  { key: 'thinkingBudgetTokens', label: 'Thinking budget (Think harder)', hint: 'How much it may think first: 1,024 to 32,000' },
  { key: 'chatRetentionDays', label: 'Days to keep saved chats', hint: '0 keeps them for ever' },
  { key: 'monthlyUsd', label: 'Monthly dollar limit', hint: '0 = none. Needs the two prices below' },
  { key: 'usdPerMInput', label: 'Price per million input tokens ($)', hint: 'Use the dearest model you use' },
  { key: 'usdPerMOutput', label: 'Price per million output tokens ($)', hint: 'Use the dearest model you use' },
];
const n = (v: number) => v.toLocaleString('en-AU');
const ago = (iso: string) => {
  const d = new Date(iso), days = Math.floor((Date.now() - d.getTime()) / 86400000);
  return days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : days < 7 ? `${days} days ago` : d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
};
function useWide(): boolean {
  const q = '(min-width: 900px)';
  const [wide, setWide] = useState(() => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(q).matches : true));
  useEffect(() => {
    if (!window.matchMedia) return;
    const m = window.matchMedia(q), on = () => setWide(m.matches);
    m.addEventListener?.('change', on); return () => m.removeEventListener?.('change', on);
  }, []);
  return wide;
}

export default function Assistant() {
  const { role } = useAuth();
  const isManager = role === 'manager', wide = useWide();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [chatId, setChatId] = useState<string | null>(null);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [search, setSearch] = useState('');
  const [showList, setShowList] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; text: string } | null>(null);
  const [editing, setEditing] = useState<{ index: number; text: string } | null>(null);
  const [text, setText] = useState('');
  const [pending, setPending] = useState<Pending[]>([]);
  const [think, setThink] = useState(false);
  const [live, setLive] = useState('');
  const [statusLine, setStatusLine] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileNote, setFileNote] = useState<string | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [showLimits, setShowLimits] = useState(false);
  const [form, setForm] = useState<Settings | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [prefs, setPrefs] = useState('');
  const [prefsSaved, setPrefsSaved] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  const loadStatus = () => apiGet('/ai/status').then((s: Status) => { setStatus(s); setForm(f => f ?? s.settings); }).catch(e => setError(e.message));
  const loadChats = (q = search) => apiGet(`/ai/chats${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`).then(r => setChats(r.chats)).catch(() => { /* the list is a convenience */ });
  useEffect(() => { loadStatus(); }, []);
  useEffect(() => { const t = setTimeout(() => { loadChats(search); }, search ? 250 : 0); return () => clearTimeout(t); }, [search]);
  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, live, busy]);
  useEffect(() => () => abort.current?.abort(), []);   // leaving the page stops an answer in progress

  async function addFiles(list: File[]) {
    if (!list.length) return;
    const r = acceptFiles(pending, list.map(f => ({ name: f.name, size: f.size })));
    setFileNote(r.error);
    try { const read = await Promise.all(r.ok.map(i => readFile(list[i]))); setPending(p => [...p, ...read]); }
    catch (e) { setFileNote((e as Error).message); }
  }

  // Sends `history` (ending with the person's question). `keep`: how many saved messages stay, so asking again or editing replaces what came after.
  async function run(history: Msg[], keep: number | null) {
    setMessages(history); setText(''); setPending([]); setFileNote(null); setError(null); setLive(''); setStatusLine('Thinking…'); setBusy(true); setEditing(null);
    const ctl = new AbortController(); abort.current = ctl;
    const payload: SendMessage[] = history.map(m => {
      const files = m.role === 'user' ? m.attachments?.filter(a => a.data).map(a => ({ name: a.name, type: a.type, data: a.data! })) : undefined;   // a file kept only by name cannot be sent again
      return { role: m.role, content: m.content, attachments: files && files.length ? files : undefined };
    });
    let acc = '';
    try {
      await streamChat(payload, {
        signal: ctl.signal, chatId, keep: chatId ? keep : null, think,
        onEvent: e => {
          if (e.type === 'text') { acc += e.delta; setLive(acc); setStatusLine(''); }
          else if (e.type === 'reset') { acc = ''; setLive(''); }
          else if (e.type === 'status') setStatusLine(e.text);
          else if (e.type === 'done') { setMessages([...history, { role: 'assistant', content: e.reply, files: e.files, tools: e.tools, steps: e.steps, charts: e.charts, thinking: think }]); if (e.chatId) setChatId(e.chatId); acc = ''; }
          else if (e.type === 'error') setError(e.error);
        },
      });
    } catch (e) {
      if ((e as Error).name === 'AbortError') { if (acc.trim()) setMessages([...history, { role: 'assistant', content: acc, stopped: true }]); }
      else setError((e as Error).message);
    } finally {
      setBusy(false); setLive(''); setStatusLine(''); abort.current = null; loadStatus(); loadChats();
    }
  }

  function send(q?: string) {
    const question = (q ?? text).trim();
    if ((!question && !pending.length) || busy) return;
    run([...messages, { role: 'user', content: question, attachments: pending.length ? pending : undefined }], null);
  }
  function regenerate() {
    const last = messages.length - 1;
    if (busy || last < 1 || messages[last].role !== 'assistant' || messages[last - 1].role !== 'user') return;
    run(messages.slice(0, last), last - 1);
  }
  function resendEdited(index: number, newText: string) {
    if (busy || !newText.trim()) return;
    run([...messages.slice(0, index), { ...messages[index], content: newText.trim() }], index);
  }

  function newChat() { abort.current?.abort(); setMessages([]); setChatId(null); setError(null); setPending([]); setEditing(null); setText(''); setShowList(false); }
  async function openChat(id: string) {
    abort.current?.abort(); setError(null); setEditing(null); setShowList(false);
    try {
      const c = await apiGet(`/ai/chats/${id}`);
      setMessages(c.messages.map((m: any): Msg => ({ role: m.role, content: m.content, attachments: m.meta?.attachments, files: m.meta?.files, tools: m.meta?.tools, steps: m.meta?.steps, charts: m.meta?.charts, thinking: m.meta?.thinking })));
      setChatId(id);
    } catch (e) { setError((e as Error).message); }
  }
  async function renameChat() {
    if (!renaming || !renaming.text.trim()) { setRenaming(null); return; }
    try { await apiPatch(`/ai/chats/${renaming.id}`, { title: renaming.text }); setRenaming(null); loadChats(); } catch (e) { setError((e as Error).message); }
  }
  async function deleteChat(c: ChatSummary) {
    if (!window.confirm(`Delete "${c.title}"? This cannot be undone.`)) return;
    try { await apiDelete(`/ai/chats/${c.id}`); if (c.id === chatId) newChat(); loadChats(); } catch (e) { setError((e as Error).message); }
  }
  async function deleteAll() {
    if (!window.confirm('Delete all of your saved chats? This cannot be undone.')) return;
    try { await apiDelete('/ai/chats'); newChat(); loadChats(); } catch (e) { setError((e as Error).message); }
  }

  async function openPrefs() { setPrefsOpen(o => !o); setPrefsSaved(null); if (!prefsOpen) { try { setPrefs((await apiGet('/ai/prefs')).text ?? ''); } catch (e) { setError((e as Error).message); } } }
  async function savePrefs() { try { await apiPut('/ai/prefs', { text: prefs }); setPrefsSaved('Saved'); } catch (e) { setError((e as Error).message); } }
  async function saveLimits() {
    if (!form) return;
    setSaved(null); setError(null);
    try { await apiPut('/ai/settings', form); setSaved('Saved'); loadStatus(); }
    catch (e) { setError((e as Error).message); }
  }

  const copy = (i: number) => { navigator.clipboard?.writeText(messages[i].content).then(() => { setCopied(i); setTimeout(() => setCopied(c => (c === i ? null : c)), 1500); }); };
  const u = status?.usage, s = status?.settings;
  const blocked = !!status?.blocked || status?.configured === false;
  const lastAssistant = messages.length - 1;

  const sidebar = (
    <aside style={{ width: wide ? 250 : '100%', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8 }} aria-label="Your chats">
      <button className="btn" type="button" onClick={newChat}>+ New chat</button>
      <input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search your chats" aria-label="Search your chats" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: wide ? 520 : 300, overflowY: 'auto' }}>
        {chats.length === 0 && <div className="acct-region" style={{ padding: 6 }}>{search ? 'No chats match.' : 'Your chats will be saved here.'}</div>}
        {chats.map(c => (
          <div key={c.id} style={{ padding: '7px 8px', borderRadius: 6, cursor: 'pointer', background: c.id === chatId ? 'var(--paper, #f0ede4)' : 'transparent', border: c.id === chatId ? '1px solid var(--line)' : '1px solid transparent' }}>
            {renaming?.id === c.id ? (
              <input autoFocus value={renaming.text} onChange={e => setRenaming({ id: c.id, text: e.target.value })} onBlur={renameChat} onKeyDown={e => { if (e.key === 'Enter') renameChat(); if (e.key === 'Escape') setRenaming(null); }} aria-label="Chat name" style={{ width: '100%' }} />
            ) : (
              <>
                <div onClick={() => openChat(c.id)} style={{ fontSize: 13.5, fontWeight: c.id === chatId ? 600 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.title}>{c.title}</div>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <span className="acct-region" style={{ fontSize: 11.5 }}>{ago(c.updatedAt)}</span>
                  <button type="button" className="link-btn" style={{ fontSize: 11.5 }} onClick={() => setRenaming({ id: c.id, text: c.title })}>Rename</button>
                  <button type="button" className="link-btn" style={{ fontSize: 11.5 }} onClick={() => deleteChat(c)}>Delete</button>
                </div>
              </>
            )}
          </div>
        ))}
      </div>
      {chats.length > 0 && <button type="button" className="link-btn" style={{ fontSize: 12, alignSelf: 'flex-start' }} onClick={deleteAll}>Delete all my chats</button>}
    </aside>
  );

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <h1>Assistant</h1>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {!wide && <button className="btn secondary" type="button" onClick={() => setShowList(v => !v)}>{showList ? 'Hide chats' : 'Chats'}</button>}
          <button className="btn secondary" type="button" onClick={openPrefs}>About me</button>
          {isManager && <button className="btn secondary" type="button" onClick={() => setShowLimits(v => !v)}>{showLimits ? 'Hide limits' : 'Limits'}</button>}
        </div>
      </div>
      <div className="acct-region" style={{ marginBottom: 10, maxWidth: 780 }}>
        Ask anything. It can look things up in your CRM, summarise, forecast, price, draw charts, write reports (Excel, CSV, Word, PDF) and read files you attach. It reads only what you can already see and changes nothing.
        Your chats are saved for you alone{status && s && s.chatRetentionDays > 0 ? ` and kept for ${s.chatRetentionDays} days` : ''}.
      </div>

      {status && !status.configured && <div className="save-msg err" style={{ marginBottom: 10 }}>Claude isn't set up yet. The API needs <b>ANTHROPIC_API_KEY</b>.</div>}
      {status?.blocked && <div className="save-msg err" style={{ marginBottom: 10 }}>{status.blocked}</div>}
      {u && s && (
        <div className="acct-region" style={{ marginBottom: 12 }}>
          Today you've used {n(u.userDayTokens)} of {n(s.userDailyTokens)} tokens. The team has used {n(u.monthTokens)} of {n(s.monthlyTokens)} this month
          {u.monthCostUsd != null ? `, about $${u.monthCostUsd.toLocaleString('en-AU')}${s.monthlyUsd > 0 ? ` of $${n(s.monthlyUsd)}` : ''}` : ''}.
        </div>
      )}

      {prefsOpen && (
        <div className="section">
          <div className="panel-title">About me <span className="plan-count">how you like the assistant to answer, for you only</span></div>
          <textarea value={prefs} onChange={e => setPrefs(e.target.value)} maxLength={2000} rows={4} style={{ width: '100%' }} aria-label="About me" placeholder="For example: I look after the Victorian stockists. Keep answers short. Show prices ex GST." />
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 6 }}>
            <button className="btn" type="button" onClick={savePrefs}>Save</button>
            {prefsSaved && <span className="save-msg ok">{prefsSaved}</span>}
            <span className="acct-region">{prefs.length}/2000</span>
          </div>
        </div>
      )}

      {isManager && showLimits && form && (
        <div className="section">
          <div className="panel-title">Limits and instructions <span className="plan-count">on top of the spend limit set in the Claude Console</span></div>
          <label className="acct-region" style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 10 }}>
            <input type="checkbox" checked={form.enabled} onChange={e => setForm({ ...form, enabled: e.target.checked })} /> Assistant on
          </label>
          <label className="modal-field" style={{ marginBottom: 12 }}>
            The company's instructions for the assistant
            <textarea value={form.instructions} onChange={e => setForm({ ...form, instructions: e.target.value })} rows={5} maxLength={4000} placeholder="For example: We are a gift wholesaler. Wholesale terms are 30 days. Always quote prices ex GST. Never promise delivery dates." style={{ width: '100%' }} />
            <span className="acct-region">Everyone's assistant follows this. {form.instructions.length}/4,000</span>
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

      <div style={{ display: 'flex', gap: 18, alignItems: 'flex-start', flexDirection: wide ? 'row' : 'column' }}>
        {(wide || showList) && sidebar}
        <div style={{ flex: 1, minWidth: 0, width: '100%' }}>
          <div className="section" style={{ minHeight: 300 }}>
            {messages.length === 0 && !busy && (
              <div>
                <div className="stat-label" style={{ marginBottom: 8 }}>Try asking</div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {SUGGESTIONS.map(q => <button key={q} type="button" className="pill neutral" style={{ cursor: 'pointer', border: 'none', fontSize: 13, padding: '6px 12px', textAlign: 'left' }} disabled={blocked} onClick={() => send(q)}>{q}</button>)}
                </div>
                <div className="acct-region" style={{ marginTop: 12 }}>Or attach a purchase order, a price list or a spreadsheet with the paperclip and ask for a summary, or to compare it with our data. Press <b>Think harder</b> for a tricky one.</div>
              </div>
            )}

            {messages.map((m, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start', margin: '12px 0' }}>
                <div style={{ maxWidth: '88%', padding: '9px 13px', borderRadius: 8, background: m.role === 'user' ? 'var(--teal)' : 'var(--paper, #f6f4ef)', color: m.role === 'user' ? '#fff' : 'inherit', border: m.role === 'user' ? 'none' : '1px solid var(--line)', minWidth: 0 }}>
                  {m.attachments && m.attachments.length > 0 && (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: m.content ? 6 : 0 }}>
                      {m.attachments.map((a, k) => <span key={k} className="pill neutral" style={{ fontSize: 12 }}>📎 {a.name} · {sizeLabel(a.size)}</span>)}
                    </div>
                  )}
                  {m.role === 'user' && editing?.index === i ? (
                    <div>
                      <textarea value={editing.text} onChange={e => setEditing({ index: i, text: e.target.value })} rows={3} style={{ width: '100%', color: '#111' }} aria-label="Edit your question" />
                      <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                        <button type="button" className="btn" disabled={busy || !editing.text.trim()} onClick={() => resendEdited(i, editing.text)}>Send</button>
                        <button type="button" className="btn secondary" onClick={() => setEditing(null)}>Cancel</button>
                      </div>
                    </div>
                  ) : m.role === 'user' ? (
                    <>
                      <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.45 }}>{m.content}</div>
                      {!busy && m.content && <button type="button" className="link-btn" style={{ color: '#fff', opacity: 0.85, fontSize: 12, marginTop: 4 }} onClick={() => setEditing({ index: i, text: m.content })}>Edit</button>}
                    </>
                  ) : (
                    <Markdown text={m.content} />
                  )}
                  {m.stopped && <div className="acct-region" style={{ marginTop: 4 }}>(stopped)</div>}
                  {m.charts && m.charts.map((c, k) => (
                    <figure key={k} style={{ margin: '10px 0 0' }}>
                      <img src={chartSrc(c.svg)} alt={c.title} style={{ maxWidth: '100%', border: '1px solid var(--line)', borderRadius: 6, background: '#fff' }} />
                      <figcaption style={{ display: 'flex', gap: 12, marginTop: 4 }}>
                        <button type="button" className="link-btn" onClick={() => downloadSvg(c.svg, c.title)}>Download SVG</button>
                        <button type="button" className="link-btn" onClick={() => downloadPng(c.svg, c.title).catch(e => setError(e.message))}>Download PNG</button>
                      </figcaption>
                    </figure>
                  ))}
                  {m.files && m.files.length > 0 && (
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                      {m.files.map(f => <button key={f.id} type="button" className="btn secondary" onClick={() => apiDownload(`/ai/files/${f.id}`, f.name).catch(e => setError(e.message))}>⬇ {f.name} ({sizeLabel(f.size)})</button>)}
                    </div>
                  )}
                  {m.role === 'assistant' && (
                    <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
                      <button type="button" className="link-btn" onClick={() => copy(i)}>{copied === i ? 'Copied' : 'Copy'}</button>
                      {i === lastAssistant && !busy && <button type="button" className="link-btn" onClick={regenerate}>Ask again</button>}
                      {m.thinking && <span className="acct-region" style={{ fontSize: 11.5 }}>Thought harder</span>}
                    </div>
                  )}
                  {m.role === 'assistant' && m.steps && m.steps.length > 0 && (
                    <details style={{ marginTop: 6 }}>
                      <summary className="acct-region" style={{ cursor: 'pointer', fontSize: 12 }}>What I looked at ({m.steps.length})</summary>
                      <ul style={{ margin: '4px 0 0 18px', padding: 0, fontSize: 12 }}>
                        {m.steps.map((st, k) => <li key={k}><b>{TOOL_WORDS[st.tool] ?? st.tool}</b> <code style={{ fontSize: 11 }}>{st.what}</code></li>)}
                      </ul>
                    </details>
                  )}
                </div>
              </div>
            ))}

            {busy && (
              <div style={{ display: 'flex', justifyContent: 'flex-start', margin: '12px 0' }}>
                <div style={{ maxWidth: '88%', padding: '9px 13px', borderRadius: 8, background: 'var(--paper, #f6f4ef)', border: '1px solid var(--line)' }}>
                  {live ? <Markdown text={live} /> : null}
                  {statusLine && <div className="acct-region">{statusLine}</div>}
                </div>
              </div>
            )}
            <div ref={end} />
          </div>

          {error && <div className="save-msg err" style={{ marginBottom: 8 }}>{error}</div>}
          {fileNote && <div className="save-msg err" style={{ marginBottom: 8 }}>{fileNote}</div>}
          {pending.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
              {pending.map((a, k) => (
                <span key={k} className="pill neutral" style={{ fontSize: 12.5 }}>
                  📎 {a.name} · {sizeLabel(a.size)}{' '}
                  <button type="button" aria-label={`Remove ${a.name}`} onClick={() => setPending(p => p.filter((_, j) => j !== k))} style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 0, marginLeft: 4 }}>✕</button>
                </span>
              ))}
            </div>
          )}
          <div
            style={{ display: 'flex', gap: 10, alignItems: 'flex-start', outline: dragging ? '2px dashed var(--teal)' : 'none', borderRadius: 6 }}
            onDragOver={e => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={e => { e.preventDefault(); setDragging(false); addFiles(Array.from(e.dataTransfer.files)); }}
            onPaste={e => { const f = Array.from(e.clipboardData.files); if (f.length) { e.preventDefault(); addFiles(f); } }}
          >
            <div style={{ flex: 1 }}>
              <DictationTextarea
                value={text}
                onChange={setText}
                tidy={false}
                rows={3}
                placeholder="Ask anything, attach a file, or press the microphone and say it"
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
              />
            </div>
            <input ref={picker} type="file" multiple accept={ACCEPT} style={{ display: 'none' }} onChange={e => { addFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn secondary" type="button" title="Attach a file" aria-label="Attach a file" disabled={busy || blocked} onClick={() => picker.current?.click()}>📎</button>
                {busy
                  ? <button className="btn secondary" type="button" onClick={() => abort.current?.abort()}>Stop</button>
                  : <button className="btn" type="button" disabled={blocked || (!text.trim() && !pending.length)} onClick={() => send()}>Ask</button>}
              </div>
              <button type="button" className={`pill ${think ? 'teal' : 'neutral'}`} aria-pressed={think} title="Let it reason longer before answering. Slower, and uses more of your allowance." onClick={() => setThink(v => !v)} style={{ cursor: 'pointer', border: 'none', fontSize: 12.5, padding: '4px 10px' }}>🧠 Think harder{think ? ': on' : ''}</button>
            </div>
          </div>
          <div className="acct-region" style={{ marginTop: 4 }}>Enter to send, Shift+Enter for a new line. You can drop or paste files here. Answers come from Claude using your CRM data, so check anything important.</div>
        </div>
      </div>
    </>
  );
}