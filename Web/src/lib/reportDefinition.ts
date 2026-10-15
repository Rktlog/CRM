// The custom report builder's shared bits (Reports page and the builder).
export type ColType = 'text' | 'number' | 'money' | 'date';
export type Col = { key: string; label: string; type: ColType; dim?: boolean };
export type Filters = {
  from?: string; to?: string; brands?: string[]; states?: string[]; categories?: string[]; statuses?: string[]; reps?: string[];
  realOrdersOnly?: boolean; inStockOnly?: boolean; includeArchived?: boolean;
};
export type Definition = { dataset: string; columns: string[]; filters: Filters; groupBy: string[]; sort?: { key: string; dir: 'asc' | 'desc' } };
export type SavedReport = { id: string; name: string; definition: Definition; shared: boolean; mine: boolean; ownerName: string };

// The definition goes in the address of a GET as base64 JSON (UTF-8 safe).
export function encodeDef(def: Definition): string {
  const bytes = new TextEncoder().encode(JSON.stringify(def));
  let s = '';
  bytes.forEach(b => { s += String.fromCharCode(b); });
  return encodeURIComponent(btoa(s));
}
export const downloadUrl = (def: Definition, name: string) => `/custom-reports/download?def=${encodeDef(def)}&name=${encodeURIComponent(name)}`;
export const fileName = (name: string) => `${(name || 'custom-report').replace(/[^A-Za-z0-9 _-]+/g, '').trim().replace(/\s+/g, '-') || 'custom-report'}.xlsx`;