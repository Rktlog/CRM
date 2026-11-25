-- Marketing login, STEP 2 of 2: make ONE person a marketing login.
--
-- RUN STEP 1 FIRST, in a separate run.
-- WHAT THIS DOES: changes the "role" of exactly one person in crm.reps to marketing. It keeps a backup of that row first, and stops without changing
-- anything unless exactly 1 person matches. It does not change their name, their territory or anything they have done.
-- The person must have signed in to Radar at least once, so that their row exists (the email below is the one they sign in with).
--
-- 1. Put their sign-in email on the line below (it appears once, in the first block), and run the whole file.
-- 2. To undo: the old role is saved in crm.reps_role_backup_marketing. See the last lines of this file.

-- 1. PREVIEW (reads only): who would be changed. Expect exactly 1 row.
select id, name, email, role::text as role_now from crm.reps where lower(email) = lower('PUT-THEIR-EMAIL-HERE@example.com');

-- 2. BACKUP, THEN THE CHANGE, with a guard: if the number of people is not exactly 1, it raises an error and nothing changes.
create table if not exists crm.reps_role_backup_marketing (id uuid primary key, role_before text not null, changed_at timestamptz not null default now());

do $$
declare
  who text := lower('PUT-THEIR-EMAIL-HERE@example.com');
  n int;
begin
  select count(*) into n from crm.reps where lower(email) = who;
  if n <> 1 then raise exception 'Expected exactly 1 person with that email, found %. Nothing was changed.', n; end if;
  if exists (select 1 from crm.reps where lower(email) = who and role::text = 'manager') then
    raise exception 'That person is a manager. A manager is not changed to marketing by this file. Nothing was changed.';
  end if;
  insert into crm.reps_role_backup_marketing (id, role_before) select id, role::text from crm.reps where lower(email) = who on conflict (id) do nothing;
  update crm.reps set role = 'marketing' where lower(email) = who;
end $$;

-- 3. CHECK (reads only): expect that person, with role marketing.
select id, name, email, role::text as role_now from crm.reps where lower(email) = lower('PUT-THEIR-EMAIL-HERE@example.com');

-- TO UNDO (run only if needed):
--   update crm.reps r set role = b.role_before::crm."RepRole" from crm.reps_role_backup_marketing b where r.id = b.id;
-- Radar remembers a person's role for up to a minute, so a change shows within a minute.
