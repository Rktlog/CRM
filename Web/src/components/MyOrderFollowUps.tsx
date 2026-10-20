import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiGet } from '../lib/api';
import { fmtMoney, fmtDate, fmtDuration } from '../lib/types';
import { todayLocal } from '../lib/logDate';

// Dashboard: the orders this person is to chase for payment, so they know without opening Open quotes. Two kinds:
//   - a follow-up the sales team gave them by name (the 2nd, for any customer), marked "for you";
//   - the 1st follow-up (a week after payment was due) on their own customers' prepayment orders.
// Overdue or due in the next 7 days, most overdue first. The link opens Open quotes already filtered to them.
type Row = {
  id: string; number: string; accountId: string; customer: string; region: string; stage: string; terms: string; remaining: number;
  lastNote?: { text?: string } | null; followUp: { next: { kind: 'fu1' | 'fu2'; date: string } }; assigned: boolean;
};
type Data = { repId: string; days: number; rows: Row[]; count: number; overdue: number; assigned: number };

const dayDiff = (a: string, b: string) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000);

export default function MyOrderFollowUps() {
  const [d, setD] = useState<Data | null>(null);
  useEffect(() => { apiGet('/orders/my-follow-ups').then(setD).catch(() => {}); }, []);   // never blocks the Dashboard
  if (!d) return null;
  const today = todayLocal();
  return (
    <div className="section" id="order-follow-ups">
      <div className="panel-title">Orders to follow up {d.count > 0 && `(${d.count})`}</div>
      <div className="acct-region" style={{ margin: '-6px 0 10px' }}>
        Orders to chase for payment, overdue or due in the next {d.days} days: the ones the sales team gave to you, and the 1st follow-up on your own customers' prepayment orders.
        {d.overdue > 0 && <> <b style={{ color: 'var(--rust)' }}>{d.overdue} overdue.</b></>}
      </div>
      {d.rows.length === 0 ? (
        <div className="empty-state">Nothing to follow up in the next {d.days} days.</div>
      ) : (
        <div className="scroll-capped-10">
          <div className="manifest">
            <div className="m-row head" style={{ gridTemplateColumns: '1fr 2fr 1.2fr 1fr' }}>
              <div>Order</div><div>Customer</div><div>Follow-up</div><div className="num-col">Still to pay</div>
            </div>
            {d.rows.map(r => {
              const n = dayDiff(r.followUp.next.date, today);
              const late = n < 0;
              return (
                <div className="m-row" key={r.id} style={{ gridTemplateColumns: '1fr 2fr 1.2fr 1fr' }}>
                  <div><Link to={`/orders/${r.id}`} className="order-link num">{r.number}</Link><div className="acct-region">{r.stage}</div></div>
                  <div>
                    <Link to={`/accounts/${r.accountId}`} className="ledger-link">{r.customer}</Link>
                    <div className="acct-region">{r.region}{r.terms !== 'Prepayment' ? ` · ${r.terms}` : ''}</div>
                    {r.lastNote?.text && <div className="acct-region" title={r.lastNote.text}>{r.lastNote.text.length > 70 ? r.lastNote.text.slice(0, 70) + '…' : r.lastNote.text}</div>}
                  </div>
                  <div>
                    <span className={`pill ${r.followUp.next.kind === 'fu2' ? 'rust' : 'amber'}`}>{r.followUp.next.kind === 'fu2' ? '2nd' : '1st'}</span>{' '}
                    <span className="num">{fmtDate(r.followUp.next.date)}</span>
                    <div className="cust-meta" style={late ? { color: 'var(--rust)', fontWeight: 600 } : undefined}>
                      {late ? `${fmtDuration(-n)} overdue` : n === 0 ? 'Due today' : `in ${fmtDuration(n)}`}
                    </div>
                    {r.assigned && <div className="cust-meta">for you, from the sales team</div>}
                  </div>
                  <div className="num-col num"><b>{fmtMoney(r.remaining)}</b></div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <div style={{ marginTop: 8 }}>
        <Link className="link-btn" to={`/orders?tab=quotes&fuBy=${d.repId}&terms=all`}>Open all my follow-ups</Link>
      </div>
    </div>
  );
}