import { prisma } from './prisma';

// The CRM's own limits on Claude, on top of the spend limit set in the Claude Console. The Console limit is the hard stop.
// These keep use sensible and show a clear message before that point: how much one person can use a day, how much the
// whole team can use a month (in tokens, and in dollars if prices are entered), and how big one question can get.
export type AiSettings = {
  enabled: boolean;
  maxReplyTokens: number;    // the longest reply Claude may write
  perRequestTokens: number;  // everything one question may use, across its look-ups
  userDailyTokens: number;   // per person, per day (Melbourne)
  monthlyTokens: number;     // the whole team, per calendar month
  monthlyUsd: number;        // 0 = no dollar limit
  usdPerMInput: number;      // dollars per million input tokens. Use the dearest model's price, so the limit errs on the safe side
  usdPerMOutput: number;
};
export const DEFAULTS: AiSettings = { enabled: true, maxReplyTokens: 2000, perRequestTokens: 120_000, userDailyTokens: 300_000, monthlyTokens: 3_000_000, monthlyUsd: 0, usdPerMInput: 0, usdPerMOutput: 0 };

const FIELDS: { key: Exclude<keyof AiSettings, 'enabled'>; label: string; lo: number; hi: number }[] = [
  { key: 'maxReplyTokens', label: 'Longest reply', lo: 100, hi: 4000 },
  { key: 'perRequestTokens', label: 'Tokens per question', lo: 2000, hi: 200_000 },
  { key: 'userDailyTokens', label: 'Tokens per person per day', lo: 1000, hi: 5_000_000 },
  { key: 'monthlyTokens', label: 'Tokens per month', lo: 10_000, hi: 500_000_000 },
  { key: 'monthlyUsd', label: 'Monthly dollar limit', lo: 0, hi: 100_000 },
  { key: 'usdPerMInput', label: 'Price per million input tokens', lo: 0, hi: 1000 },
  { key: 'usdPerMOutput', label: 'Price per million output tokens', lo: 0, hi: 1000 },
];

// From the stored rows. Anything missing or out of range falls back, so a bad row can never switch the limits off.
export function parseSettings(rows: { key: string; value: string }[]): AiSettings {
  const m = new Map(rows.map(r => [r.key, r.value]));
  const out: AiSettings = { ...DEFAULTS, enabled: m.has('enabled') ? m.get('enabled') === 'true' : DEFAULTS.enabled };
  for (const f of FIELDS) {
    const v = Number(m.get(f.key));
    if (m.has(f.key) && Number.isFinite(v) && v >= f.lo && v <= f.hi) out[f.key] = v;
  }
  return out;
}

// From a manager's form. Refuses anything out of range, with a message that names the setting.
export function validateSettings(raw: unknown): AiSettings {
  const o = (raw ?? {}) as Record<string, unknown>;
  if (typeof o.enabled !== 'boolean') throw new Error('Say whether the assistant is on or off');
  const out: AiSettings = { ...DEFAULTS, enabled: o.enabled };
  for (const f of FIELDS) {
    const v = Number(o[f.key]);
    if (!Number.isFinite(v) || v < f.lo || v > f.hi) throw new Error(`${f.label} must be between ${f.lo.toLocaleString('en-AU')} and ${f.hi.toLocaleString('en-AU')}`);
    out[f.key] = v;
  }
  return out;
}

// What a call counts as against the limits. Cached reading (an attached file read again on a follow-up) is cheap,
// so it counts a tenth; writing the cache costs a quarter more. Everything else counts once.
export function billableInput(u: { input_tokens: number; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null }): number {
  return Math.round(u.input_tokens + (u.cache_creation_input_tokens ?? 0) * 1.25 + (u.cache_read_input_tokens ?? 0) * 0.1);
}

export type Usage = { userDayTokens: number; monthInput: number; monthOutput: number };
export const costUsd = (s: AiSettings, inputTokens: number, outputTokens: number) => (inputTokens / 1e6) * s.usdPerMInput + (outputTokens / 1e6) * s.usdPerMOutput;

// null = fine to go ahead, otherwise what to tell the person.
export function checkCaps(s: AiSettings, u: Usage): string | null {
  if (!s.enabled) return 'The assistant is switched off. A manager can turn it on in the assistant settings.';
  if (u.userDayTokens >= s.userDailyTokens) return `You've used your ${s.userDailyTokens.toLocaleString('en-AU')} tokens for today. It starts again at midnight (Melbourne time).`;
  if (u.monthInput + u.monthOutput >= s.monthlyTokens) return `The team has used this month's ${s.monthlyTokens.toLocaleString('en-AU')} tokens. A manager can raise the limit.`;
  if (s.monthlyUsd > 0 && (s.usdPerMInput > 0 || s.usdPerMOutput > 0) && costUsd(s, u.monthInput, u.monthOutput) >= s.monthlyUsd) {
    return `The team has reached this month's AI budget of $${s.monthlyUsd.toLocaleString('en-AU')}. A manager can raise it.`;
  }
  return null;
}

export async function loadSettings(): Promise<AiSettings> {
  try { return parseSettings(await prisma.$queryRaw<{ key: string; value: string }[]>`select key, value from crm.ai_settings`); }
  catch (e) { console.error('ai settings load failed, using defaults', e); return DEFAULTS; }
}

export async function loadUsage(repId: string, today: string): Promise<Usage> {
  const [r] = await prisma.$queryRaw<{ user_day: number; month_in: number; month_out: number }[]>`
    select
      coalesce(sum(input_tokens + output_tokens) filter (where rep_id = ${repId}::uuid and (created_at at time zone 'Australia/Melbourne')::date = ${today}::date), 0)::float8 as user_day,
      coalesce(sum(input_tokens) filter (where created_at >= (date_trunc('month', now() at time zone 'Australia/Melbourne') at time zone 'Australia/Melbourne')), 0)::float8 as month_in,
      coalesce(sum(output_tokens) filter (where created_at >= (date_trunc('month', now() at time zone 'Australia/Melbourne') at time zone 'Australia/Melbourne')), 0)::float8 as month_out
    from crm.ai_usage where created_at >= now() - interval '40 days'`;
  return { userDayTokens: r?.user_day ?? 0, monthInput: r?.month_in ?? 0, monthOutput: r?.month_out ?? 0 };
}

export async function saveSettings(s: AiSettings, repId: string): Promise<void> {
  const rows: [string, string][] = [['enabled', String(s.enabled)], ...FIELDS.map(f => [f.key, String(s[f.key])] as [string, string])];
  for (const [key, value] of rows) {
    await prisma.$executeRaw`insert into crm.ai_settings (key, value, updated_by) values (${key}, ${value}, ${repId}::uuid)
      on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`;
  }
}