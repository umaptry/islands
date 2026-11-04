-- 2026-11-05: LINE の「受け付けました」（20261112000000_line_applied.sql）。
-- Run with: supabase test db (CI does). Everybody here is made up.
--
-- 役（アカウント id の末尾）: 01 主催者 / 11 LINE で申し込む人 / 12 メールで申し込む人 / 13 取り消した人 / 14 中止の会に申し込んだ人
-- 会: 01（10日後）/ 02（10日後。あとで中止）
begin;
select no_plan();

insert into auth.users(id, email) values
  ('c6c6c6c6-c6c6-4c6c-8c6c-c6c6c6c6c601', 'h@example.test'),
  ('c6c6c6c6-c6c6-4c6c-8c6c-c6c6c6c6c611', 'g1@example.test'), ('c6c6c6c6-c6c6-4c6c-8c6c-c6c6c6c6c612', 'g2@example.test'),
  ('c6c6c6c6-c6c6-4c6c-8c6c-c6c6c6c6c613', 'g3@example.test'), ('c6c6c6c6-c6c6-4c6c-8c6c-c6c6c6c6c614', 'g4@example.test');
insert into public.accounts(id, display_name, affiliation, name_confirmed_at) values
  ('c6c6c6c6-c6c6-4c6c-8c6c-c6c6c6c6c601', 'host', '店', now());

select public.create_community('BAR', 'la-bar', 'c6c6c6c6-c6c6-4c6c-8c6c-c6c6c6c6c601');
create temp table cm as select (select id from public.communities where slug = 'la-bar') as bar;
grant select on cm to anon, authenticated, service_role;

create function pg_temp.vec() returns vector(448) language sql immutable as $$
  select array_fill(1.0, array[448])::vector(448) $$;
create function pg_temp.prof(nm text) returns jsonb language sql as $$
  select jsonb_build_object('display_name', nm, 'affiliation', '会社X') $$;
create function pg_temp.queued(acc uuid, ev uuid) returns int language sql as $$
  select count(*)::int from public.outbound_messages
   where account_id = acc and event_id = ev and kind = 'applied' and sent_at is null and scheduled_at <= now() $$;

insert into public.posts(id, author_id, body, tags, x, y, cluster_id, vec, vec_c, community_id, recruit_capacity) values
  ('00000000-0000-4000-8000-0000000c6001', 'c6c6c6c6-c6c6-4c6c-8c6c-c6c6c6c6c601', '会 01', array['参加者募集中'], 1, 1, 0, pg_temp.vec(), pg_temp.vec(), (select bar from cm), 10),
  ('00000000-0000-4000-8000-0000000c6002', 'c6c6c6c6-c6c6-4c6c-8c6c-c6c6c6c6c601', '会 02', array['参加者募集中'], 2, 2, 0, pg_temp.vec(), pg_temp.vec(), (select bar from cm), 10);
select public.event_create('00000000-0000-4000-8000-0000000c6001', 'c6c6c6c6-c6c6-4c6c-8c6c-c6c6c6c6c601', '会 01',
                           now() + interval '10 days', now() + interval '10 days 2 hours', '場所', 'public', '[]');
select public.event_create('00000000-0000-4000-8000-0000000c6002', 'c6c6c6c6-c6c6-4c6c-8c6c-c6c6c6c6c601', '会 02',
                           now() + interval '10 days', now() + interval '10 days 2 hours', '場所', 'public', '[]');

-- -----------------------------------------------------------------------
-- 1. 権限と check
-- -----------------------------------------------------------------------
select ok(not has_function_privilege('anon', 'public.event_queue_applied(uuid, uuid)', 'execute'), 'anon cannot queue');
select ok(not has_function_privilege('authenticated', 'public.event_queue_applied(uuid, uuid)', 'execute'), 'signed-in people cannot queue');
select ok(has_function_privilege('service_role', 'public.event_queue_applied(uuid, uuid)', 'execute'), 'the server key can');
select is((select count(*)::int from pg_constraint where conrelid = 'public.outbound_messages'::regclass and contype = 'c'
            and pg_get_constraintdef(oid) like '%kind%'), 1, 'only one check on kind');
select throws_ok($$insert into public.outbound_messages (event_id, account_id, kind, scheduled_at)
                   values ('00000000-0000-4000-8000-0000000c6001', 'c6c6c6c6-c6c6-4c6c-8c6c-c6c6c6c6c611', 'promo', now())$$,
                 '23514', null, 'other kinds are still refused');

-- -----------------------------------------------------------------------
-- 2. LINE で申し込んだ人だけ
-- -----------------------------------------------------------------------
select public.event_apply('00000000-0000-4000-8000-0000000c6001', 'c6c6c6c6-c6c6-4c6c-8c6c-c6c6c6c6c611', pg_temp.prof('一 郎'), 'line', null, '[]', null);
select public.event_apply('00000000-0000-4000-8000-0000000c6001', 'c6c6c6c6-c6c6-4c6c-8c6c-c6c6c6c6c612', pg_temp.prof('二 郎'), 'email', null, '[]', null);
select is(public.event_queue_applied('00000000-0000-4000-8000-0000000c6001', 'c6c6c6c6-c6c6-4c6c-8c6c-c6c6c6c6c611'), true, 'LINE applicant: queued');
select is(pg_temp.queued('c6c6c6c6-c6c6-4c6c-8c6c-c6c6c6c6c611', '00000000-0000-4000-8000-0000000c6001'), 1, 'one applied message, due now');
select is(public.event_queue_applied('00000000-0000-4000-8000-0000000c6001', 'c6c6c6c6-c6c6-4c6c-8c6c-c6c6c6c6c612'), false, 'email applicant: not queued');
select is((select count(*)::int from public.outbound_messages where account_id = 'c6c6c6c6-c6c6-4c6c-8c6c-c6c6c6c6c612'), 0, 'nothing for the email applicant');
select is(public.event_queue_applied('00000000-0000-4000-8000-0000000c6001', 'c6c6c6c6-c6c6-4c6c-8c6c-c6c6c6c6c614'), false, 'no registration: not queued');

