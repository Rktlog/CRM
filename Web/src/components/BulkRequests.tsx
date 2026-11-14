import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { apiGet, apiPost } from '../lib/api';

// Several products for the SAME store at once: search and add them one by one, or paste or upload a list (SKU, quantity, note; a spreadsheet's columns work).
// The list is checked first and shown back, and nothing is made until "Send these requests" is pressed. Each product becomes its own request, with one alert email for the lot.
type Found = { sku: string; name: string; brand: string | null; available: number; onOrder: number };
type Row = { line: number; sku: string; qty: number | null; note: string | null; status?: 'ok' | 'unknown' | 'repeat' | 'already'; name?: string | null; brand?: string | null; available?: number | null };
type Result = { created: { id: string; sku: string | null }[]; skipped: { line: number; sku: string; reason: string }[] };
const field: CSSProperties = { width: '100%', maxWidth: 420, padding: '6px 9px', border: '1px solid var(--line)', borderRadius: 3, fontSize: 14, font: 'inherit' };
const label: CSSProperties = { display: 'grid', gap: 4, fontSize: 13 };
const STATUS: Record<NonNullable<Row['status']>, { text: string; tone: string }> = { ok: { text: 'Ready', tone: 'teal' }, unknown: { text: 'Not a SKU Radar knows', tone: 'rust' }, repeat: { text: 'In the list twice', tone: 'amber' }, already: { text: 'This store already asked for it', tone: 'amber' } };
const msgOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function BulkRequests({ onMade }: { onMade: () => void }) {
  const [customer, setCustomer] = useState('');
  const [neededBy, setNeededBy] = useState('');
  const [notes, setNotes] = useState('');
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Found[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [paste, setPaste] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (q.trim().length < 2) { setFound([]); return; }
    timer.current = setTimeout(() => { apiGet(`/products/search?q=${encodeURIComponent(q.trim())}`).then((d: { results: Found[] }) => setFound((d?.results ?? []).slice(0, 8))).catch(() => setFound([])); }, 250);
  }, [q]);

  async function check(list: Row[] | null, text?: string) {
    setBusy(true); setNote(null); setResult(null);
    try {
      const r: { rows: Row[]; problems: string[] } = await apiPost('/product-requests/bulk/check', text !== undefined ? { text, customer } : { rows: list, customer });
      setRows(r.rows); setProblems(r.problems);
    } catch (e) { setNote({ ok: false, text: msgOf(e) }); } finally { setBusy(false); }
  }
  function add(p: Found) { const next = [...rows, { line: rows.length + 1, sku: p.sku, qty: null, note: null }]; setQ(''); setFound([]); void check(next); }
  function setQty(i: number, v: string) { setRows(rows.map((r, n) => (n === i ? { ...r, qty: v === '' ? null : Number(v) } : r))); }
  function remove(i: number) { void check(rows.filter((_, n) => n !== i).map((r, n) => ({ ...r, line: n + 1 }))); }
  async function upload(file: File | undefined) { if (!file) return; const text = await file.text(); setPaste(text); await check(null, text); }
  const ready = rows.filter(r => r.status === 'ok');
  async function send() {
    setBusy(true); setNote(null);
    try {
      const r: Result = await apiPost('/product-requests/bulk', { customer, neededBy, notes, items: ready.map(x => ({ line: x.line, sku: x.sku, qty: x.qty, note: x.note })) });
      setResult(r); setNote({ ok: r.created.length > 0, text: r.created.length ? `${r.created.length} request${r.created.length === 1 ? '' : 's'} sent for ${customer}. The ordering team gets one email for them.` : 'Nothing was sent.' });
      if (r.created.length) { setRows([]); setPaste(''); onMade(); }
    } catch (e) { setNote({ ok: false, text: msgOf(e) }); } finally { setBusy(false); }
  }

  return (
    <div style={{ display: 'grid', gap: 12, maxWidth: 680 }} aria-label="Several products for one store">
      <label style={label}>Which store are they for?<input aria-label="Store" value={customer} onChange={e => setCustomer(e.target.value)} placeholder="Store name" style={field} /></label>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <label style={label}>Needed by (optional)<input type="date" aria-label="Needed by" value={neededBy} onChange={e => setNeededBy(e.target.value)} style={{ ...field, width: 180 }} /></label>
        <label style={{ ...label, flex: '1 1 240px' }}>Note for all of them (optional)<input aria-label="Note for all" value={notes} onChange={e => setNotes(e.target.value)} style={field} /></label>
      </div>
      <div>
        <label style={label}>Add a product (type its SKU or name)<input aria-label="Add a product" value={q} onChange={e => setQ(e.target.value)} placeholder="Search SKU or product name" autoComplete="off" style={field} /></label>
        {found.length > 0 && <div style={{ border: '1px solid var(--line)', borderRadius: 4, marginTop: 4, maxWidth: 420 }}>{found.map(p => <button type="button" key={p.sku} className="link-btn" aria-label={`Add ${p.sku}`} onClick={() => add(p)} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '5px 9px' }}>{p.sku} · {p.name}</button>)}</div>}
      </div>
      <details>
        <summary style={{ cursor: 'pointer', fontSize: 13 }}>Or paste or upload a list</summary>
        <div style={{ display: 'grid', gap: 6, marginTop: 6 }}>
          <div className="acct-region" style={{ fontSize: 12 }}>One product a line: SKU, quantity, note. Copying three columns from a spreadsheet works too. Up to 100 at a time.</div>
          <textarea aria-label="Paste a list" value={paste} onChange={e => setPaste(e.target.value)} rows={5} placeholder={'24182601, 12, for the window\n24182602, 6'} style={{ ...field, maxWidth: 520, fontFamily: 'monospace' }} />
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <button type="button" className="btn secondary" disabled={busy || !paste.trim()} onClick={() => check(null, paste)}>Check the list</button>
            <label className="acct-region" style={{ fontSize: 13 }}>or upload a file <input type="file" accept=".csv,.txt,text/csv,text/plain" aria-label="Upload a list" onChange={e => { void upload(e.target.files?.[0]); e.target.value = ''; }} /></label>
          </div>
        </div>
      </details>
      {problems.length > 0 && <div className="save-msg err" role="alert">{problems.join(' ')}</div>}
      {rows.length > 0 && (
        <div className="table-scroll">
          <table style={{ width: '100%', fontSize: 13.5 }} aria-label="Products to request">
            <thead><tr style={{ textAlign: 'left', color: 'var(--muted)' }}><th>SKU</th><th>Product</th><th>Quantity</th><th>Note</th><th /><th /></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.sku}-${i}`} style={{ borderTop: '1px solid var(--line)' }}>
                  <td style={{ padding: '4px 8px 4px 0' }}>{r.sku}</td>
                  <td>{r.name ?? ''}{r.available != null && <span className="acct-region"> · {r.available.toLocaleString('en-AU')} available</span>}</td>
                  <td><input aria-label={`Quantity for ${r.sku}`} inputMode="numeric" value={r.qty ?? ''} onChange={e => setQty(i, e.target.value)} style={{ ...field, width: 80 }} /></td>
                  <td>{r.note ?? ''}</td>
                  <td>{r.status && <span className={`pill ${STATUS[r.status].tone}`}>{STATUS[r.status].text}</span>}</td>
                  <td><button type="button" className="link-btn" aria-label={`Remove ${r.sku}`} onClick={() => remove(i)}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows.length > 0 && <div className="acct-region">{ready.length} of {rows.length} ready to send. The others are left out{rows.length > ready.length ? ' (see why beside each)' : ''}.</div>}
      <div><button type="button" className="btn" disabled={busy || !customer.trim() || !ready.length} onClick={send}>{busy ? 'Working…' : `Send ${ready.length || ''} request${ready.length === 1 ? '' : 's'}`.replace('  ', ' ')}</button></div>
      {note && <div className={note.ok ? 'save-msg ok' : 'save-msg err'} role={note.ok ? 'status' : 'alert'}>{note.text}</div>}
      {result && result.skipped.length > 0 && <div className="acct-region">Not sent: {result.skipped.map(s => `${s.sku || `line ${s.line}`} (${s.reason})`).join('; ')}.</div>}
    </div>
  );
}
