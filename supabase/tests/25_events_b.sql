-- 2026-11-11: 会の開催条件と第2回b（20261111000000_events_b.sql）。
-- Run with: supabase test db (CI does). Everybody here is made up.
--
-- 役（アカウント id の末尾）:
--   h 主催者（BAR の管理者）/ m1 m2 メンバー（BAR）/
--   g1〜g4 申し込みで判定を確かめる人 / ga gb gc 入り方 auto・ask・none の会に申し込む人 /
--   gd ge 飛び入り / gf 自分で取り消した人 / gg gh キャンセル期限 / gx 外された人
--   （g… は最初は auth.users だけ。accounts の行が無い）。
-- 会: e1（判定 → held）/ e2（判定日を過ぎて not_held）/ e3（毎分の判定）/ e4（会を変える）/ e5（期限切れ）/
--     ea・ek・en（もうすぐ始まる。入り方 auto・ask・none）/ ex（もうすぐ始まるが中止）。
begin;
select no_plan();

insert into auth.users(id, email) values
  ('b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b501', 'h@example.test'), ('b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b502', 'm1@example.test'),
  ('b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b503', 'm2@example.test'),
  ('b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b511', 'g1@example.test'), ('b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b512', 'g2@example.test'),
  ('b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b513', 'g3@example.test'), ('b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b514', 'g4@example.test'),
  ('b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b521', 'ga@example.test'), ('b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b522', 'gb@example.test'),
  ('b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b523', 'gc@example.test'), ('b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b524', 'gd@example.test'),
  ('b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b525', 'ge@example.test'), ('b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b526', 'gf@example.test'),
  ('b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b527', 'gg@example.test'), ('b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b528', 'gh@example.test'),
  ('b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b529', 'gx@example.test');
insert into public.accounts(id, display_name, affiliation, name_confirmed_at) values
  ('b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b501', 'host', '店', now()), ('b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b502', 'member1', '会社', now()),
  ('b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b503', 'member2', '会社', now());

