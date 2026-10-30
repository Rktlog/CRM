-- SANDBOX STRUCTURE: the tables, views, functions and rules of Radar's database, with NO data in them.
-- It was copied from the live database (structure only) on 30 October 2026 by pg_dump, and cleaned for a sandbox:
--   * the security rules for the Claude connector's read-only user are left out (the sandbox has no such user)
--   * the lines that only the psql program understands are removed
-- (Two staff ID numbers inside the function accounts_default_owner were replaced with dummy values, so no real IDs are kept here.)
-- Run it ONCE, in a brand new EMPTY Supabase project, BEFORE sandbox-seed.sql. It refuses to run if a crm schema is already there,
-- so it cannot change the live database. Use:  psql -v ON_ERROR_STOP=1 "<the SANDBOX address>" -f 01-structure.sql
create extension if not exists pg_trgm with schema public;   -- product search needs this
do $$ begin
  if exists (select 1 from information_schema.schemata where schema_name = 'crm') then
    raise exception 'STOPPED: this database already has a crm schema. This file only builds a NEW, EMPTY sandbox, so it will not run here.';
  end if;
end $$;

--
-- PostgreSQL database dump
--


-- Dumped from database version 17.6
-- Dumped by pg_dump version 18.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: crm; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA crm;


--
-- Name: AccountType; Type: TYPE; Schema: crm; Owner: -
--

CREATE TYPE crm."AccountType" AS ENUM (
    'prospect',
    'customer',
    'lead',
    'cold_lead'
);


--
-- Name: ActivityType; Type: TYPE; Schema: crm; Owner: -
--

CREATE TYPE crm."ActivityType" AS ENUM (
    'call',
    'email',
    'visit',
    'remark'
);


--
-- Name: CreditTerm; Type: TYPE; Schema: crm; Owner: -
--

CREATE TYPE crm."CreditTerm" AS ENUM (
    'prepay',
    'account'
);


--
-- Name: RepRole; Type: TYPE; Schema: crm; Owner: -
--

CREATE TYPE crm."RepRole" AS ENUM (
    'rep',
    'manager'
);


--
-- Name: RepType; Type: TYPE; Schema: crm; Owner: -
--

CREATE TYPE crm."RepType" AS ENUM (
    'field',
    'remote'
);


--
-- Name: Stage; Type: TYPE; Schema: crm; Owner: -
--

CREATE TYPE crm."Stage" AS ENUM (
    'new_lead',
    'approached',
    'quote_sent',
    'payment_cleared',
    'dispatched'
);


--
-- Name: TaskType; Type: TYPE; Schema: crm; Owner: -
--

CREATE TYPE crm."TaskType" AS ENUM (
    'cold_call',
    'visit',
    'email'
);


--
-- Name: accounts_default_owner(); Type: FUNCTION; Schema: crm; Owner: -
--

CREATE FUNCTION crm.accounts_default_owner() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    begin
      if new.rep_id = '00000000-0000-0000-0000-00000000000a'::uuid then new.rep_id := '00000000-0000-0000-0000-00000000000b'::uuid; end if;
      return new;
    end $$;


--
-- Name: accounts_set_council(); Type: FUNCTION; Schema: crm; Owner: -
--

CREATE FUNCTION crm.accounts_set_council() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  new.postcode := crm.address_postcode(new.address, new.region);
  new.council := case when new.postcode is null then null else crm.postcode_council(new.postcode, new.region) end;
  return new;
exception when others then
  raise warning 'crm.accounts_set_council skipped for %: %', new.id, sqlerrm;
  return new;
end $$;


--
-- Name: address_postcode(text, text); Type: FUNCTION; Schema: crm; Owner: -
--

CREATE FUNCTION crm.address_postcode(addr text, region text) RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
declare st text := crm.region_state(region); tok text; hit text := null;
begin
  if addr is null or region in ('NZ', 'INTL') then return null; end if;
  for tok in select m[1] from regexp_matches(addr, '(?<![0-9])([0-9]{4})(?![0-9])', 'g') as m loop
    if exists (select 1 from crm.postcode_councils p where p.postcode = tok and (st is null or p.state = st)) then hit := tok; end if;
  end loop;
  return hit;
end $$;


--
-- Name: call_api(text); Type: FUNCTION; Schema: crm; Owner: -
--

CREATE FUNCTION crm.call_api(path text) RETURNS bigint
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select net.http_post(
    url := 'https://rhinocrm-production.up.railway.app' || path,
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'sync_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 10000);
$$;


--
-- Name: eol_grace(); Type: FUNCTION; Schema: crm; Owner: -
--

CREATE FUNCTION crm.eol_grace() RETURNS interval
    LANGUAGE sql IMMUTABLE
    AS $$ select interval '24 hours' $$;


--
-- Name: fill_invoice_date(); Type: FUNCTION; Schema: crm; Owner: -
--

CREATE FUNCTION crm.fill_invoice_date() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.invoice_date is null then
    begin
      if jsonb_typeof(new.invoices) = 'array' then
        new.invoice_date := (
          select min(left(i->>'date', 19)::timestamp)
          from jsonb_array_elements(new.invoices) i
          where coalesce(i->>'status', '') !~* '^(void|delet|cancel|draft)' and (i->>'date') ~ '^\d{4}-\d{2}-\d{2}'
        );
      end if;
    exception when others then null;
    end;
  end if;
  return new;
end $$;


--
-- Name: finish_eol_products(); Type: FUNCTION; Schema: crm; Owner: -
--

CREATE FUNCTION crm.finish_eol_products() RETURNS integer
    LANGUAGE plpgsql
    AS $$
declare n int;
begin
  with t as (
    update crm.products set lifecycle = lifecycle
    where lifecycle = 'eol' and stock_zero_since is not null and stock_zero_since <= now() - crm.eol_grace()
    returning lifecycle
  )
  select count(*) filter (where lifecycle = 'discontinued') into n from t;
  return coalesce(n, 0);
end $$;


--
-- Name: is_manager(); Type: FUNCTION; Schema: crm; Owner: -
--

CREATE FUNCTION crm.is_manager() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    AS $$
  select exists (
    select 1 from crm.reps where id = auth.uid() and role = 'manager'
  );
$$;


--
-- Name: note_dear_link(); Type: FUNCTION; Schema: crm; Owner: -
--

CREATE FUNCTION crm.note_dear_link() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if old.dear_customer_id is null and new.dear_customer_id is not null and new.dear_linked_at is null then
    new.dear_linked_at := now();
  end if;
  return new;
end $$;


--
-- Name: postcode_council(text, text); Type: FUNCTION; Schema: crm; Owner: -
--

CREATE FUNCTION crm.postcode_council(pc text, region text) RETURNS text
    LANGUAGE sql STABLE
    AS $$
  select p.council from crm.postcode_councils p
  where p.postcode = pc and (crm.region_state(region) is null or p.state = crm.region_state(region))
  order by p.share desc, p.state limit 1
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: products; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.products (
    sku text NOT NULL,
    dear_id text,
    name text NOT NULL,
    brand text,
    category text,
    uom text,
    status text,
    on_hand double precision DEFAULT 0 NOT NULL,
    allocated double precision DEFAULT 0 NOT NULL,
    available double precision DEFAULT 0 NOT NULL,
    on_order double precision DEFAULT 0 NOT NULL,
    locations jsonb DEFAULT '[]'::jsonb NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT now() NOT NULL,
    stock_synced_at timestamp(3) without time zone,
    prices jsonb DEFAULT '{}'::jsonb NOT NULL,
    barcode text,
    attributes jsonb DEFAULT '{}'::jsonb NOT NULL,
    image_url text,
    sheet_data jsonb DEFAULT '{}'::jsonb NOT NULL,
    sheet_synced_at timestamp(3) without time zone,
    eta date,
    lifecycle text,
    description text,
    stock_zero_since timestamp with time zone,
    order_increment integer,
    weight_kg double precision,
    length_cm double precision,
    width_cm double precision,
    height_cm double precision,
    tags text[]
);


--
-- Name: product_has_stock(crm.products); Type: FUNCTION; Schema: crm; Owner: -
--

CREATE FUNCTION crm.product_has_stock(p crm.products) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
      select coalesce(p.available, 0) > 0 or coalesce(p.on_hand, 0) > 0 or coalesce(p.on_order, 0) > 0  or exists (
        select 1 from jsonb_array_elements(case when jsonb_typeof(p.locations::jsonb) = 'array' then p.locations::jsonb else '[]'::jsonb end) l
        where crm.safe_num(l->>'onHand') > 0 or crm.safe_num(l->>'available') > 0 or crm.safe_num(l->>'onOrder') > 0)
    $$;


--
-- Name: products_finish_eol(); Type: FUNCTION; Schema: crm; Owner: -
--

CREATE FUNCTION crm.products_finish_eol() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if crm.product_has_stock(new) then
    new.stock_zero_since := null;
  else
    new.stock_zero_since := coalesce(new.stock_zero_since, now());
  end if;
  if new.lifecycle = 'eol' and new.stock_zero_since is not null and new.stock_zero_since <= now() - crm.eol_grace() then
    new.lifecycle := 'discontinued';
    insert into crm.product_stage_log (sku, from_stage, to_stage, reason) values (new.sku, 'eol', 'discontinued', 'EOL and the stock is finished');
  end if;
  return new;
exception when others then
  raise warning 'crm.products_finish_eol skipped for %: %', new.sku, sqlerrm;
  return new;
end $$;


--
-- Name: reconcile_credit_reservations(); Type: FUNCTION; Schema: crm; Owner: -
--

CREATE FUNCTION crm.reconcile_credit_reservations() RETURNS integer
    LANGUAGE plpgsql
    AS $$
declare n2 integer := 0; rv record; hit record;
begin
  -- A similar amount of that credit note applied or paid back in DEAR
  for rv in
    select id, from_account_id, credit_no, amount, created_at, order_ref
    from crm.credit_reservations
    where status = 'reserved' and credit_no is not null
    order by created_at
  loop
    select k.key, k.used_on into hit
    from (
      select
        concat_ws('|', c->>'number', coalesce(al->>'invoice', 'refund'), al->>'amount', al->>'date') as key,
        nullif(al->>'date', '')::date as al_date,
        (select q2.number from crm.quotes q2
          where al->>'invoice' is not null
            and q2.invoices @> jsonb_build_array(jsonb_build_object('number', al->>'invoice')) limit 1) as used_on,
        abs(coalesce((al->>'amount')::numeric, 0) - rv.amount::numeric) as diff
      from crm.quotes cq
      cross join lateral jsonb_array_elements(cq.credit_notes) c
      cross join lateral jsonb_array_elements(coalesce(c->'allocations', '[]'::jsonb) || coalesce(c->'refundsPaid', '[]'::jsonb)) al
      where cq.account_id = rv.from_account_id and c->>'number' = rv.credit_no
    ) k
    where k.diff <= 1.00
      and (k.al_date is null or k.al_date >= ((rv.created_at at time zone 'UTC') at time zone 'Australia/Melbourne')::date)
      and not exists (select 1 from crm.credit_reservations o where o.matched_key = k.key and o.id <> rv.id)
    order by (upper(coalesce(rv.order_ref, '')) <> '' and k.used_on = upper(rv.order_ref)) desc, k.al_date asc nulls last
    limit 1;

    if found then
      update crm.credit_reservations
      set status = 'used', resolved_at = now(), resolved_by = null, used_on_order = hit.used_on, matched_key = hit.key
      where id = rv.id;
      n2 := n2 + 1;
    end if;
  end loop;

  return n2;
end $$;


--
-- Name: refresh_account_councils(); Type: FUNCTION; Schema: crm; Owner: -
--

CREATE FUNCTION crm.refresh_account_councils() RETURNS integer
    LANGUAGE plpgsql
    AS $$
declare n int;
begin
  with x as (select a.id, crm.address_postcode(a.address, a.region) as pc, a.region from crm.accounts a),
       y as (select x.id, x.pc, case when x.pc is null then null else crm.postcode_council(x.pc, x.region) end as council from x),
       u as (
         update crm.accounts a set postcode = y.pc, council = y.council from y
         where y.id = a.id and (a.postcode is distinct from y.pc or a.council is distinct from y.council)
         returning a.id)
  select count(*) into n from u;
  return n;
end $$;


--
-- Name: region_state(text); Type: FUNCTION; Schema: crm; Owner: -
--

CREATE FUNCTION crm.region_state(region text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $_$
  select case when region ~ '^(NSW|VIC|QLD|SA|WA|TAS|NT|ACT)(/.*)?$' then substring(region from '^[A-Z]+') end
$_$;


--
-- Name: safe_num(text); Type: FUNCTION; Schema: crm; Owner: -
--

CREATE FUNCTION crm.safe_num(t text) RETURNS numeric
    LANGUAGE plpgsql IMMUTABLE
    AS $$
begin
  return coalesce(t::numeric, 0);
exception when others then
  return 0;
end $$;


--
-- Name: _prisma_migrations; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm._prisma_migrations (
    id character varying(36) NOT NULL,
    checksum character varying(64) NOT NULL,
    finished_at timestamp with time zone,
    migration_name character varying(255) NOT NULL,
    logs text,
    rolled_back_at timestamp with time zone,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    applied_steps_count integer DEFAULT 0 NOT NULL
);


--
-- Name: abandoned_cart_lines; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.abandoned_cart_lines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    abandoned_at timestamp(3) without time zone NOT NULL,
    contact text NOT NULL,
    email text NOT NULL,
    product_name text NOT NULL,
    quantity double precision DEFAULT 0 NOT NULL,
    price double precision DEFAULT 0 NOT NULL,
    total double precision DEFAULT 0 NOT NULL,
    imported_at timestamp(3) without time zone DEFAULT now() NOT NULL
);


--
-- Name: abandoned_cart_logs; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.abandoned_cart_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    cart_key text NOT NULL,
    rep_id uuid NOT NULL,
    method text,
    note text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    activity_id uuid,
    CONSTRAINT abandoned_cart_logs_method_check CHECK ((method = ANY (ARRAY['note'::text, 'called'::text, 'emailed'::text, 'left_message'::text])))
);


