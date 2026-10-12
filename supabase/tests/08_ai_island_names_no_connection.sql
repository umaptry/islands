-- 2026-10-12: islands_state の名前の出どころ列と、「新しいつながり」通知の停止。
-- Run with: supabase test db (CI does). Everybody here is made up.
begin;
select no_plan();

insert into auth.users(id) values
  ('a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1'),
  ('b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2');
insert into public.accounts(id, display_name) values
  ('a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1', 'owner'),
  ('b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2', 'visitor')
on conflict (id) do nothing;

select has_column('public', 'islands_state', 'name_source', 'islands remember where a name came from');
select has_column('public', 'islands_state', 'name_basis', 'and which posts it was made for');
select has_column('public', 'islands_state', 'name_tried_at', 'and when the AI was last asked');
select lives_ok(
  $$insert into public.islands_state(name, name_source, name_basis, name_tried_at)
     values ('アート', 'ai', array[gen_random_uuid()], now())$$, 'an AI-named island is saved');
select lives_ok($$insert into public.islands_state(name, name_source) values ('手芸', 'manual')$$,
                'a name fixed by hand (manual) is saved');
select lives_ok($$insert into public.islands_state(name, name_source) values ('上位語', 'terms')$$,
                'a word-count name (terms) is saved');
select lives_ok($$insert into public.islands_state(name) values ('古い島')$$,
                'an island saved by old code (no new columns) still works');
select lives_ok($$insert into public.islands_state(name, name_source) values ('農業', 'genre')$$,
                'an activity-genre name (genre) is saved');
select throws_ok($$insert into public.islands_state(name, name_source) values ('x', 'robot')$$,
                 '23514', null, 'the source is terms, genre, ai or manual');

-- 「新しいつながり」はもう作られない。反応そのものの通知は今までどおり。
insert into public.posts(id, author_id, body, x, y, cluster_id, vec, vec_c)
values ('00000000-0000-4000-8000-0000000000a1', 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1',
        repeat('A', 40), 0, 0, 0,
        array_fill(1.0, array[448])::vector(448), array_fill(1.0, array[448])::vector(448));
insert into public.reactions(post_id, actor_id, kind)
values ('00000000-0000-4000-8000-0000000000a1', 'b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2', 'like');
select is((select count(*)::int from public.notifications where type = 'connection'), 0,
          'a first interaction no longer makes a connection notification');
select is((select count(*)::int from public.notifications
            where type = 'like' and recipient_id = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1'), 1,
          'but the like itself still tells the owner');
select lives_ok($$select public.notify_new_connection(
  'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1', 'b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2')$$,
  'the old function can still be called');

select * from finish();
rollback;
