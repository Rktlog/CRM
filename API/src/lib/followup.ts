/**
 * Looks for phrases like "follow up in 3 weeks", "call back next
 * month", "follow up after 10 days" in a note, and returns the date
 * that implies — relative to when the activity happened, not today.
 * Returns null if nothing matches; this is intentionally simple
 * pattern matching, not real NLP, so it'll miss unusual phrasing.
 */
const UNIT_DAYS: Record<string, number> = {
  day: 1,
  week: 7,
  fortnight: 14,
  month: 30,
};

export function parseFollowUp(note: string, baseDate: Date): Date | null {
  const text = note.toLowerCase();

  // "follow up in 3 weeks", "call back after 10 days", "check in in 2 months"
  const numeric = text.match(
    /(?:follow[\s-]?up|call\s*back|check\s*in|touch\s*base)\D{0,15}(?:in|after)\s+(\d+)\s*(day|week|fortnight|month)s?/
  );
  if (numeric) {
    const n = parseInt(numeric[1], 10);
    const unit = numeric[2];
    const days = n * (UNIT_DAYS[unit] ?? 0);
    if (days > 0) return addDays(baseDate, days);
  }

  // "follow up next week", "call back next month"
  const nextX = text.match(/(?:follow[\s-]?up|call\s*back|check\s*in|touch\s*base)\D{0,10}next\s+(day|week|fortnight|month)/);
  if (nextX) {
    const days = UNIT_DAYS[nextX[1]] ?? 0;
    if (days > 0) return addDays(baseDate, days);
  }

  return null;
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}
