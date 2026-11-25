-- Marketing login, STEP 1 of 2: add the new kind of login "marketing".
--
-- WHAT THIS DOES: adds one new value, "marketing", to the list of logins (rep, manager). It does not change, move or delete anything, and no person has it yet.
-- Safe to run twice. Run it on its own, in the Supabase SQL editor, on the SANDBOX first and then live. Then run step 2 as a separate run
-- (the database does not let a new value be used in the same run that adds it).
--
-- A marketing login is treated like a rep everywhere (no costs, only its own territory's customers), and can also use the Email Builder and the
-- Marketing Dashboard. Radar already works with this value before anyone has it.

-- 1. PREVIEW (reads only): the values the list has now. Expect rep and manager.
select unnest(enum_range(null::crm."RepRole"))::text as login_kinds_before;

-- 2. THE CHANGE
alter type crm."RepRole" add value if not exists 'marketing';

-- 3. CHECK (reads only): expect rep, manager, marketing.
select unnest(enum_range(null::crm."RepRole"))::text as login_kinds_after;
