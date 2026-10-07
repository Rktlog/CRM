import { stateLabel } from '../lib/useMe';

// Tick-box state filter: pick any number of states. The value is the ticked
// states as one comma-separated list ("NSW,ACT"), which is what the API and
// the in-page filters take; '' means all. "Others" stands for two states
// (no state set, overseas), so it's ticked when both are in the list.
export default function StateFilter({ value, onChange, options, allLabel = 'All states' }: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  allLabel?: string;
}) {
  const parts = value ? value.split(',') : [];
  const ticked = options.filter(o => o.split(',').every(r => parts.includes(r)));

  function toggle(option: string) {
    const next = ticked.includes(option) ? ticked.filter(o => o !== option) : [...ticked, option];
    onChange(next.join(','));
  }

  const summary = ticked.length === 0 ? allLabel
    : ticked.length === 1 ? stateLabel(ticked[0])
    : ticked.length <= 3 ? ticked.map(t => (t.includes(',') ? 'Others' : t)).join(', ')
    : `${ticked.length} states`;

  if (options.length <= 1) return null;
  return (
    <details className="terms-filter state-filter">
      <summary aria-label="States">{summary}</summary>
      <div className="terms-menu">
        <div className="terms-menu-tools">
          <button type="button" className="link-btn" onClick={() => onChange('')}>{allLabel}</button>
        </div>
        {options.map(o => (
          <label key={o} className="pl-check">
            <input type="checkbox" checked={ticked.includes(o)} onChange={() => toggle(o)} />
            <span>{stateLabel(o)}</span>
          </label>
        ))}
      </div>
    </details>
  );
}

// For pages that filter in the browser: does this account's state match?
export const inStates = (filter: string, region: string) => !filter || filter.split(',').includes(region);