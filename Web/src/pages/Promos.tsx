import { CSSProperties, FormEvent, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiGet, apiPost } from '../lib/api';
import { useMe } from '../lib/useMe';

// Promos: the promos the sales team gives. Managers add, change and turn them off here; everyone sees how many orders used each one and can open its orders.
type Promo = { id: string; name: string; matchText: string | null; startsOn: string | null; endsOn: string | null; active: boolean; orders: number; units: number };
const th: CSSProperties = { textAlign: 'left', fontSize: 13, color: 'var(--muted)', fontWeight: 500, padding: '8px 10px', borderBottom: '1px solid var(--line)', whiteSpace: 'nowrap' };
const td: CSSProperties = { padding: '9px 10px', borderBottom: '1px solid var(--line)', fontSize: 14, verticalAlign: 'top' };
const field: CSSProperties = { width: '100%', padding: '7px 10px', border: '1px solid var(--line)', borderRadius: 3, font: 'inherit', fontSize: 15 };
const dayText = (d: string | null) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const blank = { name: '', matchText: '', startsOn: '', endsOn: '' };

export default function Promos() {
  const me = useMe(), isManager = me?.role === 'manager';
  const [promos, setPromos] = useState<Promo[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState<{ id: string | null; v: typeof blank } | null>(null);
  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);

  const load = useCallback(() => { apiGet('/promos', { fresh: true }).then((d: { promos: Promo[] }) => { setPromos(d.promos); setErr(null); }).catch(e => setErr(e.message)); }, []);
  useEffect(() => { load(); }, [load]);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!form || busy) return;
    setBusy(true); setFormErr(null);
    try {
      const body = { name: form.v.name, matchText: form.v.matchText, startsOn: form.v.startsOn || null, endsOn: form.v.endsOn || null };
      await apiPost(form.id ? `/promos/${form.id}` : '/promos', body);
      setForm(null); load();
    } catch (x: any) { setFormErr(x.message); }
    finally { setBusy(false); }
  }
  const flip = async (p: Promo) => { try { await apiPost(`/promos/${p.id}`, { active: !p.active }); load(); } catch (x: any) { window.alert(x.message); } };
  const remove = async (p: Promo) => {
    if (!window.confirm(`Delete "${p.name}"? This cannot be undone.`)) return;
    try { await apiPost(`/promos/${p.id}/delete`, {}); load(); } catch (x: any) { window.alert(x.message); }
  };

  return (
    <>
      <h1>Promos</h1>
      <div className="acct-region" style={{ marginBottom: 14 }}>The promos the team gives. Tick the ones an order used in the box on that order. Open a promo to see every order that used it.</div>
      {err && <div className="save-msg err" role="alert">{err}</div>}

      {isManager && !form && <div style={{ marginBottom: 16 }}><button type="button" className="btn" onClick={() => { setForm({ id: null, v: blank }); setFormErr(null); }}>Add a promo</button></div>}
      {isManager && form && (
        <form className="card" style={{ maxWidth: 640 }} onSubmit={save}>
          <div className="panel-title">{form.id ? 'Change promo' : 'New promo'}</div>
          <div style={{ display: 'grid', gap: 10 }}>
            <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>Name<input style={field} value={form.v.name} maxLength={120} onChange={e => setForm({ ...form, v: { ...form.v, name: e.target.value } })} placeholder="Black Friday Deal" autoFocus /></label>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>Starts<input type="date" style={field} value={form.v.startsOn} onChange={e => setForm({ ...form, v: { ...form.v, startsOn: e.target.value } })} /></label>
              <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>Ends<input type="date" style={field} value={form.v.endsOn} onChange={e => setForm({ ...form, v: { ...form.v, endsOn: e.target.value } })} /></label>
            </div>
            <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>Words to find in old remarks (optional)<input style={field} value={form.v.matchText} maxLength={120} onChange={e => setForm({ ...form, v: { ...form.v, matchText: e.target.value } })} placeholder="Black Friday" /></label>
            <div className="acct-region" style={{ fontSize: 12.5 }}>Used once, to tick this promo on orders whose old remark mentions those words. Leave it empty to use the name.</div>
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
            <button className="btn" type="submit" disabled={busy || !form.v.name.trim()}>{busy ? 'Saving…' : 'Save'}</button>
            <button className="btn secondary" type="button" onClick={() => setForm(null)}>Cancel</button>
          </div>
          {formErr && <div className="save-msg err" role="alert" style={{ marginTop: 8 }}>{formErr}</div>}
        </form>
      )}

      {promos === null ? <div className="acct-region">Loading…</div> : promos.length === 0 ? <div className="empty-state">No promos yet.{isManager ? ' Add the first one above.' : ''}</div> : (
        <div style={{ overflowX: 'auto', border: '1px solid var(--line)', borderRadius: 4, background: 'var(--panel)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={th}>Promo</th><th style={th}>Dates</th><th style={{ ...th, textAlign: 'right' }}>Orders</th><th style={{ ...th, textAlign: 'right' }}>Units</th><th style={th}>Status</th>{isManager && <th style={th}></th>}</tr></thead>
            <tbody>{promos.map(p => (
              <tr key={p.id} style={{ opacity: p.active ? 1 : 0.65 }}>
                <td style={td}><Link to={`/promos/${p.id}`}><b>{p.name}</b></Link></td>
                <td style={td}>{p.startsOn || p.endsOn ? `${dayText(p.startsOn)}${p.endsOn ? ` to ${dayText(p.endsOn)}` : ''}` : ''}</td>
                <td style={{ ...td, textAlign: 'right' }}>{p.orders}</td>
                <td style={{ ...td, textAlign: 'right' }}>{p.units}</td>
                <td style={td}><span className={`pill ${p.active ? 'teal' : 'neutral'}`}>{p.active ? 'On' : 'Off'}</span></td>
                {isManager && <td style={{ ...td, whiteSpace: 'nowrap' }}>
                  <button type="button" className="link-btn" onClick={() => { setForm({ id: p.id, v: { name: p.name, matchText: p.matchText ?? '', startsOn: p.startsOn ?? '', endsOn: p.endsOn ?? '' } }); setFormErr(null); }}>Edit</button>{' · '}
                  <button type="button" className="link-btn" onClick={() => flip(p)}>{p.active ? 'Turn off' : 'Turn on'}</button>{p.orders === 0 && <>{' · '}<button type="button" className="link-btn" onClick={() => remove(p)}>Delete</button></>}
                </td>}
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </>
  );
}
