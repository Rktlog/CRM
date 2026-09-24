import { useEffect, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid } from 'recharts';
import { apiGet } from '../lib/api';
import { fmtMoney } from '../lib/types';

type Range = '3m' | '6m' | '12m' | 'fy_quarter' | 'fy_year' | 'last_fy_quarter' | 'last_fy_year';

const RANGE_LABELS: Record<Range, string> = {
  '3m': '3 months',
  '6m': '6 months',
  '12m': '12 months',
  fy_quarter: 'This FY quarter',
  fy_year: 'This FY year',
  last_fy_quarter: 'Last FY quarter',
  last_fy_year: 'Last FY year',
};

type ReportData = {
  currentLabel: string;
  previousLabel: string;
  currentTotal: number;
  previousTotal: number;
  changePct: number | null;
  buckets: { label: string; current: number; previous: number }[];
  earliestDataAt: string | null;
  comparisonReachesBeforeData: boolean;
};

export default function SalesComparisonCard() {
  const [range, setRange] = useState<Range>('3m');
  const [data, setData] = useState<ReportData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    apiGet(`/reports/sales?range=${range}`).then(setData).catch(e => setError(e.message));
  }, [range]);

  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h3 style={{ margin: 0 }}>Sales</h3>
        <select value={range} onChange={e => setRange(e.target.value as Range)}>
          {(Object.keys(RANGE_LABELS) as Range[]).map(r => (
            <option key={r} value={r}>{RANGE_LABELS[r]}</option>
          ))}
        </select>
      </div>

      {error && <div style={{ color: 'var(--rust)', fontSize: 13 }}>Couldn't load: {error}</div>}
      {!data && !error && <div style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</div>}

      {data && (
        <>
          <div style={{ display: 'flex', gap: 24, marginBottom: 16 }}>
            <div>
              <div className="num" style={{ fontSize: 22, fontWeight: 600 }}>{fmtMoney(data.currentTotal)}</div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{data.currentLabel}</div>
            </div>
            <div>
              <div className="num" style={{ fontSize: 22, fontWeight: 600, color: 'var(--muted)' }}>{fmtMoney(data.previousTotal)}</div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{data.previousLabel}</div>
            </div>
            {data.changePct !== null && (
              <div style={{ alignSelf: 'center' }}>
                <span className={'pill ' + (data.changePct >= 0 ? 'teal' : 'rust')}>
                  {data.changePct >= 0 ? '+' : ''}{data.changePct}%
                </span>
              </div>
            )}
          </div>

          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={data.buckets} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--muted)' }} axisLine={{ stroke: 'var(--line)' }} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: 'var(--muted)' }} axisLine={false} tickLine={false} width={50} tickFormatter={v => `$${(v / 1000).toFixed(0)}k`} />
              <Tooltip formatter={(v: number) => fmtMoney(v)} contentStyle={{ fontSize: 12, borderRadius: 4 }} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="previous" name="Previous period" fill="var(--line)" stroke="var(--muted)" strokeWidth={1} radius={[3, 3, 0, 0]} />
              <Bar dataKey="current" name="This period" fill="var(--teal)" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>

          {data.comparisonReachesBeforeData && (
            <div style={{ fontSize: 11.5, color: 'var(--amber)', marginTop: 8 }}>
              The comparison period reaches earlier than your synced Cin7 history — those months will show as $0 rather than real figures. Pull more history from DEAR for a fair comparison at this range.
            </div>
          )}
        </>
      )}
    </div>
  );
}