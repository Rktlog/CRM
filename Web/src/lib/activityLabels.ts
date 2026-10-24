// What each log type is called on screen. The stored values are call, email, visit and remark, so existing logs, reports and filters
// keep working. A remark is any comment or feedback: it is logged like the others, but it is not a contact with the customer.
export const ACTIVITY_LABEL = { call: 'Phone', email: 'Email', visit: 'F2F visit', remark: 'Remark' } as const;
export type ActivityKind = keyof typeof ACTIVITY_LABEL;
export const ACTIVITY_KINDS: ActivityKind[] = ['call', 'email', 'visit', 'remark'];   // the order of the buttons
export const ACTIVITY_ICON: Record<ActivityKind, string> = { visit: '◎', call: '☎', email: '✉', remark: '✎' };