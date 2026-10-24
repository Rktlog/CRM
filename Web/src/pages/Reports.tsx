import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiGet, apiDownload } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { SavedReport, downloadUrl, fileName } from '../lib/reportDefinition';

type Rep = { id: string; name: string };

const REPORTS: { key: string; label: string; blurb: string; group: string }[] = [
  { key: 'sales-by-sku', label: 'Sales by SKU', blurb: 'Every product, quantity and revenue, this FY.', group: 'Sales breakdowns' },
  { key: 'sales-by-brand', label: 'Sales by brand', blurb: 'Brand-level rollup, this FY.', group: 'Sales breakdowns' },
  { key: 'sales-by-category', label: 'Sales by category', blurb: 'Gift, Toy, Pharmacy etc., this FY.', group: 'Sales breakdowns' },
  { key: 'sales-by-region', label: 'Sales by region', blurb: 'State-by-state breakdown, this FY.', group: 'Sales breakdowns' },
  { key: 'sales-by-account', label: 'Sales by account', blurb: 'Every account, last FY vs this FY.', group: 'Sales breakdowns' },
  { key: 'full-orders', label: 'Full order list', blurb: 'Every invoice, one row each — real transaction history.', group: 'Working lists' },
  { key: 'unpaid-quotes', label: 'Unpaid quotes', blurb: 'A real follow-up worklist, ready to work through.', group: 'Working lists' },
  { key: 'rep-summary-sheet', label: 'Rep summary sheet', blurb: "Each rep's Summary sheet, laid out exactly as the team's Summary_Rhonda sheet and as reps see it on Sales Data: budget, invoiced sales against last year, variance, quotes awaiting payment, new and reactivated stockists, the quarter table and the unpaid quotes. One tab per rep, or pick a rep above. The year is the year the financial year starts (2026 is FY 2026/27). Managers only.", group: 'Working lists' },
  { key: 'budget-vs-actual', label: 'Budget vs actual', blurb: "Every rep's quarterly target next to real invoiced totals.", group: 'Working lists' },
  { key: 'accounts', label: 'Full account list', blurb: 'Every account — contact details, region, spend, stage.', group: 'Account & team' },
  { key: 'inactive-customers', label: 'Inactive customers', blurb: 'Overdue relative to their own pace — a ready-made outreach list.', group: 'Account & team' },
  { key: 'rep-activity', label: 'Rep activity log', blurb: 'Phone calls, emails and F2F visits logged over a date range.', group: 'Account & team' },
  { key: 'conversion', label: 'Conversion report', blurb: 'Abandoned carts, new prospects, new leads and inactive stockists, each followed to an order and a sales quote. Every customer listed.', group: 'Account & team' },
  { key: 'marketing', label: 'Marketing report', blurb: 'Emails sent, opened and clicked, each campaign, the automatic emails, and the orders that followed an email click. Managers only.', group: 'Account & team' },
  { key: 'hidden-accounts', label: 'Archived and hidden accounts', blurb: 'Every account that is not on the Accounts list and why: archived (locked or coming back on a real order), only marketing or warranty orders, or hidden from some reps. Managers only.', group: 'Account & team' },
  { key: 'credit-movements', label: 'Credit report', blurb: 'Every credit note on account and every credit movement: issued, applied, refunded, reserved, used.', group: 'Account & team' },
  { key: 'eol', label: 'EOL sell-through report', blurb: 'Sales since the start date and stock left for the clearance brands, one sheet each: summary by brand and customer, sales by SKU, purchases, staff purchases, remaining stock. Managers only.', group: 'Products & stock' },
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
  const [custom, setCustom] = useState<SavedReport[]>([]);
  const [customBusy, setCustomBusy] = useState<string | null>(null);

  useEffect(() => { apiGet('/custom-reports').then(setCustom).catch(() => {}); }, []);

  async function downloadCustom(r: SavedReport) {
    setCustomBusy(r.id);
    try { await apiDownload(downloadUrl(r.definition, r.name), fileName(r.name)); }
    catch (e) { alert((e as Error).message); }
    finally { setCustomBusy(null); }
  }

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
      if (key === 'rep-activity' || key === 'conversion' || key === 'marketing') params.set('days', String(days));
      if (key === 'rep-summary-sheet') {
        const p = new URLSearchParams({ fy: String(year) });
        if (repId) p.set('repId', repId);
        await apiDownload(`/summary-sheet/download?${p.toString()}`, `rep-summary-FY${year}-${String(year + 1).slice(2)}.xlsx`);
      } else await apiDownload(`/exports/${key}?${params.toString()}`, `${key}.xlsx`);
    } catch (e) {
      alert(`Download failed: ${(e as Error).message}`);
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
      alert(`Download failed: ${(e as Error).message}`);
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
          {[year - 1, year, year + 1].map(y => <option key={y} value={y}>{y} (for Budget vs actual and the Rep summary sheet)</option>)}
        </select>
        <select value={days} onChange={e => setDays(Number(e.target.value))}>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
          <option value={365}>Last 365 days</option>
        </select>
        <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>(the last one is for the Rep activity log and the Conversion report)</span>
      </div>

      <div className="section">
        <div className="panel-title" style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <span>Custom reports</span>
          <Link to="/reports/builder" className="btn" style={{ marginLeft: 'auto', padding: '5px 12px', fontSize: 12, textDecoration: 'none' }}>+ Build a report</Link>
        </div>
        {custom.length === 0 ? (
          <div style={{ fontSize: 12.5, color: 'var(--muted)', maxWidth: 620 }}>
            Make your own report: pick what it is about (order lines, products and stock, or customers), the columns and filters, and download it as Excel. Save it to run again.
          </div>
        ) : (
          <div className="manifest">
            {custom.map(r => (
              <div className="m-row" key={r.id} style={{ gridTemplateColumns: '1.4fr 2fr 0.9fr', cursor: 'default' }}>
                <div className="acct-name">{r.name} {r.shared && <span className="pill neutral">Shared</span>}</div>
                <div style={{ color: 'var(--muted)', fontSize: 12.5 }}>
                  {r.definition.dataset === 'sales' ? 'Order lines' : r.definition.dataset === 'products' ? 'Products and stock' : 'Customers and accounts'}
                  {!r.mine && r.ownerName ? `, by ${r.ownerName}` : ''}
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="btn secondary" style={{ padding: '5px 12px', fontSize: 12 }} disabled={customBusy === r.id} onClick={() => downloadCustom(r)}>{customBusy === r.id ? '…' : '⬇ Excel'}</button>
                  <Link to={`/reports/builder?id=${r.id}`} className="btn secondary" style={{ padding: '5px 12px', fontSize: 12, textDecoration: 'none' }}>{r.mine ? 'Edit' : 'Open'}</Link>
                </div>
              </div>
            ))}
          </div>
        )}
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
            {REPORTS.filter(r => r.group === group && (isManager || !['marketing', 'eol', 'hidden-accounts', 'rep-summary-sheet'].includes(r.key))).map(r => (
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