import { syncAll, SyncResult } from '../lib/gmail/sync';
import { gmailConfigured, missingSetup } from '../lib/gmail/google';

// The scheduled Gmail check, run by the sync worker every 15 minutes. It looks through each connected person's own mailbox in
// turn, the one checked longest ago first, using that person's own stored connection: nobody's mail is read with anybody
// else's access, and one person's problem (say a revoked connection) does not stop the others.
// Safe to start twice: a run that is still going makes the next one wait for the following turn.
let running = false;
let warnedNotSetUp = false;

type Deps = { syncAll: (budgetMs: number) => Promise<SyncResult[]>; gmailConfigured: () => boolean; missingSetup: () => string[] };
const real: Deps = { syncAll, gmailConfigured, missingSetup };

export async function runGmailJob(deps: Deps = real, budgetMs = 10 * 60_000): Promise<{ ran: boolean; reason?: string; results?: SyncResult[] }> {
  if (!deps.gmailConfigured()) {
    // The worker is a separate service from the API: it needs the same Gmail settings. Say so once, not every 15 minutes.
    if (!warnedNotSetUp) { console.warn(`Gmail check skipped: not set up on this service (missing ${deps.missingSetup().join(', ') || 'settings'}). Give the sync worker the same Gmail variables as the API.`); warnedNotSetUp = true; }
    return { ran: false, reason: 'not set up' };
  }
  if (running) return { ran: false, reason: 'already running' };
  running = true;
  try {
    const results = await deps.syncAll(budgetMs);
    const saved = results.reduce((t, r) => t + r.saved, 0), removed = results.reduce((t, r) => t + (r.removed ?? 0), 0), failed = results.reduce((t, r) => t + (r.failed ?? 0), 0);
    const trouble = results.filter(r => r.status !== 'ok' && r.status !== 'paused' && r.status !== 'skipped');
    console.log(`Gmail: ${results.length} ${results.length === 1 ? 'mailbox' : 'mailboxes'} checked, ${saved} emails saved${removed ? `, ${removed} removed (Private)` : ''}${failed ? `, ${failed} could not be saved` : ''}${trouble.length ? `, ${trouble.length} with a problem` : ''}.`);
    for (const t of trouble) console.warn(`  Gmail problem (${t.rep}): ${t.status}${t.error ? `, ${t.error}` : ''}`);
    return { ran: true, results };
  } catch (e) {
    console.error('Gmail check failed:', e);
    return { ran: false, reason: 'failed' };
  } finally {
    running = false;
  }
}