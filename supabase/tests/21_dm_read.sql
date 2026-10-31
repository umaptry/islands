-- 2026-10-31: DM の既読（dm_reads・mark_dm_read・dm_partner_read_at）。
-- Run with: supabase test db (CI does). Everybody here is made up.
begin;
select no_plan();

insert into auth.users(id) values
  ('d5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d5a1'),
  ('d5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d5a2'),
  ('d5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d5a3');
insert into public.accounts(id, display_name) values
  ('d5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d5a1', 'one'),
  ('d5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d5a2', 'two'),
  ('d5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d5a3', 'outsider')
on conflict (id) do nothing;

-- 部屋は one と two の2人。
insert into public.dm_rooms(id, user_a, user_b) values
  ('d6d6d6d6-d6d6-4d6d-8d6d-d6d6d6d6d6d6',
   'd5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d5a1', 'd5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d5a2');
delete from public.notifications;

-- -----------------------------------------------------------------------
-- 1. 権限
-- -----------------------------------------------------------------------
select ok(not has_table_privilege('anon', 'public.dm_reads', 'SELECT'), 'anon cannot read the table');
select ok(not has_table_privilege('authenticated', 'public.dm_reads', 'SELECT'), 'nor can a signed-in person');
select ok(not has_table_privilege('authenticated', 'public.dm_reads', 'INSERT'), 'nor write it');
select ok(not has_table_privilege('authenticated', 'public.dm_reads', 'UPDATE'), 'nor update it');
select ok(not has_table_privilege('authenticated', 'public.dm_reads', 'DELETE'), 'nor delete from it');
select is((select relrowsecurity from pg_class where oid = 'public.dm_reads'::regclass), true,
          'row level security is on');
select is((select count(*)::int from pg_policy where polrelid = 'public.dm_reads'::regclass), 0,
          'and there is no policy');
select is((select count(*)::int from pg_trigger
            where tgrelid = 'public.dm_reads'::regclass and not tgisinternal), 0, 'no triggers');
select ok(not has_function_privilege('anon', 'public.mark_dm_read(uuid)', 'execute'), 'anon cannot mark');
select ok(not has_function_privilege('anon', 'public.dm_partner_read_at(uuid)', 'execute'),
          'anon cannot ask');
select ok(has_function_privilege('authenticated', 'public.mark_dm_read(uuid)', 'execute'),
          'a signed-in person can mark');
select ok(has_function_privilege('authenticated', 'public.dm_partner_read_at(uuid)', 'execute'),
          'a signed-in person can ask');

-- -----------------------------------------------------------------------
-- 2. 部屋の2人: 記録して、相手が読める
-- -----------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub":"d5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d5a2","role":"authenticated"}';
select is((select public.dm_partner_read_at('d6d6d6d6-d6d6-4d6d-8d6d-d6d6d6d6d6d6')), null::timestamptz,
          'nothing is read yet');
select lives_ok($$select public.mark_dm_read('d6d6d6d6-d6d6-4d6d-8d6d-d6d6d6d6d6d6')$$, 'two marks the room');
select throws_ok($$select * from public.dm_reads$$, '42501', null, 'the table is not readable directly');
select is((select public.dm_partner_read_at('d6d6d6d6-d6d6-4d6d-8d6d-d6d6d6d6d6d6')), null::timestamptz,
          'my own time is not what I am told (only the partner is)');

set local request.jwt.claims to '{"sub":"d5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d5a1","role":"authenticated"}';
select ok((select public.dm_partner_read_at('d6d6d6d6-d6d6-4d6d-8d6d-d6d6d6d6d6d6')) is not null,
          'one sees when two read it');

-- 時刻は戻らない（先の時刻を入れておいて、もう一度記録しても動かない）。
reset role;
update public.dm_reads set read_at = now() + interval '1 day'
 where user_id = 'd5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d5a2';
set local role authenticated;
set local request.jwt.claims to '{"sub":"d5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d5a2","role":"authenticated"}';
select lives_ok($$select public.mark_dm_read('d6d6d6d6-d6d6-4d6d-8d6d-d6d6d6d6d6d6')$$, 'marking again');
reset role;
select ok((select read_at from public.dm_reads where user_id = 'd5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d5a2')
          > now() + interval '23 hours', 'the time never goes back');
update public.dm_reads set read_at = now() - interval '1 day'
 where user_id = 'd5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d5a2';
