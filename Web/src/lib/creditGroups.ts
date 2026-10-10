// Reservations for the same order are shown together: "SQ37512: 3 credit notes, $425.00, Used".
// Credit notes reserved for the same specific order are grouped, whenever they were reserved.
// Ones reserved for "their next order" have no order number, so they are grouped only when they
// were made in the same request (the same moment, by the same person).

export type GroupableReservation = {
  id: string; accountId?: string; orderRef: string | null; createdAt: string; createdBy: string | null;
  amount: number; status: 'reserved' | 'used' | 'cancelled';
};
export type ReservationGroup<T extends GroupableReservation> = {
  key: string; orderRef: string | null; items: T[]; total: number; reserved: number; used: number; cancelled: number;
};

export function groupReservations<T extends GroupableReservation>(rows: T[]): ReservationGroup<T>[] {
  const groups = new Map<string, ReservationGroup<T>>();
  for (const r of rows) {
    const key = r.orderRef
      ? `${r.accountId ?? ''}|${r.orderRef.toUpperCase()}`
      : `${r.accountId ?? ''}|next|${r.createdAt}|${r.createdBy ?? ''}`;
    let g = groups.get(key);
    if (!g) { g = { key, orderRef: r.orderRef, items: [], total: 0, reserved: 0, used: 0, cancelled: 0 }; groups.set(key, g); }
    g.items.push(r);
    g.total = Math.round((g.total + r.amount) * 100) / 100;
    g[r.status] += 1;
  }
  return [...groups.values()];   // in the order they first appear, so the members stay together
}

// "Used", "Reserved", "Released", or a mix such as "2 used, 1 reserved".
export function groupStatus<T extends GroupableReservation>(g: ReservationGroup<T>): { word: string; tone: 'amber' | 'teal' | 'neutral' } {
  const n = g.items.length;
  if (g.used === n) return { word: 'Used', tone: 'teal' };
  if (g.reserved === n) return { word: 'Reserved', tone: 'amber' };
  if (g.cancelled === n) return { word: 'Released', tone: 'neutral' };
  const parts = [g.used && `${g.used} used`, g.reserved && `${g.reserved} reserved`, g.cancelled && `${g.cancelled} released`].filter(Boolean);
  return { word: parts.join(', '), tone: g.reserved > 0 ? 'amber' : 'teal' };
}