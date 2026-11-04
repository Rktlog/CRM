import { useEffect, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { apiGet, apiPut } from '../lib/api';
import { useAuth } from '../context/AuthContext';

// Products that are left out of the customer reports (the price list and the monthly stocklist sales send to stores).
// - Everyone sees a small "Not in customer reports" badge on such a product, so nobody wonders why a SKU is missing from a report.
// - A manager gets a "Remove from report" / "Put back in report" button when a product is opened, and a panel at the top of the Products page to take several
//   SKUs out at once by pasting them, and to put any back.
// The list is loaded once and shared, so the badge, the button and the panel always agree.
type Item = { sku: string; name: string; brand: string | null; markedAt: string | null; markedBy: string | null };
type Snap = { loaded: boolean; ready: boolean; items: Item[]; skus: Set<string> };
let snap: Snap = { loaded: false, ready: true, items: [], skus: new Set() };
let loading = false;
const listeners = new Set<() => void>();
const publish = (d: { ready?: boolean; items?: Item[] }) => {
  const items = d.items ?? [];
  snap = { loaded: true, ready: d.ready !== false, items, skus: new Set(items.map(i => i.sku)) };
  listeners.forEach(l => l());
};
async function load() {
  if (loading || snap.loaded) return;
  loading = true;
  try { publish(await apiGet('/product-reports/hidden', { fresh: true })); }
  catch { publish({ ready: true, items: [] }); }   // a failure to load just shows nothing marked: the product list itself still works
  finally { loading = false; }
}
function useHidden(): Snap {
  const s = useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => snap);
  useEffect(() => { void load(); }, []);
  return s;
}

const NOT_SET_UP = 'Removing products from reports is not set up in the database yet. Ask whoever looks after Radar to run product-report-flag.sql.';
const pill: CSSProperties = { fontSize: 11, padding: '1px 8px', borderRadius: 10, border: '1px solid var(--line)', color: 'var(--ink-soft)', background: 'var(--panel)', whiteSpace: 'nowrap', fontWeight: 500 };

/** Next to a product's name: shown only when the product is left out of the customer reports. */
export function ReportHiddenBadge({ sku }: { sku: string }) {
  const s = useHidden();
  if (!s.skus.has(sku)) return null;
  return <span style={pill} title="This product is left out of the price list and the monthly stocklist sent to customers.">Not in customer reports</span>;
}

