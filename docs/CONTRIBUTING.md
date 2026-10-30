# Changing Radar with Claude Code

*A printable version is `docs/CONTRIBUTING.pdf`.*

You write changes with Claude Code. Sushan reads and approves every one before it goes live. Nobody can push straight to the live code, and that includes Sushan.

## Once only

1. Get a free GitHub login and send Sushan your username. Accept the email invitation to the repository Rktlog/CRM.
2. Install Git, Node.js 22 and Claude Code on your computer (Claude Code setup is at code.claude.com/docs). You need your own Claude account that includes Claude Code.
3. Download the project: git clone https://github.com/Rktlog/CRM.git and then cd CRM.
4. Start Claude Code inside that folder by typing claude. It reads the file CLAUDE.md by itself. Those are the house rules. Do not switch them off.
5. Do not ask for, or use, any live passwords or keys (Railway, Supabase, Vercel, DEAR, Gmail). You do not need them. If something seems to need one, stop and ask Sushan.

## Every change

1. Start fresh: git checkout main then git pull.
2. Make a branch for this one job: git checkout -b yourname/short-topic. One job per branch.
3. Tell Claude Code what you want, in plain words. Ask it to prove the change: build both apps (cd API then npm run build, and cd ../Web then npm run build) and show you the result.
4. Read what changed (git diff). You are responsible for what you send, not Claude.
5. Save and send it: git add -A, then git commit -m "what changed, in plain words", then git push -u origin yourname/short-topic.
6. Open a pull request: GitHub shows a yellow bar, Compare & pull request. Click it and fill in the form: What this changes, Why, Proof, Risk to live data, How to undo.
7. Wait for the three green ticks: API build, Web build, No secrets. If one is red, click Details, fix it and push again.
8. Send Sushan the link and say it is ready. Do not merge it. Sushan reads it, may try it in the sandbox, then approves and merges.
9. After it is merged: git checkout main, git pull, then git branch -d yourname/short-topic.

## The rules

| Always | Never |
|---|---|
| Work on a branch and open a pull request. | Push to main (GitHub refuses) or merge your own pull request. |
| Prove the change: build output, screenshots, numbers. | Say it works if it was not run. Write "not proven" instead. |
| One job per pull request. | Mix a fix with a tidy-up. |
| Put changes to live data in a script file with a preview step, a backup and a row-count guard. Sushan runs it. | Run any script against the live database. |
| Use plain words in anything a rep or manager reads. | Commit passwords, keys or .env files. The secrets check turns red. |
| Leave .github, CLAUDE.md and docs alone unless the job is about them, and say so at the top of the pull request. | Change the checks or the rules so that something passes. |

## Where to read more

- `CLAUDE.md`: The house rules and the data rules: how dates work, what counts as a sale, costs are for managers only.
- `docs/data-notes/DATA_MAP.md`: Read before touching anything about demand, stock, on-order or sales numbers.
- `docs/SANDBOX.md`: How the test copy of Radar works, and why it is safe.

> Stuck? Send Sushan three things: which step you were on, the red text or a screenshot, and the link to your pull request.
