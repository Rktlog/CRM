// Checks that NOTHING can go live without the owner's approval. It only READS settings from GitHub; it changes nothing.
//
// One-time setup on the owner's computer (needs the GitHub CLI):
//     winget install GitHub.cli        (then close and reopen PowerShell)
//     gh auth login                    (sign in as the repository OWNER: the checks need admin rights to see the settings)
// Run it from the project folder:
//     node .github/scripts/check-gate.mjs
// or name the repository:   node .github/scripts/check-gate.mjs Rktlog/CRM
import { spawnSync } from 'node:child_process';

const sh = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: 'utf8' }); return { code: r.status ?? 1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }; };
const api = (path, paginate = false) => {
  const r = sh('gh', ['api', ...(paginate ? ['--paginate'] : []), path]);
  if (r.code !== 0) return { ok: false, err: r.err || r.out, data: null };
  try { return { ok: true, data: JSON.parse(paginate ? r.out.replace(/\]\s*\[/g, ',') : r.out) }; } catch { return { ok: false, err: 'unreadable reply', data: null }; }
};
let pass = 0, fail = 0, warn = 0;
const PASS = t => { pass++; console.log('  PASS  ' + t); };
const FAIL = (t, fix) => { fail++; console.log('  FAIL  ' + t); if (fix) console.log('        Fix: ' + fix); };
const WARN = (t, fix) => { warn++; console.log('  CHECK ' + t); if (fix) console.log('        ' + fix); };
const head = t => console.log('\n' + t);
const stop = t => { console.log('\nSTOPPED: ' + t); process.exit(1); };

if (sh('gh', ['--version']).code !== 0) stop('the GitHub CLI is not installed. Run: winget install GitHub.cli   then close and reopen PowerShell, run: gh auth login   and try again.');
if (sh('gh', ['auth', 'status']).code !== 0) stop('you are not signed in to GitHub. Run: gh auth login   (sign in as the repository owner) and try again.');
let repo = process.argv[2];
if (!repo) { const m = sh('git', ['remote', 'get-url', 'origin']).out.match(/github\.com[:/]([^/]+\/[^/.]+)/); repo = m && m[1]; }
if (!repo) stop('could not tell which repository this is. Run from the project folder, or name it: node .github/scripts/check-gate.mjs Rktlog/CRM');

const info = api(`repos/${repo}`);
if (!info.ok) stop(`could not read ${repo}: ${info.err}`);
const owner = info.data.owner.login, branch = info.data.default_branch;
if (!info.data.permissions?.admin) stop(`you are signed in to GitHub, but not as an admin of ${repo}, so the settings cannot be read. Run: gh auth login   and sign in as the owner (${owner}).`);
console.log(`THE APPROVAL GATE CHECK for ${repo} (branch ${branch}). Read-only: nothing is changed.`);
if (!info.data.private) console.log('\nNOTE: this repository is PUBLIC. Everything in it, and its whole history, can be read by anyone. Never commit passwords, keys, customer data or internal notes you would not publish.');

