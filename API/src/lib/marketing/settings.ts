import { prisma } from '../prisma';

// Marketing settings, kept as rows so nothing needs a migration to add one.
export type MarketingSettings = {
  from_name: string; from_email: string; reply_to: string;
  business_name: string; footer_address: string;      // both are printed in every email (the law needs them)
  portal_url: string;                                  // the B2B ordering portal: {{portal_link}} and {{cart_link}}
  attribution_days: number;                            // an order within this many days after a click is credited to the email
  tracking_base_url: string;                           // this API's public address, used in every tracked link
};
export const DEFAULT_SETTINGS: MarketingSettings = {
  from_name: 'Rhino Rhino', from_email: '', reply_to: '', business_name: 'Rhino Rhino', footer_address: '',
  portal_url: '', attribution_days: 7, tracking_base_url: '',
};

export async function getSettings(): Promise<MarketingSettings> {
  const rows = await prisma.$queryRaw<{ key: string; value: unknown }[]>`select key, value from crm.marketing_settings`;
  const saved = Object.fromEntries(rows.map(r => [r.key, r.value]));
  const s = { ...DEFAULT_SETTINGS, ...saved } as MarketingSettings;
  s.attribution_days = Math.min(60, Math.max(1, Number(s.attribution_days) || 7));
  // The public address defaults to where the API runs (set PUBLIC_API_URL on Railway).
  s.tracking_base_url = (s.tracking_base_url || process.env.PUBLIC_API_URL || '').replace(/\/+$/, '');
  return s;
}

const TEXT_KEYS = ['from_name', 'from_email', 'reply_to', 'business_name', 'footer_address', 'portal_url', 'tracking_base_url'] as const;
export async function saveSettings(patch: Partial<MarketingSettings>): Promise<string | null> {
  for (const k of TEXT_KEYS) {
    if (patch[k] === undefined) continue;
    const v = String(patch[k]).trim().slice(0, 400);
    if ((k === 'from_email' || k === 'reply_to') && v && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) return `${k === 'from_email' ? 'The sender email' : 'The reply-to email'} doesn't look right`;
    if ((k === 'portal_url' || k === 'tracking_base_url') && v && !/^https?:\/\//i.test(v)) return 'Web addresses must start with https://';
    await prisma.$queryRaw`insert into crm.marketing_settings (key, value) values (${k}, ${JSON.stringify(v)}::jsonb) on conflict (key) do update set value = excluded.value`;
  }
  if (patch.attribution_days !== undefined) {
    const d = Math.round(Number(patch.attribution_days));
    if (!Number.isFinite(d) || d < 1 || d > 60) return 'The order window must be between 1 and 60 days';
    await prisma.$queryRaw`insert into crm.marketing_settings (key, value) values ('attribution_days', ${JSON.stringify(d)}::jsonb) on conflict (key) do update set value = excluded.value`;
  }
  return null;
}