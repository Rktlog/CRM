import { CSSProperties, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiDownload, apiGet } from '../lib/api';

// One promo: every order that used it, with a search and an Excel download.
type Order = { id: string; number: string; date: string; accountId: string; customer: string; region: string; qty: number; value: number; status: string; by: string };
type Page = { promo: { id: string; name: string; startsOn: string | null; endsOn: string | null; active: boolean }; orders: Order[]; totals: { orders: number; units: number; value: number } };
const th: CSSProperties = { textAlign: 'left', fontSize: 13, color: 'var(--muted)', fontWeight: 500, padding: '8px 10px', borderBottom: '1px solid var(--line)', whiteSpace: 'nowrap' };
const td: CSSProperties = { padding: '9px 10px', borderBottom: '1px solid var(--line)', fontSize: 14, verticalAlign: 'top' };
const money = (n: number) => n.toLocaleString('en-AU', { style: 'currency', currency: 'AUD' });
const dayText = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="ledger-stat" style={{ minWidth: 150 }}><div className="label">{label}</div><div className="val" style={{ fontSize: 20 }}>{value}</div></div>;
}

export default function PromoDetail() {
  const { id = '' } = useParams();
  const [d, setD] = useState<Page | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [exporting, setExporting] = useState(false);
  useEffect(() => { apiGet(`/promos/${id}/orders`, { fresh: true }).then((x: Page) => { setD(x); setErr(null); }).catch(e => setErr(e.message)); }, [id]);

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (d?.orders ?? []).filter(o => !s || `${o.number} ${o.customer} ${o.region} ${o.by}`.toLowerCase().includes(s));
  }, [d, q]);

  if (err) return <><p><Link to="/promos">← Promos</Link></p><div className="save-msg err" role="alert">{err}</div></>;
  if (!d) return <div className="acct-region">Loading…</div>;
  const p = d.promo;
  async function exportAll() {
    setExporting(true);
    try { await apiDownload(`/promos/${id}/export`, `promo-${p.name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'orders'}.xlsx`); }
    catch (e: any) { window.alert(e.message); } finally { setExporting(false); }
  }
  return (
    <>
      <p style={{ margin: '0 0 6px' }}><Link to="/promos">← Promos</Link></p>
      <h1 style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>{p.name}{!p.active && <span className="pill neutral">Off</span>}</h1>
      <div className="acct-region" style={{ marginBottom: 12 }}>{p.startsOn || p.endsOn ? `${p.startsOn ? dayText(p.startsOn) : ''}${p.endsOn ? ` to ${dayText(p.endsOn)}` : ''} · ` : ''}
        <button type="button" className="link-btn" disabled={exporting} onClick={exportAll}>{exporting ? 'Preparing…' : 'Export to Excel'}</button></div>
      <div className="ledger-stats" style={{ flexWrap: 'wrap' }}>
        <Stat label="Orders" value={String(d.totals.orders)} /><Stat label="Units redeemed" value={String(d.totals.units)} /><Stat label="Order value (ex GST)" value={money(d.totals.value)} />
      </div>
      <div style={{ margin: '14px 0' }}><input value={q} onChange={e => setQ(e.target.value)} placeholder="Search order, shop or state" aria-label="Search" style={{ width: '100%', maxWidth: 360, padding: '7px 10px', border: '1px solid var(--line)', borderRadius: 3, font: 'inherit', fontSize: 15 }} /></div>
      {d.orders.length === 0 ? <div className="empty-state">No order has used this promo yet.</div> : shown.length === 0 ? <div className="empty-state">Nothing matches that search.</div> : (
        <div style={{ overflowX: 'auto', border: '1px solid var(--line)', borderRadius: 4, background: 'var(--panel)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={th}>Order</th><th style={th}>Date</th><th style={th}>Shop</th><th style={{ ...th, textAlign: 'right' }}>Qty</th><th style={{ ...th, textAlign: 'right' }}>Order value</th><th style={th}>Status</th><th style={th}>Ticked by</th></tr></thead>
            <tbody>{shown.map(o => (
              <tr key={o.id}>
                <td style={td}><Link to={`/orders/${o.id}`}><b>{o.number}</b></Link></td>
                <td style={td}>{dayText(o.date)}</td>
                <td style={td}><Link to={`/accounts/${o.accountId}`}>{o.customer}</Link> <span className="acct-region">{o.region}</span></td>
                <td style={{ ...td, textAlign: 'right' }}>{o.qty}</td>
                <td style={{ ...td, textAlign: 'right' }}>{money(o.value)}</td>
                <td style={td}>{o.status}</td>
                <td style={td}>{o.by}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </>
  );
}
