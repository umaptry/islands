-- Stage 1 of the islands redesign: profiles, replies, connections, the
-- notification feed and the island record.
--
-- Run with: supabase test db (CI does). Everybody here is made up.
begin;
select no_plan();

insert into auth.users(id) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
insert into public.accounts(id, display_name) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'author'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'reader'),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'third')
on conflict (id) do nothing;
insert into public.posts(id, author_id, body, x, y, cluster_id, vec, vec_c)
select ('00000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
       'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', repeat('A', 40), i, i, 0,
       array_fill(1.0, array[448])::vector(448), array_fill(1.0, array[448])::vector(448)
  from generate_series(1, 2) i;

-- -----------------------------------------------------------------------
-- 1. Profile fields: readable words, hidden vectors, server-only writes
-- -----------------------------------------------------------------------
select ok(has_column_privilege('anon', 'public.accounts', 'topics', 'SELECT'),
          'anyone can read the topics');
select ok(has_column_privilege('anon', 'public.accounts', 'display_name', 'SELECT'),
          'names stay readable after the switch to column grants');
select ok(not has_column_privilege('anon', 'public.accounts', 'vec_topics', 'SELECT'),
          'anon cannot read a profile vector');
select ok(not has_column_privilege('authenticated', 'public.accounts', 'vec_goal', 'SELECT'),
          'a signed-in browser cannot read a profile vector');
select ok(not has_column_privilege('authenticated', 'public.accounts', 'last_seen_at', 'SELECT'),
          'nobody else learns when you were last here');
select ok(not has_column_privilege('authenticated', 'public.accounts', 'topics', 'UPDATE'),
          'the browser cannot write topics without their vector');
select ok(has_column_privilege('authenticated', 'public.accounts', 'display_name', 'UPDATE'),
          'the browser can still rename itself');

select throws_ok(
  $$update public.accounts set topics = array['1','2','3','4','5','6','7','8','9']
     where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'$$,
  '23514', null, 'at most eight topics');
select throws_ok(
  $$update public.accounts set topics = array['十三文字ある長い長い話題です']
     where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'$$,
  '23514', null, 'a topic is at most twelve characters');
select throws_ok(
  $$update public.accounts set goal = repeat('目', 61)
     where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'$$,
  '23514', null, 'a goal is at most sixty characters');

-- -----------------------------------------------------------------------
-- 2. Interactions: one 'connection' each way, once per pair
-- -----------------------------------------------------------------------
insert into public.reactions(post_id, actor_id, kind) values
  ('00000000-0000-4000-8000-000000000001', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'like');
select is((select count(*)::int from public.notifications where type = 'connection'), 2,
          'the first interaction tells both people');
insert into public.reactions(post_id, actor_id, kind) values
  ('00000000-0000-4000-8000-000000000002', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'help');
select is((select count(*)::int from public.notifications where type = 'connection'), 2,
          'a second interaction is not a new connection');
select is(public.pair_interaction_count('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                                        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'), 2,
          'interactions are counted per pair in either direction');
insert into public.reactions(post_id, actor_id, kind) values
  ('00000000-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'like');
select is((select count(*)::int from public.notifications
            where recipient_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and type = 'like'), 1,
          'reacting to your own post is nobody''s news');

-- -----------------------------------------------------------------------
-- 3. Replies
-- -----------------------------------------------------------------------
insert into public.comments(id, post_id, author_id, body) values
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', '00000000-0000-4000-8000-000000000001',
   'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'どこでキャンプしましたか');
insert into public.comments(post_id, author_id, body, reply_to) values
  ('00000000-0000-4000-8000-000000000001', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
   '私も気になります', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd');
select is((select count(*)::int from public.notifications
            where recipient_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' and type = 'reply'), 1,
          'the person replied to gets a reply');
select is((select count(*)::int from public.notifications
            where recipient_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and type = 'comment'), 2,
          'the post''s owner hears about both messages as comments');
select is((select count(*)::int from public.notifications
            where type = 'connection'
              and recipient_id in ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc')
              and actor_id in ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc')), 2,
          'a reply connects the replier to the person replied to');
select throws_ok(
  $$insert into public.comments(post_id, author_id, body, reply_to) values
     ('00000000-0000-4000-8000-000000000002', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      '返信', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd')$$,
  '23514', 'reply_to must be a comment on the same post', 'a reply stays on its own post');

select is((select count(*)::int from public.interaction_events('2000-01-01')), 4,
          'two reactions by another, a comment and a reply; the self-like is not one');
select is((select reply_author_id from public.interaction_events('2000-01-01') where kind = 'reply'),
          'cccccccc-cccc-4ccc-8ccc-cccccccccccc'::uuid,
          'a reply names the author of the comment it answers');

-- -----------------------------------------------------------------------
-- 4. The feed, as the author sees it
-- -----------------------------------------------------------------------
insert into public.reactions(post_id, actor_id, kind) values
  ('00000000-0000-4000-8000-000000000001', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'join');

set local role authenticated;
set local request.jwt.claims to '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated"}';

select is((select count(*)::int from public.notification_feed(50)
            where category = 'reaction' and post_id = '00000000-0000-4000-8000-000000000001'), 1,
          'reactions to one post within ten minutes are one entry');
select is((select others from public.notification_feed(50)
            where category = 'reaction' and post_id = '00000000-0000-4000-8000-000000000001'), 1,
          '... naming one person and "one other"');
select is((select count(*)::int from public.notification_feed(50) where category = 'reply'), 2,
          'messages are never grouped');
select throws_ok($$select * from public.profile_vectors()$$, '42501', null,
                 'the browser cannot call profile_vectors');
select throws_ok($$select * from public.interaction_events('2000-01-01')$$, '42501', null,
                 'the browser cannot call interaction_events');
select throws_ok($$select public.claim_island_run(0)$$, '42501', null,
                 'the browser cannot claim the island run');

-- -----------------------------------------------------------------------
-- 5. Settings and visits belong to their owner
-- -----------------------------------------------------------------------
select lives_ok(
  $$insert into public.notification_settings(account_id, category, push, in_app)
     values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'reaction', false, true)$$,
  'you can switch a category off for yourself');
select throws_ok(
  $$insert into public.notification_settings(account_id, category, push, in_app)
     values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'reaction', false, false)$$,
  '42501', null, 'but not for somebody else');
select throws_ok(
  $$insert into public.notification_settings(account_id, category, push, in_app)
     values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'marketing', true, true)$$,
  '23514', null, 'only the five categories exist');
select is(public.touch_last_seen(), null::timestamptz, 'a first visit has no previous visit');
select isnt(public.touch_last_seen(), null::timestamptz, 'a second visit returns the first');
select throws_ok($$insert into public.island_events(island_id, kind, cause)
                   values (gen_random_uuid(), 'birth', 'x')$$,
                 '42501', null, 'the browser cannot write the island record');
select lives_ok($$select * from public.island_events$$, 'but anyone signed in can read it');

reset role;

-- -----------------------------------------------------------------------
-- 6. The island record and the run lock
-- -----------------------------------------------------------------------
select ok(has_table_privilege('anon', 'public.island_events', 'SELECT'), 'anon can read changes');
select ok(has_table_privilege('anon', 'public.islands_state', 'SELECT'), 'anon can read islands');
select ok(not has_table_privilege('anon', 'public.island_runs', 'SELECT'), 'the run lock is private');
select ok(not has_table_privilege('anon', 'public.notification_settings', 'SELECT'),
          'settings are not public');
select is((select count(*)::int from pg_class
            where relnamespace = 'public'::regnamespace
              and relname in ('notification_settings', 'push_subscriptions', 'islands_state',
                              'island_events', 'island_runs')
              and relrowsecurity), 5, 'every new table has RLS on');

update public.island_runs set last_run_at = 'epoch';
select ok(public.claim_island_run(600), 'the first caller gets the run');
select ok(not public.claim_island_run(600), 'the next caller within ten minutes does not');

insert into public.notifications(recipient_id, type, island_id, payload) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'island', gen_random_uuid(), '{"kind":"merge"}');
select is((select count(*)::int from public.notifications where type = 'island' and actor_id is null), 1,
          'an island change needs no actor');

select * from finish();
rollback;
