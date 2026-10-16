// Files attached in the assistant: what is allowed, how many, and reading one into the form the API takes.
export const MAX_FILES = 5, MAX_FILE_MB = 10, MAX_TOTAL_MB = 20;
export const ACCEPT = '.pdf,.png,.jpg,.jpeg,.gif,.webp,.xlsx,.xls,.xlsm,.csv,.tsv,.txt,.md,.json,.docx';
const OK_EXT = ACCEPT.split(',').map(e => e.slice(1));
export type Pending = { name: string; type: string; size: number; data: string };

export const sizeLabel = (b: number) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

// Which of the new files can join the ones already attached. Returns those that fit and what to tell the person about the rest.
export function acceptFiles(current: { size: number }[], incoming: { name: string; size: number }[]): { ok: number[]; error: string | null } {
  const ok: number[] = []; let count = current.length, total = current.reduce((s, f) => s + f.size, 0), error: string | null = null;
  incoming.forEach((f, i) => {
    const ext = (f.name.split('.').pop() ?? '').toLowerCase();
    if (!OK_EXT.includes(ext)) { error = `${f.name}: that kind of file can't be read. Use a PDF, image, Excel, CSV, text or Word file.`; return; }
    if (f.size > MAX_FILE_MB * 1024 * 1024) { error = `${f.name} is over ${MAX_FILE_MB} MB.`; return; }
    if (count >= MAX_FILES) { error = `Attach up to ${MAX_FILES} files at a time.`; return; }
    if (total + f.size > MAX_TOTAL_MB * 1024 * 1024) { error = `Those files add up to more than ${MAX_TOTAL_MB} MB.`; return; }
    ok.push(i); count++; total += f.size;
  });
  return { ok, error };
}

export function readFile(f: File): Promise<Pending> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve({ name: f.name, type: f.type, size: f.size, data: String(r.result).split(',')[1] ?? '' });
    r.onerror = () => reject(new Error(`Couldn't read ${f.name}`));
    r.readAsDataURL(f);
  });
}