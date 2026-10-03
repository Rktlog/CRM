import { useEffect, useState } from 'react';
import { apiGet } from './api';

export const ALL_STATES = ['NSW', 'ACT', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'NT', 'NZ'];

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
  if (!me || me.role === 'manager') return ALL_STATES;
  return ALL_STATES.filter(s => me.regions.includes(s));
}

// One line describing whose accounts are showing, for page headers.
export function territoryLabel(me: Me | null): string | null {
  if (!me || me.role === 'manager') return null;
  return me.regions.length ? `Your states: ${me.regions.join(', ')}` : 'Your accounts (no states assigned yet)';
}