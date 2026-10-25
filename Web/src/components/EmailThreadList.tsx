import { useState } from 'react';
import { Link } from 'react-router-dom';
import { fmtDate } from '../lib/types';

// Emails between the team and a customer, as conversations. Used on the customer's account (all their emails) and on an order
// (only the emails about that order). Under each conversation: the latest message in one line (Claude's summary when there is one,
// otherwise the short preview) and the orders it is about. Open a conversation to read each message's line.
export type EmailOrder = { number: string; id: string | null };
export type EmailMsg = {
  id: string; direction: 'in' | 'out'; occurredAt: string; snippet: string | null; summary?: string | null; topic?: string | null;
  orders?: EmailOrder[]; repName: string; mine: boolean; link: string | null;
};
export type EmailThread = { threadId: string; subject: string; lastAt: string; lastDirection: 'in' | 'out'; count: number; messages: EmailMsg[] };

const line = (m: EmailMsg) => m.summary || m.snippet || null;
const OrderChip = ({ o }: { o: EmailOrder }) => o.id
  ? <Link to={`/orders/${o.id}`} className="pill neutral" style={{ textDecoration: 'none' }} title="Open this order">{o.number}</Link>
  : <span className="pill neutral">{o.number}</span>;

export default function EmailThreadList({ threads, hideOrder, limit = 5 }: { threads: EmailThread[]; hideOrder?: string; limit?: number }) {
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const shown = all ? threads : threads.slice(0, limit);
  return (
    <>
      {shown.map(t => {
        const latest = t.messages[0];
        const preview = latest ? line(latest) : null;
        const orders = [...new Map(t.messages.flatMap(m => m.orders ?? []).filter(o => o.number !== hideOrder).map(o => [o.number, o])).values()];
        return (
          <div key={t.threadId} style={{ borderTop: '1px solid var(--line)', padding: '7px 0' }}>
            <button type="button" aria-expanded={open === t.threadId} onClick={() => setOpen(open === t.threadId ? null : t.threadId)}
              style={{ all: 'unset', cursor: 'pointer', display: 'flex', gap: 8, alignItems: 'baseline', width: '100%' }}>
              <span aria-hidden="true" style={{ width: 14, color: 'var(--muted)' }}>{open === t.threadId ? '▾' : '▸'}</span>
              <span style={{ flex: 1, fontWeight: 600, fontSize: 13 }}>{t.subject}</span>
              {t.count > 1 && <span className="pill neutral">{t.count}</span>}
              <span className="acct-region">{t.lastDirection === 'in' ? 'They wrote' : 'We wrote'}, {fmtDate(t.lastAt)}</span>
            </button>
            {(preview || orders.length > 0) && (
              <div style={{ margin: '3px 0 0 22px', display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'baseline' }}>
                {preview && <span style={{ color: 'var(--ink-soft)', fontSize: 13 }} title={latest?.summary ? 'Summary by Claude' : undefined}>{preview}</span>}
                {orders.map(o => <OrderChip key={o.number} o={o} />)}
              </div>
            )}
            {open === t.threadId && (
              <div style={{ margin: '6px 0 2px 22px' }}>
                {t.messages.map(m => (
                  <div key={m.id} style={{ padding: '4px 0', fontSize: 13 }}>
                    <div className="acct-region">
                      {m.direction === 'in' ? `They wrote to ${m.repName}` : `${m.repName} wrote`}, {fmtDate(m.occurredAt)}
                      {m.topic && m.summary && <> · <span className="pill neutral">{m.topic}</span></>}
                      {m.link && <> · <a href={m.link} target="_blank" rel="noopener noreferrer" className="order-link">Open in Gmail</a></>}
                    </div>
                    {line(m) && <div style={{ color: 'var(--ink-soft)' }}>{line(m)}</div>}
                  </div>
                ))}
                {t.count > t.messages.length && <div className="acct-region">and {t.count - t.messages.length} earlier</div>}
              </div>
            )}
          </div>
        );
      })}
      {threads.length > limit && !all && <button className="edit-link" onClick={() => setAll(true)}>Show all {threads.length} conversations</button>}
    </>
  );
}