--
-- Name: account_aliases; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.account_aliases (
    id bigint NOT NULL,
    account_id uuid NOT NULL,
    alias text NOT NULL,
    merged_from_id uuid,
    merged_by uuid,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: account_aliases_id_seq; Type: SEQUENCE; Schema: crm; Owner: -
--

CREATE SEQUENCE crm.account_aliases_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: account_aliases_id_seq; Type: SEQUENCE OWNED BY; Schema: crm; Owner: -
--

ALTER SEQUENCE crm.account_aliases_id_seq OWNED BY crm.account_aliases.id;


--
-- Name: account_merges; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.account_merges (
    id bigint NOT NULL,
    into_account_id uuid NOT NULL,
    from_account_id uuid NOT NULL,
    from_name text NOT NULL,
    from_dear_customer_id text,
    merged_by uuid,
    merged_at timestamp without time zone DEFAULT now() NOT NULL,
    moved jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: account_merges_id_seq; Type: SEQUENCE; Schema: crm; Owner: -
--

CREATE SEQUENCE crm.account_merges_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: account_merges_id_seq; Type: SEQUENCE OWNED BY; Schema: crm; Owner: -
--

ALTER SEQUENCE crm.account_merges_id_seq OWNED BY crm.account_merges.id;


--
-- Name: account_owner_moves; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.account_owner_moves (
    account_id uuid NOT NULL,
    from_rep_id uuid NOT NULL,
    to_rep_id uuid NOT NULL,
    moved_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: accounts; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.accounts (
    id uuid NOT NULL,
    name text NOT NULL,
    region text NOT NULL,
    rep_id uuid NOT NULL,
    credit crm."CreditTerm" NOT NULL,
    type crm."AccountType" DEFAULT 'prospect'::crm."AccountType" NOT NULL,
    stage crm."Stage" DEFAULT 'new_lead'::crm."Stage" NOT NULL,
    spend_30 double precision DEFAULT 0 NOT NULL,
    spend_90 double precision DEFAULT 0 NOT NULL,
    spend_365 double precision DEFAULT 0 NOT NULL,
    last_order_at timestamp(3) without time zone,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    contact_name text,
    email text,
    next_follow_up_at timestamp(3) without time zone,
    phone text,
    address text,
    dear_customer_id text,
    avg_order_gap_days integer,
    archived boolean DEFAULT false NOT NULL,
    category text,
    misc boolean DEFAULT false NOT NULL,
    needs_order_backfill boolean DEFAULT false NOT NULL,
    payment_terms text,
    reorder_gap_auto integer,
    reorder_gap_override integer,
    keep_archived boolean DEFAULT false NOT NULL,
    dear_linked_at timestamp with time zone,
    dear_created_at timestamp with time zone,
    skip_open_quotes boolean DEFAULT false NOT NULL,
    postcode text,
    council text
);


--
-- Name: quotes; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.quotes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    number text NOT NULL,
    amount double precision NOT NULL,
    sent_at timestamp(3) without time zone NOT NULL,
    paid boolean DEFAULT false NOT NULL,
    source text DEFAULT 'cin7'::text NOT NULL,
    synced_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    invoice_date timestamp(3) without time zone,
    fulfillment_status text,
    shipping_address text,
    shipping_company text,
    reference text,
    misc_type text,
    dear_sale_id text,
    invoice_number text,
    payment_status text,
    shipping_status text,
    order_contact text,
    order_email text,
    order_phone text,
    shipping_details jsonb,
    shipments jsonb DEFAULT '[]'::jsonb NOT NULL,
    tax_total double precision,
    total double precision,
    memo text,
    picking_status text,
    line_fulfilment jsonb DEFAULT '{}'::jsonb NOT NULL,
    fulfilments jsonb DEFAULT '[]'::jsonb NOT NULL,
    amount_paid double precision,
    invoices jsonb DEFAULT '[]'::jsonb NOT NULL,
    credit_notes jsonb DEFAULT '[]'::jsonb NOT NULL,
    invoiced_total double precision,
    credited_total double precision,
    amount_due double precision,
    unapplied_credit double precision,
    manual_paid boolean DEFAULT false NOT NULL,
    goods_total double precision,
    paid_at timestamp(3) without time zone,
    follow_up_at date,
    fu1_done_on date,
    fu2_done_on date,
    prepay_released_at timestamp with time zone,
    prepay_released_by uuid,
    prepay_release_note text,
    follow_up_rep_id uuid
);


--
-- Name: account_status; Type: VIEW; Schema: crm; Owner: -
--

CREATE VIEW crm.account_status AS
 WITH "real" AS (
         SELECT q.account_id,
            max(q.sent_at) AS last_real_order
           FROM crm.quotes q
          WHERE ((q.misc_type IS NULL) AND ((((q.source = 'rhino-history'::text) OR (q.number ~~ 'Q%'::text)) AND q.paid) OR ((q.source <> 'rhino-history'::text) AND (q.number !~~ 'Q%'::text) AND (upper(COALESCE(q.fulfillment_status, ''::text)) <> ALL (ARRAY['DRAFT'::text, 'ESTIMATING'::text, 'ESTIMATED'::text, 'ORDERING'::text, 'VOIDED'::text, 'CREDITED'::text])))))
          GROUP BY q.account_id
        )
 SELECT a.id AS account_id,
    GREATEST(r.last_real_order, a.last_order_at) AS last_order,
        CASE
            WHEN (GREATEST(r.last_real_order, a.last_order_at) IS NOT NULL) THEN
            CASE
                WHEN (GREATEST(r.last_real_order, a.last_order_at) >= (now() - '1 year'::interval)) THEN 'Active'::text
                ELSE 'Inactive'::text
            END
            WHEN (a.dear_customer_id IS NOT NULL) THEN 'New Lead'::text
            ELSE 'Prospect'::text
        END AS status
   FROM (crm.accounts a
     LEFT JOIN "real" r ON ((r.account_id = a.id)));


--
-- Name: accounts_flags_snapshot; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.accounts_flags_snapshot (
    id uuid,
    archived boolean,
    keep_archived boolean,
    taken_at timestamp with time zone
);


--
-- Name: activity; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.activity (
    id uuid NOT NULL,
    account_id uuid NOT NULL,
    rep_id uuid NOT NULL,
    type crm."ActivityType" NOT NULL,
    note text NOT NULL,
    photo_url text,
    occurred_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_at timestamp(3) without time zone DEFAULT now() NOT NULL,
    updated_at timestamp(3) without time zone,
    quote_id uuid
);


--
-- Name: ai_chats; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.ai_chats (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    rep_id uuid NOT NULL,
    title text DEFAULT 'New chat'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ai_files; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.ai_files (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    rep_id uuid NOT NULL,
    name text NOT NULL,
    mime text NOT NULL,
    data bytea NOT NULL,
    size integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ai_messages; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.ai_messages (
    id bigint NOT NULL,
    chat_id uuid NOT NULL,
    role text NOT NULL,
    content text NOT NULL,
    meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_messages_role_check CHECK ((role = ANY (ARRAY['user'::text, 'assistant'::text])))
);


--
-- Name: ai_messages_id_seq; Type: SEQUENCE; Schema: crm; Owner: -
--

CREATE SEQUENCE crm.ai_messages_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ai_messages_id_seq; Type: SEQUENCE OWNED BY; Schema: crm; Owner: -
--

ALTER SEQUENCE crm.ai_messages_id_seq OWNED BY crm.ai_messages.id;


--
-- Name: ai_prefs; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.ai_prefs (
    rep_id uuid NOT NULL,
    text text DEFAULT ''::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ai_settings; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.ai_settings (
    key text NOT NULL,
    value text NOT NULL,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ai_usage; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.ai_usage (
    id bigint NOT NULL,
    rep_id uuid,
    feature text NOT NULL,
    model text,
    input_tokens integer,
    output_tokens integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ai_usage_id_seq; Type: SEQUENCE; Schema: crm; Owner: -
--

CREATE SEQUENCE crm.ai_usage_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ai_usage_id_seq; Type: SEQUENCE OWNED BY; Schema: crm; Owner: -
--

ALTER SEQUENCE crm.ai_usage_id_seq OWNED BY crm.ai_usage.id;


--
-- Name: budget_months; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.budget_months (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    rep_id uuid NOT NULL,
    year integer NOT NULL,
    month integer NOT NULL,
    amount double precision NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT budget_months_amount_check CHECK ((amount >= (0)::double precision)),
    CONSTRAINT budget_months_month_check CHECK (((month >= 1) AND (month <= 12))),
    CONSTRAINT budget_months_year_check CHECK (((year >= 2000) AND (year <= 2100)))
);


--
-- Name: budget_targets; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.budget_targets (
    id uuid NOT NULL,
    "repId" uuid NOT NULL,
    year integer NOT NULL,
    quarter integer NOT NULL,
    amount double precision NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);


--
-- Name: calendar_connections; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.calendar_connections (
    rep_id uuid NOT NULL,
    email text NOT NULL,
    refresh_token_enc text NOT NULL,
    scope text,
    status text DEFAULT 'ok'::text NOT NULL,
    last_error text,
    connected_at timestamp(3) without time zone DEFAULT now() NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT now() NOT NULL
);


--
-- Name: calendar_events; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.calendar_events (
    rep_id uuid NOT NULL,
    key text NOT NULL,
    event_date date NOT NULL,
    google_event_id text NOT NULL,
    hash text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: credit_reservations; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.credit_reservations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    from_account_id uuid NOT NULL,
    to_account_id uuid NOT NULL,
    amount double precision NOT NULL,
    order_ref text,
    note text,
    status text DEFAULT 'reserved'::text NOT NULL,
    created_by uuid,
    created_at timestamp(3) without time zone DEFAULT now() NOT NULL,
    resolved_by uuid,
    resolved_at timestamp(3) without time zone,
    credit_no text,
    used_on_order text,
    name text,
    matched_key text,
    source_kind text DEFAULT 'credit_note'::text NOT NULL,
    source_order text,
    CONSTRAINT credit_reservations_amount_check CHECK ((amount > (0)::double precision)),
    CONSTRAINT credit_reservations_status_check CHECK ((status = ANY (ARRAY['reserved'::text, 'used'::text, 'cancelled'::text])))
);


--
-- Name: custom_reports; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.custom_reports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    rep_id uuid NOT NULL,
    name text NOT NULL,
    definition jsonb NOT NULL,
    shared boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: email_log; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.email_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    rep_id uuid NOT NULL,
    account_id uuid NOT NULL,
    gmail_message_id text NOT NULL,
    thread_id text NOT NULL,
    direction text NOT NULL,
    subject text,
    snippet text,
    from_addr text NOT NULL,
    to_addrs text[] DEFAULT '{}'::text[] NOT NULL,
    cc_addrs text[] DEFAULT '{}'::text[] NOT NULL,
    counterparty text NOT NULL,
    occurred_at timestamp(3) without time zone NOT NULL,
    created_at timestamp(3) without time zone DEFAULT now() NOT NULL,
    summary text,
    topic text,
    order_numbers text[] DEFAULT '{}'::text[] NOT NULL,
    ai_at timestamp with time zone
);


--
-- Name: eol_snapshots; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.eol_snapshots (
    report_key text NOT NULL,
    taken_on date NOT NULL,
    taken_by uuid,
    taken_at timestamp with time zone DEFAULT now() NOT NULL,
    data jsonb NOT NULL
);


--
-- Name: followup_draft_settings; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.followup_draft_settings (
    id integer DEFAULT 1 NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    mailbox_email text DEFAULT 'sales@rhinorhino.com.au'::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT followup_draft_settings_id_check CHECK ((id = 1))
);


--
-- Name: followup_drafts; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.followup_drafts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    quote_id uuid NOT NULL,
    kind text DEFAULT 'fu1'::text NOT NULL,
    quote_number text NOT NULL,
    customer text NOT NULL,
    to_addr text,
    status text NOT NULL,
    mailbox text,
    gmail_draft_id text,
    gmail_message_id text,
    error text,
    attempts integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT followup_drafts_status_check CHECK ((status = ANY (ARRAY['creating'::text, 'created'::text, 'failed'::text])))
);


--
-- Name: gmail_connections; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.gmail_connections (
    rep_id uuid NOT NULL,
    email text NOT NULL,
    refresh_token_enc text NOT NULL,
    scope text,
    logging_enabled boolean DEFAULT true NOT NULL,
    save_preview boolean DEFAULT true NOT NULL,
    status text DEFAULT 'ok'::text NOT NULL,
    last_error text,
    connected_at timestamp(3) without time zone DEFAULT now() NOT NULL,
    last_sync_at timestamp(3) without time zone,
    last_run_at timestamp(3) without time zone,
    updated_at timestamp(3) without time zone DEFAULT now() NOT NULL,
    ai_summaries boolean DEFAULT false NOT NULL
);


--
-- Name: gmail_seen; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.gmail_seen (
    rep_id uuid NOT NULL,
    message_id text NOT NULL,
    seen_at timestamp(3) without time zone DEFAULT now() NOT NULL
);


--
-- Name: marketing_automations; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.marketing_automations (
    key text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    template_id uuid,
    delay_hours integer DEFAULT 0 NOT NULL,
    repeat_days integer DEFAULT 0 NOT NULL,
    max_sends integer DEFAULT 1 NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT now() NOT NULL
);


--
-- Name: marketing_campaigns; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.marketing_campaigns (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    subject text DEFAULT ''::text NOT NULL,
    preview_text text DEFAULT ''::text NOT NULL,
    from_name text,
    reply_to text,
    template_id uuid,
    blocks jsonb DEFAULT '[]'::jsonb NOT NULL,
    audience jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    scheduled_at timestamp(3) without time zone,
    sent_at timestamp(3) without time zone,
    created_by uuid,
    is_demo boolean DEFAULT false NOT NULL,
    created_at timestamp(3) without time zone DEFAULT now() NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT now() NOT NULL
);


--
-- Name: marketing_contacts; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.marketing_contacts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    first_name text,
    last_name text,
    company text,
    account_id uuid,
    source text DEFAULT 'manual'::text NOT NULL,
    status text DEFAULT 'subscribed'::text NOT NULL,
    consent_note text,
    unsubscribed_at timestamp(3) without time zone,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    region text,
    contact_type text,
    is_demo boolean DEFAULT false NOT NULL,
    created_at timestamp(3) without time zone DEFAULT now() NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT now() NOT NULL
);


--
-- Name: marketing_events; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.marketing_events (
    id bigint NOT NULL,
    message_id uuid NOT NULL,
    type text NOT NULL,
    url text,
    occurred_at timestamp(3) without time zone DEFAULT now() NOT NULL
);


--
-- Name: marketing_events_id_seq; Type: SEQUENCE; Schema: crm; Owner: -
--

CREATE SEQUENCE crm.marketing_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: marketing_events_id_seq; Type: SEQUENCE OWNED BY; Schema: crm; Owner: -
--

ALTER SEQUENCE crm.marketing_events_id_seq OWNED BY crm.marketing_events.id;


--
-- Name: marketing_messages; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.marketing_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    campaign_id uuid,
    automation_key text,
    template_id uuid,
    contact_id uuid,
    email text NOT NULL,
    to_name text,
    subject text DEFAULT ''::text NOT NULL,
    context jsonb DEFAULT '{}'::jsonb NOT NULL,
    marketing boolean DEFAULT true NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    error text,
    token text DEFAULT replace((gen_random_uuid())::text, '-'::text, ''::text) NOT NULL,
    entity_key text,
    dedupe_key text,
    provider_id text,
    queued_at timestamp(3) without time zone DEFAULT now() NOT NULL,
    sent_at timestamp(3) without time zone,
    delivered_at timestamp(3) without time zone,
    opened_at timestamp(3) without time zone,
    open_count integer DEFAULT 0 NOT NULL,
    first_click_at timestamp(3) without time zone,
    click_count integer DEFAULT 0 NOT NULL,
    unsubscribed_at timestamp(3) without time zone,
    is_demo boolean DEFAULT false NOT NULL
);


--
-- Name: marketing_segments; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.marketing_segments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    filter jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp(3) without time zone DEFAULT now() NOT NULL
);


--
-- Name: marketing_settings; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.marketing_settings (
    key text NOT NULL,
    value jsonb NOT NULL
);


--
-- Name: marketing_suppressions; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.marketing_suppressions (
    email text NOT NULL,
    reason text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT now() NOT NULL
);


--
-- Name: marketing_templates; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.marketing_templates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    kind text DEFAULT 'campaign'::text NOT NULL,
    subject text DEFAULT ''::text NOT NULL,
    preview_text text DEFAULT ''::text NOT NULL,
    blocks jsonb DEFAULT '[]'::jsonb NOT NULL,
    builtin boolean DEFAULT false NOT NULL,
    created_by uuid,
    created_at timestamp(3) without time zone DEFAULT now() NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT now() NOT NULL
);


--
-- Name: postcode_councils; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.postcode_councils (
    postcode text NOT NULL,
    state text NOT NULL,
    council text NOT NULL,
    share numeric DEFAULT 1 NOT NULL,
    also_in text,
    CONSTRAINT postcode_councils_council_check CHECK ((length(btrim(council)) > 0)),
    CONSTRAINT postcode_councils_postcode_check CHECK ((postcode ~ '^[0-9]{4}$'::text)),
    CONSTRAINT postcode_councils_state_check CHECK ((state = ANY (ARRAY['NSW'::text, 'VIC'::text, 'QLD'::text, 'SA'::text, 'WA'::text, 'TAS'::text, 'NT'::text, 'ACT'::text])))
);


--
-- Name: TABLE postcode_councils; Type: COMMENT; Schema: crm; Owner: -
--

COMMENT ON TABLE crm.postcode_councils IS 'seeded-v1';


--
-- Name: product_costs; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.product_costs (
    sku text NOT NULL,
    average_cost double precision DEFAULT 0 NOT NULL,
    costing_method text,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: product_costs_removed_20261029; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.product_costs_removed_20261029 (
    sku text NOT NULL,
    average_cost double precision DEFAULT 0 NOT NULL,
    costing_method text,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: product_stage_log; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.product_stage_log (
    id bigint NOT NULL,
    sku text NOT NULL,
    from_stage text,
    to_stage text NOT NULL,
    reason text NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: product_stage_log_id_seq; Type: SEQUENCE; Schema: crm; Owner: -
--

CREATE SEQUENCE crm.product_stage_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: product_stage_log_id_seq; Type: SEQUENCE OWNED BY; Schema: crm; Owner: -
--

ALTER SEQUENCE crm.product_stage_log_id_seq OWNED BY crm.product_stage_log.id;


--
-- Name: product_statuses; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.product_statuses (
    key text NOT NULL,
    label text NOT NULL,
    meaning text,
    tone text DEFAULT 'neutral'::text NOT NULL,
    system boolean DEFAULT false NOT NULL,
    sort_order integer DEFAULT 100 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT product_statuses_key_check CHECK ((key ~ '^[a-z0-9_]{1,40}$'::text)),
    CONSTRAINT product_statuses_label_check CHECK (((length(btrim(label)) >= 1) AND (length(btrim(label)) <= 40))),
    CONSTRAINT product_statuses_tone_check CHECK ((tone = ANY (ARRAY['rust'::text, 'amber'::text, 'teal'::text, 'neutral'::text])))
);


--
-- Name: TABLE product_statuses; Type: COMMENT; Schema: crm; Owner: -
--

COMMENT ON TABLE crm.product_statuses IS 'seeded-v3';


--
-- Name: products_removed_20261029; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.products_removed_20261029 (
    sku text NOT NULL,
    dear_id text,
    name text NOT NULL,
    brand text,
    category text,
    uom text,
    status text,
    on_hand double precision DEFAULT 0 NOT NULL,
    allocated double precision DEFAULT 0 NOT NULL,
    available double precision DEFAULT 0 NOT NULL,
    on_order double precision DEFAULT 0 NOT NULL,
    locations jsonb DEFAULT '[]'::jsonb NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT now() NOT NULL,
    stock_synced_at timestamp(3) without time zone,
    prices jsonb DEFAULT '{}'::jsonb NOT NULL,
    barcode text,
    attributes jsonb DEFAULT '{}'::jsonb NOT NULL,
    image_url text,
    sheet_data jsonb DEFAULT '{}'::jsonb NOT NULL,
    sheet_synced_at timestamp(3) without time zone,
    eta date,
    lifecycle text,
    description text,
    stock_zero_since timestamp with time zone,
    order_increment integer,
    weight_kg double precision,
    length_cm double precision,
    width_cm double precision,
    height_cm double precision,
    tags text[]
);


--
-- Name: purchase_costs; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.purchase_costs (
    purchase_id text NOT NULL,
    sku text NOT NULL,
    unit_cost double precision,
    line_total double precision,
    currency text,
    base_currency text,
    currency_rate double precision
);


--
-- Name: purchase_lines; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.purchase_lines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    purchase_id text NOT NULL,
    sku text NOT NULL,
    product_name text NOT NULL,
    quantity_ordered double precision DEFAULT 0 NOT NULL,
    quantity_received double precision DEFAULT 0 NOT NULL,
    last_received_at timestamp(3) without time zone
);


--
-- Name: purchase_receipts; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.purchase_receipts (
    id bigint NOT NULL,
    purchase_id text NOT NULL,
    sku text NOT NULL,
    received_at timestamp without time zone NOT NULL,
    quantity double precision NOT NULL
);


--
-- Name: purchase_receipts_id_seq; Type: SEQUENCE; Schema: crm; Owner: -
--

CREATE SEQUENCE crm.purchase_receipts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: purchase_receipts_id_seq; Type: SEQUENCE OWNED BY; Schema: crm; Owner: -
--

ALTER SEQUENCE crm.purchase_receipts_id_seq OWNED BY crm.purchase_receipts.id;


--
-- Name: purchases; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.purchases (
    id text NOT NULL,
    number text,
    supplier text,
    status text,
    receiving_status text,
    order_date timestamp(3) without time zone,
    required_by timestamp(3) without time zone,
    synced_at timestamp(3) without time zone DEFAULT now() NOT NULL
);


--
-- Name: quote_lines; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.quote_lines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    quote_id uuid NOT NULL,
    sku text NOT NULL,
    product_name text NOT NULL,
    brand text,
    quantity double precision NOT NULL,
    unit_price double precision NOT NULL,
    line_total double precision NOT NULL,
    discount double precision DEFAULT 0 NOT NULL,
    tax double precision DEFAULT 0 NOT NULL
);


--
-- Name: remarks; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.remarks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    activity_id uuid,
    account_id uuid,
    quote_id uuid,
    rep_id uuid,
    author_name text NOT NULL,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone,
    CONSTRAINT remarks_author_name_check CHECK ((length(btrim(author_name)) > 0)),
    CONSTRAINT remarks_body_check CHECK (((length(btrim(body)) >= 1) AND (length(btrim(body)) <= 2000))),
    CONSTRAINT remarks_check CHECK ((num_nonnulls(activity_id, account_id, quote_id) = 1))
);


--
-- Name: rep_account_exclusions; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.rep_account_exclusions (
    rep_id uuid NOT NULL,
    account_id uuid NOT NULL,
    created_by uuid,
    created_at timestamp(3) without time zone DEFAULT now() NOT NULL
);


--
-- Name: rep_log_moves; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.rep_log_moves (
    id bigint NOT NULL,
    batch uuid NOT NULL,
    moved_at timestamp with time zone DEFAULT now() NOT NULL,
    tbl text NOT NULL,
    row_id text NOT NULL,
    from_rep uuid NOT NULL,
    to_rep uuid NOT NULL
);


--
-- Name: rep_log_moves_id_seq; Type: SEQUENCE; Schema: crm; Owner: -
--

CREATE SEQUENCE crm.rep_log_moves_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: rep_log_moves_id_seq; Type: SEQUENCE OWNED BY; Schema: crm; Owner: -
--

ALTER SEQUENCE crm.rep_log_moves_id_seq OWNED BY crm.rep_log_moves.id;


--
-- Name: rep_regions; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.rep_regions (
    id uuid NOT NULL,
    rep_id uuid NOT NULL,
    region text NOT NULL
);


--
-- Name: reps; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.reps (
    id uuid NOT NULL,
    name text NOT NULL,
    type crm."RepType" NOT NULL,
    role crm."RepRole" DEFAULT 'rep'::crm."RepRole" NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    daily_cold_call_limit integer DEFAULT 10 NOT NULL,
    daily_inactive_count integer DEFAULT 5 NOT NULL,
    daily_new_lead_count integer DEFAULT 5 NOT NULL,
    last_auto_plan_date date,
    calendar_sync boolean DEFAULT false NOT NULL,
    calendar_show boolean DEFAULT true NOT NULL,
    calendar_synced_at timestamp with time zone,
    calendar_error text,
    email text
);


--
-- Name: sale_returns; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.sale_returns (
    id bigint NOT NULL,
    quote_id uuid NOT NULL,
    credit_note text,
    sku text NOT NULL,
    quantity double precision NOT NULL,
    returned_at timestamp without time zone NOT NULL,
    location text
);


--
-- Name: sale_returns_id_seq; Type: SEQUENCE; Schema: crm; Owner: -
--

CREATE SEQUENCE crm.sale_returns_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sale_returns_id_seq; Type: SEQUENCE OWNED BY; Schema: crm; Owner: -
--

ALTER SEQUENCE crm.sale_returns_id_seq OWNED BY crm.sale_returns.id;


--
-- Name: sheet_activity_aliases; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.sheet_activity_aliases (
    sheet_key text NOT NULL,
    account_id uuid NOT NULL,
    source text DEFAULT 'auto'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: sheet_activity_import; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.sheet_activity_import (
    row_no integer NOT NULL,
    d date NOT NULL,
    customer text NOT NULL,
    log_type text NOT NULL,
    note text NOT NULL,
    order_no text,
    ellen_note text,
    rhonda_reply text,
    CONSTRAINT sheet_activity_import_log_type_check CHECK ((log_type = ANY (ARRAY['call'::text, 'email'::text, 'visit'::text, 'remark'::text])))
);


--
-- Name: sheet_activity_import_log; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.sheet_activity_import_log (
    activity_id uuid NOT NULL,
    row_no integer NOT NULL,
    kind text NOT NULL,
    inserted_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: stock_adjustment_lines; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.stock_adjustment_lines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    adjustment_id text NOT NULL,
    kind text NOT NULL,
    sku text NOT NULL,
    product_name text,
    quantity double precision,
    location text,
    received_date timestamp(3) without time zone,
    unit_cost double precision,
    raw jsonb
);


--
-- Name: stock_adjustment_lines_backup_20261027; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.stock_adjustment_lines_backup_20261027 (
    id uuid,
    quantity double precision
);


--
-- Name: stock_adjustments; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.stock_adjustments (
    id text NOT NULL,
    number text,
    status text,
    effective_date timestamp(3) without time zone,
    reference text,
    comment text,
    synced_at timestamp(3) without time zone DEFAULT now() NOT NULL
);


--
-- Name: sync_state; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.sync_state (
    key text NOT NULL,
    last_synced_at timestamp(3) without time zone NOT NULL,
    last_id text
);


--
-- Name: tasks; Type: TABLE; Schema: crm; Owner: -
--

CREATE TABLE crm.tasks (
    id uuid NOT NULL,
    "repId" uuid NOT NULL,
    "accountId" uuid NOT NULL,
    type crm."TaskType" NOT NULL,
    scheduled_date date NOT NULL,
    fixed boolean DEFAULT false NOT NULL,
    completed boolean DEFAULT false NOT NULL,
    completed_at timestamp(3) without time zone,
    note text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    reason text
);


--
-- Name: account_aliases id; Type: DEFAULT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.account_aliases ALTER COLUMN id SET DEFAULT nextval('crm.account_aliases_id_seq'::regclass);


--
-- Name: account_merges id; Type: DEFAULT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.account_merges ALTER COLUMN id SET DEFAULT nextval('crm.account_merges_id_seq'::regclass);


--
-- Name: ai_messages id; Type: DEFAULT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.ai_messages ALTER COLUMN id SET DEFAULT nextval('crm.ai_messages_id_seq'::regclass);


--
-- Name: ai_usage id; Type: DEFAULT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.ai_usage ALTER COLUMN id SET DEFAULT nextval('crm.ai_usage_id_seq'::regclass);


--
-- Name: marketing_events id; Type: DEFAULT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.marketing_events ALTER COLUMN id SET DEFAULT nextval('crm.marketing_events_id_seq'::regclass);


--
-- Name: product_stage_log id; Type: DEFAULT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.product_stage_log ALTER COLUMN id SET DEFAULT nextval('crm.product_stage_log_id_seq'::regclass);


--
-- Name: purchase_receipts id; Type: DEFAULT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.purchase_receipts ALTER COLUMN id SET DEFAULT nextval('crm.purchase_receipts_id_seq'::regclass);


--
-- Name: rep_log_moves id; Type: DEFAULT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.rep_log_moves ALTER COLUMN id SET DEFAULT nextval('crm.rep_log_moves_id_seq'::regclass);


--
-- Name: sale_returns id; Type: DEFAULT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.sale_returns ALTER COLUMN id SET DEFAULT nextval('crm.sale_returns_id_seq'::regclass);


--
-- Name: _prisma_migrations _prisma_migrations_pkey; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm._prisma_migrations
    ADD CONSTRAINT _prisma_migrations_pkey PRIMARY KEY (id);


--
-- Name: abandoned_cart_lines abandoned_cart_lines_abandoned_at_email_product_name_key; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.abandoned_cart_lines
    ADD CONSTRAINT abandoned_cart_lines_abandoned_at_email_product_name_key UNIQUE (abandoned_at, email, product_name);


--
-- Name: abandoned_cart_lines abandoned_cart_lines_pkey; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.abandoned_cart_lines
    ADD CONSTRAINT abandoned_cart_lines_pkey PRIMARY KEY (id);


--
-- Name: abandoned_cart_logs abandoned_cart_logs_pkey; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.abandoned_cart_logs
    ADD CONSTRAINT abandoned_cart_logs_pkey PRIMARY KEY (id);


--
-- Name: account_aliases account_aliases_pkey; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.account_aliases
    ADD CONSTRAINT account_aliases_pkey PRIMARY KEY (id);


--
-- Name: account_merges account_merges_pkey; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.account_merges
    ADD CONSTRAINT account_merges_pkey PRIMARY KEY (id);


--
-- Name: account_owner_moves account_owner_moves_pkey; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.account_owner_moves
    ADD CONSTRAINT account_owner_moves_pkey PRIMARY KEY (account_id, moved_at);


--
-- Name: accounts accounts_pkey; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.accounts
    ADD CONSTRAINT accounts_pkey PRIMARY KEY (id);


--
-- Name: activity activity_pkey; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.activity
    ADD CONSTRAINT activity_pkey PRIMARY KEY (id);


--
-- Name: ai_chats ai_chats_pkey; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.ai_chats
    ADD CONSTRAINT ai_chats_pkey PRIMARY KEY (id);


--
-- Name: ai_files ai_files_pkey; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.ai_files
    ADD CONSTRAINT ai_files_pkey PRIMARY KEY (id);


--
-- Name: ai_messages ai_messages_pkey; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.ai_messages
    ADD CONSTRAINT ai_messages_pkey PRIMARY KEY (id);


--
-- Name: ai_prefs ai_prefs_pkey; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.ai_prefs
    ADD CONSTRAINT ai_prefs_pkey PRIMARY KEY (rep_id);


--
-- Name: ai_settings ai_settings_pkey; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.ai_settings
    ADD CONSTRAINT ai_settings_pkey PRIMARY KEY (key);


--
-- Name: ai_usage ai_usage_pkey; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.ai_usage
    ADD CONSTRAINT ai_usage_pkey PRIMARY KEY (id);


--
-- Name: budget_months budget_months_pkey; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.budget_months
    ADD CONSTRAINT budget_months_pkey PRIMARY KEY (id);


--
-- Name: budget_months budget_months_rep_id_year_month_key; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.budget_months
    ADD CONSTRAINT budget_months_rep_id_year_month_key UNIQUE (rep_id, year, month);


--
-- Name: budget_targets budget_targets_pkey; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.budget_targets
    ADD CONSTRAINT budget_targets_pkey PRIMARY KEY (id);


--
-- Name: calendar_connections calendar_connections_pkey; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.calendar_connections
    ADD CONSTRAINT calendar_connections_pkey PRIMARY KEY (rep_id);


--
-- Name: calendar_events calendar_events_pkey; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.calendar_events
    ADD CONSTRAINT calendar_events_pkey PRIMARY KEY (rep_id, key);


--
-- Name: credit_reservations credit_reservations_pkey; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.credit_reservations
    ADD CONSTRAINT credit_reservations_pkey PRIMARY KEY (id);


--
-- Name: custom_reports custom_reports_pkey; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.custom_reports
    ADD CONSTRAINT custom_reports_pkey PRIMARY KEY (id);


--
-- Name: email_log email_log_pkey; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.email_log
    ADD CONSTRAINT email_log_pkey PRIMARY KEY (id);


--
-- Name: eol_snapshots eol_snapshots_pkey; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.eol_snapshots
    ADD CONSTRAINT eol_snapshots_pkey PRIMARY KEY (report_key, taken_on);


--
-- Name: followup_draft_settings followup_draft_settings_pkey; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.followup_draft_settings
    ADD CONSTRAINT followup_draft_settings_pkey PRIMARY KEY (id);


--
-- Name: followup_drafts followup_drafts_pkey; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.followup_drafts
    ADD CONSTRAINT followup_drafts_pkey PRIMARY KEY (id);


--
-- Name: followup_drafts followup_drafts_quote_id_kind_key; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.followup_drafts
    ADD CONSTRAINT followup_drafts_quote_id_kind_key UNIQUE (quote_id, kind);


--
-- Name: gmail_connections gmail_connections_pkey; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.gmail_connections
    ADD CONSTRAINT gmail_connections_pkey PRIMARY KEY (rep_id);


--
-- Name: gmail_seen gmail_seen_pkey; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.gmail_seen
    ADD CONSTRAINT gmail_seen_pkey PRIMARY KEY (rep_id, message_id);


--
-- Name: marketing_automations marketing_automations_pkey; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.marketing_automations
    ADD CONSTRAINT marketing_automations_pkey PRIMARY KEY (key);


--
-- Name: marketing_campaigns marketing_campaigns_pkey; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.marketing_campaigns
    ADD CONSTRAINT marketing_campaigns_pkey PRIMARY KEY (id);


--
-- Name: marketing_contacts marketing_contacts_pkey; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.marketing_contacts
    ADD CONSTRAINT marketing_contacts_pkey PRIMARY KEY (id);


--
-- Name: marketing_events marketing_events_pkey; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.marketing_events
    ADD CONSTRAINT marketing_events_pkey PRIMARY KEY (id);


--
-- Name: marketing_messages marketing_messages_pkey; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.marketing_messages
    ADD CONSTRAINT marketing_messages_pkey PRIMARY KEY (id);


--
-- Name: marketing_segments marketing_segments_pkey; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.marketing_segments
    ADD CONSTRAINT marketing_segments_pkey PRIMARY KEY (id);


--
-- Name: marketing_settings marketing_settings_pkey; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.marketing_settings
    ADD CONSTRAINT marketing_settings_pkey PRIMARY KEY (key);


--
-- Name: marketing_suppressions marketing_suppressions_pkey; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.marketing_suppressions
    ADD CONSTRAINT marketing_suppressions_pkey PRIMARY KEY (email);


--
-- Name: marketing_templates marketing_templates_pkey; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.marketing_templates
    ADD CONSTRAINT marketing_templates_pkey PRIMARY KEY (id);


--
-- Name: postcode_councils postcode_councils_pkey; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.postcode_councils
    ADD CONSTRAINT postcode_councils_pkey PRIMARY KEY (postcode, state);


--
-- Name: product_costs product_costs_pkey; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.product_costs
    ADD CONSTRAINT product_costs_pkey PRIMARY KEY (sku);


--
-- Name: product_costs_removed_20261029 product_costs_removed_20261029_pkey; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.product_costs_removed_20261029
    ADD CONSTRAINT product_costs_removed_20261029_pkey PRIMARY KEY (sku);


--
-- Name: product_stage_log product_stage_log_pkey; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.product_stage_log
    ADD CONSTRAINT product_stage_log_pkey PRIMARY KEY (id);


--
-- Name: product_statuses product_statuses_pkey; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.product_statuses
    ADD CONSTRAINT product_statuses_pkey PRIMARY KEY (key);


--
-- Name: products products_pkey; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.products
    ADD CONSTRAINT products_pkey PRIMARY KEY (sku);


--
-- Name: products_removed_20261029 products_removed_20261029_pkey; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.products_removed_20261029
    ADD CONSTRAINT products_removed_20261029_pkey PRIMARY KEY (sku);


--
-- Name: purchase_costs purchase_costs_pkey; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.purchase_costs
    ADD CONSTRAINT purchase_costs_pkey PRIMARY KEY (purchase_id, sku);


--
-- Name: purchase_lines purchase_lines_pkey; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.purchase_lines
    ADD CONSTRAINT purchase_lines_pkey PRIMARY KEY (id);


--
-- Name: purchase_receipts purchase_receipts_pkey; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.purchase_receipts
    ADD CONSTRAINT purchase_receipts_pkey PRIMARY KEY (id);


--
-- Name: purchases purchases_pkey; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.purchases
    ADD CONSTRAINT purchases_pkey PRIMARY KEY (id);


--
-- Name: quote_lines quote_lines_pkey; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.quote_lines
    ADD CONSTRAINT quote_lines_pkey PRIMARY KEY (id);


--
-- Name: quotes quotes_pkey; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.quotes
    ADD CONSTRAINT quotes_pkey PRIMARY KEY (id);


--
-- Name: remarks remarks_pkey; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.remarks
    ADD CONSTRAINT remarks_pkey PRIMARY KEY (id);


--
-- Name: rep_account_exclusions rep_account_exclusions_pkey; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.rep_account_exclusions
    ADD CONSTRAINT rep_account_exclusions_pkey PRIMARY KEY (rep_id, account_id);


--
-- Name: rep_log_moves rep_log_moves_pkey; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.rep_log_moves
    ADD CONSTRAINT rep_log_moves_pkey PRIMARY KEY (id);


--
-- Name: rep_regions rep_regions_pkey; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.rep_regions
    ADD CONSTRAINT rep_regions_pkey PRIMARY KEY (id);


--
-- Name: reps reps_pkey; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.reps
    ADD CONSTRAINT reps_pkey PRIMARY KEY (id);


--
-- Name: sale_returns sale_returns_pkey; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.sale_returns
    ADD CONSTRAINT sale_returns_pkey PRIMARY KEY (id);


--
-- Name: sheet_activity_aliases sheet_activity_aliases_pkey; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.sheet_activity_aliases
    ADD CONSTRAINT sheet_activity_aliases_pkey PRIMARY KEY (sheet_key);


--
-- Name: sheet_activity_import_log sheet_activity_import_log_pkey; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.sheet_activity_import_log
    ADD CONSTRAINT sheet_activity_import_log_pkey PRIMARY KEY (activity_id);


--
-- Name: sheet_activity_import sheet_activity_import_pkey; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.sheet_activity_import
    ADD CONSTRAINT sheet_activity_import_pkey PRIMARY KEY (row_no);


--
-- Name: stock_adjustment_lines stock_adjustment_lines_pkey; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.stock_adjustment_lines
    ADD CONSTRAINT stock_adjustment_lines_pkey PRIMARY KEY (id);


--
-- Name: stock_adjustments stock_adjustments_pkey; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.stock_adjustments
    ADD CONSTRAINT stock_adjustments_pkey PRIMARY KEY (id);


--
-- Name: sync_state sync_state_pkey; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.sync_state
    ADD CONSTRAINT sync_state_pkey PRIMARY KEY (key);


--
-- Name: tasks tasks_pkey; Type: CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.tasks
    ADD CONSTRAINT tasks_pkey PRIMARY KEY (id);


--
-- Name: abandoned_cart_lines_at_idx; Type: INDEX; Schema: crm; Owner: -
--

CREATE INDEX abandoned_cart_lines_at_idx ON crm.abandoned_cart_lines USING btree (abandoned_at DESC);


--
-- Name: abandoned_cart_logs_activity_id_idx; Type: INDEX; Schema: crm; Owner: -
--

CREATE INDEX abandoned_cart_logs_activity_id_idx ON crm.abandoned_cart_logs USING btree (activity_id);


--
-- Name: abandoned_cart_logs_cart; Type: INDEX; Schema: crm; Owner: -
--

CREATE INDEX abandoned_cart_logs_cart ON crm.abandoned_cart_logs USING btree (cart_key, created_at DESC);


--
-- Name: account_aliases_one_per_name; Type: INDEX; Schema: crm; Owner: -
--

CREATE UNIQUE INDEX account_aliases_one_per_name ON crm.account_aliases USING btree (account_id, lower(alias));


--
-- Name: account_merges_into_idx; Type: INDEX; Schema: crm; Owner: -
--

CREATE INDEX account_merges_into_idx ON crm.account_merges USING btree (into_account_id);


--
-- Name: accounts_council_idx; Type: INDEX; Schema: crm; Owner: -
--

CREATE INDEX accounts_council_idx ON crm.accounts USING btree (council);


--
-- Name: accounts_dear_customer_id_key; Type: INDEX; Schema: crm; Owner: -
--

CREATE UNIQUE INDEX accounts_dear_customer_id_key ON crm.accounts USING btree (dear_customer_id);


--
-- Name: activity_logged_idx; Type: INDEX; Schema: crm; Owner: -
--

CREATE INDEX activity_logged_idx ON crm.activity USING btree (GREATEST(created_at, COALESCE(updated_at, created_at)) DESC);


--
-- Name: activity_quote_idx; Type: INDEX; Schema: crm; Owner: -
--

CREATE INDEX activity_quote_idx ON crm.activity USING btree (quote_id) WHERE (quote_id IS NOT NULL);


--
-- Name: ai_chats_rep; Type: INDEX; Schema: crm; Owner: -
--

CREATE INDEX ai_chats_rep ON crm.ai_chats USING btree (rep_id, updated_at DESC);


--
-- Name: ai_files_rep; Type: INDEX; Schema: crm; Owner: -
--

CREATE INDEX ai_files_rep ON crm.ai_files USING btree (rep_id, created_at);


--
-- Name: ai_messages_chat; Type: INDEX; Schema: crm; Owner: -
--

CREATE INDEX ai_messages_chat ON crm.ai_messages USING btree (chat_id, id);


--
-- Name: budget_targets_repId_year_quarter_key; Type: INDEX; Schema: crm; Owner: -
--

CREATE UNIQUE INDEX "budget_targets_repId_year_quarter_key" ON crm.budget_targets USING btree ("repId", year, quarter);


--
-- Name: calendar_events_rep_date; Type: INDEX; Schema: crm; Owner: -
--

CREATE INDEX calendar_events_rep_date ON crm.calendar_events USING btree (rep_id, event_date);


--
-- Name: credit_reservations_credit_no_idx; Type: INDEX; Schema: crm; Owner: -
--

CREATE INDEX credit_reservations_credit_no_idx ON crm.credit_reservations USING btree (credit_no) WHERE (status = 'reserved'::text);


--
-- Name: credit_reservations_from_idx; Type: INDEX; Schema: crm; Owner: -
--

CREATE INDEX credit_reservations_from_idx ON crm.credit_reservations USING btree (from_account_id, status);


--
-- Name: credit_reservations_source_order_idx; Type: INDEX; Schema: crm; Owner: -
--

CREATE INDEX credit_reservations_source_order_idx ON crm.credit_reservations USING btree (source_order) WHERE (source_kind = 'prepayment'::text);


--
-- Name: credit_reservations_to_idx; Type: INDEX; Schema: crm; Owner: -
--

CREATE INDEX credit_reservations_to_idx ON crm.credit_reservations USING btree (to_account_id, status);


--
-- Name: email_log_account_idx; Type: INDEX; Schema: crm; Owner: -
--

CREATE INDEX email_log_account_idx ON crm.email_log USING btree (account_id, occurred_at DESC);


--
-- Name: email_log_ai_pending_idx; Type: INDEX; Schema: crm; Owner: -
--

CREATE INDEX email_log_ai_pending_idx ON crm.email_log USING btree (rep_id, occurred_at DESC) WHERE (ai_at IS NULL);


--
-- Name: email_log_order_numbers_idx; Type: INDEX; Schema: crm; Owner: -
--

CREATE INDEX email_log_order_numbers_idx ON crm.email_log USING gin (order_numbers);


--
-- Name: email_log_unique; Type: INDEX; Schema: crm; Owner: -
--

CREATE UNIQUE INDEX email_log_unique ON crm.email_log USING btree (rep_id, gmail_message_id, account_id);


--
-- Name: followup_drafts_recent_idx; Type: INDEX; Schema: crm; Owner: -
--

CREATE INDEX followup_drafts_recent_idx ON crm.followup_drafts USING btree (created_at DESC);


--
-- Name: marketing_contacts_account_idx; Type: INDEX; Schema: crm; Owner: -
--

CREATE INDEX marketing_contacts_account_idx ON crm.marketing_contacts USING btree (account_id);


--
-- Name: marketing_contacts_email_key; Type: INDEX; Schema: crm; Owner: -
--

CREATE UNIQUE INDEX marketing_contacts_email_key ON crm.marketing_contacts USING btree (lower(email));


--
-- Name: marketing_contacts_tags_idx; Type: INDEX; Schema: crm; Owner: -
--

CREATE INDEX marketing_contacts_tags_idx ON crm.marketing_contacts USING gin (tags);


--
-- Name: marketing_events_message_idx; Type: INDEX; Schema: crm; Owner: -
--

CREATE INDEX marketing_events_message_idx ON crm.marketing_events USING btree (message_id);


--
-- Name: marketing_events_type_idx; Type: INDEX; Schema: crm; Owner: -
--

CREATE INDEX marketing_events_type_idx ON crm.marketing_events USING btree (type, occurred_at);


--
-- Name: marketing_messages_campaign_contact; Type: INDEX; Schema: crm; Owner: -
--

CREATE UNIQUE INDEX marketing_messages_campaign_contact ON crm.marketing_messages USING btree (campaign_id, contact_id) WHERE ((campaign_id IS NOT NULL) AND (contact_id IS NOT NULL));


--
-- Name: marketing_messages_dedupe; Type: INDEX; Schema: crm; Owner: -
--

CREATE UNIQUE INDEX marketing_messages_dedupe ON crm.marketing_messages USING btree (dedupe_key) WHERE (dedupe_key IS NOT NULL);


--
-- Name: marketing_messages_entity_idx; Type: INDEX; Schema: crm; Owner: -
--

CREATE INDEX marketing_messages_entity_idx ON crm.marketing_messages USING btree (entity_key);


--
-- Name: marketing_messages_sent_idx; Type: INDEX; Schema: crm; Owner: -
--

CREATE INDEX marketing_messages_sent_idx ON crm.marketing_messages USING btree (sent_at);


--
-- Name: marketing_messages_status_idx; Type: INDEX; Schema: crm; Owner: -
--

CREATE INDEX marketing_messages_status_idx ON crm.marketing_messages USING btree (status, queued_at);


--
-- Name: marketing_messages_token_key; Type: INDEX; Schema: crm; Owner: -
--

CREATE UNIQUE INDEX marketing_messages_token_key ON crm.marketing_messages USING btree (token);


--
-- Name: product_stage_log_sku; Type: INDEX; Schema: crm; Owner: -
--

CREATE INDEX product_stage_log_sku ON crm.product_stage_log USING btree (sku, at DESC);


--
-- Name: product_statuses_label_ci; Type: INDEX; Schema: crm; Owner: -
--

CREATE UNIQUE INDEX product_statuses_label_ci ON crm.product_statuses USING btree (lower(btrim(label)));


--
-- Name: products_brand_trgm; Type: INDEX; Schema: crm; Owner: -
--

CREATE INDEX products_brand_trgm ON crm.products USING gin (brand public.gin_trgm_ops);


--
-- Name: products_name_trgm; Type: INDEX; Schema: crm; Owner: -
--

CREATE INDEX products_name_trgm ON crm.products USING gin (name public.gin_trgm_ops);


--
-- Name: products_removed_20261029_brand_idx; Type: INDEX; Schema: crm; Owner: -
--

CREATE INDEX products_removed_20261029_brand_idx ON crm.products_removed_20261029 USING gin (brand public.gin_trgm_ops);


--
-- Name: products_removed_20261029_name_idx; Type: INDEX; Schema: crm; Owner: -
--

CREATE INDEX products_removed_20261029_name_idx ON crm.products_removed_20261029 USING gin (name public.gin_trgm_ops);


--
-- Name: products_removed_20261029_sku_idx; Type: INDEX; Schema: crm; Owner: -
--

CREATE INDEX products_removed_20261029_sku_idx ON crm.products_removed_20261029 USING gin (sku public.gin_trgm_ops);


--
-- Name: products_removed_20261029_tags_idx; Type: INDEX; Schema: crm; Owner: -
--

CREATE INDEX products_removed_20261029_tags_idx ON crm.products_removed_20261029 USING gin (tags);


--
-- Name: products_sku_trgm; Type: INDEX; Schema: crm; Owner: -
--

CREATE INDEX products_sku_trgm ON crm.products USING gin (sku public.gin_trgm_ops);


--
-- Name: products_tags_gin; Type: INDEX; Schema: crm; Owner: -
--

CREATE INDEX products_tags_gin ON crm.products USING gin (tags);


--
-- Name: purchase_lines_purchase_idx; Type: INDEX; Schema: crm; Owner: -
--

CREATE INDEX purchase_lines_purchase_idx ON crm.purchase_lines USING btree (purchase_id);


--
-- Name: purchase_lines_sku_idx; Type: INDEX; Schema: crm; Owner: -
--

CREATE INDEX purchase_lines_sku_idx ON crm.purchase_lines USING btree (sku);


--
-- Name: purchase_receipts_purchase_idx; Type: INDEX; Schema: crm; Owner: -
--

CREATE INDEX purchase_receipts_purchase_idx ON crm.purchase_receipts USING btree (purchase_id);


--
-- Name: purchase_receipts_received_at_idx; Type: INDEX; Schema: crm; Owner: -
--

CREATE INDEX purchase_receipts_received_at_idx ON crm.purchase_receipts USING btree (received_at);


--
-- Name: purchases_status_idx; Type: INDEX; Schema: crm; Owner: -
--

CREATE INDEX purchases_status_idx ON crm.purchases USING btree (status);


--
-- Name: quote_lines_quote_id_idx; Type: INDEX; Schema: crm; Owner: -
--

CREATE INDEX quote_lines_quote_id_idx ON crm.quote_lines USING btree (quote_id);


--
-- Name: quote_lines_quote_idx; Type: INDEX; Schema: crm; Owner: -
--

CREATE INDEX quote_lines_quote_idx ON crm.quote_lines USING btree (quote_id);


--
-- Name: quote_lines_sku_idx; Type: INDEX; Schema: crm; Owner: -
--

CREATE INDEX quote_lines_sku_idx ON crm.quote_lines USING btree (sku);


--
-- Name: quotes_account_id_idx; Type: INDEX; Schema: crm; Owner: -
--

CREATE INDEX quotes_account_id_idx ON crm.quotes USING btree (account_id);


--
-- Name: quotes_account_id_misc_type_idx; Type: INDEX; Schema: crm; Owner: -
--

CREATE INDEX quotes_account_id_misc_type_idx ON crm.quotes USING btree (account_id, misc_type);


--
-- Name: quotes_account_id_source_idx; Type: INDEX; Schema: crm; Owner: -
--

CREATE INDEX quotes_account_id_source_idx ON crm.quotes USING btree (account_id, source);


--
-- Name: quotes_follow_up_rep; Type: INDEX; Schema: crm; Owner: -
--

CREATE INDEX quotes_follow_up_rep ON crm.quotes USING btree (follow_up_rep_id) WHERE (follow_up_rep_id IS NOT NULL);


--
-- Name: quotes_invoice_trgm; Type: INDEX; Schema: crm; Owner: -
--

CREATE INDEX quotes_invoice_trgm ON crm.quotes USING gin (invoice_number public.gin_trgm_ops);


--
-- Name: quotes_number_key; Type: INDEX; Schema: crm; Owner: -
--

CREATE UNIQUE INDEX quotes_number_key ON crm.quotes USING btree (number);


--
-- Name: quotes_number_trgm; Type: INDEX; Schema: crm; Owner: -
--

CREATE INDEX quotes_number_trgm ON crm.quotes USING gin (number public.gin_trgm_ops);


--
-- Name: quotes_reference_trgm; Type: INDEX; Schema: crm; Owner: -
--

CREATE INDEX quotes_reference_trgm ON crm.quotes USING gin (reference public.gin_trgm_ops);


--
-- Name: quotes_sent_at_idx; Type: INDEX; Schema: crm; Owner: -
--

CREATE INDEX quotes_sent_at_idx ON crm.quotes USING btree (sent_at DESC);


--
-- Name: quotes_ship_company_trgm; Type: INDEX; Schema: crm; Owner: -
--

CREATE INDEX quotes_ship_company_trgm ON crm.quotes USING gin (shipping_company public.gin_trgm_ops);


--
-- Name: remarks_account_idx; Type: INDEX; Schema: crm; Owner: -
--

CREATE INDEX remarks_account_idx ON crm.remarks USING btree (account_id, created_at) WHERE (account_id IS NOT NULL);


--
-- Name: remarks_activity_idx; Type: INDEX; Schema: crm; Owner: -
--

CREATE INDEX remarks_activity_idx ON crm.remarks USING btree (activity_id, created_at) WHERE (activity_id IS NOT NULL);


--
-- Name: remarks_quote_idx; Type: INDEX; Schema: crm; Owner: -
--

CREATE INDEX remarks_quote_idx ON crm.remarks USING btree (quote_id, created_at) WHERE (quote_id IS NOT NULL);


--
-- Name: rep_account_exclusions_account_idx; Type: INDEX; Schema: crm; Owner: -
--

CREATE INDEX rep_account_exclusions_account_idx ON crm.rep_account_exclusions USING btree (account_id);


--
-- Name: rep_regions_rep_id_region_key; Type: INDEX; Schema: crm; Owner: -
--

CREATE UNIQUE INDEX rep_regions_rep_id_region_key ON crm.rep_regions USING btree (rep_id, region);


--
-- Name: sale_returns_quote_idx; Type: INDEX; Schema: crm; Owner: -
--

CREATE INDEX sale_returns_quote_idx ON crm.sale_returns USING btree (quote_id);


--
-- Name: sale_returns_returned_at_idx; Type: INDEX; Schema: crm; Owner: -
--

CREATE INDEX sale_returns_returned_at_idx ON crm.sale_returns USING btree (returned_at);


--
-- Name: stock_adjustment_lines_adj_idx; Type: INDEX; Schema: crm; Owner: -
--

CREATE INDEX stock_adjustment_lines_adj_idx ON crm.stock_adjustment_lines USING btree (adjustment_id);


--
-- Name: stock_adjustment_lines_sku_idx; Type: INDEX; Schema: crm; Owner: -
--

CREATE INDEX stock_adjustment_lines_sku_idx ON crm.stock_adjustment_lines USING btree (sku);


--
-- Name: accounts accounts_default_owner; Type: TRIGGER; Schema: crm; Owner: -
--

CREATE TRIGGER accounts_default_owner BEFORE INSERT OR UPDATE OF rep_id ON crm.accounts FOR EACH ROW EXECUTE FUNCTION crm.accounts_default_owner();


--
-- Name: accounts accounts_note_dear_link; Type: TRIGGER; Schema: crm; Owner: -
--

CREATE TRIGGER accounts_note_dear_link BEFORE UPDATE OF dear_customer_id ON crm.accounts FOR EACH ROW EXECUTE FUNCTION crm.note_dear_link();


--
-- Name: accounts accounts_set_council; Type: TRIGGER; Schema: crm; Owner: -
--

CREATE TRIGGER accounts_set_council BEFORE INSERT OR UPDATE OF address, region ON crm.accounts FOR EACH ROW EXECUTE FUNCTION crm.accounts_set_council();


--
-- Name: products products_finish_eol; Type: TRIGGER; Schema: crm; Owner: -
--

CREATE TRIGGER products_finish_eol BEFORE INSERT OR UPDATE ON crm.products FOR EACH ROW EXECUTE FUNCTION crm.products_finish_eol();


--
-- Name: quotes quotes_fill_invoice_date; Type: TRIGGER; Schema: crm; Owner: -
--

CREATE TRIGGER quotes_fill_invoice_date BEFORE INSERT OR UPDATE ON crm.quotes FOR EACH ROW EXECUTE FUNCTION crm.fill_invoice_date();


--
-- Name: abandoned_cart_logs abandoned_cart_logs_activity_id_fkey; Type: FK CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.abandoned_cart_logs
    ADD CONSTRAINT abandoned_cart_logs_activity_id_fkey FOREIGN KEY (activity_id) REFERENCES crm.activity(id) ON DELETE SET NULL;


--
-- Name: account_aliases account_aliases_account_id_fkey; Type: FK CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.account_aliases
    ADD CONSTRAINT account_aliases_account_id_fkey FOREIGN KEY (account_id) REFERENCES crm.accounts(id) ON DELETE CASCADE;


--
-- Name: account_owner_moves account_owner_moves_account_id_fkey; Type: FK CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.account_owner_moves
    ADD CONSTRAINT account_owner_moves_account_id_fkey FOREIGN KEY (account_id) REFERENCES crm.accounts(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: accounts accounts_rep_id_fkey; Type: FK CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.accounts
    ADD CONSTRAINT accounts_rep_id_fkey FOREIGN KEY (rep_id) REFERENCES crm.reps(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: activity activity_account_id_fkey; Type: FK CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.activity
    ADD CONSTRAINT activity_account_id_fkey FOREIGN KEY (account_id) REFERENCES crm.accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: activity activity_quote_id_fkey; Type: FK CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.activity
    ADD CONSTRAINT activity_quote_id_fkey FOREIGN KEY (quote_id) REFERENCES crm.quotes(id) ON DELETE SET NULL;


--
-- Name: activity activity_rep_id_fkey; Type: FK CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.activity
    ADD CONSTRAINT activity_rep_id_fkey FOREIGN KEY (rep_id) REFERENCES crm.reps(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: ai_messages ai_messages_chat_id_fkey; Type: FK CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.ai_messages
    ADD CONSTRAINT ai_messages_chat_id_fkey FOREIGN KEY (chat_id) REFERENCES crm.ai_chats(id) ON DELETE CASCADE;


--
-- Name: budget_months budget_months_rep_id_fkey; Type: FK CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.budget_months
    ADD CONSTRAINT budget_months_rep_id_fkey FOREIGN KEY (rep_id) REFERENCES crm.reps(id) ON DELETE CASCADE;


--
-- Name: budget_targets budget_targets_repId_fkey; Type: FK CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.budget_targets
    ADD CONSTRAINT "budget_targets_repId_fkey" FOREIGN KEY ("repId") REFERENCES crm.reps(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: calendar_connections calendar_connections_rep_id_fkey; Type: FK CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.calendar_connections
    ADD CONSTRAINT calendar_connections_rep_id_fkey FOREIGN KEY (rep_id) REFERENCES crm.reps(id) ON DELETE CASCADE;


--
-- Name: calendar_events calendar_events_rep_id_fkey; Type: FK CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.calendar_events
    ADD CONSTRAINT calendar_events_rep_id_fkey FOREIGN KEY (rep_id) REFERENCES crm.reps(id) ON DELETE CASCADE;


--
-- Name: credit_reservations credit_reservations_created_by_fkey; Type: FK CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.credit_reservations
    ADD CONSTRAINT credit_reservations_created_by_fkey FOREIGN KEY (created_by) REFERENCES crm.reps(id);


--
-- Name: credit_reservations credit_reservations_from_account_id_fkey; Type: FK CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.credit_reservations
    ADD CONSTRAINT credit_reservations_from_account_id_fkey FOREIGN KEY (from_account_id) REFERENCES crm.accounts(id);


--
-- Name: credit_reservations credit_reservations_resolved_by_fkey; Type: FK CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.credit_reservations
    ADD CONSTRAINT credit_reservations_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES crm.reps(id);


--
-- Name: credit_reservations credit_reservations_to_account_id_fkey; Type: FK CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.credit_reservations
    ADD CONSTRAINT credit_reservations_to_account_id_fkey FOREIGN KEY (to_account_id) REFERENCES crm.accounts(id);


--
-- Name: email_log email_log_account_id_fkey; Type: FK CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.email_log
    ADD CONSTRAINT email_log_account_id_fkey FOREIGN KEY (account_id) REFERENCES crm.accounts(id) ON DELETE CASCADE;


--
-- Name: email_log email_log_rep_id_fkey; Type: FK CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.email_log
    ADD CONSTRAINT email_log_rep_id_fkey FOREIGN KEY (rep_id) REFERENCES crm.reps(id) ON DELETE CASCADE;


--
-- Name: followup_drafts followup_drafts_quote_id_fkey; Type: FK CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.followup_drafts
    ADD CONSTRAINT followup_drafts_quote_id_fkey FOREIGN KEY (quote_id) REFERENCES crm.quotes(id) ON DELETE CASCADE;


--
-- Name: gmail_connections gmail_connections_rep_id_fkey; Type: FK CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.gmail_connections
    ADD CONSTRAINT gmail_connections_rep_id_fkey FOREIGN KEY (rep_id) REFERENCES crm.reps(id) ON DELETE CASCADE;


--
-- Name: gmail_seen gmail_seen_rep_id_fkey; Type: FK CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.gmail_seen
    ADD CONSTRAINT gmail_seen_rep_id_fkey FOREIGN KEY (rep_id) REFERENCES crm.reps(id) ON DELETE CASCADE;


--
-- Name: marketing_contacts marketing_contacts_account_id_fkey; Type: FK CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.marketing_contacts
    ADD CONSTRAINT marketing_contacts_account_id_fkey FOREIGN KEY (account_id) REFERENCES crm.accounts(id) ON DELETE SET NULL;


--
-- Name: marketing_events marketing_events_message_id_fkey; Type: FK CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.marketing_events
    ADD CONSTRAINT marketing_events_message_id_fkey FOREIGN KEY (message_id) REFERENCES crm.marketing_messages(id) ON DELETE CASCADE;


--
-- Name: marketing_messages marketing_messages_campaign_id_fkey; Type: FK CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.marketing_messages
    ADD CONSTRAINT marketing_messages_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES crm.marketing_campaigns(id) ON DELETE CASCADE;


--
-- Name: marketing_messages marketing_messages_contact_id_fkey; Type: FK CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.marketing_messages
    ADD CONSTRAINT marketing_messages_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES crm.marketing_contacts(id) ON DELETE SET NULL;


--
-- Name: products products_lifecycle_fkey; Type: FK CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.products
    ADD CONSTRAINT products_lifecycle_fkey FOREIGN KEY (lifecycle) REFERENCES crm.product_statuses(key) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: purchase_costs purchase_costs_purchase_id_fkey; Type: FK CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.purchase_costs
    ADD CONSTRAINT purchase_costs_purchase_id_fkey FOREIGN KEY (purchase_id) REFERENCES crm.purchases(id) ON DELETE CASCADE;


--
-- Name: purchase_lines purchase_lines_purchase_id_fkey; Type: FK CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.purchase_lines
    ADD CONSTRAINT purchase_lines_purchase_id_fkey FOREIGN KEY (purchase_id) REFERENCES crm.purchases(id) ON DELETE CASCADE;


--
-- Name: purchase_receipts purchase_receipts_purchase_id_fkey; Type: FK CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.purchase_receipts
    ADD CONSTRAINT purchase_receipts_purchase_id_fkey FOREIGN KEY (purchase_id) REFERENCES crm.purchases(id) ON DELETE CASCADE;


--
-- Name: quote_lines quote_lines_quote_id_fkey; Type: FK CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.quote_lines
    ADD CONSTRAINT quote_lines_quote_id_fkey FOREIGN KEY (quote_id) REFERENCES crm.quotes(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: quotes quotes_account_id_fkey; Type: FK CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.quotes
    ADD CONSTRAINT quotes_account_id_fkey FOREIGN KEY (account_id) REFERENCES crm.accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: quotes quotes_follow_up_rep_id_fkey; Type: FK CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.quotes
    ADD CONSTRAINT quotes_follow_up_rep_id_fkey FOREIGN KEY (follow_up_rep_id) REFERENCES crm.reps(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: remarks remarks_account_id_fkey; Type: FK CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.remarks
    ADD CONSTRAINT remarks_account_id_fkey FOREIGN KEY (account_id) REFERENCES crm.accounts(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: remarks remarks_activity_id_fkey; Type: FK CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.remarks
    ADD CONSTRAINT remarks_activity_id_fkey FOREIGN KEY (activity_id) REFERENCES crm.activity(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: remarks remarks_quote_id_fkey; Type: FK CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.remarks
    ADD CONSTRAINT remarks_quote_id_fkey FOREIGN KEY (quote_id) REFERENCES crm.quotes(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: remarks remarks_rep_id_fkey; Type: FK CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.remarks
    ADD CONSTRAINT remarks_rep_id_fkey FOREIGN KEY (rep_id) REFERENCES crm.reps(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: rep_account_exclusions rep_account_exclusions_account_id_fkey; Type: FK CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.rep_account_exclusions
    ADD CONSTRAINT rep_account_exclusions_account_id_fkey FOREIGN KEY (account_id) REFERENCES crm.accounts(id) ON DELETE CASCADE;


--
-- Name: rep_account_exclusions rep_account_exclusions_created_by_fkey; Type: FK CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.rep_account_exclusions
    ADD CONSTRAINT rep_account_exclusions_created_by_fkey FOREIGN KEY (created_by) REFERENCES crm.reps(id);


--
-- Name: rep_account_exclusions rep_account_exclusions_rep_id_fkey; Type: FK CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.rep_account_exclusions
    ADD CONSTRAINT rep_account_exclusions_rep_id_fkey FOREIGN KEY (rep_id) REFERENCES crm.reps(id) ON DELETE CASCADE;


--
-- Name: rep_regions rep_regions_rep_id_fkey; Type: FK CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.rep_regions
    ADD CONSTRAINT rep_regions_rep_id_fkey FOREIGN KEY (rep_id) REFERENCES crm.reps(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: sale_returns sale_returns_quote_id_fkey; Type: FK CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.sale_returns
    ADD CONSTRAINT sale_returns_quote_id_fkey FOREIGN KEY (quote_id) REFERENCES crm.quotes(id) ON DELETE CASCADE;


--
-- Name: sheet_activity_aliases sheet_activity_aliases_account_id_fkey; Type: FK CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.sheet_activity_aliases
    ADD CONSTRAINT sheet_activity_aliases_account_id_fkey FOREIGN KEY (account_id) REFERENCES crm.accounts(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: stock_adjustment_lines stock_adjustment_lines_adjustment_id_fkey; Type: FK CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.stock_adjustment_lines
    ADD CONSTRAINT stock_adjustment_lines_adjustment_id_fkey FOREIGN KEY (adjustment_id) REFERENCES crm.stock_adjustments(id) ON DELETE CASCADE;


--
-- Name: tasks tasks_accountId_fkey; Type: FK CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.tasks
    ADD CONSTRAINT "tasks_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES crm.accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: tasks tasks_repId_fkey; Type: FK CONSTRAINT; Schema: crm; Owner: -
--

ALTER TABLE ONLY crm.tasks
    ADD CONSTRAINT "tasks_repId_fkey" FOREIGN KEY ("repId") REFERENCES crm.reps(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: abandoned_cart_lines; Type: ROW SECURITY; Schema: crm; Owner: -
--

ALTER TABLE crm.abandoned_cart_lines ENABLE ROW LEVEL SECURITY;

--
-- Name: abandoned_cart_logs; Type: ROW SECURITY; Schema: crm; Owner: -
--

ALTER TABLE crm.abandoned_cart_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: account_aliases; Type: ROW SECURITY; Schema: crm; Owner: -
--

ALTER TABLE crm.account_aliases ENABLE ROW LEVEL SECURITY;

--
-- Name: account_merges; Type: ROW SECURITY; Schema: crm; Owner: -
--

ALTER TABLE crm.account_merges ENABLE ROW LEVEL SECURITY;

--
-- Name: account_owner_moves; Type: ROW SECURITY; Schema: crm; Owner: -
--

ALTER TABLE crm.account_owner_moves ENABLE ROW LEVEL SECURITY;

--
-- Name: accounts; Type: ROW SECURITY; Schema: crm; Owner: -
--

ALTER TABLE crm.accounts ENABLE ROW LEVEL SECURITY;

--
-- Name: accounts_flags_snapshot; Type: ROW SECURITY; Schema: crm; Owner: -
--

ALTER TABLE crm.accounts_flags_snapshot ENABLE ROW LEVEL SECURITY;

--
-- Name: accounts accounts_select; Type: POLICY; Schema: crm; Owner: -
--

CREATE POLICY accounts_select ON crm.accounts FOR SELECT USING (((rep_id = auth.uid()) OR crm.is_manager()));


--
-- Name: accounts accounts_write; Type: POLICY; Schema: crm; Owner: -
--

CREATE POLICY accounts_write ON crm.accounts USING (((rep_id = auth.uid()) OR crm.is_manager()));


--
-- Name: activity; Type: ROW SECURITY; Schema: crm; Owner: -
--

ALTER TABLE crm.activity ENABLE ROW LEVEL SECURITY;

--
-- Name: activity activity_select; Type: POLICY; Schema: crm; Owner: -
--

CREATE POLICY activity_select ON crm.activity FOR SELECT USING (((rep_id = auth.uid()) OR crm.is_manager() OR (EXISTS ( SELECT 1
   FROM crm.accounts a
  WHERE ((a.id = activity.account_id) AND (a.rep_id = auth.uid()))))));


--
-- Name: activity activity_write; Type: POLICY; Schema: crm; Owner: -
--

CREATE POLICY activity_write ON crm.activity FOR INSERT WITH CHECK (((rep_id = auth.uid()) OR crm.is_manager()));


--
-- Name: ai_chats; Type: ROW SECURITY; Schema: crm; Owner: -
--

ALTER TABLE crm.ai_chats ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_files; Type: ROW SECURITY; Schema: crm; Owner: -
--

ALTER TABLE crm.ai_files ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_messages; Type: ROW SECURITY; Schema: crm; Owner: -
--

ALTER TABLE crm.ai_messages ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_prefs; Type: ROW SECURITY; Schema: crm; Owner: -
--

ALTER TABLE crm.ai_prefs ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_settings; Type: ROW SECURITY; Schema: crm; Owner: -
--

ALTER TABLE crm.ai_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_usage; Type: ROW SECURITY; Schema: crm; Owner: -
--

ALTER TABLE crm.ai_usage ENABLE ROW LEVEL SECURITY;

--
-- Name: budget_months; Type: ROW SECURITY; Schema: crm; Owner: -
--

ALTER TABLE crm.budget_months ENABLE ROW LEVEL SECURITY;

--
-- Name: calendar_connections; Type: ROW SECURITY; Schema: crm; Owner: -
--

ALTER TABLE crm.calendar_connections ENABLE ROW LEVEL SECURITY;

--
-- Name: calendar_events; Type: ROW SECURITY; Schema: crm; Owner: -
--

ALTER TABLE crm.calendar_events ENABLE ROW LEVEL SECURITY;

--
-- Name: credit_reservations; Type: ROW SECURITY; Schema: crm; Owner: -
--

ALTER TABLE crm.credit_reservations ENABLE ROW LEVEL SECURITY;

--
-- Name: custom_reports; Type: ROW SECURITY; Schema: crm; Owner: -
--

ALTER TABLE crm.custom_reports ENABLE ROW LEVEL SECURITY;

--
-- Name: email_log; Type: ROW SECURITY; Schema: crm; Owner: -
--

ALTER TABLE crm.email_log ENABLE ROW LEVEL SECURITY;

--
-- Name: eol_snapshots; Type: ROW SECURITY; Schema: crm; Owner: -
--

ALTER TABLE crm.eol_snapshots ENABLE ROW LEVEL SECURITY;

--
-- Name: followup_draft_settings; Type: ROW SECURITY; Schema: crm; Owner: -
--

ALTER TABLE crm.followup_draft_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: followup_drafts; Type: ROW SECURITY; Schema: crm; Owner: -
--

ALTER TABLE crm.followup_drafts ENABLE ROW LEVEL SECURITY;

--
-- Name: gmail_connections; Type: ROW SECURITY; Schema: crm; Owner: -
--

ALTER TABLE crm.gmail_connections ENABLE ROW LEVEL SECURITY;

--
-- Name: gmail_seen; Type: ROW SECURITY; Schema: crm; Owner: -
--

ALTER TABLE crm.gmail_seen ENABLE ROW LEVEL SECURITY;

--
-- Name: marketing_automations; Type: ROW SECURITY; Schema: crm; Owner: -
--

ALTER TABLE crm.marketing_automations ENABLE ROW LEVEL SECURITY;

--
-- Name: marketing_campaigns; Type: ROW SECURITY; Schema: crm; Owner: -
--

ALTER TABLE crm.marketing_campaigns ENABLE ROW LEVEL SECURITY;

--
-- Name: marketing_contacts; Type: ROW SECURITY; Schema: crm; Owner: -
--

ALTER TABLE crm.marketing_contacts ENABLE ROW LEVEL SECURITY;

--
-- Name: marketing_events; Type: ROW SECURITY; Schema: crm; Owner: -
--

ALTER TABLE crm.marketing_events ENABLE ROW LEVEL SECURITY;

--
-- Name: marketing_messages; Type: ROW SECURITY; Schema: crm; Owner: -
--

ALTER TABLE crm.marketing_messages ENABLE ROW LEVEL SECURITY;

--
-- Name: marketing_segments; Type: ROW SECURITY; Schema: crm; Owner: -
--

ALTER TABLE crm.marketing_segments ENABLE ROW LEVEL SECURITY;

--
-- Name: marketing_settings; Type: ROW SECURITY; Schema: crm; Owner: -
--

ALTER TABLE crm.marketing_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: marketing_suppressions; Type: ROW SECURITY; Schema: crm; Owner: -
--

ALTER TABLE crm.marketing_suppressions ENABLE ROW LEVEL SECURITY;

--
-- Name: marketing_templates; Type: ROW SECURITY; Schema: crm; Owner: -
--

ALTER TABLE crm.marketing_templates ENABLE ROW LEVEL SECURITY;

--
-- Name: postcode_councils; Type: ROW SECURITY; Schema: crm; Owner: -
--

ALTER TABLE crm.postcode_councils ENABLE ROW LEVEL SECURITY;

--
-- Name: product_costs; Type: ROW SECURITY; Schema: crm; Owner: -
--

ALTER TABLE crm.product_costs ENABLE ROW LEVEL SECURITY;

--
-- Name: product_costs_removed_20261029; Type: ROW SECURITY; Schema: crm; Owner: -
--

ALTER TABLE crm.product_costs_removed_20261029 ENABLE ROW LEVEL SECURITY;

--
-- Name: product_stage_log; Type: ROW SECURITY; Schema: crm; Owner: -
--

ALTER TABLE crm.product_stage_log ENABLE ROW LEVEL SECURITY;

--
-- Name: product_statuses; Type: ROW SECURITY; Schema: crm; Owner: -
--

ALTER TABLE crm.product_statuses ENABLE ROW LEVEL SECURITY;

--
-- Name: products; Type: ROW SECURITY; Schema: crm; Owner: -
--

ALTER TABLE crm.products ENABLE ROW LEVEL SECURITY;

--
-- Name: products_removed_20261029; Type: ROW SECURITY; Schema: crm; Owner: -
--

ALTER TABLE crm.products_removed_20261029 ENABLE ROW LEVEL SECURITY;

--
-- Name: purchase_costs; Type: ROW SECURITY; Schema: crm; Owner: -
--

ALTER TABLE crm.purchase_costs ENABLE ROW LEVEL SECURITY;

--
-- Name: purchase_lines; Type: ROW SECURITY; Schema: crm; Owner: -
--

ALTER TABLE crm.purchase_lines ENABLE ROW LEVEL SECURITY;

--
-- Name: purchase_receipts; Type: ROW SECURITY; Schema: crm; Owner: -
--

ALTER TABLE crm.purchase_receipts ENABLE ROW LEVEL SECURITY;

--
-- Name: purchases; Type: ROW SECURITY; Schema: crm; Owner: -
--

ALTER TABLE crm.purchases ENABLE ROW LEVEL SECURITY;

--
-- Name: quotes; Type: ROW SECURITY; Schema: crm; Owner: -
--

ALTER TABLE crm.quotes ENABLE ROW LEVEL SECURITY;

--
-- Name: quotes quotes_select; Type: POLICY; Schema: crm; Owner: -
--

CREATE POLICY quotes_select ON crm.quotes FOR SELECT USING ((crm.is_manager() OR (EXISTS ( SELECT 1
   FROM crm.accounts a
  WHERE ((a.id = quotes.account_id) AND (a.rep_id = auth.uid()))))));


--
-- Name: remarks; Type: ROW SECURITY; Schema: crm; Owner: -
--

ALTER TABLE crm.remarks ENABLE ROW LEVEL SECURITY;

--
-- Name: rep_account_exclusions; Type: ROW SECURITY; Schema: crm; Owner: -
--

ALTER TABLE crm.rep_account_exclusions ENABLE ROW LEVEL SECURITY;

--
-- Name: rep_log_moves; Type: ROW SECURITY; Schema: crm; Owner: -
--

ALTER TABLE crm.rep_log_moves ENABLE ROW LEVEL SECURITY;

--
-- Name: reps; Type: ROW SECURITY; Schema: crm; Owner: -
--

ALTER TABLE crm.reps ENABLE ROW LEVEL SECURITY;

--
-- Name: reps reps_select_all; Type: POLICY; Schema: crm; Owner: -
--

CREATE POLICY reps_select_all ON crm.reps FOR SELECT USING (true);


--
-- Name: reps reps_write_manager; Type: POLICY; Schema: crm; Owner: -
--

CREATE POLICY reps_write_manager ON crm.reps USING (crm.is_manager());


--
-- Name: sale_returns; Type: ROW SECURITY; Schema: crm; Owner: -
--

ALTER TABLE crm.sale_returns ENABLE ROW LEVEL SECURITY;

--
-- Name: sheet_activity_aliases; Type: ROW SECURITY; Schema: crm; Owner: -
--

ALTER TABLE crm.sheet_activity_aliases ENABLE ROW LEVEL SECURITY;

--
-- Name: sheet_activity_import; Type: ROW SECURITY; Schema: crm; Owner: -
--

ALTER TABLE crm.sheet_activity_import ENABLE ROW LEVEL SECURITY;

--
-- Name: sheet_activity_import_log; Type: ROW SECURITY; Schema: crm; Owner: -
--

ALTER TABLE crm.sheet_activity_import_log ENABLE ROW LEVEL SECURITY;

--
-- Name: stock_adjustment_lines; Type: ROW SECURITY; Schema: crm; Owner: -
--

ALTER TABLE crm.stock_adjustment_lines ENABLE ROW LEVEL SECURITY;

--
-- Name: stock_adjustment_lines_backup_20261027; Type: ROW SECURITY; Schema: crm; Owner: -
--

ALTER TABLE crm.stock_adjustment_lines_backup_20261027 ENABLE ROW LEVEL SECURITY;

--
-- Name: stock_adjustments; Type: ROW SECURITY; Schema: crm; Owner: -
--

ALTER TABLE crm.stock_adjustments ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--