// ---- 1. the rules that apply to main right now
head('1. The rules on ' + branch + ' (as GitHub applies them now)');
const eff = api(`repos/${repo}/rules/branches/${branch}`);
if (!eff.ok) FAIL('could not read the rules on ' + branch + ': ' + eff.err);
else {
  const rules = eff.data, of = t => rules.filter(r => r.type === t), P = of('pull_request').map(r => r.parameters ?? {});
  if (!rules.length) FAIL(`${branch} has NO rules at all. Anyone with write access can push straight to live.`, 'Settings, Rules, Rulesets: import .github/rulesets/protect-main.json and make sure it says Active.');
  P.length ? PASS('Every change must come through a pull request') : FAIL('Changes can be pushed straight to ' + branch + ' without a pull request.', 'Import and activate .github/rulesets/protect-main.json');
  const maxApprovals = Math.max(0, ...P.map(p => p.required_approving_review_count ?? 0));
  maxApprovals >= 1 ? PASS(`At least ${maxApprovals} approval is needed before merging`) : FAIL('NO approval is needed: any contributor could merge their own pull request once the three checks are green, and it would go live.', 'Delete the "solo" ruleset and keep .github/rulesets/protect-main.json (it needs 1 approval).');
  P.some(p => p.require_code_owner_review) ? PASS('The approval must come from the code owner (you), not just any reviewer') : FAIL('Any reviewer can approve, not only you.', 'Turn on "Require review from Code Owners".');
  P.some(p => p.require_last_push_approval) ? PASS('The approval must be on the latest push (nobody can add changes after you approved)') : FAIL('Someone could push more changes after you approved.', 'Turn on "Require approval of the most recent reviewable push".');
  P.some(p => p.dismiss_stale_reviews_on_push) ? PASS('A new push cancels earlier approvals') : FAIL('Earlier approvals survive new pushes.', 'Turn on "Dismiss stale pull request approvals when new commits are pushed".');
  const have = new Set(of('required_status_checks').flatMap(r => (r.parameters?.required_status_checks ?? []).map(c => c.context)));
  const need = ['API build', 'Web build', 'No secrets'], missing = need.filter(n => !have.has(n));
  missing.length ? FAIL('These checks are not required before merging: ' + missing.join(', '), 'Add them under "Require status checks to pass".') : PASS('The three checks (API build, Web build, No secrets) must be green');
  of('non_fast_forward').length ? PASS('Force-pushing over ' + branch + ' is blocked') : FAIL('History on ' + branch + ' can be rewritten by force-pushing.', 'Turn on "Block force pushes".');
  of('deletion').length ? PASS(branch + ' cannot be deleted') : FAIL(branch + ' could be deleted.', 'Turn on "Restrict deletions".');

  // who can get round the rules: read the bypass list of every active ruleset that covers the default branch
  head('2. Who can get round those rules');
  const list = api(`repos/${repo}/rulesets`);
  if (!list.ok) FAIL('could not read the rulesets: ' + list.err);
  else {
    const active = list.data.filter(r => r.enforcement === 'active' && r.target === 'branch');
    let strange = 0, anyBypass = false;
    for (const r of active) {
      const d = api(`repos/${repo}/rulesets/${r.id}`); if (!d.ok) { WARN(`could not read the ruleset "${r.name}"`); continue; }
      for (const b of d.data.bypass_actors ?? []) {
        anyBypass = true;
        if (b.actor_type === 'RepositoryRole' && b.actor_id === 5 && b.bypass_mode === 'pull_request') continue;
        strange++; FAIL(`In the ruleset "${r.name}", ${b.actor_type} ${b.actor_id} can bypass (${b.bypass_mode}). That is more than the owner alone.`, 'Open the ruleset and edit its Bypass list so only "Repository admin" remains, set to "For pull requests only".');
      }
    }
    if (!strange) PASS(anyBypass ? 'Only the Admin role can bypass, and only through a pull request (that is you)' : 'Nobody can bypass the rules');
  }
}

// ---- 3. code owners
head('3. Who is the code owner');
const co = api(`repos/${repo}/contents/.github/CODEOWNERS`);
if (!co.ok) FAIL('there is no .github/CODEOWNERS file on ' + branch + ', so "code owner approval" means nothing.', 'Add .github/CODEOWNERS from the pack with your GitHub name in every line.');
else {
  const text = Buffer.from(co.data.content ?? '', 'base64').toString('utf8');
  const lines = text.split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith('#'));
  if (/YOUR-GITHUB-USERNAME/.test(text)) FAIL('CODEOWNERS still has the placeholder YOUR-GITHUB-USERNAME.', `Replace it with @${owner} in every line, through a pull request.`);
  else {
    const star = lines.find(l => l.trim().startsWith('* ') || /^\*\s/.test(l.trim()));
    if (!star) FAIL('CODEOWNERS has no "*" line, so some files have no owner.', `Add a line:  *   @${owner}`);
    else if (!star.toLowerCase().includes('@' + owner.toLowerCase())) WARN(`The "*" line names someone other than ${owner}: ${star.trim()}`, 'Make sure that person is you or a team you control.');
    else PASS(`Every file is owned by @${owner}`);
    const others = new Set(lines.flatMap(l => l.trim().split(/\s+/).slice(1)).filter(t => t.startsWith('@') && t.toLowerCase() !== '@' + owner.toLowerCase()));
    if (others.size) WARN('Other people or teams are also code owners: ' + [...others].join(', '), 'They can satisfy "code owner approval" for the files they own. Remove them if you want only your approval to count.');
  }
  const er = api(`repos/${repo}/codeowners/errors`);
  er.ok && (er.data.errors ?? []).length ? FAIL('GitHub reports problems in CODEOWNERS: ' + er.data.errors.map(e => `line ${e.line}: ${e.kind}`).join('; '), 'Fix those lines, through a pull request.') : er.ok && PASS('GitHub reads CODEOWNERS without errors');
}

