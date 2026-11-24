-- Sales Tools: saved links, and saved email templates (payment reminder, abandoned cart, order email, and any the team adds).
--
-- WHAT THIS DOES: adds TWO NEW TABLES. It does not change, move or delete anything that exists. Safe to run twice.
-- WHO RUNS IT: Sushan, in the Supabase SQL editor (live). It cannot be tried in the sandbox copy of Radar unless the sandbox database has the same schema.
--
--   crm.sales_links       a name and a web link ("Engelite preorder" -> the Google Doc), shared by the whole sales team.
--   crm.email_templates   one row per saved template. A row for payment_reminder / abandoned_cart / order_email REPLACES today's wording;
--                         with no row, Radar uses today's wording. Delete the row (the Reset button) to go back.
--
-- Radar works without these tables (Sales Tools shows a "not set up" message and every email uses today's wording), so it is safe to deploy first.
-- Row level security is on with no policies, so nothing can read these through Supabase's public API. Radar's API reads them as the owner.

-- 1. PREVIEW (reads only): the schema exists, and these tables are not there yet.
select to_regclass('crm.sales_links') as links_table, to_regclass('crm.email_templates') as templates_table;

-- 2. THE TABLES
create table if not exists crm.sales_links (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(name) between 1 and 60),
  url        text not null check (url like 'https://%' and char_length(url) <= 2000),
  note       text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists sales_links_name_unique on crm.sales_links (lower(name));

create table if not exists crm.email_templates (
  key        text primary key check (key in ('payment_reminder', 'abandoned_cart', 'order_email') or key ~ '^c-[0-9a-f]{8}$'),
  name       text not null check (char_length(name) between 1 and 60),
  subject    text not null check (char_length(subject) between 1 and 200),
  body       text not null check (char_length(body) between 1 and 8000),
  updated_by uuid,
  updated_at timestamptz not null default now()
);

alter table crm.sales_links     enable row level security;
alter table crm.email_templates enable row level security;

-- 3. CHECK: both tables exist and start empty.
select (select count(*) from crm.sales_links) as links_rows, (select count(*) from crm.email_templates) as template_rows;

-- TO UNDO (only if nothing there is wanted): drop table crm.email_templates; drop table crm.sales_links;
