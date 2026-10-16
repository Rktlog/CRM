import { useEffect, useRef, useState } from 'react';
import { apiGet, apiPut, apiDownload } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import DictationTextarea from '../components/DictationTextarea';
import { Markdown } from '../lib/markdown';
import { streamChat, MadeFile, SendMessage } from '../lib/aiStream';
import { ACCEPT, Pending, acceptFiles, readFile, sizeLabel } from '../lib/attachments';

// Claude chat, inside the CRM. Ask in plain words (or say it with the microphone): it looks things up in your data,
// summarises, writes reports as Excel or CSV you can download, and reads files you attach (PDF, images, Excel, CSV, text,
// Word). It can only read what you can already see and changes nothing. The conversation lives in this page only.
// Managers set the limits (per person per day, team per month) under Limits.

type Msg = { role: 'user' | 'assistant'; content: string; attachments?: Pending[]; files?: MadeFile[]; tools?: string[]; stopped?: boolean };
type Settings = { enabled: boolean; maxReplyTokens: number; perRequestTokens: number; userDailyTokens: number; monthlyTokens: number; monthlyUsd: number; usdPerMInput: number; usdPerMOutput: number };
type Status = { configured: boolean; settings: Settings; usage: { userDayTokens: number; monthTokens: number; monthCostUsd: number | null }; blocked: string | null };

const TOOL_WORDS: Record<string, string> = { find_accounts: 'accounts', account_summary: 'an account', open_quotes: 'open quotes', product_lookup: 'products', run_report: 'report data', create_file: 'a file' };
const SUGGESTIONS = [
  'Summarise our open quotes older than 30 days and tell me who to chase first',
  'Make an Excel of sales by brand and state for the last 90 days',
  'Which EOL products still have stock, and when is more due?',
  'Brief me on Little Whimsy before my call',
  'Write a one-page Word report on our open quotes for the Monday meeting',
];
const FIELDS: { key: keyof Settings; label: string; hint: string }[] = [
  { key: 'userDailyTokens', label: 'Tokens per person per day', hint: 'Everything one person asks, added up' },
  { key: 'monthlyTokens', label: 'Tokens per month (team)', hint: 'The whole team, per calendar month' },
  { key: 'perRequestTokens', label: 'Tokens per question', hint: 'Stops one question running away' },
  { key: 'maxReplyTokens', label: 'Longest reply', hint: 'In tokens. Raise it for long reports' },
  { key: 'monthlyUsd', label: 'Monthly dollar limit', hint: '0 = none. Needs the two prices below' },
  { key: 'usdPerMInput', label: 'Price per million input tokens ($)', hint: 'Use the dearest model you use' },
  { key: 'usdPerMOutput', label: 'Price per million output tokens ($)', hint: 'Use the dearest model you use' },
];
const n = (v: number) => v.toLocaleString('en-AU');

