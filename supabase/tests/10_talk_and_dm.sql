-- 2026-10-26: 「話してみたい」（仮名）と両思いの DM。
-- Run with: supabase test db (CI does). Everybody here is made up.
begin;
select no_plan();

insert into auth.users(id) values
  ('b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a1'),
  ('b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a2'),
  ('b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a3'),
  ('b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a4');
insert into public.accounts(id, display_name) values
  ('b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a1', 'host'),
  ('b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a2', 'guest'),
  ('b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a3', 'outsider'),
  ('b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a4', 'guest two')
on conflict (id) do nothing;

-- 2026-10-27: 会はコミュニティの投稿。host・guest・guest two はそのメンバー。outsider は入っていない。
insert into public.communities(id, name) values ('10101010-1010-4010-8010-101010101010', 'talk');
insert into public.community_members(community_id, account_id) values
  ('10101010-1010-4010-8010-101010101010', 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a1'),
  ('10101010-1010-4010-8010-101010101010', 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a2'),
  ('10101010-1010-4010-8010-101010101010', 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a4');

-- host の会（参加者募集中）。guest と guest two が参加。outsider は参加していない。
insert into public.posts(id, author_id, body, x, y, cluster_id, vec, vec_c, tags, community_id)
values ('00000000-0000-4000-8000-000000001001', 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a1',
        '週末にみんなで集まります', 1, 1, 0,
        array_fill(1.0, array[448])::vector(448), array_fill(1.0, array[448])::vector(448),
        array['参加者募集中'], '10101010-1010-4010-8010-101010101010');
insert into public.reactions(post_id, actor_id, kind) values
  ('00000000-0000-4000-8000-000000001001', 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a2', 'join'),
  ('00000000-0000-4000-8000-000000001001', 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a4', 'join');
delete from public.notifications;

-- -----------------------------------------------------------------------
-- 1. 誰からも読めない表・呼べない関数
-- -----------------------------------------------------------------------
select ok(not has_table_privilege('anon', 'public.talk_wishes', 'SELECT'), 'anon cannot read talk_wishes');
select ok(not has_table_privilege('authenticated', 'public.talk_wishes', 'SELECT'),
          'nor can a signed-in person');
select ok(not has_table_privilege('authenticated', 'public.talk_wishes', 'INSERT'),
          'nor write it');
select ok(not has_table_privilege('authenticated', 'public.talk_stats', 'SELECT'),
          'talk_stats is not readable');
select ok(not has_table_privilege('anon', 'public.dm_messages', 'SELECT'), 'anon cannot read messages');
select ok(not has_table_privilege('authenticated', 'public.dm_rooms', 'INSERT'),
          'rooms are made by functions only');
select ok(not has_table_privilege('authenticated', 'public.dm_messages', 'UPDATE'), 'messages are not editable');
select ok(not has_table_privilege('authenticated', 'public.dm_messages', 'DELETE'), 'nor deletable');
select ok(not has_function_privilege('anon', 'public.press_talk(uuid)', 'execute'), 'anon cannot press');
select ok(not has_function_privilege('anon', 'public.talk_peers()', 'execute'), 'anon has no peers');
select ok(not has_function_privilege('anon', 'public.dm_room_list()', 'execute'), 'anon has no rooms');
select ok(has_function_privilege('authenticated', 'public.press_talk(uuid)', 'execute'),
          'a signed-in person can press');
select ok(not has_function_privilege('authenticated', 'public.talk_shared_event(uuid, uuid)', 'execute'),
          'the membership test is not callable from outside');
select ok(not has_function_privilege('authenticated', 'public.talk_blocked(uuid, uuid)', 'execute'),
          'nor the block test');
select is((select count(*)::int from pg_publication_tables
            where pubname = 'supabase_realtime' and schemaname = 'public'
              and tablename in ('talk_wishes', 'talk_stats')), 0,
          'the wishes are not in the realtime publication');

-- -----------------------------------------------------------------------
-- 2. type の制約は既存の type を残している
-- -----------------------------------------------------------------------
select ok((select bool_and(position('''' || t || '''' in pg_get_constraintdef(c.oid)) > 0)
             from pg_constraint c,
                  unnest(array['like', 'help', 'join', 'comment', 'reply', 'connection', 'similar',
                               'island', 'quiet_post', 'talk_wish', 'talk_match', 'dm']) t
            where c.conname = 'notifications_type_check'),
          'every old type is kept and the three new ones are added');
select throws_ok(
  $$insert into public.notifications(recipient_id, actor_id, type)
    values ('b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a1', null, 'nonsense')$$,
  '23514', null, 'unknown types are still refused');

-- -----------------------------------------------------------------------
-- 3. 押す（guest -> host）
-- -----------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub":"b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a2","role":"authenticated"}';

select throws_ok($$select public.press_talk('b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a2')$$,
                 'P0001', null, 'you cannot press yourself');
select throws_ok($$select public.press_talk('b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a3')$$,
                 'P0001', null, 'somebody who is not in a shared meeting cannot be pressed');
select throws_ok($$select public.press_talk(gen_random_uuid())$$,
                 'P0001', null, 'nor somebody who does not exist');
select is((select public.press_talk('b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a1')),
          '{"matched": false, "room_id": null}'::jsonb, 'a one-sided press answers matched=false');
select is((select public.press_talk('b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a1')),
          '{"matched": false, "room_id": null}'::jsonb, 'pressing again answers the same');
select is((select count(*)::int from public.my_talk_state()
            where target = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a1' and state = 'pressed'), 1,
          'I see that I pressed');
select is((select count(*)::int from public.talk_peers()), 2, 'my peers are the host and the other guest');
select throws_ok($$select * from public.talk_wishes$$, '42501', null, 'the wishes cannot be read');

-- guest two も host を押す
set local request.jwt.claims to '{"sub":"b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a4","role":"authenticated"}';
select lives_ok($$select public.press_talk('b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a1')$$, 'a second person presses');

reset role;
select is((select count(*)::int from public.notifications where type = 'talk_wish'), 1,
          'twice pressed and two people pressed: one notification, no count');
select is((select recipient_id from public.notifications where type = 'talk_wish'),
          'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a1'::uuid, 'it goes to the one pressed');
select ok((select actor_id is null and post_id is null and comment_id is null and island_id is null
                  and event_id is null and payload is null
             from public.notifications where type = 'talk_wish'),
          'the row carries nothing that points at who pressed or which meeting');
select is((select pressed from public.talk_stats), 2, 'pressed counts the two first presses, not the repeat');

-- host の画面: 名前なしの1行
set local role authenticated;
set local request.jwt.claims to '{"sub":"b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a1","role":"authenticated"}';
select is((select count(*)::int from public.notification_feed(50) where type = 'talk_wish'), 1,
          'the feed shows one line');
select ok((select actor_id is null and others = 0 and category = 'reaction' and post_id is null
             from public.notification_feed(50) where type = 'talk_wish'),
          'with no actor, no "and others", under reactions');
select is((select count(*)::int from public.my_talk_state()), 0,
          'the host cannot tell who pressed (nothing returned for being pressed)');

-- -----------------------------------------------------------------------
-- 4. 取り消し
-- -----------------------------------------------------------------------
set local request.jwt.claims to '{"sub":"b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a4","role":"authenticated"}';
select lives_ok($$select public.withdraw_talk('b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a1')$$, 'withdraw works');
select is((select count(*)::int from public.my_talk_state()), 0, 'and the press is gone');

-- 読まれたあとは、別の人に押されればすぐ新しい通知になる（24時間待たない）
reset role;
update public.notifications set read_at = now() where type = 'talk_wish';
set local role authenticated;
set local request.jwt.claims to '{"sub":"b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a4","role":"authenticated"}';
select lives_ok($$select public.press_talk('b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a1')$$,
                'another person presses after the notice was read');
reset role;
select is((select count(*)::int from public.notifications where type = 'talk_wish'), 2,
          'once read, the next press makes a new notice at once');
select is((select count(*)::int from public.notifications where type = 'talk_wish' and read_at is null), 1,
          'and only the new one is unread');
select ok((select actor_id is null and post_id is null and payload is null
             from public.notifications where type = 'talk_wish' and read_at is null),
          'the new one is as nameless as the first');

-- 押す→取り消す→押す: 同じ人から同じ人へは14日に1回まで（読まれたあとでも）
update public.notifications set read_at = now() where type = 'talk_wish';
set local role authenticated;
set local request.jwt.claims to '{"sub":"b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a2","role":"authenticated"}';
select lives_ok($$select public.withdraw_talk('b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a1')$$, 'withdraw again');
select lives_ok($$select public.press_talk('b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a1')$$, 'and press again after a read');
reset role;
select is((select count(*)::int from public.notifications where type = 'talk_wish'), 2,
          'press, withdraw, press by the same person: no new notice within 14 days, even after a read');
select is((select count(*)::int from public.talk_wish_notices), 2, 'two records: one per pair that was notified');

-- 14日たてば、同じ人からの通知がまた出る
update public.talk_wish_notices set notified_at = now() - interval '15 days'
 where from_id = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a2';
set local role authenticated;
set local request.jwt.claims to '{"sub":"b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a2","role":"authenticated"}';
select lives_ok($$select public.withdraw_talk('b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a1')$$, 'withdraw once more');
select lives_ok($$select public.press_talk('b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a1')$$, 'and press once more');
reset role;
select is((select count(*)::int from public.notifications where type = 'talk_wish'), 3,
          'after 14 days the same person can notify again');
select is((select count(*)::int from public.talk_wish_notices
            where from_id = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a2'
              and notified_at > now() - interval '1 minute'), 1, 'and the record is renewed');

-- 後始末（guest two の片思いを取り下げる）と、通知を書いた記録は誰からも読めない
update public.notifications set read_at = now() where type = 'talk_wish';
set local role authenticated;
set local request.jwt.claims to '{"sub":"b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a4","role":"authenticated"}';
select lives_ok($$select public.withdraw_talk('b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a1')$$, 'guest two takes back');
reset role;
select ok(not has_table_privilege('authenticated', 'public.talk_wish_notices', 'SELECT'),
          'the notice records cannot be read by the person who was pressed');
select ok(not has_table_privilege('anon', 'public.talk_wish_notices', 'SELECT'), 'nor by anon');
set local role authenticated;

-- -----------------------------------------------------------------------
-- 5. 両思い（host -> guest。guest はすでに host を押している）
-- -----------------------------------------------------------------------
set local request.jwt.claims to '{"sub":"b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a1","role":"authenticated"}';
select ok((select (r ->> 'matched')::boolean and (r ->> 'room_id') is not null
             from (select public.press_talk('b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a2') r) q),
          'a mutual press opens a room');
select is((select count(*)::int from public.my_talk_state() where state = 'matched' and room_id is not null), 1,
          'the host sees the room');
select is((select count(*)::int from public.dm_room_list()), 1, 'one room in the list');
select is((select other_name from public.dm_room_list()), 'guest', 'with the other person');
select is((select event_excerpt from public.dm_room_list()), '週末にみんなで集まります', 'and the meeting it came from');
select ok((select (r ->> 'matched')::boolean from (select public.press_talk('b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a2') r) q),
          'pressing again after the match says matched');

reset role;
select is((select count(*)::int from public.talk_wishes), 0, 'both wishes are gone after the match');
select is((select count(*)::int from public.dm_rooms), 1, 'one room, even after pressing twice');
select is((select count(*)::int from public.notifications where type = 'talk_match'), 2, 'two match notifications');
select is((select count(*)::int from public.notifications
            where type = 'talk_match'
              and ((recipient_id = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a1' and actor_id = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a2')
                or (recipient_id = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a2' and actor_id = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a1'))), 2,
          'each names the other person');
select is((select matched from public.talk_stats), 1, 'matched is counted once');

-- -----------------------------------------------------------------------
-- 6. 部屋とメッセージは2人だけ
-- -----------------------------------------------------------------------
create temp table room as select id from public.dm_rooms;
grant select on room to authenticated;

set local role authenticated;
set local request.jwt.claims to '{"sub":"b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a3","role":"authenticated"}';
select is((select count(*)::int from public.dm_rooms), 0, 'an outsider sees no room');
select throws_ok(
  $$insert into public.dm_messages(room_id, sender_id, body)
    select id, 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a3', 'hello' from room$$,
  '42501', null, 'an outsider cannot write in it');

set local request.jwt.claims to '{"sub":"b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a2","role":"authenticated"}';
select throws_ok(
  $$insert into public.dm_messages(room_id, sender_id, body)
    select id, 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a1', 'as host' from room$$,
  '42501', null, 'nobody writes in somebody else''s name');
select throws_ok(
  $$insert into public.dm_messages(room_id, sender_id, body)
    select id, 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a2', '   ' from room$$,
  '23514', null, 'an empty message is refused');
select throws_ok(
  $$insert into public.dm_messages(room_id, sender_id, body)
    select id, 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a2', repeat('あ', 1001) from room$$,
  '23514', null, 'a message over 1000 characters is refused');
select lives_ok(
  $$insert into public.dm_messages(room_id, sender_id, body)
    select id, 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a2', 'こんにちは' from room$$,
  'a member writes');
select lives_ok(
  $$insert into public.dm_messages(room_id, sender_id, body)
    select id, 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a2', 'もう一つ' from room$$,
  'and writes again');
select throws_ok($$update public.dm_messages set body = 'edited'$$, '42501', null, 'messages cannot be edited');
select throws_ok($$delete from public.dm_messages$$, '42501', null, 'nor deleted');
select is((select last_body from public.dm_room_list()), 'もう一つ', 'the list shows the latest message');

set local request.jwt.claims to '{"sub":"b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a3","role":"authenticated"}';
select is((select count(*)::int from public.dm_messages), 0, 'an outsider reads no message');

set local request.jwt.claims to '{"sub":"b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a1","role":"authenticated"}';
select is((select count(*)::int from public.dm_messages), 2, 'the other member reads both');

reset role;
select is((select count(*)::int from public.notifications
            where type = 'dm' and recipient_id = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a1'
              and actor_id = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a2'), 1,
          'two messages, one unread notification');
select ok((select post_id is null and comment_id is null and payload is null
             from public.notifications where type = 'dm'),
          'and it carries no text');

-- 10分より古い未読の dm 通知は、新しい通知を止めない（部屋を直接開いた人でも気づける）
update public.notifications set created_at = now() - interval '11 minutes' where type = 'dm';
insert into public.dm_messages(room_id, sender_id, body)
  select id, 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a2', 'また来ました' from public.dm_rooms;
select is((select count(*)::int from public.notifications
            where type = 'dm' and recipient_id = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a1'), 2,
          'an old unread dm notice does not mute a new one');
delete from public.dm_messages where body = 'また来ました';
delete from public.notifications where type = 'dm' and created_at > now() - interval '1 minute';

-- -----------------------------------------------------------------------
-- 7. ブロック
-- -----------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub":"b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a2","role":"authenticated"}';
select lives_ok(
  $$insert into public.dm_blocks(blocker_id, blocked_id)
    values ('b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a2', 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a1')$$,
  'guest blocks host');
select throws_ok(
  $$insert into public.dm_blocks(blocker_id, blocked_id)
    values ('b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a1', 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a3')$$,
  '42501', null, 'nobody blocks in somebody else''s name');
select throws_ok(
  $$insert into public.dm_messages(room_id, sender_id, body)
    select id, 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a2', 'still?' from room$$,
  '42501', null, 'the blocker cannot send either');
select is((select blocked_by_me from public.dm_room_list()), true, 'the list says I blocked');
select is((select count(*)::int from public.talk_peers()), 1, 'the blocked person leaves my peers');
select throws_ok($$select public.press_talk('b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a1')$$,
                 'P0001', null, 'a blocked person cannot be pressed');

set local request.jwt.claims to '{"sub":"b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a1","role":"authenticated"}';
select throws_ok(
  $$insert into public.dm_messages(room_id, sender_id, body)
    select id, 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a1', 'hello?' from room$$,
  '42501', null, 'the blocked person cannot send');
select is((select count(*)::int from public.dm_blocks), 0, 'and cannot see that they were blocked');
select is((select blocked_by_me from public.dm_room_list()), false, 'the list does not say so either');
select throws_ok($$select public.press_talk('b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a2')$$,
                 'P0001', null, 'the blocked person cannot press the blocker, with the same words');

set local request.jwt.claims to '{"sub":"b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a2","role":"authenticated"}';
select lives_ok(
  $$delete from public.dm_blocks where blocker_id = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a2'$$,
  'the block can be lifted');
select lives_ok(
  $$insert into public.dm_messages(room_id, sender_id, body)
    select id, 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a2', 'back again' from room$$,
  'and sending works again');

-- -----------------------------------------------------------------------
-- 8. 押した記録は消えない（15日前の片思いでも、押し返せば両思いになる）
-- -----------------------------------------------------------------------
reset role;
insert into public.talk_wishes(from_id, to_id, created_at)
values ('b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a4', 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a2', now() - interval '15 days');
set local role authenticated;
set local request.jwt.claims to '{"sub":"b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a4","role":"authenticated"}';
select ok(exists (select 1 from public.my_talk_state()
                   where target = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a2' and state = 'pressed'),
          'an old press (15 days) still shows as pressed');
select lives_ok($$select public.press_talk('b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a2')$$, 'a press by the same person again is harmless (the press cleanup no longer touches old rows)');
reset role;
select is((select count(*)::int from public.talk_wishes
            where from_id = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a4'
              and to_id = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a2'), 1, 'the 15-day-old press is kept');
set local role authenticated;
set local request.jwt.claims to '{"sub":"b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a2","role":"authenticated"}';
select is((public.press_talk('b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a4') ->> 'matched')::boolean, true,
          'pressing back after 15 days matches');
reset role;
select is((select count(*)::int from public.dm_rooms
            where least(user_a, user_b) = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a2'
              and greatest(user_a, user_b) = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a4'), 1, 'and the room exists');
select is((select count(*)::int from public.talk_wishes
            where (from_id = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a4' and to_id = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a2')
               or (from_id = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a2' and to_id = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a4')), 0,
          'a match removes both rows as before');

-- -----------------------------------------------------------------------
-- 9. 古いコードの書き方でも動く
-- -----------------------------------------------------------------------
select lives_ok(
  $$insert into public.notifications(recipient_id, actor_id, post_id, type)
    values ('b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a1', 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a2',
            '00000000-0000-4000-8000-000000001001', 'join')$$,
  'a join notification is written as before');
select lives_ok(
  $$insert into public.notifications(recipient_id, actor_id, type, payload, community_id)
    values ('b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a1', null, 'island', '{"name":"x"}', '10101010-1010-4010-8010-101010101010')$$,
  'an island notification still has no actor');
set local role authenticated;
set local request.jwt.claims to '{"sub":"b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1a1","role":"authenticated"}';
select is((select count(*)::int from public.notification_feed(50) where category = 'reaction' and type = 'join'), 1,
          'joins are still one chained line');
select is((select others from public.notification_feed(50) where type = 'island'), 0,
          'an island line has no "others"');
select ok((select every(category = 'reply') from public.notification_feed(50) where type = 'dm'),
          'dm sits under replies');

reset role;
select * from finish();
rollback;
