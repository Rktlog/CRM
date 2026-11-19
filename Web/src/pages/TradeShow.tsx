import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { apiDownload, apiGet } from '../lib/api';
import { useMe } from '../lib/useMe';
import TsShowForm from '../components/TsShowForm';
import TsCustomerPicker, { type Picked } from '../components/TsCustomerPicker';
import { FollowUpTable } from './TradeShows';
import TsOffers from '../components/TsOffers';
import TsQueue from '../components/TsQueue';
import TsAppointments from '../components/TsAppointments';
import TsChecklist from '../components/TsChecklist';
import TsFeedback from '../components/TsFeedback';
import TsAsk from '../components/TsAsk';
import { $, errMsg, pct, postFull, shortDay, STAGE_TONE, type Customer, type FollowUpItem, type ShowPage } from '../lib/tradeshow';

// One show: write an order or quote, take a lead, see its orders, leads, follow-ups and results.
const th: CSSProperties = { textAlign: 'left', fontSize: 13, color: 'var(--muted)', fontWeight: 500, padding: '8px 10px', borderBottom: '1px solid var(--line)', whiteSpace: 'nowrap' };
const td: CSSProperties = { padding: '9px 10px', borderBottom: '1px solid var(--line)', fontSize: 14, verticalAlign: 'top' };
const num: CSSProperties = { ...td, textAlign: 'right', whiteSpace: 'nowrap' };
const field: CSSProperties = { width: '100%', padding: '7px 10px', border: '1px solid var(--line)', borderRadius: 3, font: 'inherit', fontSize: 15 };
type Tab = 'orders' | 'leads' | 'followups' | 'results' | 'queue' | 'offers' | 'appointments' | 'checklist' | 'feedback' | 'ask';

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return <div className="ledger-stat" style={{ minWidth: 150 }}><div className="label">{label}</div><div className="val" style={{ fontSize: 20 }}>{value}</div>{sub && <div className="acct-region" style={{ fontSize: 12.5, marginTop: 4 }}>{sub}</div>}</div>;
}

