-- Q36: posts are 60 characters at most, with no floor. Older, longer posts keep
-- working: a count bump on them must not trip the new limit.
--
-- Run with: supabase test db (CI does). Everybody here is made up.
begin;
select no_plan();

insert into auth.users(id) values ('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
insert into public.accounts(id, display_name) values
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'writer')
on conflict (id) do nothing;

select lives_ok(
  $$insert into public.posts(id, author_id, body, x, y, cluster_id, vec, vec_c)
    values ('00000000-0000-4000-8000-000000000501', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            '短い', 1, 1, 0,
            array_fill(1.0, array[448])::vector(448), array_fill(1.0, array[448])::vector(448))$$,
  'a two-character post is accepted (no floor)');

select lives_ok(
  $$insert into public.posts(id, author_id, body, x, y, cluster_id, vec, vec_c)
    values ('00000000-0000-4000-8000-000000000502', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            repeat('あ', 60), 2, 2, 0,
            array_fill(1.0, array[448])::vector(448), array_fill(1.0, array[448])::vector(448))$$,
  'exactly 60 characters is accepted');

select throws_ok(
  $$insert into public.posts(id, author_id, body, x, y, cluster_id, vec, vec_c)
    values ('00000000-0000-4000-8000-000000000503', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            repeat('あ', 61), 3, 3, 0,
            array_fill(1.0, array[448])::vector(448), array_fill(1.0, array[448])::vector(448))$$,
  '23514', null, 'a 61-character post is refused');

select throws_ok(
  $$insert into public.posts(id, author_id, body, x, y, cluster_id, vec, vec_c)
    values ('00000000-0000-4000-8000-000000000504', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            '', 4, 4, 0,
            array_fill(1.0, array[448])::vector(448), array_fill(1.0, array[448])::vector(448))$$,
  '23514', null, 'an empty post is refused');

-- A post written under the old rule (up to 140). The trigger is bypassed to
-- stand in for a row that existed before this migration.
alter table public.posts disable trigger posts_body_limit;
insert into public.posts(id, author_id, body, x, y, cluster_id, vec, vec_c)
values ('00000000-0000-4000-8000-000000000505', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        repeat('い', 120), 5, 5, 0,
        array_fill(1.0, array[448])::vector(448), array_fill(1.0, array[448])::vector(448));
alter table public.posts enable trigger posts_body_limit;

select lives_ok(
  $$update public.posts set comment_count = comment_count + 1
     where id = '00000000-0000-4000-8000-000000000505'$$,
  'a count bump on an older 120-character post still works');

select throws_ok(
  $$update public.posts set body = repeat('う', 61)
     where id = '00000000-0000-4000-8000-000000000505'$$,
  '23514', null, 'rewriting a body past 60 is refused');

select * from finish();
rollback;
