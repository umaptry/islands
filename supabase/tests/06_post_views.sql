-- 段5: footprints are a number only the author sees (Q35), and an unsaved
-- example sentence can be placed without writing anything (Q40).
--
-- Run with: supabase test db (CI does). Everybody here is made up.
begin;
select no_plan();

insert into auth.users(id) values
  ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'),
  ('ffffffff-ffff-4fff-8fff-ffffffffffff');
insert into public.accounts(id, display_name) values
  ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'author'),
  ('ffffffff-ffff-4fff-8fff-ffffffffffff', 'reader')
on conflict (id) do nothing;

insert into public.posts(id, author_id, body, x, y, cluster_id, vec, vec_c) values
  ('00000000-0000-4000-8000-000000000601', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
   '一つ目', 1, 1, 0,
   array_fill(1.0, array[448])::vector(448), array_fill(1.0, array[448])::vector(448)),
  ('00000000-0000-4000-8000-000000000602', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
   '二つ目', 2, 2, 0,
   array_fill(-1.0, array[448])::vector(448), array_fill(-1.0, array[448])::vector(448));

-- -----------------------------------------------------------------------
-- 1. Counting, as the server does it
-- -----------------------------------------------------------------------
insert into public.post_views(post_id, viewer) values
  ('00000000-0000-4000-8000-000000000601', 'ffffffff-ffff-4fff-8fff-ffffffffffff'),
  ('00000000-0000-4000-8000-000000000601', 'anon:0123456789abcdef');
insert into public.post_views(post_id, viewer) values
  ('00000000-0000-4000-8000-000000000601', 'ffffffff-ffff-4fff-8fff-ffffffffffff')
on conflict do nothing;

select is((select views from public.post_view_counts('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')
            where post_id = '00000000-0000-4000-8000-000000000601'), 2,
          'a second open by the same viewer is not a second view');
select is((select count(*)::int from public.post_view_counts('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')), 1,
          'a post nobody opened has no row');
select throws_ok(
  $$insert into public.post_views(post_id, viewer) values ('00000000-0000-4000-8000-000000000601', '')$$,
  '23514', null, 'an empty viewer key is refused');

update public.posts set deleted_at = now() where id = '00000000-0000-4000-8000-000000000601';
select is((select count(*)::int from public.post_view_counts('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')), 0,
          'a deleted post stops counting');
update public.posts set deleted_at = null where id = '00000000-0000-4000-8000-000000000601';

-- -----------------------------------------------------------------------
-- 2. Neighbours of a vector that was never saved
-- -----------------------------------------------------------------------
select is((select id from public.nearest_to_vector(array_fill(1.0, array[448])::vector(448)::text, 1)),
          '00000000-0000-4000-8000-000000000601'::uuid,
          'the closest saved post comes first');
select is((select count(*)::int from public.nearest_to_vector(array_fill(1.0, array[448])::vector(448)::text, 500)
            where id in ('00000000-0000-4000-8000-000000000601', '00000000-0000-4000-8000-000000000602')), 2,
          'k is capped, not refused');

-- -----------------------------------------------------------------------
-- 3. None of it is the browser's
-- -----------------------------------------------------------------------
select ok(not has_table_privilege('anon', 'public.post_views', 'SELECT'), 'anon cannot read views');
select ok(not has_table_privilege('authenticated', 'public.post_views', 'SELECT'),
          'nor can a signed-in person, the author included');
select ok(not has_table_privilege('authenticated', 'public.post_views', 'INSERT'),
          'views are written by the server only');
select ok(not has_function_privilege('authenticated', 'public.post_view_counts(uuid)', 'execute'),
          'the browser cannot ask for anybody''s counts');
select ok(not has_function_privilege('anon', 'public.nearest_to_vector(text,integer)', 'execute'),
          'nor place a vector of its own');

set local role authenticated;
set local request.jwt.claims to '{"sub":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","role":"authenticated"}';
select throws_ok($$select * from public.post_views$$, '42501', null,
                 'reading the rows fails outright');
select throws_ok($$select * from public.post_view_counts('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')$$,
                 '42501', null, 'counts go through the server');
reset role;

select * from finish();
rollback;
