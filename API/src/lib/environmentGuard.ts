// A sandbox copy of Radar must never be able to touch the live system.
//
// Why this exists: on Railway, "Duplicate Environment" copies every variable of production, including DATABASE_URL. A new test environment therefore starts out pointing at
// the LIVE database. The first lock is a person replacing those variables (docs/SANDBOX.md). This is the second lock: when APP_ENV is "staging", the API refuses to start if
// any variable mentions the live system, and it never prints the value it found.
//
// Production does not set APP_ENV (or sets it to "production"), so on production this does nothing at all.

// Names, not secrets: the live Supabase project reference and the live API address. Add more in the sandbox with LIVE_MARKERS (comma separated).
const LIVE = ['nedrakgspsmzpoqqeowe', 'rhinocrm-production.up.railway.app'];

export function sandboxProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  if ((env.APP_ENV ?? '').trim().toLowerCase() !== 'staging') return [];
  const live = [...LIVE, ...(env.LIVE_MARKERS ?? '').split(',')].map(s => s.trim().toLowerCase()).filter(Boolean);
  const problems: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!value || name === 'LIVE_MARKERS') continue;
    const v = value.toLowerCase();
    if (live.some(m => v.includes(m))) problems.push(`${name} points at the live system. A sandbox must have its own value.`);
  }
  if ((env.GMAIL_JOB ?? '').trim().toLowerCase() === 'on') problems.push('GMAIL_JOB is on. A sandbox must never read or draft real email.');
  return problems;
}

export function assertEnvironmentIsSafe(env: NodeJS.ProcessEnv = process.env): void {
  const problems = sandboxProblems(env);
  if (!problems.length) return;
  console.error('REFUSING TO START: this is a sandbox (APP_ENV=staging) but it is set up to touch the live system.');
  for (const p of problems) console.error('  - ' + p);
  console.error('Fix these variables in the Railway staging environment, then redeploy. Nothing was started.');
  process.exit(1);
}
