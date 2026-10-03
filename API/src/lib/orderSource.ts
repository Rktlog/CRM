// Two kinds of orders live in crm.quotes:
//   - live orders synced from DEAR (numbers start "SQ", source 'cin7')
//   - history imported from the old spreadsheet (numbers start "Q",
//     source 'rhino-history')
// History counts toward sales figures exactly as stored, but its
// statuses are frozen from the spreadsheet, so it must never show up as
// a live backorder, unpaid order, allocation or anything still to ship.
// The data itself is never changed.

export const HISTORY_SOURCE = 'rhino-history';

export const isHistory = (q: { source?: string | null }) => q.source === HISTORY_SOURCE;

// Prisma filter: live DEAR orders only.
export const LIVE_ORDER = { source: { not: HISTORY_SOURCE } };