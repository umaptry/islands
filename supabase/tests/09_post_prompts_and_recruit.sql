-- 2026-10-20: お題・申込期限・先着人数・受付終了。
-- Run with: supabase test db (CI does). Everybody here is made up.
begin;
select no_plan();

insert into auth.users(id) values
  ('a9a9a9a9-a9a9-4a9a-8a9a-a9a9a9a9a9a1'),
  ('a9a9a9a9-a9a9-4a9a-8a9a-a9a9a9a9a9a2'),
  ('a9a9a9a9-a9a9-4a9a-8a9a-a9a9a9a9a9a3'),
  ('a9a9a9a9-a9a9-4a9a-8a9a-a9a9a9a9a9a4');
insert into public.accounts(id, display_name) values
  ('a9a9a9a9-a9a9-4a9a-8a9a-a9a9a9a9a9a1', 'host'),
  ('a9a9a9a9-a9a9-4a9a-8a9a-a9a9a9a9a9a2', 'guest one'),
  ('a9a9a9a9-a9a9-4a9a-8a9a-a9a9a9a9a9a3', 'guest two'),
  ('a9a9a9a9-a9a9-4a9a-8a9a-a9a9a9a9a9a4', 'guest three')
on conflict (id) do nothing;

select has_column('public', 'posts', 'prompt', 'posts remember which prompt they answer');
select has_column('public', 'posts', 'recruit_deadline', 'and a sign-up deadline');
select has_column('public', 'posts', 'recruit_capacity', 'and a first-come capacity');

-- 1. Old code writes without the new columns.
select lives_ok(
  $$insert into public.posts(id, author_id, body, x, y, cluster_id, vec, vec_c)
    values ('00000000-0000-4000-8000-000000000901', 'a9a9a9a9-a9a9-4a9a-8a9a-a9a9a9a9a9a1',
            'old style', 1, 1, 0,
            array_fill(1.0, array[448])::vector(448), array_fill(1.0, array[448])::vector(448))$$,
  'a post written without the new columns still works');

-- 2. Prompt.
select lives_ok(
  $$insert into public.posts(id, author_id, body, x, y, cluster_id, vec, vec_c, prompt)
    values ('00000000-0000-4000-8000-000000000902', 'a9a9a9a9-a9a9-4a9a-8a9a-a9a9a9a9a9a1',
            'past topic', 2, 2, 0,
            array_fill(1.0, array[448])::vector(448), array_fill(1.0, array[448])::vector(448), 'past')$$,
  'a known prompt is saved');
select throws_ok(
  $$update public.posts set prompt = 'someday' where id = '00000000-0000-4000-8000-000000000902'$$,
  '23514', null, 'an unknown prompt is refused');

-- 3. Capacity range (on a post that carries the recruiting tag).
insert into public.posts(id, author_id, body, x, y, cluster_id, vec, vec_c, tags)
values ('00000000-0000-4000-8000-000000000906', 'a9a9a9a9-a9a9-4a9a-8a9a-a9a9a9a9a9a1',
        'range check', 6, 6, 0,
        array_fill(1.0, array[448])::vector(448), array_fill(1.0, array[448])::vector(448),
        array['参加者募集中']);
select throws_ok(
  $$update public.posts set recruit_capacity = 0 where id = '00000000-0000-4000-8000-000000000906'$$,
  '23514', null, 'capacity 0 is refused');
select throws_ok(
  $$update public.posts set recruit_capacity = 1000 where id = '00000000-0000-4000-8000-000000000906'$$,
  '23514', null, 'capacity 1000 is refused');

-- 4. A post without the recruiting tag keeps neither deadline nor capacity.
select lives_ok(
  $$insert into public.posts(id, author_id, body, x, y, cluster_id, vec, vec_c, tags,
                             recruit_deadline, recruit_capacity)
    values ('00000000-0000-4000-8000-000000000903', 'a9a9a9a9-a9a9-4a9a-8a9a-a9a9a9a9a9a1',
            'no tag', 3, 3, 0,
            array_fill(1.0, array[448])::vector(448), array_fill(1.0, array[448])::vector(448),
            '{}', current_date + 3, 5)$$,
  'a post without the recruiting tag can be written with the fields');
