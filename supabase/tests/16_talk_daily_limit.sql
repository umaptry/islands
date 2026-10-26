-- 2026-10-28: 「もっと話してみたい」は、押す人ごとに1日20人まで。
-- Run with: supabase test db (CI does). Everybody here is made up.
begin;
select no_plan();

-- 24 people d5..00 - d5..23, all in community K1. p = ..00 presses ..01 - ..21.
-- q = ..22 and r = ..23 are for the "pressing back counts" case.
insert into auth.users(id)
select ('d5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d5' || lpad(i::text, 2, '0'))::uuid from generate_series(0, 23) i;
insert into public.accounts(id, display_name)
select ('d5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d5' || lpad(i::text, 2, '0'))::uuid, 'd' || i from generate_series(0, 23) i
on conflict (id) do nothing;
insert into public.communities(id, name) values ('30303030-3030-4030-8030-303030303031', 'k1');
insert into public.community_members(community_id, account_id)
select '30303030-3030-4030-8030-303030303031'::uuid, ('d5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d5' || lpad(i::text, 2, '0'))::uuid from generate_series(0, 23) i;
delete from public.notifications;

select ok(not has_table_privilege('authenticated', 'public.talk_daily_presses', 'select'), 'the count table is closed to signed-in people');
select ok(not has_table_privilege('anon', 'public.talk_daily_presses', 'select'), 'and to anon');
select ok(not has_table_privilege('authenticated', 'public.talk_daily_presses', 'insert'), 'nobody writes it from outside');
select ok((select relrowsecurity from pg_class where oid = 'public.talk_daily_presses'::regclass), 'row level security is on');
select ok(has_function_privilege('authenticated', 'public.press_talk(uuid)', 'execute'), 'press_talk is still callable by signed-in people');
select ok(not has_function_privilege('anon', 'public.press_talk(uuid)', 'execute'), 'and not by anon');

-- p presses 20 people: all fine
set local role authenticated;
set local request.jwt.claims to '{"sub":"d5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d500","role":"authenticated"}';
select lives_ok($$select public.press_talk(('d5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d5' || lpad(i::text, 2, '0'))::uuid) from generate_series(1, 20) i$$,
                'p presses 20 different people');
-- the same person again: not counted, not refused (same answer as before)
select is((select (public.press_talk('d5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d501') ->> 'matched')::boolean), false, 'pressing the same person again answers the same');
-- the 21st new person is refused with the words the screen shows
select throws_ok($$select public.press_talk('d5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d521')$$, 'P0001',
                 '今日はここまでです。「もっと話してみたい」を押せるのは1日20人までで、明日（0時すぎ）からまた押せます。',
                 'the 21st person is refused');
-- taking a press back does not give the count back
select lives_ok($$select public.withdraw_talk('d5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d501')$$, 'p takes one back');
select throws_ok($$select public.press_talk('d5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d501')$$, 'P0001',
                 '今日はここまでです。「もっと話してみたい」を押せるのは1日20人までで、明日（0時すぎ）からまた押せます。',
                 'press, take back, press again: still counted, so refused');
-- the refused press left nothing behind
reset role;
select is((select presses from public.talk_daily_presses where account_id = 'd5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d500'),
          20, 'the count stays at 20');
select is((select count(*)::int from public.talk_wishes where from_id = 'd5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d500'),
          19, 'the refused presses wrote no wish (20 pressed, 1 taken back)');

-- the next day: the old count does not apply
update public.talk_daily_presses set day = day - 1 where account_id = 'd5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d500';
set local role authenticated;
set local request.jwt.claims to '{"sub":"d5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d500","role":"authenticated"}';
select lives_ok($$select public.press_talk('d5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d521')$$, 'a new day: p can press again');
reset role;
select is((select presses from public.talk_daily_presses
            where account_id = 'd5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d500' and day = ((now() at time zone 'UTC') + interval '9 hours')::date),
          1, 'today starts from 1');

-- rows older than 2 days are swept away by the next press
update public.talk_daily_presses set day = day - 5 where account_id = 'd5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d500' and presses = 20;
set local role authenticated;
set local request.jwt.claims to '{"sub":"d5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d501","role":"authenticated"}';
select lives_ok($$select public.press_talk('d5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d502')$$, 'another person presses (this sweeps old rows)');
reset role;
select is((select count(*)::int from public.talk_daily_presses where day < ((now() at time zone 'UTC') + interval '9 hours')::date - 1),
          0, 'rows older than 2 days are gone');

-- pressing back (a room opens) counts as one person too.
-- r presses q first (r: 1). q presses 19 others (19), then presses r back (20): a room opens. The next new one is refused.
set local role authenticated;
set local request.jwt.claims to '{"sub":"d5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d523","role":"authenticated"}';
select lives_ok($$select public.press_talk('d5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d522')$$, 'r presses q');
set local request.jwt.claims to '{"sub":"d5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d522","role":"authenticated"}';
select lives_ok($$select public.press_talk(('d5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d5' || lpad(i::text, 2, '0'))::uuid) from generate_series(1, 19) i$$,
                'q presses 19 people');
select is((select (public.press_talk('d5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d523') ->> 'matched')::boolean), true, 'q presses r back: a room opens (the 20th)');
-- a room that already exists is not counted and not refused
select is((select (public.press_talk('d5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d523') ->> 'matched')::boolean), true, 'pressing a person with a room answers the same, even at the limit');
select throws_ok($$select public.press_talk('d5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d520')$$, 'P0001',
                 '今日はここまでです。「もっと話してみたい」を押せるのは1日20人までで、明日（0時すぎ）からまた押せます。',
                 'q has pressed 20 (the match counted as one): the next is refused');
reset role;
select is((select presses from public.talk_daily_presses where account_id = 'd5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d522'), 20, 'q is at 20');
select is((select count(*)::int from public.dm_rooms
            where user_a = least('d5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d522'::uuid, 'd5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d523'::uuid)
              and user_b = greatest('d5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d522'::uuid, 'd5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d523'::uuid)),
          1, 'the room is there');

select * from finish();
rollback;