set local role authenticated;
set local request.jwt.claims to '{"sub":"d5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d5a2","role":"authenticated"}';
select lives_ok($$select public.mark_dm_read('d6d6d6d6-d6d6-4d6d-8d6d-d6d6d6d6d6d6')$$, 'marking once more');
reset role;
select ok((select read_at from public.dm_reads where user_id = 'd5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d5a2')
          > now() - interval '1 minute', 'an older time moves forward to now');
select is((select count(*)::int from public.dm_reads), 1, 'one row per person per room');

-- -----------------------------------------------------------------------
-- 3. 部屋の外の人・知らない部屋・ログインなし・anon
-- -----------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub":"d5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d5a3","role":"authenticated"}';
select lives_ok($$select public.mark_dm_read('d6d6d6d6-d6d6-4d6d-8d6d-d6d6d6d6d6d6')$$,
                'an outsider is not told anything (no error)');
select is((select public.dm_partner_read_at('d6d6d6d6-d6d6-4d6d-8d6d-d6d6d6d6d6d6')), null::timestamptz,
          'an outsider reads null');
select lives_ok($$select public.mark_dm_read(gen_random_uuid())$$, 'a room that does not exist is the same');
reset role;
select is((select count(*)::int from public.dm_reads where user_id = 'd5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d5a3'), 0,
          'and nothing was recorded for the outsider');

set local role authenticated;
set local request.jwt.claims to '{}';
select lives_ok($$select public.mark_dm_read('d6d6d6d6-d6d6-4d6d-8d6d-d6d6d6d6d6d6')$$, 'signed out: nothing happens');
select is((select public.dm_partner_read_at('d6d6d6d6-d6d6-4d6d-8d6d-d6d6d6d6d6d6')), null::timestamptz,
          'signed out: null');
reset role;
set local role anon;
select throws_ok($$select public.mark_dm_read('d6d6d6d6-d6d6-4d6d-8d6d-d6d6d6d6d6d6')$$,
                 '42501', null, 'anon cannot mark');
select throws_ok($$select public.dm_partner_read_at('d6d6d6d6-d6d6-4d6d-8d6d-d6d6d6d6d6d6')$$,
                 '42501', null, 'anon cannot ask');
reset role;

-- -----------------------------------------------------------------------
-- 4. ブロック（どちら向きでも、記録されず null。すでにある記録は動かず、見えない）
-- -----------------------------------------------------------------------
delete from public.dm_reads;
insert into public.dm_reads(room_id, user_id, read_at)
values ('d6d6d6d6-d6d6-4d6d-8d6d-d6d6d6d6d6d6', 'd5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d5a2', '2020-01-01 00:00:00+00');
insert into public.dm_blocks(blocker_id, blocked_id)
values ('d5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d5a1', 'd5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d5a2');
set local role authenticated;
set local request.jwt.claims to '{"sub":"d5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d5a1","role":"authenticated"}';
select is((select public.dm_partner_read_at('d6d6d6d6-d6d6-4d6d-8d6d-d6d6d6d6d6d6')), null::timestamptz,
          'the blocker reads null');
select lives_ok($$select public.mark_dm_read('d6d6d6d6-d6d6-4d6d-8d6d-d6d6d6d6d6d6')$$,
                'the blocker marks without an error');
set local request.jwt.claims to '{"sub":"d5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d5a2","role":"authenticated"}';
select lives_ok($$select public.mark_dm_read('d6d6d6d6-d6d6-4d6d-8d6d-d6d6d6d6d6d6')$$,
                'the blocked person marks without an error');
select is((select public.dm_partner_read_at('d6d6d6d6-d6d6-4d6d-8d6d-d6d6d6d6d6d6')), null::timestamptz,
          'the blocked person reads null (nothing says why)');
reset role;
select is((select count(*)::int from public.dm_reads), 1, 'nothing new was recorded under a block');
select is((select read_at from public.dm_reads), '2020-01-01 00:00:00+00'::timestamptz,
          'and the old row did not move');
delete from public.dm_blocks;

-- -----------------------------------------------------------------------
-- 5. 通知は出ない・部屋が消えると記録も消える
-- -----------------------------------------------------------------------
select is((select count(*)::int from public.notifications), 0, 'reading wrote no notification');
delete from public.dm_rooms where id = 'd6d6d6d6-d6d6-4d6d-8d6d-d6d6d6d6d6d6';
select is((select count(*)::int from public.dm_reads), 0, 'the records go with their room');

select * from finish();
rollback;
