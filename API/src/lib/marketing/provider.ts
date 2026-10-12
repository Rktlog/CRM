// The email sending service. Nothing is sent until it is connected: set RESEND_API_KEY on the
// API (Railway). Until then every send stops with a clear message and the rest of Marketing
// (audience, templates, campaigns, reports, automations' dry runs) works as normal.
export type Outgoing = { to: string; toName?: string; from: string; replyTo?: string; subject: string; html: string; text: string; headers?: Record<string, string> };
export type SendResult = { id?: string; error?: string };
export interface Provider { name: string; connected: boolean; sendBatch(msgs: Outgoing[]): Promise<SendResult[]> }

export class NotConnectedError extends Error { constructor() { super("Email sending isn't connected yet"); } }

const notConnected: Provider = { name: 'none', connected: false, async sendBatch() { throw new NotConnectedError(); } };

const address = (m: Outgoing) => (m.toName ? `${m.toName.replace(/["<>,]/g, '')} <${m.to}>` : m.to);
const payload = (m: Outgoing) => ({ from: m.from, to: [address(m)], subject: m.subject, html: m.html, text: m.text, ...(m.replyTo ? { reply_to: m.replyTo } : {}), ...(m.headers ? { headers: m.headers } : {}) });

export function resendProvider(apiKey: string, fetchFn: typeof fetch = fetch): Provider {
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  async function one(m: Outgoing): Promise<SendResult> {
    const res = await fetchFn('https://api.resend.com/emails', { method: 'POST', headers, body: JSON.stringify(payload(m)) });
    const body: any = await res.json().catch(() => ({}));
    return res.ok && body.id ? { id: body.id } : { error: String(body.message ?? body.error ?? `Rejected (${res.status})`).slice(0, 300) };
  }
  return {
    name: 'resend', connected: true,
    // Up to 100 emails in one request. If that request is refused, they go one at a time, so a
    // single bad address cannot hold back the rest.
    async sendBatch(msgs) {
      const res = await fetchFn('https://api.resend.com/emails/batch', { method: 'POST', headers, body: JSON.stringify(msgs.map(payload)) });
      const body: any = await res.json().catch(() => ({}));
      if (res.ok && Array.isArray(body.data) && body.data.length === msgs.length) return body.data.map((d: any) => ({ id: d.id }));
      const out: SendResult[] = [];
      for (const m of msgs) { out.push(await one(m)); await new Promise(r => setTimeout(r, 120)); }
      return out;
    },
  };
}

let override: Provider | null | undefined;
export const setProviderForTests = (p: Provider | null | undefined) => { override = p; };
export function getProvider(): Provider {
  if (override !== undefined) return override ?? notConnected;
  const key = process.env.RESEND_API_KEY;
  return key ? resendProvider(key) : notConnected;
}