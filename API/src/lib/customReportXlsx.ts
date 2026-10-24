import * as XLSX from 'xlsx';
import { DATASETS, Definition, Shaped } from './customReport';
import { ACTIVITY_TARGETS } from './weeklyActivity';

// A custom report as an Excel file: the data on one sheet, and a second sheet saying exactly what was asked for,
// so the file still makes sense when someone opens it in three months.
export function describeFilters(def: Definition): string[] {
  const f = def.filters, out: string[] = [];
  if (f.from || f.to) out.push(`${def.dataset === 'weekly_activity' ? 'Week' : 'Order date'} ${f.from ? `from ${f.from}` : ''}${f.from && f.to ? ' ' : ''}${f.to ? `to ${f.to}` : ''}`);
  if (f.brands?.length) out.push(`Brand: ${f.brands.join(', ')}`);
  if (f.states?.length) out.push(`State: ${f.states.join(', ')}`);
  if (f.categories?.length) out.push(`Category: ${f.categories.join(', ')}`);
  if (f.statuses?.length) out.push(`Status: ${f.statuses.join(', ')}`);
  if (f.reps?.length) out.push(`Rep: ${f.reps.join(', ')}`);
  if (def.dataset === 'sales') out.push(f.realOrdersOnly === false ? 'Includes drafts, quotes and voided orders' : 'Real orders only (not drafts, quotes or voided)');
  if (def.dataset === 'weekly_activity') out.push('Weeks run Monday to Sunday and belong to the month they start in', `Targets: ${ACTIVITY_TARGETS.f2fPerWeek}+ F2F visits and ${ACTIVITY_TARGETS.quotesPerWeek}+ sales quotes a week, ${ACTIVITY_TARGETS.newPerMonth}+ new or returning customers a month`);
  if (f.inStockOnly) out.push('In stock only');
  if (def.dataset === 'customers') out.push(f.includeArchived ? 'Includes archived accounts' : 'Archived accounts left out');
  return out.length ? out : ['None'];
}

export function reportWorkbook(shaped: Shaped, def: Definition, info: { name: string; by: string; on: string }): Buffer {
  const cols = shaped.columns;
  const asDate = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00Z`) : v);
  const aoa: unknown[][] = [cols.map(c => c.label), ...shaped.rows.map(r => cols.map(c => (c.type === 'date' ? asDate(r[c.key]) : r[c.key])))];
  const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true });
  ws['!cols'] = cols.map((c, i) => ({ wch: Math.min(48, Math.max(c.label.length + 2, ...shaped.rows.slice(0, 500).map(r => String(r[cols[i].key] ?? '').length + 2))) }));
  const last = Math.max(shaped.rows.length, 1);
  ws['!autofilter'] = { ref: `A1:${XLSX.utils.encode_col(cols.length - 1)}${last + 1}` };
  for (const addr of Object.keys(ws)) {
    if (addr[0] === '!') continue;
    const { r, c } = XLSX.utils.decode_cell(addr);
    if (r === 0) continue;
    const t = cols[c].type;
    if (t === 'money' && ws[addr].t === 'n') ws[addr].z = '#,##0.00';
    else if (t === 'date' && ws[addr].t === 'd') ws[addr].z = 'dd mmm yyyy';
  }
  const about = XLSX.utils.aoa_to_sheet([
    ['Report', info.name],
    ['Built by', info.by],
    ['Built on', info.on],
    ['About', DATASETS[def.dataset].label],
    ['Rows', shaped.rows.length],
    ['Added up by', def.groupBy.length ? def.groupBy.map(k => DATASETS[def.dataset].columns.find(c => c.key === k)?.label ?? k).join(', ') : 'Not added up: one row each'],
    ['Ordered by', def.sort ? `${shaped.columns.find(c => c.key === def.sort!.key)?.label ?? def.sort.key}, ${def.sort.dir === 'desc' ? 'high to low' : 'low to high'}` : 'Not ordered'],
    ['Filters', ...describeFilters(def)],
  ]);
  about['!cols'] = [{ wch: 14 }, { wch: 90 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Report');
  XLSX.utils.book_append_sheet(wb, about, 'About this report');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellDates: true });
}