-- 2回呼んでも1行
select public.event_queue_applied('00000000-0000-4000-8000-0000000c6001', 'c6c6c6c6-c6c6-4c6c-8c6c-c6c6c6c6c611');
select is((select count(*)::int from public.outbound_messages where account_id = 'c6c6c6c6-c6c6-4c6c-8c6c-c6c6c6c6c611' and kind = 'applied'), 1, 'still one row');

-- 取り出せる（LINE の友だちのとき）
insert into public.line_links (account_id, line_user_id, is_friend) values ('c6c6c6c6-c6c6-4c6c-8c6c-c6c6c6c6c611', 'Uc6test11', true);
select is((select array_agg(kind order by kind) from public.outbound_claim(50, 300) where account_id = 'c6c6c6c6-c6c6-4c6c-8c6c-c6c6c6c6c611'),
          array['applied'], 'outbound_claim picks the applied message now (the others are later)');

-- -----------------------------------------------------------------------
-- 3. 取り消した人・中止の会
-- -----------------------------------------------------------------------
select public.event_apply('00000000-0000-4000-8000-0000000c6001', 'c6c6c6c6-c6c6-4c6c-8c6c-c6c6c6c6c613', pg_temp.prof('三 郎'), 'line', null, '[]', null);
select public.event_queue_applied('00000000-0000-4000-8000-0000000c6001', 'c6c6c6c6-c6c6-4c6c-8c6c-c6c6c6c6c613');
select public.event_cancel_registration('00000000-0000-4000-8000-0000000c6001', 'c6c6c6c6-c6c6-4c6c-8c6c-c6c6c6c6c613');
select is(pg_temp.queued('c6c6c6c6-c6c6-4c6c-8c6c-c6c6c6c6c613', '00000000-0000-4000-8000-0000000c6001'), 0, 'cancelling drops the unsent message');
select is(public.event_queue_applied('00000000-0000-4000-8000-0000000c6001', 'c6c6c6c6-c6c6-4c6c-8c6c-c6c6c6c6c613'), false, 'a cancelled registration is not queued');

-- 送ったあとに取り消して申し込み直すと、新しい id の行でもう一度送る（LINE の再送キーは id から作る）
select public.event_apply('00000000-0000-4000-8000-0000000c6001', 'c6c6c6c6-c6c6-4c6c-8c6c-c6c6c6c6c613', '{}', 'line', null, '[]', null);
select public.event_queue_applied('00000000-0000-4000-8000-0000000c6001', 'c6c6c6c6-c6c6-4c6c-8c6c-c6c6c6c6c613');
create temp table first_send as
  select id from public.outbound_messages
   where account_id = 'c6c6c6c6-c6c6-4c6c-8c6c-c6c6c6c6c613' and kind = 'applied';
update public.outbound_messages set sent_at = now()
 where account_id = 'c6c6c6c6-c6c6-4c6c-8c6c-c6c6c6c6c613' and kind = 'applied';
select public.event_cancel_registration('00000000-0000-4000-8000-0000000c6001', 'c6c6c6c6-c6c6-4c6c-8c6c-c6c6c6c6c613');
select public.event_apply('00000000-0000-4000-8000-0000000c6001', 'c6c6c6c6-c6c6-4c6c-8c6c-c6c6c6c6c613', '{}', 'line', null, '[]', null);
select is(public.event_queue_applied('00000000-0000-4000-8000-0000000c6001', 'c6c6c6c6-c6c6-4c6c-8c6c-c6c6c6c6c613'), true, 'applying again: queued again');
select is(pg_temp.queued('c6c6c6c6-c6c6-4c6c-8c6c-c6c6c6c6c613', '00000000-0000-4000-8000-0000000c6001'), 1, 'one unsent applied message');
select ok((select id from public.outbound_messages where account_id = 'c6c6c6c6-c6c6-4c6c-8c6c-c6c6c6c6c613' and kind = 'applied')
          <> (select id from first_send), 'with a new id');

-- お断りで、未送信の「受け付けました」は消える
select public.event_decline('00000000-0000-4000-8000-0000000c6001', 'c6c6c6c6-c6c6-4c6c-8c6c-c6c6c6c6c601', 'c6c6c6c6-c6c6-4c6c-8c6c-c6c6c6c6c613');
select is(pg_temp.queued('c6c6c6c6-c6c6-4c6c-8c6c-c6c6c6c6c613', '00000000-0000-4000-8000-0000000c6001'), 0, 'declining drops the unsent message');

select public.event_apply('00000000-0000-4000-8000-0000000c6002', 'c6c6c6c6-c6c6-4c6c-8c6c-c6c6c6c6c614', pg_temp.prof('四 郎'), 'line', null, '[]', null);
update public.events set cancelled_at = now() where post_id = '00000000-0000-4000-8000-0000000c6002';
select is(public.event_queue_applied('00000000-0000-4000-8000-0000000c6002', 'c6c6c6c6-c6c6-4c6c-8c6c-c6c6c6c6c614'), false, 'a cancelled event is not queued');

select * from finish();
rollback;
