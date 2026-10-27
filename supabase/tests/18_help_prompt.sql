-- 2026-10-28: お題「困ってること」（prompt = 'help'）。
-- Run with: supabase test db (CI does). Everybody here is made up.
begin;
select no_plan();

insert into auth.users(id) values ('b8b8b8b8-b8b8-4b8b-8b8b-b8b8b8b8b8b1');
insert into public.accounts(id, display_name) values ('b8b8b8b8-b8b8-4b8b-8b8b-b8b8b8b8b8b1', 'asker')
on conflict (id) do nothing;

select lives_ok(
  $$insert into public.posts(id, author_id, body, x, y, cluster_id, vec, vec_c, prompt)
    values ('00000000-0000-4000-8000-000000001801', 'b8b8b8b8-b8b8-4b8b-8b8b-b8b8b8b8b8b1',
            'ミニトマトが育たない', 1, 1, 0,
            array_fill(1.0, array[448])::vector(448), array_fill(1.0, array[448])::vector(448), 'help')$$,
  'a post written with 困ってること is saved');
select lives_ok(
  $$update public.posts set prompt = 'future' where id = '00000000-0000-4000-8000-000000001801'$$,
  'the prompts before it are still accepted');
select throws_ok(
  $$update public.posts set prompt = 'someday' where id = '00000000-0000-4000-8000-000000001801'$$,
  '23514', null, 'an unknown prompt is still refused');

select * from finish();
rollback;
