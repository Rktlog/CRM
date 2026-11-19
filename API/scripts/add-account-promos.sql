-- PROMOS GIVEN TO A CUSTOMER: adds one new, empty table, crm.account_promos.
-- It changes nothing in any existing table and copies or moves no rows, so there is nothing to back up. The backup step in the house rules does
-- not apply; the guard below checks that the new table starts empty and that the promos tables it depends on are there.
--
-- Who runs it: Sushan, never a contributor. Run it on the SANDBOX first, then on the live database, BEFORE the pull request that uses it is merged.
-- (Without the table the customer's Promos box shows an error and the Promos page cannot load.)
--
-- STEP 1, PREVIEW (changes nothing). Run only the select below. Expect:
--   promos_table        crm.promos            (if empty, the promos tables are missing: add them first)
--   order_promos_table  crm.order_promos      (the same)
--   new_table           empty                 (if it says crm.account_promos, this file was already run: stop)
--   accounts_table      crm.accounts
--   reps_table          crm.reps
select to_regclass('crm.promos')         as promos_table,
       to_regclass('crm.order_promos')   as order_promos_table,
       to_regclass('crm.account_promos') as new_table,
       to_regclass('crm.accounts')       as accounts_table,
       to_regclass('crm.reps')           as reps_table;

-- STEP 2, RUN the rest of the file in one go. It is one transaction: if any check fails, nothing is kept.
begin;

do $$
begin
  if to_regclass('crm.promos') is null or to_regclass('crm.order_promos') is null then
    raise exception 'The promos tables (crm.promos, crm.order_promos) are missing. Add them first. Nothing was changed.';
  end if;
  if to_regclass('crm.account_promos') is not null then
    raise exception 'crm.account_promos already exists, so this file was already run. Nothing was changed.';
  end if;
end $$;

-- One row per promo given to a customer. qty is how many were given; empty means no set number.
-- Allocations to the customer's orders stay in crm.order_promos, as before.
create table crm.account_promos (
  id          uuid primary key default gen_random_uuid(),
  promo_id    uuid not null references crm.promos(id) on delete restrict,
  account_id  uuid not null references crm.accounts(id) on delete cascade,
  qty         integer check (qty is null or qty between 1 and 9999),
  rep_id      uuid references crm.reps(id) on delete set null,
  created_at  timestamptz not null default now(),
  unique (promo_id, account_id)
);
create index account_promos_account_id_idx on crm.account_promos (account_id);

-- Row security on, the same as every other crm table.
alter table crm.account_promos enable row level security;

-- GUARD: the new table must start empty.
do $$
declare n integer;
begin
  select count(*) into n from crm.account_promos;
  if n <> 0 then raise exception 'crm.account_promos should be empty but has % rows. Nothing was changed.', n; end if;
end $$;

commit;

-- STEP 3, CHECK (changes nothing). Expect one row: account_promos, 0 rows.
select 'account_promos' as table_name, count(*) as rows from crm.account_promos;
