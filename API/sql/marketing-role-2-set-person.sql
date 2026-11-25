-- Marketing login, STEP 2 of 2: make ONE sign-in user a marketing login in Radar.
--
-- RUN STEP 1 FIRST, in a separate run.
-- WHAT THIS DOES: for one person, who must already exist as a sign-in user (Supabase, Authentication, Users):
--   - if Radar has no row for them yet, it adds one with the role marketing (signing in does NOT add a row: Radar refuses anyone without one)
--   - if Radar has a row and they are a rep, it saves a backup of the old role and changes it to marketing
--   - if they are a manager it refuses, and changes nothing
-- It stops with an error, changing nothing, unless exactly 1 sign-in user has that email.
--
-- 1. Replace the two lines marked <-- in the first block of the DO section (their sign-in email, and the name to show in Radar). Run the whole file.
-- 2. To undo: see the last lines of this file.

-- 1. PREVIEW (reads only): the sign-in user, and their Radar row if they have one. Put the same email here.
select u.id, u.email, r.name, r.role::text as role_now from auth.users u left join crm.reps r on r.id = u.id where lower(u.email) = lower('PUT-THEIR-EMAIL-HERE@example.com');

-- 2. BACKUP, THEN THE CHANGE, with a guard.
create table if not exists crm.reps_role_backup_marketing (id uuid primary key, role_before text, changed_at timestamptz not null default now());

do $$
declare
  who  text := lower('PUT-THEIR-EMAIL-HERE@example.com');   -- <-- their sign-in email
  nm   text := 'Marketing';                                   -- <-- the name to show in Radar (only used if they have no row yet)
  uid  uuid;
  n    int;
  have crm.reps%rowtype;
begin
  select count(*) into n from auth.users where lower(email) = who;
  if n <> 1 then raise exception 'Expected exactly 1 sign-in user with that email, found %. Nothing was changed.', n; end if;
  select id into uid from auth.users where lower(email) = who;
  select * into have from crm.reps where id = uid;
  if not found then
    insert into crm.reps_role_backup_marketing (id, role_before) values (uid, null) on conflict (id) do nothing;   -- null means "had no row"
    insert into crm.reps (id, name, type, role, email) values (uid, nm, 'remote', 'marketing', who);
  else
    if have.role::text = 'manager' then raise exception 'That person is a manager. A manager is not changed to marketing by this file. Nothing was changed.'; end if;
    insert into crm.reps_role_backup_marketing (id, role_before) values (uid, have.role::text) on conflict (id) do nothing;
    update crm.reps set role = 'marketing' where id = uid;
  end if;
end $$;

-- 3. CHECK (reads only): expect that person, with role marketing.
select id, name, email, role::text as role_now from crm.reps where lower(email) = lower('PUT-THEIR-EMAIL-HERE@example.com');

-- TO UNDO (run only if needed). A person who had a row goes back to their old role:
--   update crm.reps r set role = b.role_before::crm."RepRole" from crm.reps_role_backup_marketing b where r.id = b.id and b.role_before is not null and r.id = '<their id>';
-- A person who had no row before: delete their row only if they have done nothing in Radar yet:
--   delete from crm.reps where id = '<their id>' and id in (select id from crm.reps_role_backup_marketing where role_before is null);
-- Radar remembers a person's role for up to a minute, so a change shows within a minute.
