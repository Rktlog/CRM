import { useNavigate } from 'react-router-dom';
import { Account, STAGE_LABELS, fmtMoney, fmtDate, daysBetween, flagFor } from '../lib/types';

export type SortKey = 'name' | 'stage' | 'spend90' | 'lastOrder';

type Props = {
  accounts: Account[];
  sortKey?: SortKey;
  sortDir?: 'asc' | 'desc';
  onSort?: (key: SortKey) => void;
};

export default function AccountTable({ accounts, sortKey, sortDir, onSort }: Props) {
  const navigate = useNavigate();

  function headerLabel(key: SortKey, label: string) {
    if (!onSort) return <div>{label}</div>;
    const active = sortKey === key;
    return (
      <div className="sortable-head" onClick={() => onSort(key)}>
        {label}
        {active && <span className="sort-arrow">{sortDir === 'asc' ? ' ↑' : ' ↓'}</span>}
      </div>
    );
  }

  return (
    <div className="manifest">
      <div className="m-row head">
        {headerLabel('name', 'Account')}
        <div>Contact</div>
        {headerLabel('stage', 'Stage')}
        <div className="num">{headerLabel('spend90', 'Spend (90d)')}</div>
        {headerLabel('lastOrder', 'Last order')}
        <div>Status</div>
      </div>
      {accounts.map(a => {
        const flag = flagFor(a);
        return (
          <div className="m-row" key={a.id} onClick={() => navigate(`/accounts/${a.id}`)}>
            <div>
              <div className="acct-name">{a.name}</div>
              <div className="acct-region">{a.region} · {a.credit === 'prepay' ? 'Pay first' : 'Credit account'}</div>
              {a.repName && <div className="acct-region" style={{ opacity: 0.7 }}>{a.repName}</div>}
              {a.hasHistoricalOrders && <span className="badge muted" style={{ fontSize: 10, marginTop: 2, display: 'inline-block' }}>History</span>}
            </div>
            <div>
              {a.contactName && <div>{a.contactName}</div>}
              {(a.phone || a.email) && (
                <div className="acct-region">{[a.phone, a.email].filter(Boolean).join(' · ')}</div>
              )}
              {!a.contactName && !a.phone && !a.email && <span style={{ color: 'var(--muted)' }}>—</span>}
            </div>
            <div>{STAGE_LABELS[a.stage]}</div>
            <div className="num">{fmtMoney(a.spend90)}</div>
            <div>{a.lastOrderAt ? `${fmtDate(a.lastOrderAt)} (${daysBetween(a.lastOrderAt)}d)` : '—'}</div>
            <div>
              {flag === 'rust' && <span className="pill rust">Inactive</span>}
              {!flag && a.type === 'prospect' && <span className="pill neutral">Prospect</span>}
              {!flag && a.type === 'customer' && <span className="pill teal">Active</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}