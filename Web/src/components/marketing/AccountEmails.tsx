import { useEffect, useState } from 'react';
import { apiGet } from '../../lib/api';
import { fmtDate } from '../../lib/types';
import { Pill } from './Ui';

// On an account: the emails sent to that customer and what they did with them. Hidden if there are none.
type Row = { id: string; subject: string; status: string; sentAt: string; openedAt: string | null; clicks: number; marketing: boolean; source: string | null; automation: boolean };
export default function AccountEmails({ accountId }: { accountId: string }) {
  const [rows, setRows] = useState<Row[]>([]); const [all, setAll] = useState(false);
  useEffect(() => { apiGet(`/marketing/account/${accountId}/emails`).then(setRows).catch(() => setRows([])); }, [accountId]);
  if (!rows.length) return null;
  const shown = all ? rows : rows.slice(0, 5);
  return (
    <div className="card">
      <h3>Emails sent to them</h3>
      {shown.map(r => (
        <div key={r.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '6px 0', borderTop: '1px solid var(--line)', fontSize: 13 }}>
          <div style={{ flex: 1 }}>{r.subject}<div className="acct-region">{r.automation ? 'Order email' : r.source ?? 'Campaign'} · {fmtDate(r.sentAt)}</div></div>
          {r.status === 'bounced' && <Pill tone="bad">Bounced</Pill>}{r.clicks > 0 ? <Pill tone="ok">Clicked</Pill> : r.openedAt ? <Pill tone="warn">Opened</Pill> : <Pill tone="muted">Sent</Pill>}
        </div>
      ))}
      {rows.length > 5 && !all && <button className="edit-link" onClick={() => setAll(true)}>Show all {rows.length}</button>}
    </div>
  );
}