select is((select recruit_capacity from public.posts where id = '00000000-0000-4000-8000-000000000903'),
          null, 'but the capacity is cleared');
select is((select recruit_deadline from public.posts where id = '00000000-0000-4000-8000-000000000903'),
          null, 'and so is the deadline');

-- 5. A recruiting post (2 places, deadline tomorrow) and one past its deadline.
select lives_ok(
  $$insert into public.posts(id, author_id, body, x, y, cluster_id, vec, vec_c, tags,
                             recruit_deadline, recruit_capacity)
    values ('00000000-0000-4000-8000-000000000904', 'a9a9a9a9-a9a9-4a9a-8a9a-a9a9a9a9a9a1',
            'open event', 4, 4, 0,
            array_fill(1.0, array[448])::vector(448), array_fill(1.0, array[448])::vector(448),
            array['参加者募集中'], current_date + 1, 2)$$,
  'a recruiting post keeps its deadline and capacity');
select is((select recruit_capacity from public.posts where id = '00000000-0000-4000-8000-000000000904'),
          2, 'capacity kept');
insert into public.posts(id, author_id, body, x, y, cluster_id, vec, vec_c, tags,
                         recruit_deadline, recruit_capacity)
values ('00000000-0000-4000-8000-000000000905', 'a9a9a9a9-a9a9-4a9a-8a9a-a9a9a9a9a9a1',
        'closed event', 5, 5, 0,
        array_fill(1.0, array[448])::vector(448), array_fill(1.0, array[448])::vector(448),
        array['参加者募集中'], current_date - 2, null);

select is(public.post_recruit_closed(current_date - 2, null, 0), 'deadline', 'a past date is closed');
select is(public.post_recruit_closed(current_date + 1, 2, 0), null, 'a future date with room is open');
select is(public.post_recruit_closed(null, 2, 2), 'full', 'a full house is closed');
select is(public.post_recruit_closed(null, null, 99), null, 'no limits means open');
select is(public.post_recruit_closed(
            (now() at time zone 'Asia/Tokyo')::date, null, 0), null,
          'the deadline day itself is still open until the end of the day in Japan');

select lives_ok(
  $$insert into public.reactions(post_id, actor_id, kind)
    values ('00000000-0000-4000-8000-000000000904', 'a9a9a9a9-a9a9-4a9a-8a9a-a9a9a9a9a9a2', 'join')$$,
  'the first guest can join');
select lives_ok(
  $$insert into public.reactions(post_id, actor_id, kind)
    values ('00000000-0000-4000-8000-000000000904', 'a9a9a9a9-a9a9-4a9a-8a9a-a9a9a9a9a9a3', 'join')$$,
  'the second guest can join');
select is((select join_count from public.posts where id = '00000000-0000-4000-8000-000000000904'),
          2, 'two joins are counted');
select throws_ok(
  $$insert into public.reactions(post_id, actor_id, kind)
    values ('00000000-0000-4000-8000-000000000904', 'a9a9a9a9-a9a9-4a9a-8a9a-a9a9a9a9a9a4', 'join')$$,
  'P0001', 'recruit_full', 'a third guest is turned away: recruit_full');
select lives_ok(
  $$insert into public.reactions(post_id, actor_id, kind)
    values ('00000000-0000-4000-8000-000000000904', 'a9a9a9a9-a9a9-4a9a-8a9a-a9a9a9a9a9a4', 'like')$$,
  'a like is not a join and is not turned away');
select lives_ok(
  $$insert into public.reactions(post_id, actor_id, kind)
    values ('00000000-0000-4000-8000-000000000904', 'a9a9a9a9-a9a9-4a9a-8a9a-a9a9a9a9a9a2', 'join')
    on conflict (post_id, actor_id, kind) do nothing$$,
  'someone who already joined can press again without an error');
select is((select join_count from public.posts where id = '00000000-0000-4000-8000-000000000904'),
          2, 'and is not counted twice');

