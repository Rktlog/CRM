import { useEffect, useState } from 'react';
import { apiGet, apiPost } from '../lib/api';

// The promos box on an order: tick the promos this order redeemed (and how many). Shown inside the order's team log. Nothing shows when there are no promos on.
type P = { id: string; name: string; startsOn: string | null; endsOn: string | null; active: boolean; ticked: boolean; qty: number };
const shortDay = (d: string | null) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }) : '');

export default function OrderPromos({ orderId, onChange }: { orderId: string; onChange?: () => void }) {
  const [list, setList] = useState<P[] | null>(null);
  const [saved, setSaved] = useState<P[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = () => apiGet(`/promos/order/${orderId}`, { fresh: true }).then((d: { promos: P[] }) => { setList(d.promos); setSaved(d.promos); }).catch(() => { setList([]); setSaved([]); });
  useEffect(() => { setList(null); setMsg(null); load(); }, [orderId]);

  if (!list || list.length === 0) return null;
  const dirty = JSON.stringify(list.map(p => [p.id, p.ticked, p.ticked ? p.qty : 0])) !== JSON.stringify((saved ?? []).map(p => [p.id, p.ticked, p.ticked ? p.qty : 0]));
  const set = (id: string, patch: Partial<P>) => { setList(l => (l ?? []).map(p => (p.id === id ? { ...p, ...patch } : p))); setMsg(null); };

  async function save() {
    setSaving(true); setMsg(null);
    try {
      await apiPost(`/promos/order/${orderId}`, { promos: list!.filter(p => p.ticked).map(p => ({ id: p.id, qty: Math.max(1, Math.round(Number(p.qty) || 1)) })) });
      setMsg({ ok: true, text: 'Promos saved.' }); await load(); onChange?.();
    } catch (e: any) { setMsg({ ok: false, text: e?.message ?? 'Could not save.' }); }
    finally { setSaving(false); }
  }

  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 4, padding: '10px 12px', marginBottom: 14 }}>
      <div style={{ fontWeight: 500, marginBottom: 6 }}>Promos on this order</div>
      <div style={{ display: 'grid', gap: 6 }}>
        {list.map(p => (
          <div key={p.id} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
              <input type="checkbox" checked={p.ticked} onChange={e => set(p.id, { ticked: e.target.checked })} />
              <span>{p.name}</span>
              {!p.active && <span className="pill neutral">Off</span>}
              {(p.startsOn || p.endsOn) && <span className="acct-region" style={{ fontSize: 12.5 }}>{p.startsOn ? shortDay(p.startsOn) : ''}{p.endsOn ? ` to ${shortDay(p.endsOn)}` : ''}</span>}
            </label>
            {p.ticked && (
              <label className="acct-region" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                Qty <input type="number" min={1} max={9999} value={p.qty} style={{ width: 70 }} onChange={e => set(p.id, { qty: Number(e.target.value) })} aria-label={`Quantity for ${p.name}`} />
              </label>
            )}
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 10 }}>
        <button type="button" className="btn" disabled={saving || !dirty} onClick={save}>{saving ? 'Saving…' : 'Save promos'}</button>
        {msg && <span className={'save-msg' + (msg.ok ? '' : ' err')}>{msg.text}</span>}
      </div>
    </div>
  );
}
