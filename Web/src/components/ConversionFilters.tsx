import { useMemo } from 'react';
import { useMe, stateOptionsFor } from '../lib/useMe';
import { Period, encodePeriod, decodePeriod, periodOptions } from '../lib/period';
import StateFilter from './StateFilter';

// The period (last N days, a month, or a fiscal quarter) and the states, for the Conversion
// section on the Dashboard and on its detail page.
export default function ConversionFilters({ period, onPeriod, region, onRegion }: {
  period: Period; onPeriod: (p: Period) => void; region: string; onRegion: (r: string) => void;
}) {
  const me = useMe();
  const options = useMemo(() => periodOptions(), []);
  const Group = ({ label, items }: { label: string; items: { value: string; label: string }[] }) => (
    <optgroup label={label}>{items.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</optgroup>
  );
  return (
    <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <select value={encodePeriod(period)} onChange={e => onPeriod(decodePeriod(e.target.value))} aria-label="Period">
        <Group label="Recent" items={options.recent} />
        <Group label="Fiscal quarter" items={options.quarters} />
        <Group label="Month" items={options.months} />
      </select>
      <StateFilter value={region} onChange={onRegion} options={stateOptionsFor(me)} allLabel={me?.role === 'manager' ? 'All states' : 'All my states'} />
    </span>
  );
}