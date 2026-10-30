// Run:  npx tsx scripts/test-environment-guard.ts      (from the API folder)
import assert from 'node:assert/strict';
import { sandboxProblems, assertEnvironmentIsSafe } from '../src/lib/environmentGuard';

const LIVE_DB = 'postgresql://postgres.nedrakgspsmzpoqqeowe:hunter2secret@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres';
const TEST_DB = 'postgresql://postgres.abcdefghijklmnopqrst:other@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres';
let n = 0; const ok = (c: unknown, t: string) => { assert.ok(c, t); n++; console.log('  PASS ', t); };

ok(sandboxProblems({ DATABASE_URL: LIVE_DB }).length === 0, 'production (no APP_ENV): nothing is checked, even with the live database');
ok(sandboxProblems({ APP_ENV: 'production', DATABASE_URL: LIVE_DB }).length === 0, 'APP_ENV=production: nothing is checked');
ok(sandboxProblems({ APP_ENV: 'staging', DATABASE_URL: TEST_DB, DIRECT_URL: TEST_DB }).length === 0, 'a sandbox with its own database is allowed');
const p1 = sandboxProblems({ APP_ENV: 'staging', DATABASE_URL: LIVE_DB });
ok(p1.length === 1 && p1[0].startsWith('DATABASE_URL '), 'a sandbox pointing at the live database is refused, naming the variable');
ok(!p1.join(' ').includes('hunter2secret') && !p1.join(' ').includes('nedrakgspsmzpoqqeowe'), 'and the message never contains the password or the project reference');
ok(sandboxProblems({ APP_ENV: ' Staging ', DATABASE_URL: LIVE_DB.toUpperCase() }).length === 1, 'spaces and capital letters do not get past it');
ok(sandboxProblems({ APP_ENV: 'staging', DATABASE_URL: TEST_DB, MCP_DATABASE_URL: LIVE_DB, PUBLIC_API_URL: 'https://rhinocrm-production.up.railway.app' }).map(p => p.split(' ')[0]).join() === 'MCP_DATABASE_URL,PUBLIC_API_URL', 'every variable that points live is named: the connector database and the live API address');
ok(sandboxProblems({ APP_ENV: 'staging', DATABASE_URL: TEST_DB, GMAIL_JOB: 'on' }).length === 1, 'the email job being on is refused in a sandbox');
ok(sandboxProblems({ APP_ENV: 'staging', DATABASE_URL: TEST_DB, EXTRA: 'https://old-live.example.com', LIVE_MARKERS: 'old-live.example.com' }).length === 1, 'extra live names can be added with LIVE_MARKERS');
ok(sandboxProblems({ APP_ENV: 'staging', DATABASE_URL: TEST_DB, LIVE_MARKERS: 'old-live.example.com' }).length === 0, 'and LIVE_MARKERS itself is not treated as a problem');

// assertEnvironmentIsSafe stops the process, and says why
const realExit = process.exit, realError = console.error; let code: number | undefined; const said: string[] = [];
(process as any).exit = (c?: number) => { code = c; throw new Error('exit'); }; console.error = (...a: unknown[]) => { said.push(a.join(' ')); };
try { assertEnvironmentIsSafe({ APP_ENV: 'staging', DATABASE_URL: LIVE_DB } as any); } catch { /* the stubbed exit */ } finally { process.exit = realExit; console.error = realError; }
ok(code === 1 && said[0].startsWith('REFUSING TO START') && !said.join(' ').includes('hunter2secret'), 'the API exits with an error and a plain message, without printing the secret');
code = undefined; (process as any).exit = (c?: number) => { code = c ?? 0; throw new Error('exit'); };
try { assertEnvironmentIsSafe({ APP_ENV: 'staging', DATABASE_URL: TEST_DB } as any); assertEnvironmentIsSafe({ DATABASE_URL: LIVE_DB } as any); } finally { process.exit = realExit; }
ok(code === undefined, 'a safe sandbox and production both start normally');
console.log(`\n${n} of ${n} checks passed`);
