// Checks that the GitHub rules really work. Run from the project folder:
//
//   node check-rules.mjs            runs Test 1 and sets up Test 2
//   node check-rules.mjs cleanup    removes everything the test made
//
// It works on whatever git project folder you run it from, so the file can live anywhere (for example C:\dev\check-rules.mjs).
//
// Test 1: pushing straight to main must be REFUSED.
// Test 2: pushes a branch holding a fake .env file, so you can open a pull request and see "No secrets" go red.
// It never touches your real files. Only plain words are printed.
import { spawnSync } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';

const git = (...args) => { const r = spawnSync('git', args, { encoding: 'utf8' }); return { code: r.status ?? 1, out: ((r.stdout ?? '') + (r.stderr ?? '')).trim() }; };
const say = t => console.log(t);
const stop = t => { say('\nSTOPPED: ' + t); process.exit(1); };
const BRANCH = 'rule-test2', MESSAGE = 'rule test (safe to delete)';
const me = `node "${process.argv[1]}"`;   // how this script was started, so the cleanup line can be copied exactly

if (process.argv[2] === 'cleanup') {
  git('checkout', 'main');
  const local = git('branch', '-D', BRANCH).code === 0;
  const remote = git('push', 'origin', '--delete', BRANCH).code === 0;
  if (!local && !remote) say(`Nothing to remove: there is no test branch (${BRANCH}) here or on GitHub.`);
  else say(`Removed the test branch ${BRANCH}` + (remote ? ' from GitHub' : '') + (local ? (remote ? ' and' : '') + ' from this computer' : '') + '.' + (remote ? ' A pull request for it is closed automatically.' : ''));
  say('You are on main again. Done.');
  process.exit(0);
}

// ---- before anything: is it safe to run? ----
if (git('rev-parse', '--is-inside-work-tree').code !== 0) stop('this is not a git project folder. Open PowerShell in C:\\dev\\Rocket-crm first.');
if (git('rev-parse', '--abbrev-ref', 'HEAD').out !== 'main') stop('you are not on the main branch. Run: git checkout main');
if (git('status', '--porcelain').out !== '') stop('there are unsaved changes in the project. Save or commit them first, then run this again.');
if (git('fetch', 'origin').code !== 0) stop('could not reach GitHub. Check your internet and that you are signed in to git.');
if (git('rev-list', '--left-right', '--count', 'main...origin/main').out.replace(/\s+/g, ' ') !== '0 0') stop('your main is not the same as GitHub\'s main. Run: git pull   and then try again.');

// ---- Test 1 ----
say('TEST 1: try to push straight to main. GitHub must refuse.');
writeFileSync('rule-test.txt', 'rule test\n');
git('add', 'rule-test.txt');
git('commit', '-m', MESSAGE);
const push = git('push', 'origin', 'main');
let test1;
if (push.code !== 0 && /rule|protected|GH013|GH006|pull request/i.test(push.out)) {
  test1 = true;
  say('  PASS: the push was refused. GitHub said: ' + (push.out.split('\n').find(l => /rule|protected|pull request/i.test(l)) ?? '').replace(/^remote:\s*/, '').trim());
} else if (push.code === 0) {
  test1 = false;
  say('  FAIL: the push was ACCEPTED. The rules are NOT switched on.');
  say('  Removing the test file again so main is clean...');
  git('rm', 'rule-test.txt');
  git('commit', '-m', 'Remove the rule test file');
  say(git('push', 'origin', 'main').code === 0 ? '  Removed. Go back to Part 4 and switch the ruleset on (Enforcement status must say Active).' : '  Could not remove it automatically. Delete the file rule-test.txt on GitHub by hand.');
} else {
  test1 = false;
  say('  UNCLEAR: the push failed, but not with a message about rules:');
  say('  ' + push.out.split('\n').slice(-3).join('\n  '));
}
// put this computer back exactly as it was (only if the last commit is the one this script made)
if (git('log', '-1', '--pretty=%s').out === MESSAGE) git('reset', '--hard', 'origin/main'); else if (existsSync('rule-test.txt') && git('status', '--porcelain').out !== '') git('checkout', '--', '.');

if (!test1) { say('\nTest 2 skipped: fix Test 1 first.'); process.exit(1); }

// ---- Test 2 ----
say('\nTEST 2: send a change containing a fake .env file. You open the pull request yourself.');
git('checkout', '-b', BRANCH);
writeFileSync('.env', 'TEST=1\n');
git('add', '-f', '.env');
git('commit', '-m', 'rule test 2 (safe to delete)');
const p2 = git('push', '-u', 'origin', BRANCH);
if (p2.code !== 0) { git('checkout', 'main'); git('branch', '-D', BRANCH); stop('could not send the test branch: ' + p2.out.split('\n').pop()); }
const url = (git('config', '--get', 'remote.origin.url').out || '').replace(/\.git$/, '').replace(/^git@github\.com:/, 'https://github.com/');
say('  The test branch is on GitHub.');
say('\nNOW DO THIS IN YOUR BROWSER:');
say('  1. Open: ' + url + '/compare/main...' + BRANCH + '?expand=1');
say('  2. Click the green "Create pull request" button.');
say('  3. Scroll to the bottom and wait 2 to 5 minutes. You should see:');
say('       CI / No secrets   a RED cross   (click Details: it says the .env file is an environment file)');
say('       CI / API build and CI / Web build   green ticks');
say('       The merge button is blocked while a check is red.');
say('  4. When you have seen that, come back here and run:');
say('       ' + me + ' cleanup');
git('checkout', 'main');
say('\nTest 1 passed. This computer is back on main.');
