import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiGet, apiDownload } from '../lib/api';
import { fmtMoney, fmtDate } from '../lib/types';
import { useMe, stateOptionsFor } from '../lib/useMe';
import StateFilter from '../components/StateFilter';

// Credit: every credit note on account, every reservation (one row each, whose status
// changes from Reserved to Used when DEAR shows the credit applied), and every credit
// movement, so the team can follow where credit has gone. Credit is applied in DEAR.

type NoteRow = {
  accountId: string; account: string; region: string; rep: string | null; orderNo: string; creditNo: string; date: string | null;
  total: number; applied: number; refunded: number; onAccount: number; reservedAmount: number; reservedFor: string | null; free: number;
};
type Reservation = {
  id: string; name: string; accountId: string; account: string; region: string; rep: string | null; amount: number;
  creditNo: string | null; orderRef: string | null; usedOnOrder: string | null; note: string | null;
  status: 'reserved' | 'used' | 'cancelled'; createdAt: string; createdBy: string | null; resolvedAt: string | null; resolvedBy: string | null;
};
type Totals = { onAccount: number; reserved: number; free: number; openNotes: number; customers: number };
type Move = {
  date: string | null; type: string; accountId: string; account: string; region: string; rep: string | null;
  creditNo: string | null; reference: string | null; amount: number; by: string | null;
};
const PAGE = 100;
const TONE: Record<string, string> = { 'Credit note issued': 'teal', 'Applied to invoice': 'neutral', 'Refunded to customer': 'rust' };
const STATUS_TONE = { reserved: 'amber', used: 'teal', cancelled: 'neutral' } as const;
const STATUS_WORD = { reserved: 'Reserved', used: 'Used', cancelled: 'Released' } as const;

