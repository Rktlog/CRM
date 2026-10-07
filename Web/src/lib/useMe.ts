import { useEffect, useState } from 'react';
import { apiGet } from './api';

// States an account can be in: the states, head offices as their own
// "state" (tracked separately from the stores there), and overseas.
export const ALL_STATES = ['NSW', 'ACT', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'NT', 'NZ', 'NSW/HO', 'VIC/HO', 'INTL'];

// "Others" in the filters: no state set, plus overseas (except NZ, which has
// its own option). Sent to the API as two states, which it already accepts.
export const OTHERS = 'Unknown,INTL';
export const FILTER_STATES = ['NSW', 'ACT', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'NT', 'NZ', 'NSW/HO', 'VIC/HO', OTHERS];
export const stateLabel = (s: string) => (s === OTHERS ? 'Others (no state / overseas)' : s);

export type Me = { id: string; role: 'rep' | 'manager'; name?: string; regions: string[] };

// Who's signed in, with their assigned states. Loaded once per page.
export function useMe(): Me | null {
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    apiGet('/me').then((m: any) => setMe({ ...m, regions: m.regions ?? [] })).catch(() => {});
  }, []);
  return me;
}

// States a person can filter by: managers get them all, reps get their
// assigned states. The API enforces the same rule; this just keeps the
// dropdowns from offering states that would come back empty.
export function stateOptionsFor(me: Me | null): string[] {
  if (!me || me.role === 'manager') return FILTER_STATES;
  return FILTER_STATES.filter(s => s.split(',').some(r => me.regions.includes(r)));
}

// One line describing whose accounts are showing, for page headers.
export function territoryLabel(me: Me | null): string | null {
  if (!me || me.role === 'manager') return null;
  return me.regions.length ? `Your states: ${me.regions.join(', ')}` : 'No states assigned yet. Ask a manager to assign you in Settings.';
}