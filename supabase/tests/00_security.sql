-- Security tests for the islands schema.
--
-- Run with: supabase test db
-- These require pgTAP (installed by default in Supabase local).

begin;
select plan(7);

-- -----------------------------------------------------------------------
-- 1. Every public table has RLS enabled
-- -----------------------------------------------------------------------
select is(
  (select count(*)::int from pg_class c
    where c.relnamespace = 'public'::regnamespace
      and c.relkind = 'r'
      and not c.relrowsecurity),
  0,
  'All public tables have RLS enabled'
);

-- -----------------------------------------------------------------------
-- 2. Every public table has at least one RLS policy
-- -----------------------------------------------------------------------
select is(
  (select count(*)::int from (
     select c.relname
       from pg_class c
      where c.relnamespace = 'public'::regnamespace
        and c.relkind = 'r'
     except
     select distinct p.tablename::name
       from pg_policies p
      where p.schemaname = 'public'
   ) missing_policies),
  0,
  'Every public table has at least one policy'
);

-- -----------------------------------------------------------------------
-- 3. posts has NO INSERT policy for authenticated
-- -----------------------------------------------------------------------
select is(
  (select count(*)::int from pg_policies
    where tablename = 'posts' and schemaname = 'public' and cmd = 'INSERT'),
  0,
  'posts has no INSERT policy (server-only via service_role)'
);

-- -----------------------------------------------------------------------
-- 4. posts.vec is not readable by anon
-- -----------------------------------------------------------------------
select is(
  (select count(*)::int from information_schema.column_privileges
    where table_schema = 'public' and table_name = 'posts'
      and column_name = 'vec' and grantee = 'anon'
      and privilege_type = 'SELECT'),
  0,
  'posts.vec is not SELECT-granted to anon'
);

-- -----------------------------------------------------------------------
-- 5. posts.vec is not readable by authenticated
-- -----------------------------------------------------------------------
select is(
  (select count(*)::int from information_schema.column_privileges
    where table_schema = 'public' and table_name = 'posts'
      and column_name = 'vec' and grantee = 'authenticated'
      and privilege_type = 'SELECT'),
  0,
  'posts.vec is not SELECT-granted to authenticated'
);

-- -----------------------------------------------------------------------
-- 6. posts.vec_c is not readable by anon
-- -----------------------------------------------------------------------
select is(
  (select count(*)::int from information_schema.column_privileges
    where table_schema = 'public' and table_name = 'posts'
      and column_name = 'vec_c' and grantee = 'anon'
      and privilege_type = 'SELECT'),
  0,
  'posts.vec_c is not SELECT-granted to anon'
);

-- -----------------------------------------------------------------------
-- 7. posts.vec_c is not readable by authenticated
-- -----------------------------------------------------------------------
select is(
  (select count(*)::int from information_schema.column_privileges
    where table_schema = 'public' and table_name = 'posts'
      and column_name = 'vec_c' and grantee = 'authenticated'
      and privilege_type = 'SELECT'),
  0,
  'posts.vec_c is not SELECT-granted to authenticated'
);

select * from finish();
rollback;
