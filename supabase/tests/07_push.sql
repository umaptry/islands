-- 段6: notifications that reach a closed app. The keys, the dispatch address
-- and "who has the app on screen" are the server's alone; subscriptions are
-- saved by the server; quiet_post reads as a recommendation.
--
-- Run with: supabase test db (CI does). Everybody here is made up.
begin;
select no_plan();

insert into auth.users(id) values
  ('12121212-1212-4121-8121-121212121212'),
  ('34343434-3434-4343-8343-343434343434');
insert into public.accounts(id, display_name) values
  ('12121212-1212-4121-8121-121212121212', 'listener'),
  ('34343434-3434-4343-8343-343434343434', 'neighbour')
on conflict (id) do nothing;
-- 2026-10-27: 二人は同じコミュニティのメンバー（投稿のある通知は、そのメンバーだけが読める）。
insert into public.communities(id, name) values ('07070707-0707-4707-8707-070707070707', 'push');
insert into public.community_members(community_id, account_id) values
  ('07070707-0707-4707-8707-070707070707', '12121212-1212-4121-8121-121212121212'),
  ('07070707-0707-4707-8707-070707070707', '34343434-3434-4343-8343-343434343434');

-- -----------------------------------------------------------------------
-- 1. Server-only tables
-- -----------------------------------------------------------------------
select is((select count(*)::int from public.push_config), 1, 'push_config has exactly one row');
select is((select dispatch_url from public.push_config), null,
          'no dispatch address outside production');
select ok(not has_table_privilege('anon', 'public.push_config', 'SELECT'), 'anon cannot read the keys');
select ok(not has_table_privilege('authenticated', 'public.push_config', 'SELECT'),
          'nor can a signed-in person');
select ok(not has_table_privilege('authenticated', 'public.push_config', 'UPDATE'),
          'nor point the dispatcher somewhere else');
select ok(not has_table_privilege('authenticated', 'public.push_presence', 'SELECT'),
          'who is on screen is not readable');
select ok(not has_table_privilege('authenticated', 'public.push_presence', 'INSERT'),
          'and only written through mark_active');
select throws_ok($$insert into public.push_config(singleton) values (false)$$, '23514', null,
                 'there is never a second config row');
select throws_ok($$update public.push_config set dispatch_url = 'http://example.invalid/x'$$,
                 '23514', null, 'the dispatch address must be https');

-- -----------------------------------------------------------------------
-- 2. Subscriptions go through the server
-- -----------------------------------------------------------------------
select ok(not has_table_privilege('authenticated', 'public.push_subscriptions', 'INSERT'),
          'the browser cannot save an endpoint of its choosing');
select ok(has_table_privilege('authenticated', 'public.push_subscriptions', 'DELETE'),
          'but can still remove its own');
select is((select count(*)::int from pg_policies
            where schemaname = 'public' and tablename = 'push_subscriptions'
              and policyname = 'push_subscriptions_insert'), 0,
          'the insert policy is gone');

-- -----------------------------------------------------------------------
-- 3. mark_active
-- -----------------------------------------------------------------------
select ok(not has_function_privilege('anon', 'public.mark_active(integer)', 'execute'),
          'anon cannot mark anyone active');
select ok(not has_function_privilege('authenticated', 'public.poke_push_dispatch()', 'execute'),
          'nobody calls the dispatch trigger by hand');

set local role authenticated;
set local request.jwt.claims to '{"sub":"12121212-1212-4121-8121-121212121212","role":"authenticated"}';
select lives_ok($$select public.mark_active(45)$$, 'a signed-in person marks themself active');
select lives_ok($$select public.mark_active(100000)$$, 'a huge number is capped, not refused');
reset role;

select is((select count(*)::int from public.push_presence), 1, 'one row, the caller''s own');
select is((select account_id from public.push_presence),
          '12121212-1212-4121-8121-121212121212'::uuid, 'keyed by the caller');
select ok((select active_until <= now() + interval '121 seconds' from public.push_presence),
          'at most two minutes ahead');

set local role authenticated;
set local request.jwt.claims to '{"sub":"12121212-1212-4121-8121-121212121212","role":"authenticated"}';
select lives_ok($$select public.mark_active(0)$$, 'leaving the screen clears it');
reset role;
select is((select count(*)::int from public.push_presence), 0, 'and the row is gone');

-- -----------------------------------------------------------------------
-- 4. Notifications: pushed_at, quiet_post, the trigger
-- -----------------------------------------------------------------------
insert into public.posts(id, author_id, body, x, y, cluster_id, vec, vec_c, community_id) values
  ('00000000-0000-4000-8000-000000000701', '34343434-3434-4343-8343-343434343434',
   '近くの島の投稿', 1, 1, 0,
   array_fill(1.0, array[448])::vector(448), array_fill(1.0, array[448])::vector(448),
   '07070707-0707-4707-8707-070707070707');

select ok(not has_column_privilege('authenticated', 'public.notifications', 'pushed_at', 'UPDATE'),
          'the browser cannot mark its own notifications as pushed');
select has_trigger('public', 'notifications', 'notifications_push', 'new rows poke the dispatcher');

select lives_ok(
  $$insert into public.notifications(recipient_id, type, post_id, payload, community_id) values
    ('12121212-1212-4121-8121-121212121212', 'quiet_post',
     '00000000-0000-4000-8000-000000000701', '{}'::jsonb, '07070707-0707-4707-8707-070707070707')$$,
  'quiet_post is a notification type');
select throws_ok(
  $$insert into public.notifications(recipient_id, type) values
    ('12121212-1212-4121-8121-121212121212', 'nonsense')$$,
  '23514', null, 'unknown types are still refused');
select is((select pushed_at from public.notifications where type = 'quiet_post'), null,
          'a new row waits for the dispatcher');

update public.push_config set dispatch_url = 'https://example.invalid/api/push/dispatch';
select lives_ok(
  $$insert into public.notifications(recipient_id, actor_id, type, post_id) values
    ('34343434-3434-4343-8343-343434343434', '12121212-1212-4121-8121-121212121212', 'like',
     '00000000-0000-4000-8000-000000000701')$$,
  'with an address set, the insert still goes through');
update public.push_config set dispatch_url = null;

set local role authenticated;
set local request.jwt.claims to '{"sub":"12121212-1212-4121-8121-121212121212","role":"authenticated"}';
select is((select category from public.notification_feed(50) where type = 'quiet_post'), 'similar',
          'quiet_post sits with the recommendations');
select throws_ok($$update public.notifications set pushed_at = now()$$, '42501', null,
                 'pushed_at is the server''s');
reset role;

-- -----------------------------------------------------------------------
-- 5. Realtime
-- -----------------------------------------------------------------------
select ok(not exists (select 1 from pg_publication where pubname = 'supabase_realtime')
          or exists (select 1 from pg_publication_tables
                      where pubname = 'supabase_realtime'
                        and schemaname = 'public' and tablename = 'notifications'),
          'an open app hears new notifications');

select * from finish();
rollback;
