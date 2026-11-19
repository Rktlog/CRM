import { useEffect, useState } from 'react';
import { apiDelete, apiGet, apiPut } from '../lib/api';
import { errMsg } from '../lib/tradeshow';
import { DEFAULT_FREIGHT, REGION_TYPES, type FreightCfg } from '../lib/tsOffers';
import { sel } from '../lib/tsExtra';

// The freight rates the order page uses (the team's calculator): by state, metro, regional or rural, large items and Pantone Living. Managers can change them and go back to the calculator's rates.
export default function TsFreightRates({ isManager }: { isManager: boolean }) {
  const [cfg, setCfg] = useState<FreightCfg | null>(null);
  const [custom, setCustom] = useState(false);
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open && !cfg) apiGet('/tradeshow/freight', { fresh: true }).then((x: { cfg: FreightCfg; custom: boolean }) => { setCfg(x.cfg); setCustom(x.custom); }).catch(e => setMsg({ ok: false, text: errMsg(e) })); }, [open, cfg]);
  async function run(f: () => Promise<{ cfg: FreightCfg; custom: boolean }>, ok: string) {
    setBusy(true); setMsg(null);
    try { const x = await f(); setCfg(x.cfg); setCustom(x.custom); setMsg({ ok: true, text: ok }); } catch (e) { setMsg({ ok: false, text: errMsg(e) }); } finally { setBusy(false); }
  }
  const setState = (k: string, f: 'rate' | 'min', v: string) => setCfg(c => (c ? { ...c, states: { ...c.states, [k]: { ...c.states[k]!, [f]: f === 'rate' ? Number(v) / 100 : Number(v) } } } : c));
  return (
    <div className="section" style={{ marginTop: 22 }}>
      <button type="button" className="link-btn" onClick={() => setOpen(o => !o)}>{open ? 'Hide' : 'Show'} freight rates{custom ? ' (changed from the calculator)' : ''}</button>
      {open && (
        <div className="card" style={{ maxWidth: 640, marginTop: 8 }}>
          <div className="acct-region" style={{ fontSize: 13, marginBottom: 8 }}>Freight = the biggest of the state minimum and (order total inc GST × state rate × metro, regional or rural × large items × Pantone Living). ACT is worked out as {cfg?.act.state} {cfg?.act.region.toLowerCase()}. New Zealand uses Australia Post.</div>
          {!cfg ? <div className="acct-region">Loading…</div> : <>
            <table style={{ borderCollapse: 'collapse', fontSize: 14 }}>
              <thead><tr><th style={{ textAlign: 'left', padding: 4 }}>State</th><th style={{ textAlign: 'left', padding: 4 }}>Rate %</th><th style={{ textAlign: 'left', padding: 4 }}>Minimum $</th></tr></thead>
              <tbody>{Object.entries(cfg.states).map(([k, v]) => (
                <tr key={k}><td style={{ padding: 4 }}>{k}</td>
                  <td style={{ padding: 4 }}><input inputMode="decimal" style={{ ...sel, width: 90 }} disabled={!isManager} value={String(Math.round(v.rate * 10000) / 100)} onChange={e => setState(k, 'rate', e.target.value)} /></td>
                  <td style={{ padding: 4 }}><input inputMode="decimal" style={{ ...sel, width: 90 }} disabled={!isManager} value={String(v.min)} onChange={e => setState(k, 'min', e.target.value)} /></td></tr>
              ))}</tbody>
            </table>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 10, alignItems: 'end' }}>
              {REGION_TYPES.map(r => <label key={r} style={{ display: 'grid', gap: 3, fontSize: 13 }}>{r} ×<input inputMode="decimal" style={{ ...sel, width: 80 }} disabled={!isManager} value={String(cfg.regions[r] ?? 1)} onChange={e => setCfg({ ...cfg, regions: { ...cfg.regions, [r]: Number(e.target.value) } })} /></label>)}
              <label style={{ display: 'grid', gap: 3, fontSize: 13 }}>Large items ×<input inputMode="decimal" style={{ ...sel, width: 80 }} disabled={!isManager} value={String(cfg.large)} onChange={e => setCfg({ ...cfg, large: Number(e.target.value) })} /></label>
              <label style={{ display: 'grid', gap: 3, fontSize: 13 }}>Pantone Living ×<input inputMode="decimal" style={{ ...sel, width: 80 }} disabled={!isManager} value={String(cfg.pantone)} onChange={e => setCfg({ ...cfg, pantone: Number(e.target.value) })} /></label>
            </div>
            {isManager && <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
              <button type="button" className="btn" disabled={busy} onClick={() => run(() => apiPut('/tradeshow/freight', { cfg }), 'Saved.')}>Save rates</button>
              <button type="button" className="btn secondary" disabled={busy || !custom} onClick={() => window.confirm('Go back to the rates from the team calculator?') && run(() => apiDelete('/tradeshow/freight'), 'Back to the calculator rates.')}>Reset to the calculator rates</button>
              <button type="button" className="link-btn" onClick={() => setCfg(DEFAULT_FREIGHT)}>Show the calculator rates</button>
            </div>}
          </>}
          {msg && <div className={msg.ok ? 'save-msg ok' : 'save-msg err'} role={msg.ok ? 'status' : 'alert'}>{msg.text}</div>}
        </div>
      )}
    </div>
  );
}
