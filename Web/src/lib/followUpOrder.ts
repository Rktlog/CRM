// The 2nd follow-up list is shown with the oldest follow-up date first, so the most overdue is at the top. A 2nd still waiting for its date has no date,
// so those come last. Orders with the same follow-up date (or none) go oldest order first. The Excel download is in the same order (the same rule is in
// the API, api/src/lib/receivables.ts).
type Row = { number?: string; date: unknown; followUp?: { next?: { date: string } | null } };

export function bySecondFollowUpDate(a: Row, b: Row): number {
  const da = a.followUp?.next?.date, db = b.followUp?.next?.date;
  if (da && db && da !== db) return da < db ? -1 : 1;
  if (!da !== !db) return da ? -1 : 1;
  return Date.parse(String(a.date)) - Date.parse(String(b.date)) || String(a.number ?? '').localeCompare(String(b.number ?? ''));
}