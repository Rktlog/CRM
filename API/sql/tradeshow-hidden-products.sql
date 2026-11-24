-- Trade shows: products and brands that are left out of the trade show product list.
--
-- WHAT THIS DOES: adds ONE NEW TABLE. It does not change, move or delete anything that exists. Safe to run twice.
-- WHO RUNS IT: Sushan, in the Supabase SQL editor, on the SANDBOX first (if it has the trade show tables), then live.
--
--   crm.ts_hidden_products   one row per hidden brand or hidden SKU. A hidden product or brand does not show in the trade show order search, the Show range,
--                            the other-colours list, or the assistant's order tool. Orders that already have it are not touched.
--
-- Discontinued products (DEAR status Deprecated, or stage Discontinued) are always left out, without this table.
-- Radar works without this table (nothing extra is hidden, and the setting says it needs set-up), so it is safe to deploy first.
-- Row level security is switched on with no policies, so nothing can read it through Supabase's public API. Radar's API reads it as the owner.

-- 1. PREVIEW (reads only): the trade show tables this sits next to, and whether this table already exists.
select to_regclass('crm.ts_shows') as shows_table, to_regclass('crm.ts_hidden_products') as hidden_table_before;

-- 2. THE TABLE
create table if not exists crm.ts_hidden_products (
  kind       text not null check (kind in ('brand', 'sku')),
  value      text not null check (btrim(value) <> ''),
  created_at timestamptz not null default now(),
  created_by uuid,
  primary key (kind, value)
);
alter table crm.ts_hidden_products enable row level security;

-- 3. CHECK: the table exists and starts empty (0 rows).
select count(*) as hidden_rows from crm.ts_hidden_products;

-- TO UNDO (only if nothing there is wanted): drop table crm.ts_hidden_products;
