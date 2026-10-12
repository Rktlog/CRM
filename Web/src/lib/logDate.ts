// Dates for activity logs, as the person sees them.
//
// A log can be given a past date (a call made yesterday, logged today). The date box works in
// the person's own calendar day. A chosen day is saved as 12 noon that day on their clock, so it
// reads as that same day on every screen and in the Excel exports. (Midnight would slip to the
// day before once converted to UTC.)
const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const todayLocal = () => ymd(new Date());                          // for the date box's default and its limit
export const dateInputValue = (iso: string) => ymd(new Date(iso));        // a saved log's day, for the date box
export const isoForDay = (day: string) => new Date(`${day}T12:00:00`).toISOString();   // local noon, to save