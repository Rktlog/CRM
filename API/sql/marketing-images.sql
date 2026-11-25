-- Email Builder: pictures uploaded from a computer.
--
-- WHAT THIS DOES: adds ONE NEW TABLE. It does not change, move or delete anything that exists. Safe to run twice.
-- WHO RUNS IT: Sushan, in the Supabase SQL editor, on the SANDBOX first, then live. Run each numbered step on its own.
--
--   crm.marketing_images   one row per uploaded picture (the picture itself, up to 2.5 MB, is kept in the row).
--                          Radar shows it from /m/img/<id>. The id is a long random code, so a picture can only be seen by someone who has its address,
--                          which is how an email program fetches it.
--
-- Radar works without this table (the upload button says it needs set-up), so it is safe to deploy first.
-- Row level security is switched on with no policies, so nothing can read it through Supabase's public API. Radar's API reads it as the owner.

-- 1. PREVIEW (reads only): does the table exist yet?
select to_regclass('crm.marketing_images') as table_before;

-- 2. THE TABLE
create table if not exists crm.marketing_images (
  id           uuid primary key default gen_random_uuid(),
  content_type text not null check (content_type in ('image/jpeg', 'image/png', 'image/webp')),
  bytes        bytea not null check (octet_length(bytes) between 1 and 2500000),
  name         text,
  created_by   uuid,
  created_at   timestamptz not null default now()
);
alter table crm.marketing_images enable row level security;

-- 3. CHECK: the table exists and starts empty (0 rows).
select count(*) as picture_rows from crm.marketing_images;

-- TO UNDO (only if nothing there is wanted): drop table crm.marketing_images;
