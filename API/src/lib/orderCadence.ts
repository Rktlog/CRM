/**
 * Average days between consecutive paid orders, sorted oldest to
 * newest. Needs at least 2 orders to mean anything — returns null
 * otherwise, and the caller should fall back to a fixed threshold
 * (e.g. 75 days) for accounts with only one order on record.
 */
export function computeAvgOrderGapDays(sentAtDates: Date[]): number | null {
  if (sentAtDates.length < 2) return null;
  const sorted = [...sentAtDates].sort((a, b) => a.getTime() - b.getTime());
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    gaps.push((sorted[i].getTime() - sorted[i - 1].getTime()) / 86400000);
  }
  const avg = gaps.reduce((s, g) => s + g, 0) / gaps.length;
  return Math.round(avg);
}