export default function Credit() {
  const me = useMe();
  const stateOptions = stateOptionsFor(me);
  const [tab, setTab] = useState<'notes' | 'reservations' | 'moves'>('notes');
  const [region, setRegion] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('open');
  const [resStatus, setResStatus] = useState('reserved');
  const [reservations, setReservations] = useState<Reservation[] | null>(null);
  const [type, setType] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const [notes, setNotes] = useState<NoteRow[] | null>(null);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [moves, setMoves] = useState<Move[]>([]);
  const [moveTotal, setMoveTotal] = useState(0);
  const [types, setTypes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  const base = () => {
    const p = new URLSearchParams();
    if (region) p.set('region', region);
    if (search.trim()) p.set('q', search.trim());
    return p;
  };

  // The totals follow the state filter and search, on both tabs.
  useEffect(() => {
    const t = setTimeout(() => {
      setError(null);
      const p = base();
      if (tab === 'notes') {
        p.set('status', status);
        setLoading(true);
        apiGet(`/credit/notes?${p.toString()}`).then(d => { setNotes(d.rows); setTotals(d.totals); }).catch(e => setError(e.message)).finally(() => setLoading(false));
      } else if (tab === 'reservations') {
        apiGet(`/credit/notes?${base().toString()}`).then(d => setTotals(d.totals)).catch(() => {});
        const p2 = base();
        if (resStatus) p2.set('status', resStatus);
        setLoading(true);
        apiGet(`/credit/reservations?${p2.toString()}`).then(d => setReservations(d.rows)).catch(e => setError(e.message)).finally(() => setLoading(false));
      } else {
        apiGet(`/credit/notes?${base().toString()}`).then(d => setTotals(d.totals)).catch(() => {});
        loadMoves(0, false);
      }
    }, search ? 300 : 0);
    return () => clearTimeout(t);
  }, [tab, region, search, status, resStatus, type, from, to]);

  function loadMoves(offset: number, append: boolean) {
    const p = base();
    if (type) p.set('type', type);
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    p.set('limit', String(PAGE)); p.set('offset', String(offset));
    setLoading(true);
    apiGet(`/credit/movements?${p.toString()}`)
      .then(d => { setMoves(prev => (append ? [...prev, ...d.rows] : d.rows)); setMoveTotal(d.total); setTypes(d.types); })
      .catch(e => setError(e.message)).finally(() => setLoading(false));
  }

  async function download() {
    setDownloading(true);
    try {
      const p = base();
      if (type) p.set('type', type);
      if (from) p.set('from', from);
      if (to) p.set('to', to);
      await apiDownload(`/exports/credit-movements?${p.toString()}`, 'credit.xlsx');
    } catch { alert('Download failed. Check the API is running.'); }
    finally { setDownloading(false); }
  }

  const signed = (n: number) => (n < 0 ? `-${fmtMoney(-n)}` : fmtMoney(n));

  return (
    <>
      <h1>Credit</h1>
      <div className="stock-as-of">
        Every credit note on account, every reservation and every credit movement. Credit is applied in DEAR. A reservation is the team's plan, and the same row is marked used by itself once DEAR shows that credit note applied.
      </div>

      <div className="stat-row" style={{ margin: '12px 0' }}>
        <Stat label="Credit on account" value={totals ? fmtMoney(totals.onAccount) : '…'} sub={totals ? `${totals.openNotes} credit notes, ${totals.customers} customers` : ''} tone="flag-teal" />
        <Stat label="Reserved for orders" value={totals ? fmtMoney(totals.reserved) : '…'} sub="set aside, waiting for DEAR" tone="flag-amber" />
        <Stat label="Free to use" value={totals ? fmtMoney(totals.free) : '…'} sub="not reserved" />
      </div>

      <div className="controls" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
        <StateFilter value={region} onChange={setRegion} options={stateOptions} allLabel={me?.role === 'manager' ? 'All states' : 'All my states'} />
        <input type="search" placeholder="Search customer, credit no or order" value={search} onChange={e => setSearch(e.target.value)}
          style={{ padding: '7px 10px', border: '1px solid var(--line)', borderRadius: 6, font: 'inherit', fontSize: 13, background: 'var(--panel)', minWidth: 240 }} />
        <button className="btn secondary" style={{ marginLeft: 'auto' }} disabled={downloading} onClick={download}>{downloading ? 'Downloading…' : '⬇ Excel'}</button>
      </div>

      <div className="tab-bar" style={{ marginBottom: 12 }}>
        <button className={'tab' + (tab === 'notes' ? ' active' : '')} onClick={() => setTab('notes')}>Credit on account</button>
        <button className={'tab' + (tab === 'reservations' ? ' active' : '')} onClick={() => setTab('reservations')}>Reservations</button>
        <button className={'tab' + (tab === 'moves' ? ' active' : '')} onClick={() => setTab('moves')}>Movements</button>
      </div>

      {error && <div className="empty-state">Couldn't load credit: {error}</div>}

      {!error && tab === 'notes' && (
        <>
          <div className="controls" style={{ marginBottom: 8 }}>
            <select value={status} onChange={e => setStatus(e.target.value)} aria-label="Credit status">
              <option value="open">Free to use</option>
              <option value="reserved">Reserved</option>
              <option value="used">Fully used</option>
              <option value="">All credit notes</option>
            </select>
          </div>
          {loading && !notes ? <div className="empty-state">Loading…</div>
            : !notes || !notes.length ? <div className="empty-state">No credit notes match.</div>
            : (
              <div className="manifest">
                <div className="m-row head" style={{ gridTemplateColumns: '2fr 0.5fr 0.9fr 0.8fr 0.8fr 0.9fr 0.9fr 1.2fr' }}>
                  <div>Customer</div><div>State</div><div>Credit no</div><div>Date</div><div className="num">Total</div><div className="num">Applied</div><div className="num">On account</div><div>Reserved</div>
                </div>
                {notes.map(n => (
                  <div className="m-row" key={n.creditNo + n.orderNo} style={{ gridTemplateColumns: '2fr 0.5fr 0.9fr 0.8fr 0.8fr 0.9fr 0.9fr 1.2fr', cursor: 'default' }}>
                    <div><Link to={`/accounts/${n.accountId}`} className="order-link">{n.account}</Link>{n.rep && <div className="acct-region">{n.rep}</div>}</div>
                    <div>{n.region}</div>
                    <div>{n.creditNo}<div className="acct-region">{n.orderNo}</div></div>
                    <div>{n.date ? fmtDate(n.date) : ''}</div>
                    <div className="num">{fmtMoney(n.total)}</div>
                    <div className="num">{fmtMoney(n.applied + n.refunded)}</div>
                    <div className="num"><b>{fmtMoney(n.onAccount)}</b></div>
                    <div>
                      {n.reservedAmount > 0.005 && <span className="pill amber">{fmtMoney(n.reservedAmount)}{n.reservedFor ? ` · ${n.reservedFor}` : ''}</span>}
                      {n.reservedAmount <= 0.005 && <span className="acct-region">{n.onAccount > 0.005 ? 'Free' : 'Used'}</span>}
                      {n.reservedAmount > 0.005 && n.free > 0.005 && <div className="acct-region">{fmtMoney(n.free)} free</div>}
                    </div>
                  </div>
                ))}
              </div>
            )}
        </>
      )}

      {!error && tab === 'reservations' && (
        <>
          <div className="controls" style={{ marginBottom: 8 }}>
            <select value={resStatus} onChange={e => setResStatus(e.target.value)} aria-label="Reservation status">
              <option value="reserved">Reserved</option>
              <option value="used">Used</option>
              <option value="cancelled">Released</option>
              <option value="">All reservations</option>
            </select>
          </div>
          {loading && !reservations ? <div className="empty-state">Loading…</div>
            : !reservations || !reservations.length ? <div className="empty-state">No reservations match.</div>
            : (
              <div className="manifest">
                <div className="m-row head" style={{ gridTemplateColumns: '2fr 0.5fr 0.9fr 0.9fr 1fr 1.6fr 1fr' }}>
                  <div>Name</div><div>State</div><div className="num">Amount</div><div>Credit no</div><div>Sales order / quote</div><div>Note</div><div>Status</div>
                </div>
                {reservations.map(r => (
                  <div className="m-row" key={r.id} style={{ gridTemplateColumns: '2fr 0.5fr 0.9fr 0.9fr 1fr 1.6fr 1fr', cursor: 'default' }}>
                    <div>
                      <Link to={`/accounts/${r.accountId}`} className="order-link">{r.name}</Link>
                      <div className="acct-region">{r.name !== r.account ? `${r.account}. ` : ''}{r.createdBy ?? ''}{r.createdBy ? ', ' : ''}{r.createdAt ? fmtDate(r.createdAt) : ''}</div>
                    </div>
                    <div>{r.region}</div>
                    <div className="num"><b>{fmtMoney(r.amount)}</b></div>
                    <div>{r.creditNo ?? ''}</div>
                    <div>{r.usedOnOrder ?? r.orderRef ?? <span className="acct-region">Next order</span>}</div>
                    <div className="acct-region">{r.note ?? ''}</div>
                    <div>
                      <span className={`pill ${STATUS_TONE[r.status]}`}>{STATUS_WORD[r.status]}</span>
                      {r.status !== 'reserved' && r.resolvedAt && (
                        <div className="acct-region">{fmtDate(r.resolvedAt)}{r.status === 'used' && r.resolvedBy === 'Found in DEAR' ? ', DEAR' : r.resolvedBy ? `, ${r.resolvedBy}` : ''}</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
        </>
      )}

      {!error && tab === 'moves' && (
        <>
          <div className="controls" style={{ marginBottom: 8, flexWrap: 'wrap' }}>
            <select value={type} onChange={e => setType(e.target.value)} aria-label="Movement type">
              <option value="">All movements</option>
              {(types.length ? types : ['Credit note issued', 'Applied to invoice', 'Refunded to customer']).map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <label className="acct-region">From <input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label>
            <label className="acct-region">To <input type="date" value={to} onChange={e => setTo(e.target.value)} /></label>
            {(type || from || to) && <button className="link-btn" onClick={() => { setType(''); setFrom(''); setTo(''); }}>Clear</button>}
          </div>
          {loading && !moves.length ? <div className="empty-state">Loading…</div>
            : !moves.length ? <div className="empty-state">No movements match.</div>
            : (
              <div className="manifest">
                <div className="m-row head" style={{ gridTemplateColumns: '0.8fr 1.2fr 2fr 0.5fr 0.9fr 1.5fr 0.9fr 1fr' }}>
                  <div>Date</div><div>Movement</div><div>Customer</div><div>State</div><div>Credit no</div><div>Reference</div><div className="num">Amount</div><div>By</div>
                </div>
                {moves.map((m, i) => (
                  <div className="m-row" key={i} style={{ gridTemplateColumns: '0.8fr 1.2fr 2fr 0.5fr 0.9fr 1.5fr 0.9fr 1fr', cursor: 'default' }}>
                    <div>{m.date ? fmtDate(m.date) : ''}</div>
                    <div><span className={`pill ${TONE[m.type] ?? 'neutral'}`}>{m.type}</span></div>
                    <div><Link to={`/accounts/${m.accountId}`} className="order-link">{m.account}</Link></div>
                    <div>{m.region}</div>
                    <div>{m.creditNo ?? ''}</div>
                    <div className="acct-region">{m.reference ?? ''}</div>
                    <div className="num" style={{ color: m.amount < 0 ? 'var(--rust)' : undefined }}>{signed(m.amount)}</div>
                    <div className="acct-region">{m.by ?? ''}</div>
                  </div>
                ))}
              </div>
            )}
          {moves.length > 0 && moves.length < moveTotal && (
            <button className="btn secondary" style={{ marginTop: 12 }} disabled={loading} onClick={() => loadMoves(moves.length, true)}>
              {loading ? 'Loading…' : `Show ${Math.min(PAGE, moveTotal - moves.length)} more (${(moveTotal - moves.length).toLocaleString('en-AU')} left)`}
            </button>
          )}
        </>
      )}
    </>
  );
}

function Stat({ label, value, sub, tone = '' }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className={`stat ${tone}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value num">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}