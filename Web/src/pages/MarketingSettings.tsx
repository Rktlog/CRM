import { useEffect, useState } from 'react';
import { apiGet, apiPut } from '../lib/api';
import { MarketingNav, ManagersOnly, SendingBanner, SendingStatus } from '../components/marketing/Ui';

// Who the emails come from, the address printed in every email, and how to connect the sending service.
type S = { from_name: string; from_email: string; reply_to: string; business_name: string; footer_address: string; portal_url: string; tracking_base_url: string; attribution_days: number; status: SendingStatus };
const field = { width: '100%', maxWidth: 460, padding: '7px 9px', border: '1px solid var(--line)', borderRadius: 6, font: 'inherit', fontSize: 13.5 } as const;

export default function MarketingSettings() {
  const [s, setS] = useState<S | null>(null); const [error, setError] = useState<string | null>(null); const [saving, setSaving] = useState(false); const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { apiGet('/marketing/settings').then(setS).catch(e => setError(e.message)); }, []);
  async function save() {
    if (!s) return; setSaving(true); setMsg(null);
    try { const { status, ...body } = s; const r = await apiPut('/marketing/settings', body); setS(prev => (prev ? { ...prev, ...r } : r)); setMsg({ ok: true, text: 'Saved.' }); } catch (e: any) { setMsg({ ok: false, text: e.message }); } finally { setSaving(false); }
  }
  const set = (k: keyof Omit<S, 'status'>, v: string) => setS(prev => (prev ? { ...prev, [k]: k === 'attribution_days' ? Number(v) : v } : prev));
  if (error) return <ManagersOnly><div className="empty-state">Couldn't load settings: {error}</div></ManagersOnly>;
  if (!s) return <div className="empty-state">Loading…</div>;
  const api = s.tracking_base_url || 'https://YOUR-API-ADDRESS';
  const L = ({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) => <div style={{ marginBottom: 12 }}><div className="stat-label" style={{ marginBottom: 3 }}>{label}</div>{children}{hint && <div className="acct-region" style={{ marginTop: 3, maxWidth: 460 }}>{hint}</div>}</div>;
  return (
    <ManagersOnly>
      <h1>Marketing settings</h1><MarketingNav /><SendingBanner status={s.status} />
      <div className="section"><div className="panel-title">Sender</div>
        <L label="From name"><input aria-label="From name" style={field} value={s.from_name} onChange={e => set('from_name', e.target.value)} /></L>
        <L label="From email" hint="Must be on a domain you have verified with the sending service."><input aria-label="From email" style={field} value={s.from_email} onChange={e => set('from_email', e.target.value)} placeholder="hello@rhinorhino.com.au" /></L>
        <L label="Replies go to (optional)"><input aria-label="Reply to" style={field} value={s.reply_to} onChange={e => set('reply_to', e.target.value)} placeholder="sales@rhinorhino.com.au" /></L>
      </div>
      <div className="section"><div className="panel-title">Printed at the bottom of every email</div>
        <L label="Business name"><input aria-label="Business name" style={field} value={s.business_name} onChange={e => set('business_name', e.target.value)} /></L>
        <L label="Business address" hint="Australian law requires marketing emails to say who sent them and how to contact them. Campaigns will not send without this."><input aria-label="Business address" style={field} value={s.footer_address} onChange={e => set('footer_address', e.target.value)} placeholder="12 Smith St, Fitzroy VIC 3065" /></L>
      </div>
      <div className="section"><div className="panel-title">Links and orders</div>
        <L label="Ordering portal address" hint="Where the {{portal_link}} and {{cart_link}} merge tags go."><input aria-label="Portal address" style={field} value={s.portal_url} onChange={e => set('portal_url', e.target.value)} placeholder="https://..." /></L>
        <L label="This API's public web address" hint="Used for the open, click and unsubscribe links in every email. It is your Railway address."><input aria-label="API address" style={field} value={s.tracking_base_url} onChange={e => set('tracking_base_url', e.target.value)} placeholder="https://your-api.up.railway.app" /></L>
        <L label="Order window (days)" hint="A confirmed order counts as coming from an email when the customer clicked it up to this many days before ordering."><input aria-label="Order window" type="number" min={1} max={60} style={{ ...field, maxWidth: 90 }} value={s.attribution_days} onChange={e => set('attribution_days', e.target.value)} /></L>
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 22 }}><button className="btn" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save settings'}</button>{msg && <span className={'save-msg ' + (msg.ok ? 'ok' : 'err')}>{msg.text}</span>}</div>

      <div className="section"><div className="panel-title">Connecting the email service {s.status.connected ? '(done)' : '(do this last)'}</div>
        <div className="acct-region" style={{ maxWidth: 720, marginBottom: 8 }}>Everything above works without it. Do these steps when you are ready to send for real.</div>
        <ol style={{ fontSize: 13.5, lineHeight: 1.7, maxWidth: 760, paddingLeft: 20 }}>
          <li>Create an account at <b>resend.com</b>, add your sending domain, and add the DNS records it shows you (this is what stops your emails going to spam).</li>
          <li>On Railway, add these variables to the API: <code>RESEND_API_KEY</code> (from Resend), <code>PUBLIC_API_URL</code> ({api}), <code>MARKETING_SECRET</code> (any long random text) and <code>MARKETING_WEBHOOK_KEY</code> (any random text).</li>
          <li>In Resend, add a webhook to <code>{api}/m/webhook?key=YOUR_MARKETING_WEBHOOK_KEY</code> for the events: delivered, bounced and complained. This is how bounces and spam complaints switch people off.</li>
          <li>In Supabase, run <code>marketing-schedule.sql</code> (it makes the API check for automatic emails and scheduled campaigns every 5 minutes).</li>
          <li>Come back to this page. The banner at the top turns green. Send yourself a test from any campaign.</li>
        </ol>
      </div>
    </ManagersOnly>
  );
}