export default function Assistant() {
  const { role } = useAuth();
  const isManager = role === 'manager';
  const [messages, setMessages] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [pending, setPending] = useState<Pending[]>([]);
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
  const abort = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  const loadStatus = () => apiGet('/ai/status').then((s: Status) => { setStatus(s); setForm(f => f ?? s.settings); }).catch(e => setError(e.message));
  useEffect(() => { loadStatus(); }, []);
  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, live, busy]);
  useEffect(() => () => abort.current?.abort(), []);   // leaving the page stops an answer in progress

  async function addFiles(list: File[]) {
    if (!list.length) return;
    const r = acceptFiles(pending, list.map(f => ({ name: f.name, size: f.size })));
    setFileNote(r.error);
    try { const read = await Promise.all(r.ok.map(i => readFile(list[i]))); setPending(p => [...p, ...read]); }
    catch (e) { setFileNote((e as Error).message); }
  }

  async function send(q?: string) {
    const question = (q ?? text).trim();
    if ((!question && !pending.length) || busy) return;
    const next: Msg[] = [...messages, { role: 'user', content: question, attachments: pending.length ? pending : undefined }];
    setMessages(next); setText(''); setPending([]); setFileNote(null); setError(null); setLive(''); setStatusLine('Thinking…'); setBusy(true);
    const ctl = new AbortController(); abort.current = ctl;
    const payload: SendMessage[] = next.map(m => ({ role: m.role, content: m.content, attachments: m.role === 'user' ? m.attachments?.map(a => ({ name: a.name, type: a.type, data: a.data })) : undefined }));
    let acc = '';
    try {
      await streamChat(payload, {
        signal: ctl.signal,
        onEvent: e => {
          if (e.type === 'text') { acc += e.delta; setLive(acc); setStatusLine(''); }
          else if (e.type === 'reset') { acc = ''; setLive(''); }
          else if (e.type === 'status') setStatusLine(e.text);
          else if (e.type === 'done') { setMessages([...next, { role: 'assistant', content: e.reply, files: e.files, tools: e.tools }]); acc = ''; }
          else if (e.type === 'error') setError(e.error);
        },
      });
    } catch (e) {
      if ((e as Error).name === 'AbortError') { if (acc.trim()) setMessages([...next, { role: 'assistant', content: acc, stopped: true }]); }
      else setError((e as Error).message);
    } finally {
      setBusy(false); setLive(''); setStatusLine(''); abort.current = null; loadStatus();
    }
  }

  async function saveLimits() {
    if (!form) return;
    setSaved(null); setError(null);
    try { await apiPut('/ai/settings', form); setSaved('Saved'); loadStatus(); }
    catch (e) { setError((e as Error).message); }
  }

  const copy = (i: number) => { navigator.clipboard?.writeText(messages[i].content).then(() => { setCopied(i); setTimeout(() => setCopied(c => (c === i ? null : c)), 1500); }); };
  const u = status?.usage, s = status?.settings;
  const blocked = !!status?.blocked || status?.configured === false;

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <h1>Assistant</h1>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {messages.length > 0 && <button className="btn secondary" onClick={() => { abort.current?.abort(); setMessages([]); setError(null); setPending([]); }}>New chat</button>}
          {isManager && <button className="btn secondary" onClick={() => setShowLimits(v => !v)}>{showLimits ? 'Hide limits' : 'Limits'}</button>}
        </div>
      </div>
      <div className="acct-region" style={{ marginBottom: 10, maxWidth: 760 }}>
        Ask anything about your customers, quotes, orders and stock. It can summarise, write reports as Excel, CSV, Word or PDF to download, and read files you attach
        (PDF, images, Excel, CSV, text, Word). It reads only what you can already see, and changes nothing. This chat is cleared when you leave the page.
      </div>

      {status && !status.configured && <div className="save-msg err" style={{ marginBottom: 10 }}>Claude isn't set up yet. The API needs <b>ANTHROPIC_API_KEY</b>.</div>}
      {status?.blocked && <div className="save-msg err" style={{ marginBottom: 10 }}>{status.blocked}</div>}
      {u && s && (
        <div className="acct-region" style={{ marginBottom: 12 }}>
          Today you've used {n(u.userDayTokens)} of {n(s.userDailyTokens)} tokens. The team has used {n(u.monthTokens)} of {n(s.monthlyTokens)} this month
          {u.monthCostUsd != null ? `, about $${u.monthCostUsd.toLocaleString('en-AU')}${s.monthlyUsd > 0 ? ` of $${n(s.monthlyUsd)}` : ''}` : ''}.
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

      <div className="section" style={{ minHeight: 300 }}>
        {messages.length === 0 && !busy && (
          <div>
            <div className="stat-label" style={{ marginBottom: 8 }}>Try asking</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {SUGGESTIONS.map(q => <button key={q} type="button" className="pill neutral" style={{ cursor: 'pointer', border: 'none', fontSize: 13, padding: '6px 12px', textAlign: 'left' }} disabled={blocked} onClick={() => send(q)}>{q}</button>)}
            </div>
            <div className="acct-region" style={{ marginTop: 12 }}>Or attach a purchase order, a price list or a spreadsheet with the paperclip and ask for a summary, or to compare it with our data.</div>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start', margin: '12px 0' }}>
            <div style={{ maxWidth: '86%', padding: '9px 13px', borderRadius: 8, background: m.role === 'user' ? 'var(--teal)' : 'var(--paper, #f6f4ef)', color: m.role === 'user' ? '#fff' : 'inherit', border: m.role === 'user' ? 'none' : '1px solid var(--line)' }}>
              {m.attachments && m.attachments.length > 0 && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: m.content ? 6 : 0 }}>
                  {m.attachments.map((a, k) => <span key={k} className="pill neutral" style={{ fontSize: 12 }}>📎 {a.name} · {sizeLabel(a.size)}</span>)}
                </div>
              )}
              {m.role === 'user' ? <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.45 }}>{m.content}</div> : <Markdown text={m.content} />}
              {m.stopped && <div className="acct-region" style={{ marginTop: 4 }}>(stopped)</div>}
              {m.files && m.files.length > 0 && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                  {m.files.map(f => <button key={f.id} type="button" className="btn secondary" onClick={() => apiDownload(`/ai/files/${f.id}`, f.name).catch(e => setError(e.message))}>⬇ {f.name} ({sizeLabel(f.size)})</button>)}
                </div>
              )}
              {m.role === 'assistant' && (
                <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 6 }}>
                  <button type="button" className="link-btn" onClick={() => copy(i)}>{copied === i ? 'Copied' : 'Copy'}</button>
                  {m.tools && m.tools.length > 0 && <span className="acct-region" style={{ fontSize: 11.5 }}>Looked up: {m.tools.map(t => TOOL_WORDS[t] ?? t).join(', ')}</span>}
                </div>
              )}
            </div>
          </div>
        ))}

        {busy && (
          <div style={{ display: 'flex', justifyContent: 'flex-start', margin: '12px 0' }}>
            <div style={{ maxWidth: '86%', padding: '9px 13px', borderRadius: 8, background: 'var(--paper, #f6f4ef)', border: '1px solid var(--line)' }}>
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
            placeholder="Ask a question, attach a file, or press the microphone and say it"
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          />
        </div>
        <input ref={picker} type="file" multiple accept={ACCEPT} style={{ display: 'none' }} onChange={e => { addFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
        <button className="btn secondary" type="button" title="Attach a file" aria-label="Attach a file" disabled={busy || blocked} onClick={() => picker.current?.click()}>📎</button>
        {busy
          ? <button className="btn secondary" type="button" onClick={() => abort.current?.abort()}>Stop</button>
          : <button className="btn" type="button" disabled={blocked || (!text.trim() && !pending.length)} onClick={() => send()}>Ask</button>}
      </div>
      <div className="acct-region" style={{ marginTop: 4 }}>Enter to send, Shift+Enter for a new line. You can drop or paste files here. Answers come from Claude using your CRM data, so check anything important.</div>
    </>
  );
}