select throws_ok(
  $$insert into public.reactions(post_id, actor_id, kind)
    values ('00000000-0000-4000-8000-000000000905', 'a9a9a9a9-a9a9-4a9a-8a9a-a9a9a9a9a9a2', 'join')$$,
  'P0001', 'recruit_closed', 'joining after the deadline is turned away: recruit_closed');

-- Withdrawing is always possible, and a freed place can be taken.
select lives_ok(
  $$delete from public.reactions
     where post_id = '00000000-0000-4000-8000-000000000904'
       and actor_id = 'a9a9a9a9-a9a9-4a9a-8a9a-a9a9a9a9a9a2' and kind = 'join'$$,
  'a guest can withdraw a join from a full post');
select is((select join_count from public.posts where id = '00000000-0000-4000-8000-000000000904'),
          1, 'the count goes down');
select lives_ok(
  $$insert into public.reactions(post_id, actor_id, kind)
    values ('00000000-0000-4000-8000-000000000904', 'a9a9a9a9-a9a9-4a9a-8a9a-a9a9a9a9a9a4', 'join')$$,
  'a freed place can be taken by someone else');

-- Removing the tag clears the deadline and the capacity.
update public.posts set tags = '{}' where id = '00000000-0000-4000-8000-000000000904';
select is((select recruit_capacity from public.posts where id = '00000000-0000-4000-8000-000000000904'),
          null, 'removing the tag clears the capacity');

-- A post with no limits takes joins as before.
select lives_ok(
  $$insert into public.reactions(post_id, actor_id, kind)
    values ('00000000-0000-4000-8000-000000000901', 'a9a9a9a9-a9a9-4a9a-8a9a-a9a9a9a9a9a2', 'join')$$,
  'a post with no limits accepts joins');

-- 6. 地図の読みは新しい列を返す。2026-10-27 から map_posts はメンバーの JWT がないと 0 件なので、
--    サーバー専用の map_posts_for_community（列は同じ）で確かめる。
insert into public.communities(id, name) values ('09090909-0909-4909-8909-090909090909', 'prompts');
update public.posts set community_id = '09090909-0909-4909-8909-090909090909'
 where id in ('00000000-0000-4000-8000-000000000901', '00000000-0000-4000-8000-000000000902',
              '00000000-0000-4000-8000-000000000905');
select is((select recruit_closed from public.map_posts_for_community('09090909-0909-4909-8909-090909090909', -1000, -1000, 1000, 1000, 100)
            where id = '00000000-0000-4000-8000-000000000905'),
          'deadline', 'map_posts says the post is closed by its deadline');
select is((select prompt from public.map_posts_for_community('09090909-0909-4909-8909-090909090909', -1000, -1000, 1000, 1000, 100)
            where id = '00000000-0000-4000-8000-000000000902'),
          'past', 'map_posts returns the prompt');
select is((select recruit_closed from public.map_posts_for_community('09090909-0909-4909-8909-090909090909', -1000, -1000, 1000, 1000, 100)
            where id = '00000000-0000-4000-8000-000000000901'),
          null, 'and null for a post that takes joins');

-- 7. Privileges: readable, but not writable from the browser.
select ok(has_column_privilege('authenticated', 'public.posts', 'recruit_deadline', 'SELECT'),
          'a signed-in person can read the deadline (their rows only: members-only)');
select ok(has_column_privilege('authenticated', 'public.posts', 'prompt', 'SELECT'), 'and the prompt');
select ok(not has_column_privilege('anon', 'public.posts', 'recruit_deadline', 'SELECT'),
          'anon cannot (members-only, 2026-10-27)');
select ok(not has_column_privilege('anon', 'public.posts', 'prompt', 'SELECT'), 'nor the prompt');
select ok(not has_column_privilege('authenticated', 'public.posts', 'prompt', 'UPDATE'),
          'the browser cannot write the prompt');
select ok(not has_column_privilege('authenticated', 'public.posts', 'recruit_capacity', 'UPDATE'),
          'nor the capacity');
select ok(not has_function_privilege('authenticated', 'public.reactions_recruit_guard()', 'EXECUTE'),
          'the guard function is not callable by clients');

select * from finish();
rollback;
