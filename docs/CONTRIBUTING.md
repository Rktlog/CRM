# Changing Radar with Claude Code

Setup, testing in the sandbox, and getting your change approved. A printable version is `docs/CONTRIBUTING.pdf`.

You write changes with Claude Code. Every change is tried on a safe copy of Radar (the sandbox) and read by Sushan before it goes live. Nobody can push straight to the live code, and that includes Sushan.

**How a change travels:** 1. you and Claude Code change the code; 2. you open a pull request; 3. three automatic checks run; 4. the label `sandbox` is added (Claude Code does it for you, or you); 5. the sandbox updates by itself; 6. you test it there and write down what you saw; 7. Sushan reads it, tries it, approves and merges; 8. the live Radar updates.

## Part 1: Setup, once

1. Send Sushan your GitHub username (make a free account at github.com if you have none). He invites you to Rktlog/CRM. Open the email and click Accept invitation.
2. Ask Sushan for the sandbox logins (one manager and three reps). They are made up, but keep them within the team.
3. Install Git, Node.js 22 and Claude Code (setup is at code.claude.com/docs). You need your own Claude account that includes Claude Code.
4. Install the GitHub CLI (called gh, from cli.github.com) and sign in with your own account: type gh auth login and follow the questions. Claude Code uses it to open pull requests and to add the sandbox label for you.
5. Download the project: git clone https://github.com/Rktlog/CRM.git then cd CRM.
6. Install what the two apps need, once: cd API, npm ci, cd ../Web, npm ci, then cd ...
7. Start Claude Code in the project folder by typing claude. It reads CLAUDE.md by itself. Check it did: ask What rules do you follow in this project? It should mention branches, pull requests, proof and the sandbox.
8. Do not ask for or use any live passwords or keys (Railway, Supabase, Vercel, DEAR, Gmail). You do not need them. The sandbox is where you test.

## Part 2: Making a change, every time

1. Start fresh: git checkout main then git pull.
2. One branch for one job: git checkout -b yourname/short-topic.
3. Ask Claude Code for the change, using the prompt in the box below.
4. Read what it changed (git diff). You are responsible for what you send, not Claude.
5. Save and send it: git add -A, then git commit -m "what changed, in plain words", then git push -u origin yourname/short-topic.
6. On GitHub click the yellow Compare & pull request bar and fill in the form. Under Proof, add a heading How to try it in the sandbox and paste the steps Claude gave you.
7. Wait for the three green ticks: API build, Web build, No secrets. If one is red, click Details, fix it and push again.
8. Go on to Part 3: put it in the sandbox and test it. When your test notes are on the pull request, tell Sushan it is ready for review. Do not merge it yourself.

**Prompt to give Claude Code:**

```
Read CLAUDE.md. I want to change: [say it in plain words].
Make the smallest change that does it.
Then build both apps (API and Web) and show me the output.
When the three checks are green, put it in the sandbox (CLAUDE.md says how).
In your summary, list the exact steps I should click in the sandbox
to check it works, and what I should see at each step.
Do not touch anything under .github, docs or CLAUDE.md.
```

## Part 3: Testing in the sandbox

The sandbox address is https://crm-snowy-ten-25.vercel.app. After you sign in a red SANDBOX bar shows at the top of every page. If you see real shops and no red bar, you are on the live site: stop and tell Sushan.

1. When the three ticks are green, Claude Code adds the label sandbox for you (CLAUDE.md tells it how, and it checks first that nobody else has the sandbox). If it cannot, add it yourself: your pull request page, right-hand column, Labels, tick sandbox. You never need to ask anyone. (If another pull request already has the sandbox, the label comes off again and a comment tells you who has it. See Rule 1.)
2. Within a minute a comment appears on your pull request: The sandbox now holds this pull request at commit .... Check the code matches your latest commit. Then wait 3 to 5 minutes while Railway and Vercel rebuild.
3. Open the sandbox, press Ctrl+F5, and sign in with the login for the role your change affects.
4. Follow the How to try it in the sandbox steps from your pull request. Look at what you changed, then at the screens next to it.
5. Write down what you saw as a comment on your pull request (template below), with screenshots. Then tell Sushan it is ready for review.

**What to check**

- It does what you said it should do.
- The screens next to it still work (Dashboard, Customers, Orders, Products).
- Odd cases: no results, a very long name, an empty list.
- No red error messages on the page. (Optional: press F12, open Console. Red lines mean a problem.)
- A screen change: also look at a narrow window, like a phone.
- The right role: a rep must not see manager-only things.

**Comment to paste on your pull request:**

```
TESTED IN THE SANDBOX
Login used: manager / rep (which one)
What I did: 1) ... 2) ... 3) ...
What I saw: ...
Result: works / does not work
Screenshots: attached
NOT tested here, and why: ...
```

- One change at a time. The pull request with the label holds the sandbox. If someone else has it, your label comes off again with a comment saying who.
- Pushing more changes updates the sandbox by itself while your pull request has the label.
- Closing or merging your pull request frees the sandbox, and it goes back to the live code.
- Never type real customer details into the sandbox.
- The sandbox cannot test real Cin7 syncs, email, Google, the AI assistant, the Claude connector, or real data volume. Say so under "NOT proven".

## Part 4: Getting approved

Sushan checks your pull request and tries it in the sandbox himself, then approves and merges. The live Radar updates two to five minutes later.

## The rules

| Always | Never |
|---|---|
| Work on a branch and open a pull request. | Push to main (GitHub refuses) or merge your own pull request. |
| Prove the change: build output, sandbox test notes, screenshots. | Say it works if it was not run. Write "not proven" instead. |
| One job per pull request. | Mix a fix with a tidy-up. |
| Put changes to live data in a script file with a preview step, a backup and a row-count guard. Sushan runs it. | Run any script against the live database. |
| Use plain words in anything a rep or manager reads. | Commit passwords, keys or .env files. The secrets check turns red. |
| Leave .github, CLAUDE.md and docs alone unless the job is about them, and say so at the top of the pull request. | Push to the staging branch by hand, or change the checks so something passes. |

## For the approver: checklist before you approve

1. Open the pull request. Read What this changes, Why, Proof and the contributor's How to try it steps. If you cannot follow them, send it back.
2. Click Files changed. Only the files you expect? The sandbox holds made-up data only, so anything is safe to try there. But read changes to these line by line before you approve, because they matter for live: .github, CLAUDE.md, docs, API/prisma, API/scripts, API/src/mcp and API/src/lib/environmentGuard.ts.
3. Check the three green ticks: API build, Web build, No secrets.
4. The contributor has probably put it in the sandbox already. Look for the comment from github-actions on the pull request, and check the staging branch shows their latest commit. If the sandbox holds a different pull request and you need it, take the label off that pull request (tell its owner), then add the label sandbox to the one you want to try. Nothing is lost: the other one adds the label again later. The rule is the same for you as for everyone, so nobody can take the sandbox by accident. Wait for Railway (staging) and the sandbox Vercel project to say Ready.
5. Try it yourself in the sandbox, following their steps, and one screen next to it. Read their test comment: does it match what you see?
6. If it changes data: the script or SQL must be a file in the pull request with a preview step, a backup and a row-count guard. You run it on the live database, never the contributor.
7. Click Review changes, Approve, Submit review. Then Squash and merge and Delete branch (never the staging branch).
8. Watch the live Radar for a few minutes after: the Railway deployment is healthy, the Dashboard loads, and the screen that changed looks right.
9. If something is wrong: open the merged pull request and click Revert. It makes a new pull request that undoes it. Check its ticks, then merge it the same way.
