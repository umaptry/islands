-- 2026-10-28: 「もっと話してみたい」は、少なくとも1つ同じコミュニティに入っている人どうしなら押せる。
-- Run with: supabase test db (CI does). Everybody here is made up.
begin;
select no_plan();

-- c01 c02: community K1 (c01 hosts a meeting, c02 joins). c03: K2 only. c04: K1 and K2. c05: K1 (blocked with c01). c06: nowhere.
insert into auth.users(id) values ('c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c401'), ('c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c402'), ('c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c403'), ('c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c404'), ('c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c405'), ('c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c406');
insert into public.accounts(id, display_name) values
  ('c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c401', 'c01'), ('c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c402', 'c02'), ('c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c403', 'c03'), ('c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c404', 'c04'), ('c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c405', 'c05'), ('c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c406', 'c06')
on conflict (id) do nothing;
insert into public.communities(id, name) values
  ('20202020-2020-4020-8020-202020202021', 'k1'), ('20202020-2020-4020-8020-202020202022', 'k2');
insert into public.community_members(community_id, account_id) values
  ('20202020-2020-4020-8020-202020202021', 'c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c401'),
  ('20202020-2020-4020-8020-202020202021', 'c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c402'),
  ('20202020-2020-4020-8020-202020202021', 'c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c404'),
  ('20202020-2020-4020-8020-202020202021', 'c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c405'),
  ('20202020-2020-4020-8020-202020202022', 'c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c403'),
  ('20202020-2020-4020-8020-202020202022', 'c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c404');
insert into public.posts(id, author_id, body, x, y, cluster_id, vec, vec_c, tags, community_id)
values ('00000000-0000-4000-8000-000000004001', 'c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c401', '週末の会', 1, 1, 0,
        array_fill(1.0, array[448])::vector(448), array_fill(1.0, array[448])::vector(448),
        array['参加者募集中'], '20202020-2020-4020-8020-202020202021');
insert into public.reactions(post_id, actor_id, kind) values
  ('00000000-0000-4000-8000-000000004001', 'c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c402', 'join');
insert into public.dm_blocks(blocker_id, blocked_id) values ('c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c405', 'c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c401');
delete from public.notifications;

select ok(not has_function_privilege('authenticated', 'public.talk_same_community(uuid, uuid)', 'execute'),
          'the community test is not callable from outside');
select ok(has_function_privilege('authenticated', 'public.talk_peers()', 'execute'), 'peers: signed-in people can call');
select ok(not has_function_privilege('anon', 'public.talk_peers()', 'execute'), 'peers: anon cannot');

-- c01 の peers: K1 の c02 c04 だけ（c05 はブロック、c03 は別のコミュニティ、c06 はどこにも入っていない）
set local role authenticated;
set local request.jwt.claims to '{"sub":"c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c401","role":"authenticated"}';
select is((select array_agg(account_id order by account_id) from public.talk_peers()),
          array['c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c402', 'c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c404']::uuid[],
          'c01 peers: the other members of K1 (not the blocked one, nor other communities)');
select throws_ok($$select public.press_talk('c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c403')$$, 'P0001', 'この相手には押せません。',
                 'a person in another community only cannot be pressed');
select throws_ok($$select public.press_talk('c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c406')$$, 'P0001', 'この相手には押せません。',
                 'nor a person in no community');
select throws_ok($$select public.press_talk('c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c405')$$, 'P0001', 'この相手には押せません。',
                 'nor a blocked person, with the same words');
select lives_ok($$select public.press_talk('c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c402')$$, 'c01 presses c02 (same community and a meeting)');
select lives_ok($$select public.press_talk('c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c404')$$, 'c01 presses c04 (same community, no meeting)');

-- c04 は K1 と K2 の両方: c01 も c03 も押せる
set local role authenticated;
set local request.jwt.claims to '{"sub":"c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c404","role":"authenticated"}';
select is((select array_agg(account_id order by account_id) from public.talk_peers()),
          array['c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c401', 'c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c402', 'c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c403', 'c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c405']::uuid[],
          'c04 peers: members of both communities');
select is((select (public.press_talk('c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c401') ->> 'matched')::boolean), true, 'c04 presses back: a room opens (no meeting in common)');
select is((select event_post_id from public.dm_rooms
            where user_a = least('c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c401', 'c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c404') and user_b = greatest('c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c401', 'c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c404')),
          null::uuid, 'a room without a common meeting has no event_post_id');

set local role authenticated;
set local request.jwt.claims to '{"sub":"c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c402","role":"authenticated"}';
select is((select (public.press_talk('c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c401') ->> 'matched')::boolean), true, 'c02 presses back: a room opens');
select is((select event_post_id from public.dm_rooms
            where user_a = least('c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c401', 'c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c402') and user_b = greatest('c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c401', 'c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c402')),
          '00000000-0000-4000-8000-000000004001'::uuid, 'a room with a common meeting carries it');

-- c03 (K2 のみ) は c04 だけ。c01 とは何もない
set local role authenticated;
set local request.jwt.claims to '{"sub":"c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c403","role":"authenticated"}';
select is((select array_agg(account_id order by account_id) from public.talk_peers()),
          array['c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c404']::uuid[], 'c03 peers: only c04');
select throws_ok($$select public.press_talk('c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c401')$$, 'P0001', 'この相手には押せません。', 'c03 cannot press c01');

-- c05 は c01 にブロックされている（どちら向きでも押せない）
set local role authenticated;
set local request.jwt.claims to '{"sub":"c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c405","role":"authenticated"}';
select throws_ok($$select public.press_talk('c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c401')$$, 'P0001', 'この相手には押せません。', 'the blocker cannot press the blocked either');
select is((select count(*)::int from public.talk_peers()), 2, 'c05 peers: c02 and c04 (not the person who blocked them)');

-- c06 はどこにも入っていない
set local role authenticated;
set local request.jwt.claims to '{"sub":"c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c406","role":"authenticated"}';
select is((select count(*)::int from public.talk_peers()), 0, 'c06 has no peers');
reset role;

select * from finish();
rollback;
