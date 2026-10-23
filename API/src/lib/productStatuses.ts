import { prisma } from './prisma';

// The product statuses (stages): EOL, Discontinued, Preorder Only, New, and so on. They live in crm.product_statuses (product-statuses.sql),
// so a manager can add and remove them, and every screen, import, report and the assistant read the same list from here.
export type StatusRow = { key: string; label: string; meaning: string | null; tone: string; system: boolean; sortOrder: number };

export const TONES = ['rust', 'amber', 'teal', 'neutral'] as const;   // the colours a status tag can have
// EOL and Discontinued are used by the automatic EOL rule (EOL with no stock for 24 hours becomes Discontinued), so they stay.
export const SYSTEM_KEYS = ['eol', 'discontinued'] as const;
export const MAX_STATUSES = 40;

// What the table starts with. Also what is used until product-statuses.sql has been run.
export const DEFAULT_STATUSES: StatusRow[] = [
  { key: 'eol', label: 'EOL', meaning: 'End of line: being cleared, will not be reordered', tone: 'rust', system: true, sortOrder: 10 },
  { key: 'discontinued', label: 'Discontinued', meaning: 'No longer available', tone: 'neutral', system: true, sortOrder: 20 },
  { key: 'preorder_only', label: 'Preorder Only', meaning: 'Only available to pre-order', tone: 'amber', system: false, sortOrder: 30 },
  { key: 'new', label: 'New', meaning: 'New to the range', tone: 'teal', system: false, sortOrder: 40 },
  { key: 'ranging', label: 'Confirmed for Ranging', meaning: 'Confirmed to be ranged', tone: 'teal', system: false, sortOrder: 50 },
  { key: 'customer_only', label: 'For Customer Only Then Cease', meaning: 'Only for customer orders, then the product ceases', tone: 'amber', system: false, sortOrder: 60 },
  { key: 'phasing_out', label: 'Phasing Out', meaning: 'Being phased out of the range', tone: 'amber', system: false, sortOrder: 70 },
  { key: 'new_ss27', label: 'New-SS27', meaning: 'New for Spring/Summer 2027', tone: 'teal', system: false, sortOrder: 80 },
];

let cache: { at: number; list: StatusRow[]; fromDb: boolean } | null = null;
export const clearStatusCache = () => { cache = null; };

// The list, kept for 30 seconds (10 when the table is not there yet, so it is noticed soon after the SQL is run).
export async function loadStatuses(): Promise<{ list: StatusRow[]; fromDb: boolean }> {
  if (cache && Date.now() - cache.at < (cache.fromDb ? 30_000 : 10_000)) return cache;
  try {
    const rows = await prisma.$queryRaw<{ key: string; label: string; meaning: string | null; tone: string; system: boolean; sort_order: number }[]>`
      select key, label, meaning, tone, system, sort_order from crm.product_statuses order by sort_order, lower(label)`;
    cache = { at: Date.now(), fromDb: true, list: rows.map(r => ({ key: r.key, label: r.label, meaning: r.meaning, tone: r.tone, system: r.system, sortOrder: r.sort_order })) };
  } catch {
    cache = { at: Date.now(), fromDb: false, list: DEFAULT_STATUSES };   // the table has not been created yet
  }
  return cache;
}
export const listStatuses = async (): Promise<StatusRow[]> => (await loadStatuses()).list;

// Letters and digits only, in lower case: "New-SS27", "new ss27" and "NEW_SS27" are all "newss27".
export const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// A status from what someone gave: its key exactly, else its name (any case, any spaces and dashes), else its key written loosely.
// A name always wins over a loosely written key, so a name a status has taken is never mistaken for another status's key.
export function matchStatus(list: Pick<StatusRow, 'key' | 'label'>[], text: unknown): Pick<StatusRow, 'key' | 'label'> | null {
  if (typeof text !== 'string') return null;
  const n = normName(text);
  if (!n) return null;
  return list.find(s => s.key === text.trim()) ?? list.find(s => normName(s.label) === n) ?? list.find(s => normName(s.key) === n) ?? null;
}

// "New-SS27" -> "new_ss27". The key is made once from the name and never changes.
export const slugKey = (label: string): string => label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40).replace(/_+$/g, '');

// A name that is safe in a spreadsheet drop-down and a filter: no commas, quotes or line breaks. null when it is fine.
export function labelProblem(label: unknown): string | null {
  if (typeof label !== 'string' || !label.trim()) return 'Give the status a name';
  const t = label.trim();
  if (t.length > 40) return 'The name can be at most 40 characters';
  if (!/^[A-Za-z0-9][A-Za-z0-9 \-\/&()+.'’]*$/.test(t)) return 'Use letters, numbers, spaces and - / & ( ) + . in the name, starting with a letter or number (no commas or quotes)';
  if (!slugKey(t)) return 'The name needs at least one letter or number';
  return null;
}