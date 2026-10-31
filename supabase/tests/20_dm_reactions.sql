-- 2026-10-31: DM の吹き出しへの絵文字の反応（dm_reactions と react_dm）。
-- Run with: supabase test db (CI does). Everybody here is made up.
begin;
select no_plan();

insert into auth.users(id) values
  ('d2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2a1'),
  ('d2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2a2'),
  ('d2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2a3');
insert into public.accounts(id, display_name) values
  ('d2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2a1', 'one'),
  ('d2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2a2', 'two'),
  ('d2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2a3', 'outsider')
on conflict (id) do nothing;

-- 部屋は one と two の2人。メッセージは one が1通、two が1通。
insert into public.dm_rooms(id, user_a, user_b) values
  ('d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d3d3',
   'd2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2a1', 'd2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2a2');
insert into public.dm_messages(id, room_id, sender_id, body) values
  ('d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4a1', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d3d3',
   'd2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2a1', 'こんにちは'),
  ('d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4a2', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d3d3',
   'd2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2a2', 'どうも');
delete from public.notifications;

-- -----------------------------------------------------------------------
-- 1. 権限
-- -----------------------------------------------------------------------
select ok(not has_table_privilege('anon', 'public.dm_reactions', 'SELECT'), 'anon cannot read reactions');
select ok(has_table_privilege('authenticated', 'public.dm_reactions', 'SELECT'),
          'a signed-in person can read (RLS narrows it to the room)');
select ok(not has_table_privilege('authenticated', 'public.dm_reactions', 'INSERT'),
          'reactions are written by the function only');
select ok(not has_table_privilege('authenticated', 'public.dm_reactions', 'UPDATE'), 'not updatable');
select ok(not has_table_privilege('authenticated', 'public.dm_reactions', 'DELETE'), 'not deletable');
select ok(not has_function_privilege('anon', 'public.react_dm(uuid, text)', 'execute'), 'anon cannot react');
select ok(has_function_privilege('authenticated', 'public.react_dm(uuid, text)', 'execute'),
          'a signed-in person can react');
select is((select relrowsecurity from pg_class where oid = 'public.dm_reactions'::regclass), true,
          'row level security is on');
select is((select count(*)::int from pg_trigger
            where tgrelid = 'public.dm_reactions'::regclass and not tgisinternal), 0,
          'no triggers (no maintenance trigger, no notification)');

-- -----------------------------------------------------------------------
-- 2. 付ける・付け替える・外す（two）
-- -----------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub":"d2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2a2","role":"authenticated"}';

select is((select public.react_dm('d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4a1', 'heart')),
          '{"kind": "heart"}'::jsonb, 'a reaction is added');
select is((select kind from public.dm_reactions where account_id = 'd2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2a2'),
          'heart', 'and stored as its key');
select is((select room_id from public.dm_reactions where account_id = 'd2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2a2'),
          'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d3d3'::uuid, 'the room comes from the message');
select is((select public.react_dm('d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4a1', 'thumbs')),
          '{"kind": "thumbs"}'::jsonb, 'a different one swaps it');
select is((select count(*)::int from public.dm_reactions
            where message_id = 'd4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4a1'), 1, 'one per person per message');
select is((select public.react_dm('d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4a1', 'thumbs')),
          '{"kind": null}'::jsonb, 'the same one again takes it off');
select is((select count(*)::int from public.dm_reactions), 0, 'and nothing is left');
select lives_ok($$select public.react_dm('d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4a2', 'pray')$$,
                'my own message can be reacted to as well');
select throws_ok($$select public.react_dm('d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4a1', 'party')$$,
                 'P0001', null, 'an unknown kind is refused');
select throws_ok($$select public.react_dm('d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4a1', null)$$,
                 'P0001', null, 'and so is no kind');
select throws_ok(
  $$insert into public.dm_reactions(message_id, room_id, account_id, kind)
    values ('d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4a1', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d3d3',
            'd2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2a2', 'heart')$$,
  '42501', null, 'a direct insert is refused');
select throws_ok($$update public.dm_reactions set kind = 'sad'$$, '42501', null, 'a direct update is refused');
select throws_ok($$delete from public.dm_reactions$$, '42501', null, 'a direct delete is refused');

-- one も付ける。2人とも読める。
set local request.jwt.claims to '{"sub":"d2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2a1","role":"authenticated"}';
select lives_ok($$select public.react_dm('d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4a2', 'pray')$$,
                'the other person reacts too');
select is((select count(*)::int from public.dm_reactions), 2, 'both people read both reactions');

-- -----------------------------------------------------------------------
-- 3. 部屋の外の人（outsider）
-- -----------------------------------------------------------------------
set local request.jwt.claims to '{"sub":"d2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2a3","role":"authenticated"}';
select is((select count(*)::int from public.dm_reactions), 0, 'an outsider reads no reaction');
select throws_ok($$select public.react_dm('d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4a1', 'heart')$$,
                 '42501', null, 'an outsider cannot react');
select throws_ok($$select public.react_dm(gen_random_uuid(), 'heart')$$,
                 '42501', null, 'nor to a message that does not exist, with the same words');

-- ログインしていない・anon
set local request.jwt.claims to '{}';
select throws_ok($$select public.react_dm('d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4a1', 'heart')$$,
                 'P0001', null, 'signing in is required');
reset role;
set local role anon;
select throws_ok($$select public.react_dm('d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4a1', 'heart')$$,
                 '42501', null, 'anon cannot call it');

-- -----------------------------------------------------------------------
-- 4. ブロック（どちら向きでも付けられない。付いていた反応は残る）
-- -----------------------------------------------------------------------
reset role;
insert into public.dm_blocks(blocker_id, blocked_id)
values ('d2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2a1', 'd2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2a2');
set local role authenticated;
set local request.jwt.claims to '{"sub":"d2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2a2","role":"authenticated"}';
select throws_ok($$select public.react_dm('d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4a1', 'heart')$$,
                 '42501', null, 'the blocked person cannot react (the words say nothing about a block)');
set local request.jwt.claims to '{"sub":"d2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2a1","role":"authenticated"}';
select throws_ok($$select public.react_dm('d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4a2', 'heart')$$,
                 '42501', null, 'nor can the blocker');
select is((select count(*)::int from public.dm_reactions), 2, 'what was already there stays');

-- -----------------------------------------------------------------------
-- 5. 通知は出ない・メッセージが消えると反応も消える
-- -----------------------------------------------------------------------
reset role;
delete from public.dm_blocks;
select is((select count(*)::int from public.notifications), 0, 'reacting wrote no notification');
delete from public.dm_messages where id = 'd4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4a2';
select is((select count(*)::int from public.dm_reactions), 0, 'reactions go with their message');
set local role authenticated;
set local request.jwt.claims to '{"sub":"d2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2a1","role":"authenticated"}';
select lives_ok($$select public.react_dm('d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4a1', 'wow')$$, 'react again');
reset role;
delete from public.dm_rooms where id = 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d3d3';
select is((select count(*)::int from public.dm_reactions), 0, 'reactions go with their room');

select * from finish();
rollback;
