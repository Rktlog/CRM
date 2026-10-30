# The sandbox: a safe copy for testing

A sandbox is a second copy of Radar with its own database, its own API and its own website, filled with made-up data. Changes are tried there first. It has a red banner on every page.

## How a change travels

1. Claude writes the change on a branch called `claude/<topic>` and opens a pull request. It proves the change itself (tests, and screenshots from a local run with made-up data) and puts that in the pull request.
2. Three automatic checks run on the pull request: API build, Web build and No secrets.
3. When the three checks are green, the label `sandbox` is added to the pull request. Claude Code does it itself (`gh pr edit <number> --add-label sandbox`), or the person adds it from the pull request page. Nobody has to wait for you. A workflow (`deploy-to-sandbox.yml`, with its script `.github/scripts/sandbox-deploy.sh`) copies the branch to `staging`, comments on the pull request, and Railway and Vercel deploy it to the sandbox.
4. They try it in the sandbox as a rep or manager would, and write down what they saw in a comment on the pull request.
5. You read the pull request and the list of changed files, try it in the sandbox yourself, then approve and merge. Merging to `main` deploys to the live Radar.

## Who holds the sandbox

There is one sandbox and it holds one change at a time.

- **Claiming:** the label `sandbox` on an open pull request means it holds the sandbox. If another pull request already has the label, the new label is taken off again with a comment saying which pull request has it.
- **Updating:** while a pull request has the label, every new commit pushed to it updates the sandbox by itself.
- **Releasing:** when a labelled pull request is closed or merged, the label comes off and `staging` goes back to the live code (`main`).
- **Taking over:** the rule is the same for everybody, you included. A label added while another pull request holds the sandbox is taken off again. To take it over, take the label off the other pull request first (tell its owner), then add it to yours. That is why it is safe for Claude to add the label, whoever's GitHub login it is working under.
- **Safe by design (this repository is public):** the workflow only acts on pull requests from branches in this repository, never from forks. It reads its script from `main`, so a pull request cannot change what the script does. It only copies a branch onto `staging`, never runs the branch's own code and never writes to `main`. Pushes made with the built-in token do not start other workflows, and GitHub holds no secrets. It uses the ordinary `pull_request` trigger, not `pull_request_target`, which GitHub blocks in public repositories from 2 December 2026. The sandbox has only made-up data and sandbox settings, and the API refuses to start if it is pointed at the live system. Anything under `.github/`, `CLAUDE.md`, `docs/`, `.claude/`, `API/prisma`, `API/scripts`, `API/src/mcp` and `API/src/lib/environmentGuard.ts` still needs your line-by-line reading before you approve, because those matter for live.
- **Merge conflicts:** GitHub does not run this workflow on a pull request that has a merge conflict, so the label does nothing until the conflict is fixed. Merge `main` into the branch, fix the conflicts, push, and add the label again.
- **Stuck:** if someone leaves a label on for days, remove it from their pull request. The sandbox then keeps showing their change until the next claim, which is harmless.

## The one danger

On Railway, **Duplicate Environment copies every variable of production, including the live database address.** A new sandbox starts out pointing at your real data. So:

- You replace the variables (list below). This is the first lock.
- The API checks them. When `APP_ENV=staging`, it refuses to start if any variable mentions the live Supabase project or the live API address, and it says which variable. This is the second lock (`API/src/lib/environmentGuard.ts`, tested).
- Railway's automatic test copies for each pull request would also copy production. **Do not switch on "PR Environments" with production as the base.** Use the single `staging` environment below.

## What to create

### 1. A second Supabase project: `radar-sandbox`
- Create it in the same region as the live one (Sydney). It gets its own keys. Check the price Supabase shows before you confirm: a second project can cost extra.
- Add sign-in users: Authentication, Users, Add user, tick **Auto Confirm User**. Create at least two. The first becomes the manager, the next ones sales reps.
- Load the structure and the made-up data with the files in the `sandbox` folder, in this order (details in `sandbox/README.md`):
  `psql -v ON_ERROR_STOP=1 "<the SANDBOX address>" -f sandbox/01-structure.sql`
  `psql -v ON_ERROR_STOP=1 "<the SANDBOX address>" -f sandbox/02-seed.sql`
  Both files refuse to run on a database that already holds data, and the address must never contain the live project's reference.
- In the sandbox only, give the secret store its own made-up value: `select vault.create_secret('sandbox-made-up-secret', 'sync_secret');`
- Do **not** create the scheduled jobs (pg_cron) in this project. They are what call the live API.

### 2. A Railway environment: `staging`
- In the Railway project: **Environments**, **New Environment**, **Duplicate Environment**, from production. Name it `staging`.
- On the API service in `staging`, set **Source branch** to `staging`. Production must deploy only from `main`.
- Go through **every** variable in the staging environment next to the production list and change them like this:

| Variable | In the sandbox |
|---|---|
| `APP_ENV` | `staging` (add it) |
| `DATABASE_URL`, `DIRECT_URL` | the sandbox project's, never the live one |
| `PUBLIC_API_URL` | the sandbox API's own address |
| `ALLOWED_ORIGINS` | the sandbox website's address |
| Any secret (sync secret, sheet feed token, and so on) | new random values. Never reuse the live ones |
| Google or Gmail sign-in keys | leave empty. The sandbox must never see real email or calendars |
| `GMAIL_JOB` | not set |
| DEAR / Cin7 keys | leave empty, so nothing syncs from the real DEAR |
| `MCP_...` (the Claude connector) | leave unset, so the connector is off |
| Supabase service key | the sandbox project's |

- Sealed variables are not copied when you duplicate, so those you must set again anyway.

### 3. Vercel: the sandbox website
- The `staging` branch is deployed as a preview. In **Settings**, **Environment Variables**, set these for **Preview** only (or for the `staging` branch only), never for Production:
  `VITE_API_URL` = the sandbox API address, `VITE_SUPABASE_URL` and the key = the sandbox project's, `VITE_APP_ENV` = `staging` (this turns on the red banner).

## Checking the sandbox is safe (do these once)

1. The sandbox website shows the red **SANDBOX** banner. The live one does not.
2. In the Railway `staging` logs, `API listening on` appears and **no** line saying `Radar ordering connector is on`.
3. If you deliberately set `DATABASE_URL` to the live one in `staging` and redeploy, the API must refuse to start and name the variable. (Then put it back.)
4. Write a test note on a customer in the sandbox. Open the same customer in the live Radar. The note must not be there.
5. In the sandbox Supabase SQL editor, `select count(*) from crm.accounts` shows the made-up number, not your real one.

## Resetting

To start again: in the sandbox project run `drop schema crm cascade;`, then run `sandbox/01-structure.sql` and `sandbox/02-seed.sql` again. Never do this in the live project.

## Refreshing the structure

`sandbox/01-structure.sql` is a snapshot of the live database's structure. When the live database changes (a new table or column), take a fresh structure-only copy (it only reads, and copies no rows):
`pg_dump "<live DIRECT_URL>" --schema-only --schema=crm --no-owner --no-privileges -f sandbox-schema.sql`
Check it for secrets, then ask Claude to clean it and test it with the seed. Keep that file out of git until it is cleaned.

## What the sandbox cannot tell you

It has fake data, so it cannot show a result that depends on real sales history or real DEAR behaviour. For those, a change must also state how it will be checked on live data after merging (a read-only query is safest).
