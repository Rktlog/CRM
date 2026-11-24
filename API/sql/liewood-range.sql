-- Liewood range: the Product Range List moves from the Liewood Master File into Radar (Products, Liewood, Range).
--
-- WHAT THIS DOES: adds TWO NEW TABLES. It does not change, move or delete anything that exists. Safe to run twice.
-- WHO RUNS IT: Sushan, in the Supabase SQL editor, on the SANDBOX first, then live.
--
--   crm.lw_range       one row per Liewood SKU in the range: season, Essential, category, order increment, the two delivery dates,
--                      ranged yes or no, Liewood's EUR price, the proposed RRP. Filled by importing the Product Range List tab once,
--                      then kept up by each new Liewood sales order.
--   crm.lw_catalogue   what each season's files say about a SKU: Liewood's Product Data file (EAN, names, EUR prices, drop delivery,
--                      sales order multiple) and the Customer Forecast Form (AUD RRP and wholesale, category, order increment).
--                      When a sales order comes in, its SKUs are filled into crm.lw_range from here.
--
-- Both tables hold Liewood's EUR prices, which are costs: they are for managers only. Do NOT grant them to the read-only
-- database user that the Claude connector uses. Row level security is switched on with no policies, so nothing can read
-- them through Supabase's public API. Radar's API reads them as the owner.
-- Radar works without these tables (the Range page says it needs set-up, and sales orders upload as before), so it is safe to deploy first.

-- 1. PREVIEW (reads only): whether the tables already exist, and the Liewood order tables they sit next to.
select to_regclass('crm.lw_orders') as orders_table, to_regclass('crm.lw_range') as range_before, to_regclass('crm.lw_catalogue') as catalogue_before;

-- 2. THE TABLES
create table if not exists crm.lw_range (
  sku             text primary key check (btrim(sku) <> '' and sku = upper(btrim(sku))),
  ean             text,
  name            text,
  colour          text,
  season          text,
  essential       text,          -- as written: YES, NO, N/A
  subbrand        text,
  category        text,
  sub_category    text,
  product_type    text,
  order_increment int check (order_increment is null or order_increment between 1 and 1000),   -- Master File column L
  drop_eur        text,          -- Master File column M: Liewood's drop delivery
  drop_aus        text,          -- Master File column O: typed in by hand, never filled from a file
  ranged          text,          -- Confirmed to range: Y, N, N - Pre order only
  status          text,
  wsp_eur         numeric(12, 2) check (wsp_eur is null or wsp_eur >= 0),          -- Liewood's wholesale price in EUR (a cost)
  proposed_rrp    numeric(12, 2) check (proposed_rrp is null or proposed_rrp >= 0),
  notes           text,
  source          text not null default 'master' check (source in ('master', 'season files')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  updated_by      uuid
);
alter table crm.lw_range enable row level security;

create table if not exists crm.lw_catalogue (
  sku              text primary key check (btrim(sku) <> '' and sku = upper(btrim(sku))),
  ean              text,
  -- from Liewood's Product Data file
  style_no         text,
  style_name       text,
  colour_code      text,
  colour           text,
  size             text,
  season_code      text,
  essentials       text,
  development      text,
  drop_delivery    text,
  sales_multiple   int,
  wsp_eur_stock    numeric(12, 2),
  wsp_eur_pre      numeric(12, 2),
  rrp_eur          numeric(12, 2),
  brand            text,
  lw_category      text,
  lw_sub_category  text,
  lw_product_type  text,
  product_file     text,
  product_at       timestamptz,
  -- from the Customer Forecast Form
  f_style_name     text,
  f_colour         text,
  f_size           text,
  f_category       text,
  f_sub_category   text,
  f_product_type   text,
  f_eta            text,
  f_increment      int,
  rrp_aud          numeric(12, 2),
  ws_aud           numeric(12, 2),
  forecast_file    text,
  forecast_at      timestamptz
);
alter table crm.lw_catalogue enable row level security;

-- 3. CHECK: both tables exist and start empty (0 rows each).
select (select count(*) from crm.lw_range) as range_rows, (select count(*) from crm.lw_catalogue) as catalogue_rows;

-- TO UNDO (only if nothing there is wanted): drop table crm.lw_range; drop table crm.lw_catalogue;
