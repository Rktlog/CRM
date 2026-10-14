import { useEffect, useState } from 'react';
import { apiGet } from '../lib/api';
import { fmtDate } from '../lib/types';

// On an account: the emails between the team and this customer, as conversations. Hidden if there are none.
type Msg = { id: string; direction: 'in' | 'out'; occurredAt: string; snippet: string | null; repName: string; mine: boolean; link: string | null };
type Thread = { threadId: string; subject: string; lastAt: string; lastDirection: 'in' | 'out'; count: number; messages: Msg[] };

export default function AccountGmail({ accountId }: { accountId: string }) {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  useEffect(() => { apiGet(`/gmail/account/${accountId}/emails`).then(d => setThreads(d.threads ?? [])).catch(() => setThreads([])); }, [accountId]);
  if (!threads.length) return null;
  const shown = all ? threads : threads.slice(0, 5);
  return (
    <div className="card">
      <h3>Emails with them</h3>
      {shown.map(t => (
        <div key={t.threadId} style={{ borderTop: '1px solid var(--line)', padding: '7px 0' }}>
          <button type="button" aria-expanded={open === t.threadId} onClick={() => setOpen(open === t.threadId ? null : t.threadId)}
            style={{ all: 'unset', cursor: 'pointer', display: 'flex', gap: 8, alignItems: 'baseline', width: '100%' }}>
            <span aria-hidden="true" style={{ width: 14, color: 'var(--muted)' }}>{open === t.threadId ? '▾' : '▸'}</span>
            <span style={{ flex: 1, fontWeight: 600, fontSize: 13 }}>{t.subject}</span>
            {t.count > 1 && <span className="pill neutral">{t.count}</span>}
            <span className="acct-region">{t.lastDirection === 'in' ? 'They wrote' : 'We wrote'}, {fmtDate(t.lastAt)}</span>
          </button>
          {open === t.threadId && (
            <div style={{ margin: '6px 0 2px 22px' }}>
              {t.messages.map(m => (
                <div key={m.id} style={{ padding: '4px 0', fontSize: 13 }}>
                  <div className="acct-region">
                    {m.direction === 'in' ? `They wrote to ${m.repName}` : `${m.repName} wrote`}, {fmtDate(m.occurredAt)}
                    {m.link && <> · <a href={m.link} target="_blank" rel="noopener noreferrer" className="order-link">Open in Gmail</a></>}
                  </div>
                  {m.snippet && <div style={{ color: 'var(--ink-soft)' }}>{m.snippet}</div>}
                </div>
              ))}
              {t.count > t.messages.length && <div className="acct-region">and {t.count - t.messages.length} earlier</div>}
            </div>
          )}
        </div>
      ))}
      {threads.length > 5 && !all && <button className="edit-link" onClick={() => setAll(true)}>Show all {threads.length} conversations</button>}
    </div>
  );
}