// What each log type is called on screen. The stored values stay call, email
// and visit, so existing logs, reports and filters keep working.
export const ACTIVITY_LABEL = { call: 'Phone', email: 'Email', visit: 'F2F visit' } as const;
export type ActivityKind = keyof typeof ACTIVITY_LABEL;