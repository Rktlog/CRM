import { useState } from 'react';
import { apiDownload, apiPostText } from '../lib/api';
import { statusInfo, useProductStatuses } from '../lib/productStatus';

// Products > Import. Download the template, fill in SKU, image link and status, upload it. It shows what would change
// first; nothing is saved until you press Apply. Name, brand, stock and prices stay as DEAR has them.

type Change = { sku: string; name: string; image?: { from: string | null; to: string }; status?: { from: string | null; to: string | null }; eta?: { from: string | null; to: string | null } };
type Plan = {
  applied: boolean;
  counts: { rows: number; matched: number; toUpdate: number; unchanged: number; notFound: number; problems: number; statusesSet: number; statusesCleared: number; imagesSet: number; etasSet: number; etasCleared: number; nameDiffers: number };
  changes: Change[];
  problems: { row: number; sku: string; message: string }[];
};

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const label = (s: string | null | undefined) => statusInfo(s)?.label ?? 'none';

export default function ProductImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  useProductStatuses();   // so the status names below follow the list, which managers can change
  const [file, setFile] = useState<File | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function template(blank: boolean) {
    setBusy('template'); setError(null);
    try { await apiDownload(`/products/template${blank ? '?blank=1' : ''}`, `product-import-${blank ? 'blank-' : ''}template.xlsx`); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  }

  async function send(apply: boolean) {
    if (!file) return;
    setBusy(apply ? 'apply' : 'check'); setError(null);
    try {
      const body = toBase64(await file.arrayBuffer());
      const qs = apply ? `?apply=1&expect=${plan?.changes.length ?? 0}` : '';
      const r: Plan = await apiPostText(`/products/import${qs}`, body, 'text/plain');
      setPlan(r);
      if (apply) { setDone(true); onDone(); }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const c = plan?.counts;
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" style={{ maxWidth: 780, width: '94vw', maxHeight: '90vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
        <h2 style={{ marginTop: 0 }}>Import products</h2>
        <div className="acct-region" style={{ marginBottom: 12, maxWidth: 640 }}>
          Set each product's status (EOL, Discontinued, Pre-order, New, Confirmed for Ranging, For Customer Only Then Cease, Preorder Only), ETA and photo link from a spreadsheet.
          Everything else (name, brand, stock, prices) stays as DEAR has it.
        </div>

        <div className="stat-label">1. Get the template</div>
        <div style={{ display: 'flex', gap: 8, margin: '6px 0 14px', flexWrap: 'wrap' }}>
          <button type="button" className="btn secondary" disabled={busy === 'template'} onClick={() => template(false)}>⬇ All products, as they are now</button>
          <button type="button" className="btn secondary" disabled={busy === 'template'} onClick={() => template(true)}>⬇ Blank template</button>
        </div>

        <div className="stat-label">2. Fill it in, then choose the file</div>
        <div className="acct-region" style={{ margin: '4px 0 6px' }}>
          Columns: SKU, Product name (to help you find it), Image link, Status, ETA. Leave Image link blank to keep the current photo. ETA is the date of the next delivery.
        </div>
        <input type="file" accept=".xlsx,.csv" onChange={e => { setFile(e.target.files?.[0] ?? null); setPlan(null); setDone(false); setError(null); }} />

        <div style={{ display: 'flex', gap: 8, margin: '12px 0' }}>
          <button type="button" className="btn" disabled={!file || !!busy} onClick={() => send(false)}>{busy === 'check' ? 'Checking…' : '3. Check the file'}</button>
        </div>

        {error && <div className="save-msg err" style={{ marginBottom: 10 }}>{error}</div>}

        {plan && c && (
          <>
            <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', margin: '4px 0 10px' }}>
              <Fig label="Rows read" v={c.rows} />
              <Fig label={done ? 'Updated' : 'Will update'} v={c.toUpdate} tone="teal" />
              <Fig label="No change" v={c.unchanged} />
              <Fig label="SKU not found" v={c.notFound} tone={c.notFound ? 'rust' : undefined} />
              <Fig label="Skipped, see below" v={c.problems - c.notFound > 0 ? c.problems - c.notFound : 0} tone={c.problems - c.notFound > 0 ? 'amber' : undefined} />
            </div>
            <div className="acct-region" style={{ marginBottom: 8 }}>
              {c.statusesSet} statuses set, {c.statusesCleared} cleared. {c.etasSet} ETAs set, {c.etasCleared} cleared. {c.imagesSet} photo links changed.
            </div>
            {c.statusesCleared > 0 && !done && (
              <div className="save-msg err" style={{ marginBottom: 8 }}>
                {c.statusesCleared} {c.statusesCleared === 1 ? 'product has' : 'products have'} a blank Status in the file, so {c.statusesCleared === 1 ? 'it' : 'they'} will lose the status {c.statusesCleared === 1 ? 'it has' : 'they have'} now. Delete the Status column if you don't want statuses touched.
              </div>
            )}

            {c.etasCleared > 0 && !done && (
              <div className="save-msg err" style={{ marginBottom: 8 }}>
                {c.etasCleared} {c.etasCleared === 1 ? 'product has' : 'products have'} a blank ETA in the file, so the ETA set by hand will be removed (the date on the incoming order in DEAR shows instead). Delete the ETA column if you don't want ETAs touched.
              </div>
            )}

            {plan.changes.length > 0 && (
              <div className="ledger-table-scroll" style={{ maxHeight: 220, marginBottom: 10 }}>
                <table className="ov-table">
                  <thead><tr><th>SKU</th><th>Product</th><th>Status</th><th>ETA</th><th>Photo</th></tr></thead>
                  <tbody>
                    {plan.changes.slice(0, 200).map(ch => (
                      <tr key={ch.sku}>
                        <td className="num">{ch.sku}</td>
                        <td>{ch.name}</td>
                        <td>{ch.status ? `${label(ch.status.from)} → ${label(ch.status.to)}` : <span className="acct-region">same</span>}</td>
                        <td>{ch.eta ? `${ch.eta.from ?? 'none'} → ${ch.eta.to ?? 'none'}` : <span className="acct-region">same</span>}</td>
                        <td>{ch.image ? (ch.image.from ? 'changed' : 'added') : <span className="acct-region">same</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {plan.changes.length > 200 && <div className="acct-region" style={{ marginBottom: 8 }}>Showing the first 200 of {plan.changes.length} changes.</div>}

            {plan.problems.length > 0 && (
              <details style={{ marginBottom: 10 }}>
                <summary>{plan.problems.length} {plan.problems.length === 1 ? 'row' : 'rows'} skipped or partly skipped</summary>
                <div className="ledger-table-scroll" style={{ maxHeight: 160, marginTop: 6 }}>
                  <table className="ov-table">
                    <thead><tr><th>Row</th><th>SKU</th><th>What happened</th></tr></thead>
                    <tbody>{plan.problems.map((p, i) => <tr key={i}><td className="num">{p.row}</td><td className="num">{p.sku}</td><td>{p.message}</td></tr>)}</tbody>
                  </table>
                </div>
              </details>
            )}

            {done
              ? <div className="save-msg ok">Done. {c.toUpdate} {c.toUpdate === 1 ? 'product' : 'products'} updated.</div>
              : <button type="button" className="btn" disabled={!!busy || plan.changes.length === 0} onClick={() => send(true)}>
                  {busy === 'apply' ? 'Applying…' : plan.changes.length ? `Apply ${plan.changes.length} ${plan.changes.length === 1 ? 'change' : 'changes'}` : 'Nothing to change'}
                </button>}
          </>
        )}

        <div className="modal-actions" style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <button type="button" className="btn secondary" onClick={onClose}>{done ? 'Close' : 'Cancel'}</button>
        </div>
      </div>
    </div>
  );
}

function Fig({ label, v, tone }: { label: string; v: number; tone?: string }) {
  return (
    <div>
      <div className="stat-label">{label}</div>
      <div className="num" style={{ fontSize: 22, fontWeight: 700, color: tone ? `var(--${tone})` : undefined }}>{v.toLocaleString('en-AU')}</div>
    </div>
  );
}