# Nothing goes live without your approval

"Live" means the real Radar: the Railway production API and the Vercel production website. Both deploy from one place only, the `main` branch. So the whole gate comes down to one sentence: **nothing reaches `main` without the owner's approval.**

## The locks

1. **`main` is closed.** Nobody can push straight to it, force-push over it or delete it.
2. **A pull request needs your approval.** One approval, from the code owner (you), on every file, on the latest push. A new push cancels earlier approvals. The three checks (API build, Web build, No secrets) must be green. Only squash merging is allowed.
3. **Only you can get round it.** Only the Admin role can bypass, and only through a pull request. Invite everyone else as **Write**, never Admin.
4. **Production deploys only from `main`.** Railway and Vercel are set that way (see the hand checks below).
5. **GitHub holds no keys.** No secrets are stored there, workflows can only read the repository, and they cannot approve pull requests.
6. **The sandbox cannot reach live.** The sandbox workflow only ever writes the `staging` branch (the tests prove it never moves `main`). The sandbox has made-up data and its own settings, and the API refuses to start if it is pointed at the live system.
7. **Live data changes need you.** A change to live data is a script file that only you run. Contributors have no access to Railway, Vercel or Supabase.
8. **Claude cannot merge.** `.claude/settings.json` blocks `gh pr merge`, `gh pr review`, `gh api`, force pushes, pushes to `main` or `staging`, and reading `.env` files. Rule 5 in `CLAUDE.md` says the same in words. Claude Code in the browser can only push branches called `claude/...`.

## Because the repository is public

GitHub's free plan keeps protected branches and code owners for public repositories only, so this repository stays public. That has consequences:

- **Everything in it, and its whole history, is readable by anyone.** Never commit passwords, keys, customer data or internal notes you would not publish. Taking a file out again does not unpublish it. If a key is ever committed, change the key at its provider straight away.
- **Look at the Security tab now** for "secret scanning" alerts. GitHub scans public repositories for free. Our No secrets check only looks at new pull requests, so older commits were never checked.
- **Strangers can open pull requests from forks.** They cannot merge (your approval is needed) and they cannot start the sandbox workflow (it ignores forks). Also set Settings, Actions, General, "Fork pull request workflows from outside collaborators" to "Require approval for all outside collaborators". The checker reports it.
- **The sandbox workflow uses `pull_request`, not `pull_request_target`,** because GitHub blocks that one in public repositories from 2 December 2026.
- **The live Supabase project ID and API address are in the code.** They are also visible in the live website's own code, and they are not passwords. The safety rests on passwords and keys never being in the repository.

## Check it (ten minutes, before you invite anyone, and again after any change to roles or rules)

**1. Run the checker.** It only reads settings. It changes nothing.
- Once: `winget install GitHub.cli`, close and reopen PowerShell, then `gh auth login` and sign in as the owner.
- Then, in `C:\dev\Rocket-crm`: `node .github/scripts/check-gate.mjs`
- You want `0 FAILED`. Every FAIL says how to fix it. Do not invite anyone until there are none.

**2. Check by hand what the checker cannot see.**
- **Railway, production environment, API service:** Settings, Source: the branch is `main`. Settings, Deploy: **Pre-deploy command** is empty and the build command only builds. Project Settings, Environments: **PR Environments** is off. Project members: only people you trust.
- **Vercel, the live project:** Settings, Environments, Production, Branch Tracking says `main`. Team members: only people you trust.
- **Supabase:** organization members are only you. Nobody else is ever given a database password.
- **Two-step sign-in (2FA)** is on for GitHub, Railway, Vercel and Supabase. Your GitHub login is the key to everything below.

**3. Prove it (optional, strongest).** Make a free second GitHub account, invite it as Write, and from it try to push to `main`: GitHub must refuse. Open a pull request: the merge button must be blocked with "Review required", and there must be no bypass box. Then remove the account.

**4. Prove the Claude block.** In Claude Code ask it to run `gh pr merge 1`. It must be blocked.

## The weak points, honestly

- **You are the key.** Your admin login can bypass the rules (by design, so you can merge your own work). Keep 2FA on, and never run Claude Code unattended under your admin login. Better: let Claude and your contributors use their own non-admin GitHub accounts.
- **Railway, Vercel and Supabase sit outside GitHub.** Anyone with access there can change live without a pull request. Keep those lists short.
- **The gate is only as good as the review.** Approving a pull request you have not read defeats it. Use the approver checklist in the contributor guide.
- **The block list is a speed bump, not a wall.** The real walls are the ruleset and non-admin accounts.
- **The checker is a snapshot.** Run it again after you change a role, a ruleset or CODEOWNERS.
