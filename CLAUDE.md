# Rules for Claude on this repository

The owner is Sushan. Write in plain words. If you are not sure, ask before you act.

## The four rules that cannot bend

1. **Never push to `main` and never merge.** Work on a branch called `claude/<short-topic>` and open a pull request. Sushan reads it, approves it and merges it. Production deploys only from `main`.
2. **Never touch the live system.** No production keys, no scripts run against the live database, no changes to Railway, Vercel or Supabase settings. If a change needs live data to change, put the script or SQL in the pull request as a file for Sushan to run. It must have a preview step, a backup table, and a guard on the number of rows it expects to change.
3. **Prove every change.** A pull request is not ready until its **Proof** section shows real evidence: command output, the figures before and after on sandbox data, screenshots from the sandbox. If something could not be proven, write "not proven" and say why. Never write that something works unless it was run.
4. **Do not change the rules.** Do not edit `.github/`, `CLAUDE.md` or `docs/` unless the task asks for it, and if you do, say so in the first line of the pull request.
5. **Never merge, approve or change settings.** Not with `gh pr merge`, not with `gh api`, not by editing rulesets, secrets or workflows' permissions. Those commands are blocked in `.claude/settings.json`. Do not try to get round a block with another command. If you think you need one of them, stop and tell the person.

## How to test: the sandbox

- The sandbox is a separate copy of Radar with its own database and **made-up data**. It has a red banner at the top of every page. See `docs/SANDBOX.md`.
- You can only push branches called `claude/<topic>`. Never push to `staging` or `main`, and never turn on "Allow unrestricted branch pushes".
- Prove the change yourself: run the build and tests, and for anything on screen run the app locally with made-up data and take screenshots. Put the output in the pull request.
- **Put it in the sandbox yourself** once the three checks are green (`gh pr checks <number> --watch`) and the Proof section is filled in: first check no other pull request holds it (`gh pr list --state open --label sandbox`), then run `gh pr edit <number> --add-label sandbox`. A workflow copies your branch to `staging` and comments on the pull request within a minute. Tell the person to start testing in 3 to 5 minutes, with the exact steps to click. There is one sandbox and it holds one change at a time: if another pull request has it, say which one and stop. Do not keep retrying, and never take the label off someone else's pull request. If `gh` is not installed or you cannot add labels, tell the person to add the label from the pull request page. Pushing more commits updates the sandbox by itself while the label is on.
- Never copy live customer data into the sandbox. Never point anything in the sandbox at a live address. The API refuses to start if you do (`API/src/lib/environmentGuard.ts`).

## What this repository is

- `API/`: the Express 4 and Prisma API on Railway. It talks to Supabase Postgres, schema `crm`. The Claude connector for managers is embedded under `API/src/mcp/` and uses a **read-only** database user.
- `Web/`: the React and Vite web app on Vercel. (The folder name has a capital W: GitHub's machines care about capitals.)
- DEAR (Cin7) data comes in through Supabase edge functions (`sync-products`, `sync-sales`, `sync-purchases`).
- Speed: the API is in Singapore and the database is in Sydney, so every database round trip costs 160 to 245 ms. Fewer queries per request matters more than clever SQL.

## Commands

- API: `cd API && npm ci && npm run build`. This is what Railway does. Node 22.
- Web: `cd Web && npm ci && npm run build`.
- The three automatic checks (`API build`, `Web build`, `No secrets`) must pass before a pull request can merge.

## Data rules. Never guess these.

- **Dates.** DEAR order dates are stored as the order day at 00:00 UTC. Old `rhino-history` rows were once stored as Melbourne midnight in UTC. A Melbourne day is `((col at time zone 'UTC') at time zone 'Australia/Melbourne')`.
- **A live order** is `source <> 'rhino-history' and number not like 'Q%'`. Order numbers ran `Q...` before 1 July 2025 and run `SQ...` after it, so a customer count that falls at that date is an artefact.
- **Counts as a sale** means `upper(fulfillment_status) not in ('DRAFT','ESTIMATING','ESTIMATED','ORDERING','VOIDED','CREDITED','QUOTE')`. Forecasts also need `misc_type is null`.
- **Costs** exist only in `crm.product_costs` and `crm.purchase_costs`. They are for managers only. Never show them to reps, and never expose them through the Claude connector.
- **Products starting `OLD-`** are removed and the sync skips them. Eight service items are kept on purpose (surcharge, ICON-HIRE, PPREFUND, RHINOCREDIT, RR Freight - Standard, two Shipping items, IBTT-Deposit).
- **Internal accounts** (`RHINO RHINO TEST`, `Rhino Rhino Marketing`) distort totals. Exclude them wherever they can be identified.
- More traps are in `docs/data-notes/DATA_MAP.md`. Read it before you touch anything about demand, stock, on-order or sales numbers.

## Known problems

`docs/data-notes/RHINO_RADAR_-_EXPORT_CHECK_27102026.md` lists what was wrong with Radar's exports on 27 October 2026: order dates a day early, 119 orders with later dates, quotes not syncing, stock movements that do not reconcile, and missing cost columns. Some of this may already be fixed. Check how it behaves in the sandbox before you change anything.

## Writing

Plain words. Short sentences. No jargon in anything a rep or manager will read. Commit messages say what changed for the user.