export default function TradeShow() {
  const { id = '' } = useParams(), nav = useNavigate();
  const me = useMe(), isManager = me?.role === 'manager';
  const [d, setD] = useState<ShowPage | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('orders');
  const [exporting, setExporting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [starting, setStarting] = useState<null | 'order' | 'quote' | 'lead'>(null);
  const [lead, setLead] = useState({ brands: '', notes: '' });
  const [busy, setBusy] = useState(false);
  const [matches, setMatches] = useState<Customer[] | null>(null);
  const [startErr, setStartErr] = useState<string | null>(null);
  const [fu, setFu] = useState<FollowUpItem[] | null>(null);
  const load = useCallback(() => { apiGet(`/tradeshow/shows/${id}`, { fresh: true }).then((x: ShowPage) => { setD(x); setErr(null); }).catch(e => setErr(errMsg(e))); }, [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (tab === 'followups') apiGet(`/tradeshow/followups?who=all&showId=${id}`, { fresh: true }).then((x: { followUps: FollowUpItem[] }) => setFu(x.followUps)).catch(e => setErr(errMsg(e))); }, [tab, id]);

  async function start(p: Picked) {
    if (!starting || busy) return;
    setBusy(true); setStartErr(null);
    const r = await postFull<{ id: string }>(starting === 'lead' ? '/tradeshow/leads' : '/tradeshow/orders', { showId: id, kind: starting, ...p, ...(starting === 'lead' ? lead : {}) });
    setBusy(false);
    if (r.ok) { nav(starting === 'lead' ? `/trade-shows/leads/${r.body.id}` : `/trade-shows/orders/${r.body.id}`); return; }
    if (r.status === 409 && r.body.matches) { setMatches(r.body.matches); setStartErr(null); return; }
    setStartErr(r.body.error ?? 'Something went wrong.');
  }

  if (err) return <><p><Link to="/trade-shows">← Trade Shows</Link></p><div className="save-msg err" role="alert">{err}</div></>;
  if (!d) return <div className="acct-region">Loading…</div>;
  const s = d.show, r = d.results;
  async function exportAll() {
    setExporting(true);
    try { await apiDownload(`/tradeshow/shows/${id}/export`, `trade-show-${s.name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'show'}.xlsx`); }
    catch (e) { window.alert(errMsg(e)); } finally { setExporting(false); }
  }
  const open = (k: 'order' | 'quote' | 'lead') => { setStarting(k); setMatches(null); setStartErr(null); };
  return (
    <>
      <p style={{ margin: '0 0 6px' }}><Link to="/trade-shows">← Trade Shows</Link></p>
      <h1 style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>{s.name}{s.archived && <span className="pill neutral">Closed</span>}</h1>
      <div className="acct-region" style={{ marginBottom: 12 }}>{shortDay(s.startsOn)}{s.endsOn !== s.startsOn ? ` to ${shortDay(s.endsOn)}` : ''}{s.venue ? ` · ${s.venue}` : ''}{s.stand ? ` · stand ${s.stand}` : ''}{s.staff ? ` · ${s.staff}` : ''} · references start "{s.refName}"
        {isManager && !editing && <> · <button type="button" className="link-btn" onClick={() => setEditing(true)}>Edit</button></>}
        {' · '}<Link to="/trade-shows/compare">Compare shows</Link>{' · '}<button type="button" className="link-btn" disabled={exporting} onClick={exportAll}>{exporting ? 'Preparing…' : 'Export to Excel'}</button></div>
      {editing && <TsShowForm show={s} onSaved={() => { setEditing(false); load(); }} onCancel={() => setEditing(false)} />}

      {!s.archived && !starting && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 18 }}>
          <button type="button" className="btn" onClick={() => open('order')}>New order</button>
          <button type="button" className="btn secondary" onClick={() => open('quote')}>New quote</button>
          <button type="button" className="btn secondary" onClick={() => open('lead')}>New lead</button>
        </div>
      )}
      {starting && (
        <div className="card" style={{ maxWidth: 720 }}>
          <div style={{ display: 'flex', alignItems: 'baseline' }}><div className="panel-title" style={{ flex: 1 }}>{starting === 'lead' ? 'New lead: who is it?' : `New ${starting}: which customer?`}</div><button type="button" className="link-btn" onClick={() => setStarting(null)}>Cancel</button></div>
          {starting === 'lead' && (
            <div style={{ display: 'grid', gap: 10, marginBottom: 12 }}>
              <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>Brands they liked<input style={field} value={lead.brands} onChange={e => setLead({ ...lead, brands: e.target.value })} placeholder="Miffy, Liewood…" /></label>
              <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>Notes<textarea style={{ ...field, minHeight: 50 }} value={lead.notes} onChange={e => setLead({ ...lead, notes: e.target.value })} placeholder="Opening a second shop in March…" /></label>
            </div>
          )}
          <TsCustomerPicker busy={busy} matches={matches} onPick={start} />
          {startErr && <div className="save-msg err" role="alert">{startErr}</div>}
        </div>
      )}

      <div className="tab-bar">
        {(['orders', 'leads', 'followups', 'results', 'queue', 'offers', 'appointments', 'checklist', 'feedback', 'ask'] as Tab[]).map(t => <button key={t} type="button" className={`tab${tab === t ? ' active' : ''}`} onClick={() => setTab(t)}>{t === 'orders' ? `Orders and quotes (${d.orders.length})` : t === 'leads' ? `Leads (${d.leads.length})` : t === 'followups' ? 'Follow-ups' : t === 'queue' ? 'Payments and DEAR' : t === 'offers' ? 'Offers' : t === 'appointments' ? 'Appointments' : t === 'checklist' ? 'Checklist' : t === 'feedback' ? 'Feedback' : t === 'ask' ? 'Ask Claude' : 'Results'}</button>)}
      </div>

      {tab === 'orders' && (d.orders.length === 0 ? <div className="empty-state">No orders yet.</div> : (
        <div style={{ overflowX: 'auto', border: '1px solid var(--line)', borderRadius: 4, background: 'var(--panel)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={th}>No.</th><th style={th}>Customer</th><th style={th}>Rep</th><th style={{ ...th, textAlign: 'right' }}>Ex GST</th><th style={{ ...th, textAlign: 'right' }}>Total</th><th style={th}>Where it is</th><th style={th}>Next follow-up</th></tr></thead>
            <tbody>{d.orders.map(o => (
              <tr key={o.id}>
                <td style={td}><Link to={`/trade-shows/orders/${o.id}`}><b>{o.number}</b></Link><div className="acct-region" style={{ fontSize: 12.5 }}>{o.kind === 'quote' ? 'Quote' : 'Order'} · {shortDay(o.orderDate)}</div></td>
                <td style={td}>{o.customer} <span className="acct-region">{o.region}</span>{o.newCustomer && <> <span className="pill teal">New</span></>}</td>
                <td style={td}>{o.rep}</td>
                <td style={num}>{$(o.exGst)}</td><td style={num}>{$(o.total)}</td>
                <td style={td}><span className={`pill ${STAGE_TONE[o.stage] ?? 'neutral'}`}>{o.stageLabel}</span>{o.dear && <span className="acct-region"> {o.dear}</span>}{o.emailError && o.status === 'sent' && <div style={{ color: 'var(--rust)', fontSize: 12.5 }}>Not emailed</div>}</td>
                <td style={td}>{o.nextFollowUp ? `${shortDay(o.nextFollowUp.dueOn)}, ${o.nextFollowUp.who}` : ''}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ))}

      {tab === 'leads' && (d.leads.length === 0 ? <div className="empty-state">No leads yet.</div> : (
        <div style={{ overflowX: 'auto', border: '1px solid var(--line)', borderRadius: 4, background: 'var(--panel)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={th}>Shop</th><th style={th}>Contact</th><th style={th}>Brands</th><th style={th}>Rep</th><th style={th}>Status</th><th style={th}>Next follow-up</th></tr></thead>
            <tbody>{d.leads.map(l => (
              <tr key={l.id}>
                <td style={td}><Link to={`/trade-shows/leads/${l.id}`}><b>{l.customer}</b></Link> <span className="acct-region">{l.region}</span>{l.newAccount && <> <span className="pill teal">New</span></>}</td>
                <td style={td}>{l.contact}</td><td style={td}>{l.brands}</td><td style={td}>{l.rep}</td>
                <td style={td}><span className={`pill ${l.status === 'won' ? 'teal' : l.status === 'lost' ? 'neutral' : 'amber'}`}>{l.status === 'won' ? 'Won' : l.status === 'lost' ? `Lost${l.lostReason ? `: ${l.lostReason}` : ''}` : 'Open'}</span></td>
                <td style={td}>{l.nextFollowUp ? `${shortDay(l.nextFollowUp.dueOn)}, ${l.nextFollowUp.who}` : ''}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ))}

      {tab === 'followups' && (fu === null ? <div className="acct-region">Loading…</div> : <FollowUpTable items={fu} showShow={false} />)}

      {tab === 'queue' && <TsQueue showId={id} />}
      {tab === 'offers' && <TsOffers showId={id} isManager={isManager} />}
      {tab === 'appointments' && <TsAppointments showId={id} />}
      {tab === 'checklist' && <TsChecklist showId={id} isManager={isManager} />}
      {tab === 'feedback' && <TsFeedback showId={id} />}
      {tab === 'ask' && <TsAsk showId={id} />}

      {tab === 'results' && (
        <>
          <div className="ledger-stats" style={{ flexWrap: 'wrap' }}>
            <Stat label="Orders written (ex GST)" value={$(r.orderValue)} sub={`${r.orders} ${r.orders === 1 ? 'order' : 'orders'}, average ${$(r.averageOrder)}${r.target ? `. ${pct(r.toTarget)} of the ${$(r.target)} target` : ''}`} />
            <Stat label="Quotes still open" value={$(r.quoteValue)} sub={`${r.quotes} ${r.quotes === 1 ? 'quote' : 'quotes'}`} />
            <Stat label="New customers" value={String(r.newCustomers.count)} sub={`${$(r.newCustomers.value)}; existing ${r.existingCustomers.count}, ${$(r.existingCustomers.value)}`} />
            <Stat label="Show cost" value={$(r.cost)} sub={r.cost ? `${r.costPerOrder ? `${$(r.costPerOrder)} per order, ` : ''}sales ${r.returnOnCost !== null ? `${r.returnOnCost.toFixed(1)}x` : ''} the cost` : 'Add the costs in Edit'} />
            <Stat label="Leads won" value={`${r.leads.won} of ${r.leads.taken}`} sub={`${pct(r.leads.winRate)} won, ${r.leads.lost} lost; ${$(r.leads.wonSales)} sales from them`} />
          </div>
          {r.stillWithSales > 0 && <div className="save-msg err" style={{ maxWidth: 700 }}>{r.stillWithSales} confirmed {r.stillWithSales === 1 ? 'order or quote is' : 'orders or quotes are'} not in DEAR yet.</div>}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16, marginTop: 16 }}>
            <div className="card" style={{ marginBottom: 0 }}><div className="panel-title">By rep</div>{r.byRep.map(x => <div key={x.name} className="kv"><span>{x.name} ({x.orders})</span><span className="num">{$(x.value)}</span></div>)}</div>
            <div className="card" style={{ marginBottom: 0 }}><div className="panel-title">By brand</div>{r.byBrand.map(x => <div key={x.name} className="kv"><span>{x.name}</span><span className="num">{$(x.value)}</span></div>)}</div>
          </div>
          <div className="panel-title" style={{ marginTop: 18 }}>Products ordered, with stock now</div>
          <div style={{ overflowX: 'auto', border: '1px solid var(--line)', borderRadius: 4, background: 'var(--panel)' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr><th style={th}>SKU</th><th style={th}>Product</th><th style={{ ...th, textAlign: 'right' }}>Units</th><th style={{ ...th, textAlign: 'right' }}>Value</th><th style={{ ...th, textAlign: 'right' }}>Free now</th><th style={th}>Coming</th></tr></thead>
              <tbody>{r.products.map(p => <tr key={p.sku}><td style={td}>{p.sku}</td><td style={td}>{p.name}</td><td style={num}>{p.units}</td><td style={num}>{$(p.value)}</td><td style={{ ...num, color: (p.free ?? 0) < 0 ? 'var(--rust)' : undefined }}>{p.free ?? ''}</td><td style={td}>{p.incoming ? `${p.incoming.qty}${p.incoming.date ? `, ${p.incoming.date}` : ''}${p.incoming.po ? ` (${p.incoming.po})` : ''}` : ''}</td></tr>)}</tbody>
            </table>
          </div>
          <div className="acct-region" style={{ fontSize: 12.5, marginTop: 8 }}>Values are goods ex GST after discount, the same as Sales Data. Cancelled orders are left out.</div>
        </>
      )}
    </>
  );
}