// ---- 4. people
head('4. Who has access');
const col = api(`repos/${repo}/collaborators`, true);
if (!col.ok) FAIL('could not read the collaborators: ' + col.err);
else {
  const others = col.data.filter(c => c.login.toLowerCase() !== owner.toLowerCase());
  const admins = others.filter(c => c.role_name === 'admin'), maint = others.filter(c => c.role_name === 'maintain');
  admins.length ? FAIL('These people are ADMINS and can change or bypass any rule: ' + admins.map(c => c.login).join(', '), 'Settings, Collaborators: change their role to Write.') : PASS('Nobody else is an admin');
  maint.length && WARN('These people are Maintainers: ' + maint.map(c => c.login).join(', '), 'They cannot bypass the rules, but they can change some settings. Use Write unless they need more.');
  console.log(`        (${others.length} other ${others.length === 1 ? 'person' : 'people'} with access${others.length ? ': ' + others.map(c => `${c.login} (${c.role_name})`).join(', ') : ''})`);
}
const inv = api(`repos/${repo}/invitations`);
if (inv.ok) { const a = inv.data.filter(i => i.permissions === 'admin'); a.length ? FAIL('A pending invitation gives ADMIN rights: ' + a.map(i => i.invitee?.login).join(', '), 'Cancel it and invite them again as Write.') : PASS('No pending invitation gives admin rights'); }

// ---- 5. what a workflow can do
head('5. What the automatic workflows can do');
const ap = api(`repos/${repo}/actions/permissions/workflow`);
if (ap.ok) {
  ap.data.default_workflow_permissions === 'read' ? PASS('Workflows can only READ the repository unless a workflow asks for more') : FAIL('Workflows can WRITE to the repository by default.', 'Settings, Actions, General, Workflow permissions: choose "Read repository contents and packages permissions".');
  ap.data.can_approve_pull_request_reviews ? FAIL('Workflows are allowed to APPROVE pull requests.', 'Settings, Actions, General: untick "Allow GitHub Actions to create and approve pull requests".') : PASS('Workflows cannot approve pull requests');
} else WARN('could not read the workflow permissions: ' + ap.err);
const sec = api(`repos/${repo}/actions/secrets`);
if (sec.ok) sec.data.total_count === 0 ? PASS('No secrets are stored in GitHub, so no workflow can use a key') : WARN(`${sec.data.total_count} secret(s) are stored in GitHub: ${(sec.data.secrets ?? []).map(s => s.name).join(', ')}`, 'The plan was none. Delete them unless you know why they exist.');
const keys = api(`repos/${repo}/keys`);
if (keys.ok) { const w = keys.data.filter(k => k.read_only === false); w.length ? FAIL('A deploy key can write to the repository: ' + w.map(k => k.title).join(', '), 'Settings, Deploy keys: delete it, or make it read-only.') : PASS('No deploy key can write to the repository'); }
if (!info.data.private) {
  const fp = api(`repos/${repo}/actions/permissions/fork-pr-contributor-approval`);
  if (!fp.ok) WARN('could not read the setting for pull requests from outsiders.', 'Check by hand: Settings, Actions, General, "Fork pull request workflows from outside collaborators" should be "Require approval for all outside collaborators".');
  else fp.data.approval_policy === 'all_external_contributors' ? PASS('A pull request from an outsider never runs a workflow until you approve it') : WARN('A pull request from an outsider can run workflows without your approval once they have contributed before (setting: ' + fp.data.approval_policy + ').', 'Settings, Actions, General, "Fork pull request workflows from outside collaborators": choose "Require approval for all outside collaborators".');
}
info.data.allow_auto_merge ? WARN('Auto-merge is switched on. A pull request still needs your approval first, but you can switch it off.', 'Settings, General, Pull Requests: untick "Allow auto-merge".') : PASS('Auto-merge is off');

console.log(`\nRESULT: ${pass} passed, ${fail} FAILED, ${warn} to look at.`);
console.log('\nTHINGS THIS CANNOT SEE: check these by hand (the guide docs/APPROVAL-GATE.md explains each):');
console.log('  - Railway production deploys only from the main branch, has no Pre-deploy command, and "PR Environments" is OFF.');
console.log('  - Vercel (live project) production branch is main. Nobody else is a member of Railway, Vercel or Supabase.');
console.log('  - Two-step sign-in (2FA) is on for GitHub, Railway, Vercel and Supabase. Your GitHub login is the key to everything.');
console.log(fail ? '\nDo NOT invite anyone until every FAIL is fixed.' : '\nNo FAILs. Now do the hand checks above.');
process.exit(fail ? 1 : 0);
