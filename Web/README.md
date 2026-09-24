# Web — setup

Vite + React + TypeScript, talking to the Express API you already have
running on :4000, using Supabase Auth for login.

## 1. Install

```
cd web
npm install
```

## 2. Env

```
copy .env.example .env
```

Fill in `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (Settings ->
API in the Supabase dashboard, same values you already used in the
API's `.env`). Leave `VITE_API_URL` as `http://localhost:4000` while
you're running the API locally.

## 3. Create a login for yourself

You already seeded a rep row in `crm.reps`, but that's the database
side — you also need an actual Supabase Auth user with the same UUID
to log in with. If you created the rep by hand via SQL, go to
Supabase -> Authentication -> Users -> Add user, set an email and
password, then copy the UUID it generates and make sure it matches
the `id` on that rep's row in `crm.reps` (update the row if it
doesn't).

## 4. Run both, at once

Two terminals:

```
cd API && npm run dev
cd web && npm run dev
```

Open http://localhost:5173, sign in, you should land on the
Dashboard pulling real accounts from your API.

## What's actually wired up

- Login screen using `supabase.auth.signInWithPassword`
- Every page fetches through `apiGet`/`apiPost` in `src/lib/api.ts`,
  which attaches the current session's JWT as a Bearer token
- Dashboard, Pipeline, Accounts, Account detail, Visit log — same
  layout and status colours as the original mock, now reading real
  data
- Logging a call/email/visit on the account detail page actually
  POSTs to `/activity` and refreshes, so the New Lead -> Approached
  auto-advance you built into the API shows up live

## One known gap, on purpose

`GET /accounts` doesn't return each account's quotes, so the
Dashboard and Pipeline board can only show the "inactive customer"
flag (based on `lastOrderAt`), not the "payment overdue" flag — that
one needs the quote data, which currently only comes back from
`GET /accounts/:id` (account detail). Fix later by having the
accounts list endpoint include each account's latest quote, or add
a small `/accounts?withQuotes=true` variant — either way, that's an
API change, not a frontend one.
