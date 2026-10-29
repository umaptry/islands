-- 2026-10-29: つながりの通知（notifications.type = 'match'）。
-- Run with: supabase test db (CI does). Everybody here is made up.
begin;
select no_plan();

insert into auth.users(id) values
  ('b9b9b9b9-b9b9-4b9b-8b9b-b9b9b9b9b9a1'),
  ('b9b9b9b9-b9b9-4b9b-8b9b-b9b9b9b9b9a2'),
  ('b9b9b9b9-b9b9-4b9b-8b9b-b9b9b9b9b9a3');
insert into public.accounts(id, display_name) values
  ('b9b9b9b9-b9b9-4b9b-8b9b-b9b9b9b9b9a1', 'older'),
  ('b9b9b9b9-b9b9-4b9b-8b9b-b9b9b9b9b9a2', 'newer'),
  ('b9b9b9b9-b9b9-4b9b-8b9b-b9b9b9b9b9a3', 'elsewhere')
on conflict (id) do nothing;

-- older と newer は同じコミュニティ。elsewhere は別のコミュニティだけ。
insert into public.communities(id, name) values
  ('19191919-1919-4019-8019-191919191919', 'match here'),
  ('19191919-1919-4019-8019-191919191920', 'match elsewhere');
insert into public.community_members(community_id, account_id) values
  ('19191919-1919-4019-8019-191919191919', 'b9b9b9b9-b9b9-4b9b-8b9b-b9b9b9b9b9a1'),
  ('19191919-1919-4019-8019-191919191919', 'b9b9b9b9-b9b9-4b9b-8b9b-b9b9b9b9b9a2'),
  ('19191919-1919-4019-8019-191919191920', 'b9b9b9b9-b9b9-4b9b-8b9b-b9b9b9b9b9a3');

-- older の前の投稿 Q と、newer の新しい投稿 P1・P2（どれも同じコミュニティ）。別のコミュニティに R。
insert into public.posts(id, author_id, body, x, y, cluster_id, vec, vec_c, community_id) values
  ('00000000-0000-4000-8000-000000001901', 'b9b9b9b9-b9b9-4b9b-8b9b-b9b9b9b9b9a1', '前の投稿', 1, 1, 0,
   array_fill(1.0, array[448])::vector(448), array_fill(1.0, array[448])::vector(448),
   '19191919-1919-4019-8019-191919191919'),
  ('00000000-0000-4000-8000-000000001902', 'b9b9b9b9-b9b9-4b9b-8b9b-b9b9b9b9b9a2', '新しい投稿1', 1, 1, 0,
   array_fill(1.0, array[448])::vector(448), array_fill(1.0, array[448])::vector(448),
   '19191919-1919-4019-8019-191919191919'),
  ('00000000-0000-4000-8000-000000001903', 'b9b9b9b9-b9b9-4b9b-8b9b-b9b9b9b9b9a2', '新しい投稿2', 1, 1, 0,
   array_fill(1.0, array[448])::vector(448), array_fill(1.0, array[448])::vector(448),
   '19191919-1919-4019-8019-191919191919'),
  ('00000000-0000-4000-8000-000000001904', 'b9b9b9b9-b9b9-4b9b-8b9b-b9b9b9b9b9a3', '別のコミュニティ', 1, 1, 0,
   array_fill(1.0, array[448])::vector(448), array_fill(1.0, array[448])::vector(448),
   '19191919-1919-4019-8019-191919191920');
delete from public.notifications;