/** Under an opened product (managers): take it out of the customer reports, or put it back. */
export function ReportToggle({ sku }: { sku: string }) {
  const { role } = useAuth();
  const s = useHidden();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (role !== 'manager') return null;
  const hidden = s.skus.has(sku);
  async function flip() {
    setBusy(true); setErr(null);
    try { publish(await apiPut('/product-reports/hidden', { skus: [sku], hidden: !hidden })); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', padding: '8px 14px', border: '1px solid var(--line)', borderTop: 'none', background: 'var(--panel)', fontSize: 13 }}>
      <b>Customer reports</b>
      <span style={{ color: 'var(--muted)' }}>
        {!s.ready ? NOT_SET_UP : hidden ? 'Left out of the price list and the monthly stocklist.' : 'In the price list and the monthly stocklist.'}
      </span>
      {s.ready && <button className="btn secondary" style={{ padding: '4px 12px', fontSize: 12.5 }} onClick={flip} disabled={busy}>{busy ? 'Saving…' : hidden ? 'Put back in report' : 'Remove from report'}</button>}
      {err && <span className="save-msg err" role="alert">{err}</span>}
    </div>
  );
}

/** Top of the Products page (managers): what is left out, remove several SKUs at once, put any back. */
export function ReportHiddenPanel() {
  const { role } = useAuth();
  const s = useHidden();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (role !== 'manager') return null;

  async function change(skus: string[], hidden: boolean) {
    setBusy(hidden ? 'remove' : skus[0] ?? 'put'); setMsg(null);
    try {
      const r = await apiPut('/product-reports/hidden', { skus, hidden });
      publish(r);
      const n = (r.changed ?? []).length, same = (r.alreadyThatWay ?? []).length, missing: string[] = r.notFound ?? [];
      const parts = [
        hidden ? `Left out of customer reports: ${n}.` : `Put back in customer reports: ${n}.`,
        same ? `${same} already ${hidden ? 'left out' : 'in the reports'}.` : '',
        missing.length ? `Not found: ${missing.join(', ')}.` : '',
      ].filter(Boolean);
      setMsg({ ok: missing.length === 0, text: parts.join(' ') });
      if (hidden && missing.length === 0) setText('');
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
    finally { setBusy(null); }
  }
  const typed = text.split(/[\n,;\t]+/).map(x => x.trim()).filter(Boolean);

  return (
    <details style={{ margin: '10px 0 14px', border: '1px solid var(--line)', borderRadius: 6, background: 'var(--panel)' }}>
      <summary style={{ cursor: 'pointer', padding: '8px 12px', fontWeight: 600 }}>
        Left out of customer reports <span className="plan-count">{s.items.length}</span>
      </summary>
      <div style={{ padding: '4px 14px 14px', fontSize: 13 }}>
        <div style={{ color: 'var(--muted)', marginBottom: 10, maxWidth: 640 }}>
          These products are not in the price list or the monthly stocklist sent to customers, even for a store that has bought them. To take one out, open it below and press "Remove from report", or paste several SKUs here.
        </div>
        {!s.ready ? <div className="save-msg err" role="alert">{NOT_SET_UP}</div> : (
          <>
            <label style={{ display: 'grid', gap: 4, maxWidth: 520 }}>
              Remove these SKUs from customer reports (one per line, or separated by commas)
              <textarea value={text} onChange={e => setText(e.target.value)} rows={3} placeholder={'LSB-219\nLSB-223'} disabled={busy !== null} style={{ padding: '6px 9px', border: '1px solid var(--line)', borderRadius: 3, fontSize: 13, fontFamily: 'inherit' }} />
            </label>
            <div style={{ marginTop: 8 }}>
              <button className="btn secondary" style={{ padding: '5px 14px', fontSize: 12.5 }} disabled={busy !== null || typed.length === 0} onClick={() => change(typed, true)}>
                {busy === 'remove' ? 'Saving…' : typed.length ? `Remove ${typed.length} from customer reports` : 'Remove from customer reports'}
              </button>
            </div>
            {msg && <div className={msg.ok ? 'save-msg ok' : 'save-msg err'} role={msg.ok ? 'status' : 'alert'} style={{ marginTop: 8 }}>{msg.text}</div>}
            {s.items.length > 0 ? (
              <div className="manifest" style={{ marginTop: 14, maxHeight: 320, overflowY: 'auto' }}>
                <div className="m-row head" style={{ gridTemplateColumns: '1fr 3fr 1fr 1.4fr 0.9fr' }}><div>SKU</div><div>Product</div><div>Brand</div><div>Left out by</div><div></div></div>
                {s.items.map(i => (
                  <div className="m-row" key={i.sku} style={{ gridTemplateColumns: '1fr 3fr 1fr 1.4fr 0.9fr', cursor: 'default' }}>
                    <div className="num">{i.sku}</div>
                    <div>{i.name}</div>
                    <div>{i.brand ?? ''}</div>
                    <div style={{ color: 'var(--muted)' }}>{i.markedBy ?? ''}{i.markedAt ? ` ${new Date(i.markedAt).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}` : ''}</div>
                    <div><button className="btn secondary" style={{ padding: '3px 10px', fontSize: 12 }} disabled={busy !== null} onClick={() => change([i.sku], false)}>{busy === i.sku ? 'Saving…' : 'Put back'}</button></div>
                  </div>
                ))}
              </div>
            ) : <div style={{ marginTop: 14, color: 'var(--muted)' }}>Nothing is left out: every product is in the customer reports.</div>}
          </>
        )}
      </div>
    </details>
  );
}
