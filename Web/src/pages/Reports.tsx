import { useEffect, useState } from 'react';
import { apiGet, apiDownload } from '../lib/api';
import { useAuth } from '../context/AuthContext';

type Rep = { id: string; name: string };

const REPORTS: { key: string; label: string; blurb: string; group: string }[] = [
  { key: 'sales-by-sku', label: 'Sales by SKU', blurb: 'Every product, quantity and revenue, this FY.', group: 'Sales breakdowns' },
  { key: 'sales-by-brand', label: 'Sales by brand', blurb: 'Brand-level rollup, this FY.', group: 'Sales breakdowns' },
  { key: 'sales-by-category', label: 'Sales by category', blurb: 'Gift, Toy, Pharmacy etc., this FY.', group: 'Sales breakdowns' },
  { key: 'sales-by-region', label: 'Sales by region', blurb: 'State-by-state breakdown, this FY.', group: 'Sales breakdowns' },
  { key: 'sales-by-account', label: 'Sales by account', blurb: 'Every account, last FY vs this FY.', group: 'Sales breakdowns' },
  { key: 'full-orders', label: 'Full order list', blurb: 'Every invoice, one row each — real transaction history.', group: 'Working lists' },
  { key: 'unpaid-quotes', label: 'Unpaid quotes', blurb: 'A real follow-up worklist, ready to work through.', group: 'Working lists' },
  { key: 'budget-vs-actual', label: 'Budget vs actual', blurb: "Every rep's quarterly target next to real invoiced totals.", group: 'Working lists' },
  { key: 'accounts', label: 'Full account list', blurb: 'Every account — contact details, region, spend, stage.', group: 'Account & team' },
  { key: 'inactive-customers', label: 'Inactive customers', blurb: 'Overdue relative to their own pace — a ready-made outreach list.', group: 'Account & team' },
  { key: 'rep-activity', label: 'Rep activity log', blurb: 'Calls, visits, emails logged over a date range.', group: 'Account & team' },
];

const ALL_STATES = ['NSW', 'ACT', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'NT', 'NZ'];

export default function Reports() {
  const { role } = useAuth();
  const isManager = role === 'manager';
  const [reps, setReps] = useState<Rep[]>([]);
  const [region, setRegion] = useState('');
  const [repId, setRepId] = useState('');
  const [year, setYear] = useState(new Date().getFullYear());
  const [days, setDays] = useState(30);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (isManager) apiGet('/reports/reps').then(setReps).catch(() => {});
  }, [isManager]);

  async function download(key: string) {
    setDownloading(key);
    try {
      const params = new URLSearchParams();
      if (region) params.set('region', region);
      if (isManager && repId) params.set('repId', repId);
      if (key === 'budget-vs-actual') params.set('year', String(year));
      if (key === 'rep-activity') params.set('days', String(days));
      await apiDownload(`/exports/${key}?${params.toString()}`, `${key}.xlsx`);
    } catch (e) {
      alert('Download failed — check the API is running.');
    } finally {
      setDownloading(null);
    }
  }

  async function downloadSearch() {
    if (!searchTerm.trim()) return;
    setSearching(true);
    try {
      const params = new URLSearchParams();
      params.set('q', searchTerm.trim());
      if (region) params.set('region', region);
      if (isManager && repId) params.set('repId', repId);
      await apiDownload(`/exports/brand-search?${params.toString()}`, `search-${searchTerm.trim()}.xlsx`);
    } catch (e) {
      alert('Download failed — check the API is running.');
    } finally {
      setSearching(false);
    }
  }

  const groups = [...new Set(REPORTS.map(r => r.group))];

  return (
    <>
      <h1>Reports</h1>
      <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 20, maxWidth: 620 }}>
        Every report here is a real Excel download, generated fresh from your synced data —
        never a cached snapshot. Filters apply to whichever ones they're relevant to.
      </div>

      <div className="controls" style={{ marginBottom: 24 }}>
        <select value={region} onChange={e => setRegion(e.target.value)}>
          <option value="">All regions</option>
          {ALL_STATES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        {isManager && (
          <select value={repId} onChange={e => setRepId(e.target.value)}>
            <option value="">All reps</option>
            {reps.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        )}
        <select value={year} onChange={e => setYear(Number(e.target.value))}>
          {[year - 1, year, year + 1].map(y => <option key={y} value={y}>{y} (for Budget vs actual)</option>)}
        </select>
        <select value={days} onChange={e => setDays(Number(e.target.value))}>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
          <option value={365}>Last 365 days</option>
        </select>
        <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>(last one is for Rep activity log)</span>
      </div>

      <div className="section">
        <div className="panel-title">Search by brand or product</div>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 12, maxWidth: 560 }}>
          Type a brand or product keyword — e.g. "Meri Meri" or "Miffy" — to get every customer who's
          ordered it, with quantities and revenue, plus a SKU-level breakdown. Matches all-time, not
          just this FY.
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            placeholder="Brand or product name…"
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && downloadSearch()}
            style={{ flex: 1, maxWidth: 320, padding: '7px 10px', border: '1px solid var(--line)', borderRadius: 3 }}
          />
          <button className="btn" disabled={searching || !searchTerm.trim()} onClick={downloadSearch}>
            {searching ? 'Downloading…' : '⬇ Excel'}
          </button>
        </div>
      </div>

      {groups.map(group => (
        <div className="section" key={group}>
          <div className="panel-title">{group}</div>
          <div className="manifest">
            {REPORTS.filter(r => r.group === group).map(r => (
              <div className="m-row" key={r.key} style={{ gridTemplateColumns: '1.4fr 2fr 0.8fr', cursor: 'default' }}>
                <div className="acct-name">{r.label}</div>
                <div style={{ color: 'var(--muted)', fontSize: 12.5 }}>{r.blurb}</div>
                <div>
                  <button className="btn secondary" style={{ padding: '5px 12px', fontSize: 12 }} disabled={downloading === r.key} onClick={() => download(r.key)}>
                    {downloading === r.key ? 'Downloading…' : '⬇ Excel'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}