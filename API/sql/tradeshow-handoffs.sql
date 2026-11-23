-- Trade shows: payment details and "To action" for each confirmed order, and the range on the stand.
--
-- WHAT THIS DOES: adds TWO NEW TABLES. It does not change, move or delete anything that exists. Safe to run twice.
-- WHO RUNS IT: Sushan, in the Supabase SQL editor, on the SANDBOX first (if it has the trade show tables), then live.
--
--   crm.ts_handoffs    one row per confirmed trade show order: paid at the show or not, how, how much, the customer's payment screenshot,
--                      and whether sales has dealt with it yet ("To action").
--   crm.ts_show_stand  the brands that are physically on a show's stand.
--
-- Radar works without these tables (the payment step and the To action list stay switched off until they exist), so it is safe to deploy first.
-- Row level security is switched on with no policies, so nothing can read these tables through Supabase's public API. Radar's API reads them as the owner.

-- 1. PREVIEW (reads only): confirm the tables these point at exist, and how many orders there are today.
select to_regclass('crm.ts_orders') as orders_table, to_regclass('crm.ts_shows') as shows_table, (select count(*) from crm.ts_orders) as orders_now;

-- 2. THE TABLES
create table if not exists crm.ts_handoffs (
  order_id    uuid primary key references crm.ts_orders (id) on delete cascade,
  mode        text not null default 'later' check (mode in ('later', 'paid')),
  method      text check (method in ('bank', 'card')),
  amount      numeric(12, 2),
  proof_name  text,
  proof_mime  text,
  proof       bytea,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  actioned_at timestamptz,
  actioned_by uuid,
  action_note text,
  -- a "paid here" order must say how, how much, and carry the screenshot
  constraint ts_handoffs_paid_complete check (mode <> 'paid' or (method is not null and amount is not null and proof is not null))
);
create index if not exists ts_handoffs_todo on crm.ts_handoffs (actioned_at) where actioned_at is null;

create table if not exists crm.ts_show_stand (
  show_id uuid not null references crm.ts_shows (id) on delete cascade,
  brand   text not null,
  primary key (show_id, brand)
);

alter table crm.ts_handoffs   enable row level security;
alter table crm.ts_show_stand enable row level security;

-- 3. CHECK: both tables exist and start empty.
select (select count(*) from crm.ts_handoffs) as handoffs_rows, (select count(*) from crm.ts_show_stand) as stand_rows;

-- TO UNDO (only if nothing there is wanted): drop table crm.ts_show_stand; drop table crm.ts_handoffs;