-- -----------------------------------------------------------------------
-- 1. type の制約: 既存の type を残して match を足している
-- -----------------------------------------------------------------------
select ok((select bool_and(position('''' || t || '''' in pg_get_constraintdef(c.oid)) > 0)
             from pg_constraint c,
                  unnest(array['like', 'help', 'join', 'comment', 'reply', 'connection', 'similar',
                               'island', 'quiet_post', 'talk_wish', 'talk_match', 'dm', 'match']) t
            where c.conname = 'notifications_type_check'),
          'every old type is kept and match is added');
select throws_ok(
  $$insert into public.notifications(recipient_id, actor_id, type)
    values ('b9b9b9b9-b9b9-4b9b-8b9b-b9b9b9b9b9a1', null, 'nonsense')$$,
  '23514', null, 'unknown types are still refused');
select lives_ok(
  $$insert into public.notifications(recipient_id, actor_id, post_id, type, payload, community_id)
    values ('b9b9b9b9-b9b9-4b9b-8b9b-b9b9b9b9b9a1', 'b9b9b9b9-b9b9-4b9b-8b9b-b9b9b9b9b9a2',
            '00000000-0000-4000-8000-000000001902', 'match',
            '{"kind":"need_have","other_post":"00000000-0000-4000-8000-000000001901","reason":"r1"}',
            '19191919-1919-4019-8019-191919191919'),
           ('b9b9b9b9-b9b9-4b9b-8b9b-b9b9b9b9b9a1', 'b9b9b9b9-b9b9-4b9b-8b9b-b9b9b9b9b9a2',
            '00000000-0000-4000-8000-000000001903', 'match',
            '{"kind":"near","other_post":"00000000-0000-4000-8000-000000001901","reason":"r2"}',
            '19191919-1919-4019-8019-191919191919')$$,
  'match notifications can be written');
-- elsewhere 宛て（同じ会の投稿につく行。elsewhere はその会のメンバーではない）
insert into public.notifications(recipient_id, actor_id, post_id, type, payload, community_id)
values ('b9b9b9b9-b9b9-4b9b-8b9b-b9b9b9b9b9a3', 'b9b9b9b9-b9b9-4b9b-8b9b-b9b9b9b9b9a2',
        '00000000-0000-4000-8000-000000001902', 'match', '{"kind":"near","reason":"x"}',
        '19191919-1919-4019-8019-191919191919');

-- -----------------------------------------------------------------------
-- 2. 通知の一覧: 反応に入り、まとめずに1行ずつ出る
-- -----------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub":"b9b9b9b9-b9b9-4b9b-8b9b-b9b9b9b9b9a1","role":"authenticated"}';
select is((select count(*)::int from public.notification_feed(50) where type = 'match'), 2,
          'two matches from one writer stay two lines');
select ok((select bool_and(category = 'reaction' and others = 0) from public.notification_feed(50) where type = 'match'),
          'a match sits under reactions, with nobody folded in');
select is((select payload ->> 'reason' from public.notification_feed(50)
            where post_id = '00000000-0000-4000-8000-000000001902' and type = 'match'), 'r1',
          'the payload comes through');
select is((select count(*)::int from public.notifications where type = 'match'), 2,
          'the recipient reads only their own match rows');

-- 別のコミュニティだけの人には、行があっても読めない（投稿のコミュニティのメンバーではない）
set local request.jwt.claims to '{"sub":"b9b9b9b9-b9b9-4b9b-8b9b-b9b9b9b9b9a3","role":"authenticated"}';
select is((select count(*)::int from public.notification_feed(50) where type = 'match'), 0,
          'a match about a post of a community the reader is not in is not shown');
select is((select count(*)::int from public.notifications where type = 'match'), 0,
          'nor readable from the table');

-- 他人の行は読めない
set local request.jwt.claims to '{"sub":"b9b9b9b9-b9b9-4b9b-8b9b-b9b9b9b9b9a2","role":"authenticated"}';
select is((select count(*)::int from public.notification_feed(50) where type = 'match'), 0,
          'the writer of the new post is not shown the notices meant for others');

reset role;

-- -----------------------------------------------------------------------
-- 3. 既存のまとめは変わらない（like / help / join）
-- -----------------------------------------------------------------------
insert into public.notifications(recipient_id, actor_id, post_id, type, community_id) values
  ('b9b9b9b9-b9b9-4b9b-8b9b-b9b9b9b9b9a2', 'b9b9b9b9-b9b9-4b9b-8b9b-b9b9b9b9b9a1',
   '00000000-0000-4000-8000-000000001902', 'like', '19191919-1919-4019-8019-191919191919'),
  ('b9b9b9b9-b9b9-4b9b-8b9b-b9b9b9b9b9a2', 'b9b9b9b9-b9b9-4b9b-8b9b-b9b9b9b9b9a3',
   '00000000-0000-4000-8000-000000001902', 'like', '19191919-1919-4019-8019-191919191919');
set local role authenticated;
set local request.jwt.claims to '{"sub":"b9b9b9b9-b9b9-4b9b-8b9b-b9b9b9b9b9a2","role":"authenticated"}';
select is((select count(*)::int from public.notification_feed(50) where type = 'like'), 1,
          'likes are still folded into one line');
reset role;

select * from finish();
rollback;
