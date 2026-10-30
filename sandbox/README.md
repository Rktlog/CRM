# The sandbox: structure and made-up data

This folder builds a **sandbox**: a second copy of Radar's database filled with made-up shops, products and orders. Nothing in it is real.

| File | What it is |
|---|---|
| `01-structure.sql` | The empty tables, views, functions and rules, copied (structure only, no data) from the live database on 30 October 2026. Refuses to run if a `crm` schema already exists. |
| `02-seed.sql` | 72 made-up shops, 92 products, about 500 orders, purchase orders, follow-ups, activity notes and today's Planner jobs. Refuses to run unless the database is empty and at least two sign-in users exist. |
| `build-seed.mjs` | The program that writes `02-seed.sql`. The same program always writes the same file. Run `node build-seed.mjs` to remake it. |

## Load order (once, in a brand new empty Supabase project)

1. Create the sandbox project and at least two sign-in users (Authentication, Users, Add user). The **first** user you create becomes the manager. The next ones become sales reps.
2. `psql -v ON_ERROR_STOP=1 "<the SANDBOX address>" -f 01-structure.sql`
3. `psql -v ON_ERROR_STOP=1 "<the SANDBOX address>" -f 02-seed.sql`

The address must never be the live one. The live project's reference is `nedrakgspsmzpoqqeowe`: if your address contains that, stop.

## Starting again

Run `drop schema crm cascade;` in the **sandbox** project only (never the live one), then repeat the load order.

## What is made up, and what is not

Made up: every shop name, person, phone number, email (all `example.com`), address, product, price, cost, order, note and staff name. Real: the **shape** of the database (its tables, columns, functions and rules), because the sandbox must behave like the real thing.

## Known limits

- The structure file is a snapshot. When the live database changes, make a fresh copy (see `docs/SANDBOX.md`) and replace `01-structure.sql`.
- Dates are written relative to the day `02-seed.sql` is run, so the data looks current on that day and slowly ages.
- Customer emails, marketing, AI chat and Gmail tables are left empty on purpose.
