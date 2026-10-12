import { ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';

// Small pieces the Marketing screens share.
const TONES = {
  ok: { background: '#e3efe9', color: '#2f6b5e' }, warn: { background: '#fbefd9', color: '#9a6212' },
  bad: { background: '#f7e1da', color: '#a2402a' }, muted: { background: '#eceee6', color: '#5b6573' },
};
export function Pill({ tone = 'muted', children }: { tone?: keyof typeof TONES; children: ReactNode }) {
  return <span style={{ ...TONES[tone], display: 'inline-block', padding: '2px 9px', borderRadius: 10, fontSize: 11.5, fontWeight: 600, whiteSpace: 'nowrap' }}>{children}</span>;
}

const TABS = [
  { to: '/marketing', label: 'Dashboard', end: true }, { to: '/marketing/campaigns', label: 'Campaigns' }, { to: '/marketing/audience', label: 'Audience' },
  { to: '/marketing/templates', label: 'Templates' }, { to: '/marketing/automations', label: 'Automatic emails' }, { to: '/marketing/settings', label: 'Settings' },
];
export function MarketingNav() {
  return (
    <div className="tab-bar" style={{ margin: '4px 0 14px', flexWrap: 'wrap' }} aria-label="Marketing">
      {TABS.map(t => <NavLink key={t.to} to={t.to} end={t.end} className={({ isActive }) => 'tab' + (isActive ? ' active' : '')}>{t.label}</NavLink>)}
    </div>
  );
}

// Marketing is for managers. Anyone else is told, not shown a broken page.
export function ManagersOnly({ children }: { children: ReactNode }) {
  const { role } = useAuth();
  if (role && role !== 'manager') return <div className="empty-state">Marketing is for managers.</div>;
  return <>{children}</>;
}

export type SendingStatus = { connected: boolean; ready: boolean; missing: string[]; fromEmail?: string; attributionDays?: number };
// The one-line truth about whether emails can go out. Everything else works without it.
export function SendingBanner({ status }: { status: SendingStatus | null | undefined }) {
  if (!status) return null;
  if (status.ready) return <div className="save-msg ok" style={{ margin: '0 0 12px' }}>Email sending is connected{status.fromEmail ? `, from ${status.fromEmail}` : ''}.</div>;
  return (
    <div style={{ background: '#fbefd9', color: '#7a4d0e', borderRadius: 6, padding: '10px 14px', fontSize: 13, margin: '0 0 12px' }} role="status">
      <b>{status.connected ? 'Almost ready to send.' : "Email sending isn't connected yet."}</b>{' '}
      {status.connected
        ? <>Still needed: {status.missing.join(', ')}. </>
        : <>You can build audiences, designs and campaigns now, and see exactly who the automatic emails would go to. Nothing is sent until it is connected. </>}
      <Link to="/marketing/settings" className="order-link">How to connect</Link>
    </div>
  );
}

export function PeriodSelect({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { recent: { value: string; label: string }[]; quarters: { value: string; label: string }[]; months: { value: string; label: string }[] } }) {
  const Group = ({ label, items }: { label: string; items: { value: string; label: string }[] }) => <optgroup label={label}>{items.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</optgroup>;
  return (
    <select value={value} onChange={e => onChange(e.target.value)} aria-label="Period">
      <Group label="Recent" items={options.recent} /><Group label="Fiscal quarter" items={options.quarters} /><Group label="Month" items={options.months} />
    </select>
  );
}
export const Back = ({ to, children }: { to: string; children: ReactNode }) => <Link to={to} className="order-link">← {children}</Link>;