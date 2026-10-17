import { useEffect, useState } from 'react';
import { apiGet } from '../lib/api';
import { fmtMoney, fmtDate } from '../lib/types';

// What DEAR itself says about the money on one order, next to what the CRM holds. Asks DEAR live, so it is right
// even if the sync is behind. Held = prepaid in total minus what has been paid on invoices.

type Live = {
  orderTotal: number | null; paymentStatus: string | null;
  prepayments: { date: string | null; reference: string | null; amount: number }[]; prepaidTotal: number;
  invoices: { number: string | null; date: string | null; status: string | null; total: number; paid: number }[]; paidOnInvoices: number;
  held: number; raw: unknown;
};
type Check = { order: string; status: string | null; crmHeld: number; crmReserved: number; released: boolean; releaseNote: string | null; live: Live | null; problem: string | null; matches: boolean | null };

export default function DearPaymentCheck({ orderNo, onClose }: { orderNo: string; onClose: () => void }) {
  const [data, setData] = useState<Check | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { apiGet(`/credit/order-dear/${encodeURIComponent(orderNo)}`).then(setData).catch(e => setError(e.message)); }, [orderNo]);

  const L = data?.live;
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" style={{ maxWidth: 640, width: '94vw', maxHeight: '88vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
        <h2 style={{ marginTop: 0 }}>{orderNo} in DEAR</h2>
        {!data && !error && <div className="acct-region">Asking DEAR…</div>}
        {error && <div className="save-msg err">{error}</div>}
        {data && (
          <>
            {data.problem && <div className="save-msg err" style={{ marginBottom: 10 }}>Couldn't read it from DEAR: {data.problem}</div>}
            {L && (
              <>
                <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 12 }}>
                  <Fig label="Order total" v={L.orderTotal == null ? '–' : fmtMoney(L.orderTotal)} />
                  <Fig label="Prepaid in total" v={fmtMoney(L.prepaidTotal)} />
                  <Fig label="Paid on invoices" v={fmtMoney(L.paidOnInvoices)} />
                  <Fig label="Still held by DEAR" v={fmtMoney(L.held)} strong />
                </div>
                <div style={{ marginBottom: 12 }}>
                  <span className="stat-label">The CRM shows </span><b className="num">{fmtMoney(data.crmHeld)}</b>
                  {data.crmReserved > 0.005 && <span className="acct-region"> ({fmtMoney(data.crmReserved)} of it reserved)</span>}{' '}
                  {data.matches
                    ? <span className="pill teal">Matches</span>
                    : <span className="pill amber">Differs by {fmtMoney(Math.abs(L.held - data.crmHeld))}</span>}
                  {L.paymentStatus && <span className="acct-region"> · DEAR payment status: {L.paymentStatus}</span>}
                </div>
                <table className="ov-table">
                  <thead><tr><th>Prepayment</th><th>Date</th><th className="num-col">Amount</th></tr></thead>
                  <tbody>{L.prepayments.length ? L.prepayments.map((p, i) => <tr key={i}><td>{p.reference ?? '–'}</td><td>{p.date ? fmtDate(p.date) : '–'}</td><td className="num-col num">{fmtMoney(p.amount)}</td></tr>) : <tr><td colSpan={3} className="acct-region">None found</td></tr>}</tbody>
                </table>
                <table className="ov-table" style={{ marginTop: 10 }}>
                  <thead><tr><th>Invoice</th><th>Date</th><th>Status</th><th className="num-col">Total</th><th className="num-col">Paid</th></tr></thead>
                  <tbody>{L.invoices.length ? L.invoices.map((i, k) => <tr key={k}><td>{i.number ?? '–'}</td><td>{i.date ? fmtDate(i.date) : '–'}</td><td>{i.status ?? '–'}</td><td className="num-col num">{fmtMoney(i.total)}</td><td className="num-col num">{fmtMoney(i.paid)}</td></tr>) : <tr><td colSpan={5} className="acct-region">No invoices yet</td></tr>}</tbody>
                </table>
                <details style={{ marginTop: 10 }}>
                  <summary className="acct-region">What DEAR sent</summary>
                  <pre style={{ maxHeight: 220, overflow: 'auto', fontSize: 11 }}>{JSON.stringify(L.raw, null, 2)}</pre>
                </details>
              </>
            )}
            {data.released && <div className="acct-region" style={{ marginTop: 10 }}>Released: {data.releaseNote}</div>}
          </>
        )}
        <div className="modal-actions" style={{ marginTop: 14 }}><button type="button" className="btn secondary" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}

function Fig({ label, v, strong }: { label: string; v: string; strong?: boolean }) {
  return <div><div className="stat-label">{label}</div><div className="num" style={{ fontSize: 20, fontWeight: strong ? 700 : 500 }}>{v}</div></div>;
}