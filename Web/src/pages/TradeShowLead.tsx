import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { apiGet, apiPatch } from '../lib/api';
import TsLogFollowUps from '../components/TsLogFollowUps';
import { errMsg, postFull, shortDay, type Lead } from '../lib/tradeshow';

// A lead taken at a show: who, what they liked, its log and follow-ups. It is won by itself when the shop orders (here or in DEAR);
// it can be closed as lost with a reason.
const field: CSSProperties = { width: '100%', padding: '7px 10px', border: '1px solid var(--line)', borderRadius: 3, font: 'inherit', fontSize: 14 };

export default function TradeShowLead() {
  const { id = '' } = useParams(), nav = useNavigate();
  const [l, setL] = useState<Lead | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [f, setF] = useState({ brands: '', notes: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const show = useCallback((x: Lead) => { setL(x); setF({ brands: x.brands ?? '', notes: x.notes ?? '' }); }, []);
  const load = useCallback(() => { apiGet(`/tradeshow/leads/${id}`, { fresh: true }).then((d: { lead: Lead }) => { show(d.lead); setErr(null); }).catch(e => setErr(errMsg(e))); }, [id, show]);
  useEffect(() => { load(); }, [load]);
  async function patch(b: object, ok: string) {
    setBusy(true); setMsg(null);
    try { const d: { lead: Lead } = await apiPatch(`/tradeshow/leads/${id}`, b); show(d.lead); setMsg({ ok: true, text: ok }); } catch (e) { setMsg({ ok: false, text: errMsg(e) }); } finally { setBusy(false); }
  }
  async function order() {
    if (!l) return;
    setBusy(true);
    const r = await postFull<{ id: string }>('/tradeshow/orders', { showId: l.show.id, kind: 'order', accountId: l.customer.id });
    setBusy(false);
    if (r.ok) nav(`/trade-shows/orders/${r.body.id}`); else setMsg({ ok: false, text: r.body.error ?? 'Something went wrong.' });
  }
  if (err) return <><p><Link to="/trade-shows">← Trade Shows</Link></p><div className="save-msg err" role="alert">{err}</div></>;
  if (!l) return <div className="acct-region">Loading…</div>;
  return (
    <>
      <p style={{ margin: '0 0 6px' }}><Link to={`/trade-shows/${l.show.id}`}>← {l.show.name}</Link></p>
      <h1 style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>Lead: {l.customer.name}
        <span className={`pill ${l.status === 'won' ? 'teal' : l.status === 'lost' ? 'neutral' : 'amber'}`}>{l.status === 'won' ? 'Won: they ordered' : l.status === 'lost' ? `Lost: ${l.lostReason}` : 'Open'}</span></h1>
      <div className="acct-region" style={{ marginBottom: 14 }}>Taken {shortDay(l.takenOn)} by {l.repName ?? 'unknown'}{l.newAccount ? ' · new account' : ''} · <Link to={`/accounts/${l.customer.id}`}>open the account</Link></div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16, marginBottom: 16 }}>
        <div className="card" style={{ marginBottom: 0 }}>
          <div className="panel-title">Contact</div>
          <div style={{ fontSize: 14, lineHeight: 1.7 }}>{[l.contact.name, l.contact.email, l.contact.phone].filter(Boolean).map(x => <div key={x}>{x}</div>)}<div className="acct-region">{l.customer.region}{l.customer.address ? ` · ${l.customer.address}` : ''}</div></div>
          {l.status === 'open' && <div style={{ display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
            <button type="button" className="btn" disabled={busy} onClick={order}>Write an order for them</button>
            <button type="button" className="link-btn" disabled={busy} onClick={() => { const why = window.prompt('Why is it closed? (for example "not a fit", "too small", "can\'t reach them")'); if (why) patch({ status: 'lost', reason: why }, 'Closed as lost.'); }}>Close as lost</button>
          </div>}
          {l.status === 'lost' && <button type="button" className="link-btn" style={{ marginTop: 10 }} disabled={busy} onClick={() => patch({ status: 'open' }, 'Opened again.')}>Open it again</button>}
        </div>
        <div className="card" style={{ marginBottom: 0 }}>
          <div className="panel-title">What they are interested in</div>
          <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>Brands<input style={field} value={f.brands} onChange={e => setF({ ...f, brands: e.target.value })} /></label>
          <label style={{ display: 'grid', gap: 4, fontSize: 13, marginTop: 8 }}>Notes<textarea style={{ ...field, minHeight: 60 }} value={f.notes} onChange={e => setF({ ...f, notes: e.target.value })} /></label>
          {(f.brands !== (l.brands ?? '') || f.notes !== (l.notes ?? '')) && <button type="button" className="btn secondary" style={{ marginTop: 8 }} disabled={busy} onClick={() => patch(f, 'Saved.')}>Save</button>}
        </div>
      </div>
      {msg && <div className={msg.ok ? 'save-msg ok' : 'save-msg err'} role={msg.ok ? 'status' : 'alert'}>{msg.text}</div>}
      <TsLogFollowUps target={{ leadId: l.id }} log={l.log} followUps={l.followUps} closed={l.followUpsClosed} onChange={load}
        closedNote={l.status === 'won' ? 'They have ordered: the lead is won, no more follow-ups.' : 'Closed: no more follow-ups.'} />
    </>
  );
}