select public.create_community('BAR', 'eb-bar', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b501');
create temp table cm as select (select id from public.communities where slug = 'eb-bar') as bar;
grant select on cm to anon, authenticated, service_role;
insert into public.community_members(community_id, account_id, role) values
  ((select bar from cm), 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b502', 'member'), ((select bar from cm), 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b503', 'member');
-- gx は BAR から外されている／ga は BAR に承認待ちで申し込んでいる（受付で入ったら消える）
insert into public.community_removals(community_id, account_id) values ((select bar from cm), 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b529');
insert into public.community_join_requests(community_id, account_id, status) values ((select bar from cm), 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b521', 'pending');

create function pg_temp.vecs() returns text language sql immutable as $$
  select array_fill(0.1::real, array[448])::vector(448)::text $$;
create function pg_temp.ans(prompts text[]) returns jsonb language sql as $$
  select coalesce(jsonb_agg(jsonb_build_object('prompt', p, 'body', p || 'の答え', 'vec', pg_temp.vecs(), 'vec_c', pg_temp.vecs(),
                                               'x', 1.5, 'y', 2.5, 'cluster_id', 3, 'terms', '["a"]'::jsonb)), '[]'::jsonb)
    from unnest(prompts) p $$;
create function pg_temp.prof(nm text) returns jsonb language sql as $$
  select jsonb_build_object('display_name', nm, 'affiliation', '会社X', 'age_band', '30s', 'job_title', '設計') $$;
create function pg_temp.hint_of(q text) returns text language plpgsql as $$
declare h text; m text; begin
  execute q; return 'none';
exception when others then
  get stacked diagnostics h = pg_exception_hint, m = message_text;
  return case when h ~ '^[a-z_]+$' then h else m end;
end $$;
create function pg_temp.state_of(q text) returns text language plpgsql as $$
begin execute q; return 'none'; exception when others then return sqlstate; end $$;
create function pg_temp.vec() returns vector(448) language sql immutable as $$
  select array_fill(1.0, array[448])::vector(448) $$;

-- 会の投稿（e1〜e5・e9 は10日後、ea・ek・en・ex は1時間後に始まる＝受付の時間の中）
insert into public.posts(id, author_id, body, tags, x, y, cluster_id, vec, vec_c, community_id, recruit_capacity) values
  ('00000000-0000-4000-8000-0000000b5001', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b501', '会 e1', array['参加者募集中'], 1, 1, 0, pg_temp.vec(), pg_temp.vec(), (select bar from cm), 5),
  ('00000000-0000-4000-8000-0000000b5002', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b501', '会 e2', array['参加者募集中'], 2, 2, 0, pg_temp.vec(), pg_temp.vec(), (select bar from cm), 5),
  ('00000000-0000-4000-8000-0000000b5003', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b501', '会 e3', array['参加者募集中'], 3, 3, 0, pg_temp.vec(), pg_temp.vec(), (select bar from cm), 5),
  ('00000000-0000-4000-8000-0000000b5004', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b501', '会 e4', array['参加者募集中'], 4, 4, 0, pg_temp.vec(), pg_temp.vec(), (select bar from cm), 5),
  ('00000000-0000-4000-8000-0000000b5005', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b501', '会 e5', array['参加者募集中'], 5, 5, 0, pg_temp.vec(), pg_temp.vec(), (select bar from cm), 5),
  ('00000000-0000-4000-8000-0000000b5006', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b501', '会 ea', array['参加者募集中'], 6, 6, 0, pg_temp.vec(), pg_temp.vec(), (select bar from cm), 10),
  ('00000000-0000-4000-8000-0000000b5007', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b501', '会 ek', array['参加者募集中'], 7, 7, 0, pg_temp.vec(), pg_temp.vec(), (select bar from cm), 10),
  ('00000000-0000-4000-8000-0000000b5008', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b501', '会 en', array['参加者募集中'], 8, 8, 0, pg_temp.vec(), pg_temp.vec(), (select bar from cm), 10),
  ('00000000-0000-4000-8000-0000000b5009', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b501', '会 e9', array['参加者募集中'], 9, 9, 0, pg_temp.vec(), pg_temp.vec(), (select bar from cm), 5),
  ('00000000-0000-4000-8000-0000000b5010', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b501', '会 ex', array['参加者募集中'], 10, 10, 0, pg_temp.vec(), pg_temp.vec(), (select bar from cm), 10);

create temp table q3 as
  select '[{"prompt":"now","label":"最近やってること"},{"prompt":"past","label":"昔やってたこと"},{"prompt":"future","label":"これからやりたいこと"}]'::jsonb as q;
grant select on q3 to anon, authenticated, service_role;
-- s・e: 10日後の会 / sd: その開始日（JST）/ today: JST の今日 / s1・e1: 1時間後に始まる会
create temp table t0 as
  select now() + interval '10 days' as s, now() + interval '10 days 2 hours' as e,
         ((now() + interval '10 days') at time zone 'Asia/Tokyo')::date as sd,
         (now() at time zone 'Asia/Tokyo')::date as today,
         now() + interval '1 hour' as s1, now() + interval '3 hours' as e1;
grant select on t0 to anon, authenticated, service_role;

-- -----------------------------------------------------------------------
-- 1. 列と権限
-- -----------------------------------------------------------------------
select has_column('public', 'events', 'min_participants', 'events has min_participants');
select has_column('public', 'events', 'decide_on', 'events has decide_on');
select has_column('public', 'events', 'cancel_deadline', 'events has cancel_deadline');
select has_column('public', 'events', 'join_policy', 'events has join_policy');
select has_column('public', 'events', 'decision', 'events has decision');
select has_column('public', 'events', 'decided_at', 'events has decided_at');
select is((select count(*)::int from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'event_create'), 1,
          'there is only one event_create (the old 8-argument one is gone)');
select is((select pronargs::int from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'event_create'), 12,
          'it takes 12 arguments (4 new ones with defaults)');
select is((select array_agg(p.proname::text order by p.proname) from pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and p.proname in ('event_settle', 'event_settle_due', 'event_create', 'event_update', 'event_apply', 'event_cancel_registration',
                                'event_set_late', 'outbound_claim', 'event_checkin', 'event_walkin_request', 'event_checkin_by_host',
                                'event_reject_walkin', 'event_join_community', 'event_participants', 'event_participant_answers',
                                'event_after_people', 'event_meet')
              and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))),
          null::text[], 'the server-only functions (new and remade) cannot be run by anon or signed-in people');
select is((select count(*)::int from pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and p.proname in ('event_settle', 'event_settle_due', 'event_create', 'event_update', 'event_apply', 'event_cancel_registration',
                                'event_set_late', 'outbound_claim', 'event_checkin', 'event_walkin_request', 'event_checkin_by_host',
                                'event_reject_walkin', 'event_join_community', 'event_participants', 'event_participant_answers',
                                'event_after_people', 'event_meet')
              and has_function_privilege('service_role', p.oid, 'execute')), 17, 'the server key can run all 17');
select is((select array_agg(p.proname::text order by p.proname) from pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and p.proname in ('event_live_count', 'event_admit', 'event_after_attend', 'event_queue_reminders')
              and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))),
          null::text[], 'the inside-only functions cannot be run by anon or signed-in people');
set local role authenticated;
set local request.jwt.claims to '{"sub":"b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b502","role":"authenticated"}';
select is(pg_temp.state_of($$select public.event_checkin('00000000-0000-4000-8000-0000000b5006', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b502')$$),
          '42501', 'a member cannot call event_checkin');
select is(pg_temp.state_of($$select public.event_join_community('00000000-0000-4000-8000-0000000b5006', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b502')$$),
          '42501', 'nor event_join_community');
select is(pg_temp.state_of($$select public.event_create('00000000-0000-4000-8000-0000000b5009', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b501', '会', now() + interval '1 day', now() + interval '2 days', '', 'community', '[]')$$),
          '42501', 'nor the new event_create');
reset role;
reset request.jwt.claims;
set local role anon;
select is(pg_temp.state_of($$select * from public.event_participants('00000000-0000-4000-8000-0000000b5006')$$), '42501', 'anon cannot read the participants');
reset role;

-- -----------------------------------------------------------------------
-- 2. 会を作る（開催の条件）
-- -----------------------------------------------------------------------
-- 今のコード（8引数）のまま呼んでも作れる。最小人数なし・期限なし・auto
select is(pg_temp.hint_of($$select public.event_create('00000000-0000-4000-8000-0000000b5004', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b501', '会 e4', (select s from t0), (select e from t0), '場所', 'public', (select q from q3))$$),
          'none', 'the old 8-argument call still makes an event');
select is((select coalesce(min_participants::text, '-') || '/' || coalesce(decide_on::text, '-') || '/' || coalesce(cancel_deadline::text, '-') || '/' || join_policy
             from public.events where post_id = '00000000-0000-4000-8000-0000000b5004'), '-/-/-/auto', 'with no minimum, no deadline, and auto');
select is(pg_temp.hint_of($$select public.event_create('00000000-0000-4000-8000-0000000b5009', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b501', '会', (select s from t0), (select e from t0), '', 'public', '[]', 1::smallint, (select sd - 2 from t0))$$),
          'event_invalid', 'a minimum of 1 is refused');
select is(pg_temp.hint_of($$select public.event_create('00000000-0000-4000-8000-0000000b5009', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b501', '会', (select s from t0), (select e from t0), '', 'public', '[]', 6::smallint, (select sd - 2 from t0))$$),
          'event_invalid', 'a minimum above the capacity (5) is refused');
select is(pg_temp.hint_of($$select public.event_create('00000000-0000-4000-8000-0000000b5009', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b501', '会', (select s from t0), (select e from t0), '', 'public', '[]', 2::smallint, null)$$),
          'event_invalid', 'a minimum without a decision day is refused');
select is(pg_temp.hint_of($$select public.event_create('00000000-0000-4000-8000-0000000b5009', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b501', '会', (select s from t0), (select e from t0), '', 'public', '[]', null, (select sd - 2 from t0))$$),
          'event_invalid', 'a decision day without a minimum is refused');
select is(pg_temp.hint_of($$select public.event_create('00000000-0000-4000-8000-0000000b5009', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b501', '会', (select s from t0), (select e from t0), '', 'public', '[]', 2::smallint, (select sd from t0))$$),
          'event_invalid', 'the decision day cannot be the start day itself (it must be a day before)');
select is(pg_temp.hint_of($$select public.event_create('00000000-0000-4000-8000-0000000b5009', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b501', '会', (select s from t0), (select e from t0), '', 'public', '[]', 2::smallint, (select today - 1 from t0))$$),
          'event_invalid', 'the decision day cannot be in the past');
select is(pg_temp.hint_of($$select public.event_create('00000000-0000-4000-8000-0000000b5009', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b501', '会', (select s from t0), (select e from t0), '', 'public', '[]', null, null, (select s from t0))$$),
          'event_invalid', 'the cancel deadline must be before the start');
select is(pg_temp.hint_of($$select public.event_create('00000000-0000-4000-8000-0000000b5009', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b501', '会', (select s from t0), (select e from t0), '', 'public', '[]', null, null, null, 'maybe')$$),
          'event_invalid', 'an unknown join policy is refused');
select is((select count(*)::int from public.events where post_id = '00000000-0000-4000-8000-0000000b5009'), 0, 'none of the refused tries made an event');
select is(pg_temp.hint_of($$select public.event_create('00000000-0000-4000-8000-0000000b5001', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b501', '会 e1', (select s from t0), (select e from t0), '場所', 'public', (select q from q3),
                                                         2::smallint, (select sd - 2 from t0), (select s - interval '1 day' from t0), 'ask')$$),
          'none', 'an event with a minimum of 2, a decision day, a cancel deadline and "ask"');
select is((select min_participants || '/' || (decide_on = (select sd - 2 from t0)) || '/' || (cancel_deadline = (select s - interval '1 day' from t0)) || '/' || join_policy || '/' || coalesce(decision, '-')
             from public.events where post_id = '00000000-0000-4000-8000-0000000b5001'), '2/true/true/ask/-', 'the settings are saved and nothing is decided yet');
select public.event_create('00000000-0000-4000-8000-0000000b5002', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b501', '会 e2', (select s from t0), (select e from t0), '', 'public', (select q from q3), 3::smallint, (select sd - 2 from t0));
select public.event_create('00000000-0000-4000-8000-0000000b5003', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b501', '会 e3', (select s from t0), (select e from t0), '', 'public', (select q from q3), 2::smallint, (select sd - 2 from t0));
select public.event_create('00000000-0000-4000-8000-0000000b5005', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b501', '会 e5', (select s from t0), (select e from t0), '', 'public', (select q from q3), null, null, now() - interval '1 hour');
select public.event_create('00000000-0000-4000-8000-0000000b5006', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b501', '会 ea', (select s1 from t0), (select e1 from t0), '', 'public', (select q from q3), null, null, null, 'auto');
select public.event_create('00000000-0000-4000-8000-0000000b5007', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b501', '会 ek', (select s1 from t0), (select e1 from t0), '', 'public', (select q from q3), null, null, null, 'ask');
select public.event_create('00000000-0000-4000-8000-0000000b5008', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b501', '会 en', (select s1 from t0), (select e1 from t0), '', 'public', (select q from q3), null, null, null, 'none');
select public.event_create('00000000-0000-4000-8000-0000000b5010', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b501', '会 ex', (select s1 from t0), (select e1 from t0), '', 'public', (select q from q3));

-- ここから招待制をオンにする（受付待ちの行があれば accounts を作れることも確かめる）
insert into public.app_settings(key, value) values ('invite_only', 'true'::jsonb)
  on conflict (key) do update set value = 'true'::jsonb;

-- -----------------------------------------------------------------------
-- 3. 判定: 届いたら held（固定）
-- -----------------------------------------------------------------------
select is(public.event_settle('00000000-0000-4000-8000-0000000b5004'), null, 'an event with no minimum has no phase');
select is(public.event_settle('00000000-0000-4000-8000-0000000b5001'), 'recruiting', 'e1 is recruiting');
select is((select decision from public.events where post_id = '00000000-0000-4000-8000-0000000b5001'), null, 'and recruiting is not recorded');
select is(public.event_apply('00000000-0000-4000-8000-0000000b5001', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b511', pg_temp.prof('一 郎'), 'line', null, pg_temp.ans(array['now', 'past']), null) ->> 'phase',
          'recruiting', 'one applicant: still recruiting (the apply result tells the phase)');
select is(public.event_apply('00000000-0000-4000-8000-0000000b5004', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b511', '{}', 'email', null, pg_temp.ans(array['now', 'past']), null) -> 'phase',
          'null'::jsonb, 'an event with no minimum reports a null phase');
select is(public.event_live_count('00000000-0000-4000-8000-0000000b5001'), 1, 'one live registration');
select is(public.event_apply('00000000-0000-4000-8000-0000000b5001', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b512', pg_temp.prof('二 郎'), 'email', null, pg_temp.ans(array['now', 'past']), null) ->> 'phase',
          'held', 'the second applicant reaches the minimum: held');
select ok((select decision = 'held' and decided_at is not null from public.events where post_id = '00000000-0000-4000-8000-0000000b5001'), 'held is recorded with the time');
select is(public.event_cancel_registration('00000000-0000-4000-8000-0000000b5001', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b512') ->> 'status', 'cancelled', 'one cancels (before the deadline)');
select is(public.event_settle('00000000-0000-4000-8000-0000000b5001'), 'held', 'it stays held even with fewer people');
select is(pg_temp.hint_of($$select public.event_update('00000000-0000-4000-8000-0000000b5001', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b501', '{"min_participants":3}')$$),
          'event_decided', 'after the decision the minimum cannot change');
select is(pg_temp.hint_of($$select public.event_update('00000000-0000-4000-8000-0000000b5001', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b501', jsonb_build_object('decide_on', (select sd - 1 from t0)))$$),
          'event_decided', 'nor the decision day');
select is(public.event_update('00000000-0000-4000-8000-0000000b5001', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b501', jsonb_build_object('min_participants', 2, 'join_policy', 'none')) ->> 'changed',
          'true', 'sending the same minimum is fine, and the join policy can still change');
select is((select join_policy from public.events where post_id = '00000000-0000-4000-8000-0000000b5001'), 'none', 'the join policy changed');
select is(public.event_update('00000000-0000-4000-8000-0000000b5001', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b501', '{"cancel_deadline":null}') ->> 'changed',
          'true', 'the cancel deadline can be removed after the decision');

-- -----------------------------------------------------------------------
-- 4. 判定: 判定日を過ぎて届かなければ not_held
-- -----------------------------------------------------------------------
select public.event_apply('00000000-0000-4000-8000-0000000b5002', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b513', pg_temp.prof('三 郎'), 'line', null, pg_temp.ans(array['now', 'past']), null);
select is((select count(*)::int from public.outbound_messages where event_id = '00000000-0000-4000-8000-0000000b5002' and sent_at is null), 3, 'before: 3 planned notices');
-- 判定日を一昨日にする（関数は過去を受け付けないので表を直接）
update public.events set decide_on = (select today - 2 from t0) where post_id = '00000000-0000-4000-8000-0000000b5002';
select is(public.event_settle('00000000-0000-4000-8000-0000000b5002'), 'not_held', 'after the decision day, short of the minimum: not held');
select is((select decision from public.events where post_id = '00000000-0000-4000-8000-0000000b5002'), 'not_held', 'not_held is recorded');
select is((select count(*)::int from public.outbound_messages where event_id = '00000000-0000-4000-8000-0000000b5002' and sent_at is null), 0, 'and the planned notices are gone');
select is(pg_temp.hint_of($$select public.event_apply('00000000-0000-4000-8000-0000000b5002', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b514', pg_temp.prof('四 郎'), 'line', null, pg_temp.ans(array['now', 'past']), null)$$),
          'event_not_held', 'a not-held event takes no more applications');
select is((select count(*)::int from public.event_registrations where account_id = 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b514') + (select count(*)::int from public.accounts where id = 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b514'),
          0, 'and the refused try left nothing');
select is(pg_temp.hint_of($$select public.event_set_late('00000000-0000-4000-8000-0000000b5002', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b513', 10)$$), 'event_not_held', 'nor a "late" message');
select is(pg_temp.hint_of($$select public.event_checkin('00000000-0000-4000-8000-0000000b5002', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b513')$$), 'event_not_held', 'nor check-in');
select public.event_queue_reminders('00000000-0000-4000-8000-0000000b5002', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b513');
select is((select count(*)::int from public.outbound_messages where event_id = '00000000-0000-4000-8000-0000000b5002'), 0, 'no notices are planned for a not-held event');
-- 未送信の行が残っていても、取り出さない
select public.line_link_save('b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b513', 'U-g3', true);
insert into public.outbound_messages(event_id, account_id, kind, scheduled_at)
  values ('00000000-0000-4000-8000-0000000b5002', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b513', 'day_of', now() - interval '1 minute');
select is((select count(*)::int from public.outbound_claim(50, 300) where event_id = '00000000-0000-4000-8000-0000000b5002'), 0, 'outbound_claim skips a not-held event');
select is(pg_temp.hint_of($$select public.event_update('00000000-0000-4000-8000-0000000b5002', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b501', '{"min_participants":2}')$$),
          'event_decided', 'a not-held event cannot lower its minimum afterwards');
-- 毎分の判定: e3 は申し込みなしで判定日を過ぎた
update public.events set decide_on = (select today - 1 from t0) where post_id = '00000000-0000-4000-8000-0000000b5003';
select is(public.event_settle_due(), 1, 'the every-minute settle decides the one event past its day (e3)');
select is((select decision from public.events where post_id = '00000000-0000-4000-8000-0000000b5003'), 'not_held', 'e3 is not held');
select is(public.event_settle_due(), 0, 'running it again decides nothing');

-- -----------------------------------------------------------------------
-- 5. 会を変える（開催の条件）
-- -----------------------------------------------------------------------
select is(pg_temp.hint_of($$select public.event_update('00000000-0000-4000-8000-0000000b5004', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b501', '{"min_participants":2}')$$),
          'event_invalid', 'a minimum needs a decision day too');
select is(pg_temp.hint_of($$select public.event_update('00000000-0000-4000-8000-0000000b5004', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b501', '{"min_participants":"two","decide_on":"2030-01-01"}')$$),
          'event_invalid', 'a minimum that is not a number is refused');
select is(pg_temp.hint_of($$select public.event_update('00000000-0000-4000-8000-0000000b5004', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b501', '{"join_policy":"maybe"}')$$),
          'event_invalid', 'an unknown join policy is refused');
select is(public.event_update('00000000-0000-4000-8000-0000000b5004', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b501',
                              jsonb_build_object('min_participants', 3, 'decide_on', (select sd - 3 from t0), 'cancel_deadline', (select s - interval '2 days' from t0))) ->> 'changed',
          'true', 'a minimum, a decision day and a cancel deadline can be added later');
select is((select decision from public.events where post_id = '00000000-0000-4000-8000-0000000b5004'), null, 'one applicant: not decided yet');
select is(pg_temp.hint_of($$select public.event_update('00000000-0000-4000-8000-0000000b5004', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b501',
                                 jsonb_build_object('starts_at', (select s - interval '9 days' from t0), 'ends_at', (select s - interval '9 days' + interval '1 hour' from t0)))$$),
          'event_invalid', 'moving the start before the decision day is refused');
select is(pg_temp.hint_of($$select public.event_update('00000000-0000-4000-8000-0000000b5004', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b501',
                                 jsonb_build_object('starts_at', (select s - interval '2 days' - interval '1 hour' from t0)))$$),
          'event_invalid', 'moving the start before the cancel deadline is refused');
select is(public.event_update('00000000-0000-4000-8000-0000000b5004', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b501', '{"min_participants":2}') ->> 'changed',
          'true', 'lowering the minimum to the number of applicants…');
select is((select decision from public.events where post_id = '00000000-0000-4000-8000-0000000b5004'), null, '…of one is not enough (one applicant, minimum 2)');
select public.event_apply('00000000-0000-4000-8000-0000000b5004', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b502', '{}', 'email', null, '[]', null);
select is((select decision from public.events where post_id = '00000000-0000-4000-8000-0000000b5004'), 'held', 'a member''s one-tap application reaches it: held');

-- -----------------------------------------------------------------------
-- 6. キャンセル期限
-- -----------------------------------------------------------------------
select public.event_apply('00000000-0000-4000-8000-0000000b5005', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b527', pg_temp.prof('七 子'), 'email', null, pg_temp.ans(array['now', 'past']), null);
select is(pg_temp.hint_of($$select public.event_cancel_registration('00000000-0000-4000-8000-0000000b5005', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b527')$$),
          'cancel_closed', 'after the cancel deadline an application cannot be cancelled');
select is((select status from public.event_registrations where event_id = '00000000-0000-4000-8000-0000000b5005' and account_id = 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b527'), 'applied', 'it stays applied');

-- -----------------------------------------------------------------------
-- 7. 受付と入り方（auto / ask / none）
-- -----------------------------------------------------------------------
select is(pg_temp.hint_of($$select public.event_checkin('00000000-0000-4000-8000-0000000b5001', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b511')$$), 'checkin_closed', 'check-in is closed 10 days before');
-- auto: 受付でメンバーになり、回答が投稿に写る
select public.event_apply('00000000-0000-4000-8000-0000000b5006', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b521', pg_temp.prof('エー 太'), 'line', null, pg_temp.ans(array['now', 'past']), null);
create temp table posts_before as select count(*)::int as n from public.posts where author_id = 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b521';
grant select on posts_before to anon, authenticated, service_role;
select is((select n from posts_before), 0, 'before check-in the guest has no posts');
create temp table ck1 as select public.event_checkin('00000000-0000-4000-8000-0000000b5006', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b521') as j;
grant select on ck1 to anon, authenticated, service_role;
select is((select j from ck1), '{"result":"attended","joined":true}'::jsonb, 'auto: checking in makes the guest a member');
select is((select status || '/' || (checked_in_at is not null) from public.event_registrations where event_id = '00000000-0000-4000-8000-0000000b5006' and account_id = 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b521'),
          'attended/true', 'the registration is attended');
select is((select role || '/' || joined_via || '/' || event_post_id from public.community_members where community_id = (select bar from cm) and account_id = 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b521'),
          'member/event/00000000-0000-4000-8000-0000000b5006', 'a member who came through this event');
select is((select count(*)::int from public.community_join_requests where account_id = 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b521'), 0, 'the pending join request is gone');
select is((select array_agg(prompt || ':' || body order by prompt) from public.posts where author_id = 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b521' and community_id = (select bar from cm) and deleted_at is null),
          array['now:nowの答え', 'past:pastの答え'], 'the two answers became posts in the community');
select is((select count(*)::int from public.event_answers where event_id = '00000000-0000-4000-8000-0000000b5006' and account_id = 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b521'), 2,
          'the answers are kept for the participant list');
select is(public.event_checkin('00000000-0000-4000-8000-0000000b5006', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b521'), '{"result":"already","joined":false}'::jsonb, 'checking in again is "already"');
select is((select count(*)::int from public.posts where author_id = 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b521'), 2, 'and copies nothing twice');
select is(pg_temp.hint_of($$select public.event_join_community('00000000-0000-4000-8000-0000000b5006', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b521')$$), 'join_not_allowed', 'the join button is only for "ask" events');
-- ask: 受付だけではメンバーにならない。「参加する」でなる
select public.event_apply('00000000-0000-4000-8000-0000000b5007', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b522', pg_temp.prof('ビー 子'), 'email', null, pg_temp.ans(array['future', 'now']), null);
select is(pg_temp.hint_of($$select public.event_join_community('00000000-0000-4000-8000-0000000b5007', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b522')$$), 'event_not_attended', 'before check-in the join button is refused');
select is(public.event_checkin('00000000-0000-4000-8000-0000000b5007', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b522'), '{"result":"attended","joined":false}'::jsonb, 'ask: check-in alone does not make a member');
select is((select count(*)::int from public.community_members where account_id = 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b522'), 0, 'not a member yet');
select is((select count(*)::int from public.posts where author_id = 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b522'), 0, 'and no posts yet');
select is(public.event_join_community('00000000-0000-4000-8000-0000000b5007', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b522') ->> 'status', 'joined', 'pressing "join this community" makes a member');
select is((select joined_via || '/' || event_post_id from public.community_members where account_id = 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b522'),
          'event/00000000-0000-4000-8000-0000000b5007', 'through this event');
select is((select count(*)::int from public.posts where author_id = 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b522' and community_id = (select bar from cm)), 2, 'and the answers became posts');
select is(public.event_join_community('00000000-0000-4000-8000-0000000b5007', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b522') ->> 'status', 'already', 'pressing again is "already"');
-- none: 入れない
select public.event_apply('00000000-0000-4000-8000-0000000b5008', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b523', pg_temp.prof('シー 郎'), 'email', null, pg_temp.ans(array['now', 'past']), null);
select is(public.event_checkin('00000000-0000-4000-8000-0000000b5008', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b523'), '{"result":"attended","joined":false}'::jsonb, 'none: check-in does not make a member');
select is(pg_temp.hint_of($$select public.event_join_community('00000000-0000-4000-8000-0000000b5008', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b523')$$), 'join_not_allowed', 'and the join button is refused');
select is((select count(*)::int from public.community_members where account_id = 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b523'), 0, 'they stay a guest');
-- メンバーは申し込みなしで QR の受付ができる
select is(public.event_checkin('00000000-0000-4000-8000-0000000b5006', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b502'), '{"result":"attended","joined":false}'::jsonb, 'a member with no application checks in by QR');
select is((select status || '/' || channel || '/' || was_guest from public.event_registrations where event_id = '00000000-0000-4000-8000-0000000b5006' and account_id = 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b502'),
          'attended/walkin/false', 'as a walk-in row');
-- 自分で取り消した人
select public.event_apply('00000000-0000-4000-8000-0000000b5006', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b526', pg_temp.prof('エフ 美'), 'email', null, pg_temp.ans(array['now', 'past']), null);
select public.event_cancel_registration('00000000-0000-4000-8000-0000000b5006', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b526');
select is(pg_temp.hint_of($$select public.event_checkin('00000000-0000-4000-8000-0000000b5006', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b526')$$), 'checkin_cancelled_reg', 'someone who cancelled is sent to the host');
-- 中止の会・外された人
update public.posts set deleted_at = now() where id = '00000000-0000-4000-8000-0000000b5010';
select is(pg_temp.hint_of($$select public.event_checkin('00000000-0000-4000-8000-0000000b5010', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b502')$$), 'event_cancelled', 'a cancelled event takes no check-in');
select is(pg_temp.hint_of($$select public.event_checkin('00000000-0000-4000-8000-0000000b5006', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b529')$$), 'event_banned', 'a removed person cannot check in');
select is(pg_temp.hint_of($$select public.event_walkin_request('00000000-0000-4000-8000-0000000b5006', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b529', pg_temp.prof('外 された'), '2026-11-16')$$), 'event_banned', 'nor wait as a walk-in');

-- -----------------------------------------------------------------------
-- 8. 飛び入り（受付待ち → 主催者が受付／却下3回で walkin_limit）
-- -----------------------------------------------------------------------
select is(public.event_checkin('00000000-0000-4000-8000-0000000b5006', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b524'), '{"result":"need_walkin","joined":false}'::jsonb, 'a stranger is asked for their name');
select is(pg_temp.hint_of($$select public.event_walkin_request('00000000-0000-4000-8000-0000000b5006', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b524', '{}', null)$$), 'name_required', 'a walk-in needs a full name and affiliation');
select is(public.event_walkin_request('00000000-0000-4000-8000-0000000b5006', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b524', pg_temp.prof('ディー 介'), '2026-11-16'), '{"status":"waiting"}'::jsonb, 'then they wait');
select is((select status || '/' || channel || '/' || created_account || '/' || consent_version from public.event_registrations where event_id = '00000000-0000-4000-8000-0000000b5006' and account_id = 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b524'),
          'waiting/walkin/true/2026-11-16', 'a waiting walk-in row');
select is((select display_name || '/' || created_via from public.accounts where id = 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b524'), 'ディー 介/event', 'the account was made (even with invite-only on)');
select is(public.event_walkin_request('00000000-0000-4000-8000-0000000b5006', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b524', '{}', null), '{"status":"waiting"}'::jsonb, 'asking again while waiting changes nothing');
select is(public.event_checkin('00000000-0000-4000-8000-0000000b5006', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b524'), '{"result":"waiting","joined":false}'::jsonb, 'the QR says they are waiting');
select is(pg_temp.hint_of($$select public.event_reject_walkin('00000000-0000-4000-8000-0000000b5006', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b502', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b524')$$), 'event_not_host', 'only the host can turn a walk-in away');
select is(pg_temp.hint_of($$select public.event_reject_walkin('00000000-0000-4000-8000-0000000b5006', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b501', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b521')$$), 'not_waiting', 'an attended person cannot be turned away');
select is(public.event_reject_walkin('00000000-0000-4000-8000-0000000b5006', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b501', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b524'), '{"walkin_rejects":1}'::jsonb, 'the host turns them away once');
select is(public.event_checkin('00000000-0000-4000-8000-0000000b5006', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b524'), '{"result":"need_walkin","joined":false}'::jsonb, 'they can ask again');
select public.event_walkin_request('00000000-0000-4000-8000-0000000b5006', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b524', '{}', null);
select is((select status from public.event_registrations where event_id = '00000000-0000-4000-8000-0000000b5006' and account_id = 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b524'), 'waiting', 'the same row waits again');
select public.event_reject_walkin('00000000-0000-4000-8000-0000000b5006', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b501', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b524');
select public.event_walkin_request('00000000-0000-4000-8000-0000000b5006', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b524', '{}', null);
select is(public.event_reject_walkin('00000000-0000-4000-8000-0000000b5006', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b501', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b524') ->> 'walkin_rejects', '3', 'turned away a third time');
select is(pg_temp.hint_of($$select public.event_walkin_request('00000000-0000-4000-8000-0000000b5006', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b524', '{}', null)$$), 'walkin_limit', 'after three, waiting again is refused');
-- 受付待ち → 主催者が受付（auto の会なのでメンバーに）
select public.event_walkin_request('00000000-0000-4000-8000-0000000b5006', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b525', pg_temp.prof('イー 介'), '2026-11-16');
select is(pg_temp.hint_of($$select public.event_checkin_by_host('00000000-0000-4000-8000-0000000b5006', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b502', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b525')$$), 'event_not_host', 'only the host checks people in');
select is(public.event_checkin_by_host('00000000-0000-4000-8000-0000000b5006', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b501', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b525'), '{"status":"attended","joined":true}'::jsonb,
          'the host checks the walk-in in, and they become a member (auto)');
select is((select joined_via from public.community_members where account_id = 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b525'), 'event', 'through the event');
select is(pg_temp.hint_of($$select public.event_checkin_by_host('00000000-0000-4000-8000-0000000b5006', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b501', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b525')$$), 'not_waiting', 'checking them in twice is refused');
-- 主催者は申し込み中の人も受付できる（時間に関係なく）
select is(public.event_checkin_by_host('00000000-0000-4000-8000-0000000b5001', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b501', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b511') ->> 'status', 'attended',
          'the host can check in an applicant even 10 days early');
select is((select count(*)::int from public.community_members where account_id = 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b511'), 0, 'e1 is now "none": no member');
-- 受付待ちの取り下げは、キャンセル期限を過ぎていてもできる
select public.event_apply('00000000-0000-4000-8000-0000000b5007', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b528', pg_temp.prof('エイチ 男'), 'email', null, pg_temp.ans(array['now', 'past']), null);
select public.event_walkin_request('00000000-0000-4000-8000-0000000b5007', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b527', '{}', null);
update public.events set cancel_deadline = now() - interval '1 minute' where post_id = '00000000-0000-4000-8000-0000000b5007';
select is(pg_temp.hint_of($$select public.event_cancel_registration('00000000-0000-4000-8000-0000000b5007', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b528')$$), 'cancel_closed', 'an applicant cannot cancel after the deadline');
select is(public.event_cancel_registration('00000000-0000-4000-8000-0000000b5007', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b527') ->> 'status', 'cancelled', 'but a waiting walk-in can withdraw');

-- -----------------------------------------------------------------------
-- 9. 参加者リスト
-- -----------------------------------------------------------------------
-- ea: 主催者（申し込みなし）・ga（attended）・m1（attended）・ge（attended）。gf（取り消し）・gd（却下）は出ない
select is((select array_agg(display_name || ':' || status || ':' || is_member || ':' || is_host order by display_name)
             from public.event_participants('00000000-0000-4000-8000-0000000b5006')),
          array['host:host:true:true', 'member1:attended:true:false', 'イー 介:attended:true:false', 'エー 太:attended:true:false'],
          'the list has the host and the people who came (not the cancelled or turned-away)');
select is((select account_id from public.event_participants('00000000-0000-4000-8000-0000000b5006') limit 1), 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b501'::uuid, 'the host comes first');
select is((select job_title || '/' || affiliation || '/' || icon_id from public.event_participants('00000000-0000-4000-8000-0000000b5006') where account_id = 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b521'),
          '設計/会社X/0', 'job title, affiliation and icon are there');
select is((select 'age_band' = any (p.proargnames) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'event_participants'),
          false, 'no age band');
-- ek: gb（attended・メンバー）と gh（applied）
select is((select array_agg(display_name || ':' || status || ':' || is_member order by display_name)
             from public.event_participants('00000000-0000-4000-8000-0000000b5007') where not is_host),
          array['エイチ 男:applied:false', 'ビー 子:attended:true'], 'applicants show as applied, guests as not members');
select is((select array_agg(prompt || ':' || body order by prompt) from public.event_participant_answers('00000000-0000-4000-8000-0000000b5006') where account_id = 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b521'),
          array['now:nowの答え', 'past:pastの答え'], 'the answers of a participant');
select is((select count(*)::int from public.event_participant_answers('00000000-0000-4000-8000-0000000b5006') where account_id = 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b526'), 0, 'a cancelled person''s answers are not shown');

-- -----------------------------------------------------------------------
-- 10. 会のあと（会えてよかった）
-- -----------------------------------------------------------------------
select is(pg_temp.hint_of($$select * from public.event_after_people('00000000-0000-4000-8000-0000000b5006', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b526')$$), 'event_not_attended', 'only people who came see the list after');
select is((select array_agg(display_name || ':' || is_member || ':' || met order by display_name) from public.event_after_people('00000000-0000-4000-8000-0000000b5006', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b521')),
          array['member1:true:false', 'イー 介:true:false'], 'the others who came (not myself)');
select is(public.event_meet('00000000-0000-4000-8000-0000000b5006', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b521', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b502', true), '{"on":true}'::jsonb, '"glad we met" is pressed');
select public.event_meet('00000000-0000-4000-8000-0000000b5006', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b521', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b502', true);
select is((select count(*)::int from public.event_meetings where event_id = '00000000-0000-4000-8000-0000000b5006'), 1, 'pressing twice keeps one');
select is((select met from public.event_after_people('00000000-0000-4000-8000-0000000b5006', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b521') where account_id = 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b502'), true, 'and the list shows it');
select is((select met from public.event_after_people('00000000-0000-4000-8000-0000000b5006', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b502') where account_id = 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b521'), false, 'it is one-way (the other side has not pressed)');
select is(public.event_meet('00000000-0000-4000-8000-0000000b5006', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b521', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b502', false), '{"on":false}'::jsonb, 'and unpressed');
select is((select count(*)::int from public.event_meetings where event_id = '00000000-0000-4000-8000-0000000b5006'), 0, 'gone');
select is(pg_temp.hint_of($$select public.event_meet('00000000-0000-4000-8000-0000000b5006', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b521', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b526', true)$$), 'event_not_attended', 'not with someone who did not come');
select is(pg_temp.hint_of($$select public.event_meet('00000000-0000-4000-8000-0000000b5006', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b521', 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b521', true)$$), 'event_not_attended', 'nor with oneself');

-- -----------------------------------------------------------------------
-- 11. 片付けは今のまま（受付した人の行は残る）
-- -----------------------------------------------------------------------
update public.events set starts_at = now() - interval '9 days', ends_at = now() - interval '8 days' where post_id = '00000000-0000-4000-8000-0000000b5006';
select public.event_cleanup(now());
select is((select array_agg(status order by status) from public.event_registrations where event_id = '00000000-0000-4000-8000-0000000b5006'),
          array['attended', 'attended', 'attended'], 'a week after, only the attended rows remain');
select is((select count(*)::int from public.event_answers where event_id = '00000000-0000-4000-8000-0000000b5006'), 0, 'the answers for the list are gone');
select is((select count(*)::int from public.posts where author_id = 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b521'), 2, 'the copied posts stay');

select * from finish();
rollback;
