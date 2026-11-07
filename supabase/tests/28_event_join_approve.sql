-- 2026-11-07: 会のあとの入り方「希望したら、管理者が承認して加入」（20261114000000_event_join_approve.sql）。
-- Run with: supabase test db (CI does). Everybody here is made up.
--
-- 役（アカウント id の末尾）: 01 主催者（BAR の管理者）/ 11 承認される人 / 12 断られる人 / 13 ask の会の人
-- 会: 81（approve・公開・質問3つ・1時間後に始まる）/ 82（質問なしの公開の会・approve）/ 83（ask）
begin;
select no_plan();

insert into auth.users(id, email) values
  ('c8c8c8c8-c8c8-4c8c-8c8c-c8c8c8c8c801', 'h@example.test'),
  ('c8c8c8c8-c8c8-4c8c-8c8c-c8c8c8c8c811', 'a@example.test'),
  ('c8c8c8c8-c8c8-4c8c-8c8c-c8c8c8c8c812', 'b@example.test'),
  ('c8c8c8c8-c8c8-4c8c-8c8c-c8c8c8c8c813', 'c@example.test');
insert into public.accounts(id, display_name, affiliation, name_confirmed_at) values
  ('c8c8c8c8-c8c8-4c8c-8c8c-c8c8c8c8c801', 'host', '店', now());

select public.create_community('BAR', 'ej-bar', 'c8c8c8c8-c8c8-4c8c-8c8c-c8c8c8c8c801');
create temp table cm as select (select id from public.communities where slug = 'ej-bar') as bar;
grant select on cm to anon, authenticated, service_role;

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
create function pg_temp.vec() returns vector(448) language sql immutable as $$
  select array_fill(1.0, array[448])::vector(448) $$;

insert into public.posts(id, author_id, body, tags, x, y, cluster_id, vec, vec_c, community_id, recruit_capacity) values
  ('00000000-0000-4000-8000-0000000c8081', 'c8c8c8c8-c8c8-4c8c-8c8c-c8c8c8c8c801', '会 81', array['参加者募集中'], 1, 1, 0, pg_temp.vec(), pg_temp.vec(), (select bar from cm), 10),
  ('00000000-0000-4000-8000-0000000c8082', 'c8c8c8c8-c8c8-4c8c-8c8c-c8c8c8c8c801', '会 82', array['参加者募集中'], 2, 2, 0, pg_temp.vec(), pg_temp.vec(), (select bar from cm), 10),
  ('00000000-0000-4000-8000-0000000c8083', 'c8c8c8c8-c8c8-4c8c-8c8c-c8c8c8c8c801', '会 83', array['参加者募集中'], 3, 3, 0, pg_temp.vec(), pg_temp.vec(), (select bar from cm), 10);

create temp table q3 as
  select '[{"prompt":"now","label":"最近やってること"},{"prompt":"past","label":"昔やってたこと"},{"prompt":"future","label":"これからやりたいこと"}]'::jsonb as q;
grant select on q3 to anon, authenticated, service_role;

-- -----------------------------------------------------------------------
-- 1. 入り方 approve で会を作れる・変えられる。知らない値は今までどおり断る
-- -----------------------------------------------------------------------
select is(pg_temp.hint_of($$select public.event_create('00000000-0000-4000-8000-0000000c8081', 'c8c8c8c8-c8c8-4c8c-8c8c-c8c8c8c8c801', '会 81', now() + interval '1 hour', now() + interval '3 hours', '場所', 'public', (select q from q3), null, null, null, 'approve')$$),
          'none', 'an event can be made with approve');
select is((select join_policy from public.events where post_id = '00000000-0000-4000-8000-0000000c8081'), 'approve', 'and keeps it');
-- 質問なしの公開の会（DB は前から 0 個を許す。答えも 0 個でよい）
select is(pg_temp.hint_of($$select public.event_create('00000000-0000-4000-8000-0000000c8082', 'c8c8c8c8-c8c8-4c8c-8c8c-c8c8c8c8c801', '会 82', now() + interval '1 hour', now() + interval '3 hours', '場所', 'public', '[]', null, null, null, 'approve')$$),
          'none', 'a public event with no questions can be made');
select is(pg_temp.hint_of($$select public.event_create('00000000-0000-4000-8000-0000000c8083', 'c8c8c8c8-c8c8-4c8c-8c8c-c8c8c8c8c801', '会 83', now() + interval '1 hour', now() + interval '3 hours', '場所', 'public', (select q from q3), null, null, null, 'ask')$$),
          'none', 'an ask event as before');
select is(public.event_update('00000000-0000-4000-8000-0000000c8083', 'c8c8c8c8-c8c8-4c8c-8c8c-c8c8c8c8c801', '{"join_policy":"approve"}') ->> 'changed', 'true', 'an event can be changed to approve');
select is(public.event_update('00000000-0000-4000-8000-0000000c8083', 'c8c8c8c8-c8c8-4c8c-8c8c-c8c8c8c8c801', '{"join_policy":"ask"}') ->> 'changed', 'true', 'and back to ask');
select is(pg_temp.hint_of($$select public.event_update('00000000-0000-4000-8000-0000000c8083', 'c8c8c8c8-c8c8-4c8c-8c8c-c8c8c8c8c801', '{"join_policy":"maybe"}')$$),
          'event_invalid', 'an unknown join policy is still refused');
select ok(not has_function_privilege('anon', 'public.event_request_join(uuid, uuid)', 'execute'), 'anon cannot ask to join');
select ok(not has_function_privilege('authenticated', 'public.event_request_join(uuid, uuid)', 'execute'), 'nor a signed-in browser');
select ok(not has_function_privilege('authenticated', 'public.event_join_request_state(uuid, uuid)', 'execute'), 'nor read the state');

-- 質問なしの会には、答えなしで申し込める
select is(pg_temp.hint_of($$select public.event_apply('00000000-0000-4000-8000-0000000c8082', 'c8c8c8c8-c8c8-4c8c-8c8c-c8c8c8c8c813', pg_temp.prof('シー 郎'), 'email', null, '[]', null)$$),
          'none', 'no questions, no answers needed');

-- -----------------------------------------------------------------------
-- 2. 希望 → 承認待ち → 承認でメンバー、答えが投稿に
-- -----------------------------------------------------------------------
select public.event_apply('00000000-0000-4000-8000-0000000c8081', 'c8c8c8c8-c8c8-4c8c-8c8c-c8c8c8c8c811', pg_temp.prof('エー 太'), 'email', null, pg_temp.ans(array['now', 'past']), null);
select public.event_apply('00000000-0000-4000-8000-0000000c8081', 'c8c8c8c8-c8c8-4c8c-8c8c-c8c8c8c8c812', pg_temp.prof('ビー 子'), 'email', null, pg_temp.ans(array['now', 'future']), null);
select is(pg_temp.hint_of($$select public.event_request_join('00000000-0000-4000-8000-0000000c8081', 'c8c8c8c8-c8c8-4c8c-8c8c-c8c8c8c8c811')$$),
          'event_not_attended', 'before check-in nobody can ask to join');
select is(public.event_checkin('00000000-0000-4000-8000-0000000c8081', 'c8c8c8c8-c8c8-4c8c-8c8c-c8c8c8c8c811'), '{"result":"attended","joined":false}'::jsonb, 'approve: check-in alone does not make a member');
select is(public.event_checkin('00000000-0000-4000-8000-0000000c8081', 'c8c8c8c8-c8c8-4c8c-8c8c-c8c8c8c8c812') ->> 'result', 'attended', 'the second one checks in too');
select is(public.event_join_request_state('00000000-0000-4000-8000-0000000c8081', 'c8c8c8c8-c8c8-4c8c-8c8c-c8c8c8c8c811'), null, 'nothing asked yet');
select is(pg_temp.hint_of($$select public.event_join_community('00000000-0000-4000-8000-0000000c8081', 'c8c8c8c8-c8c8-4c8c-8c8c-c8c8c8c8c811')$$),
          'join_not_allowed', 'the straight join of ask is not for approve');
select is(public.event_request_join('00000000-0000-4000-8000-0000000c8081', 'c8c8c8c8-c8c8-4c8c-8c8c-c8c8c8c8c811') ->> 'status', 'pending', 'asking to join makes a pending request');
select is((select status || '/' || event_post_id from public.community_join_requests where community_id = (select bar from cm) and account_id = 'c8c8c8c8-c8c8-4c8c-8c8c-c8c8c8c8c811'),
          'pending/00000000-0000-4000-8000-0000000c8081', 'with the event it came from');
select is((select count(*)::int from public.notifications where type = 'join_request' and actor_id = 'c8c8c8c8-c8c8-4c8c-8c8c-c8c8c8c8c811'
             and recipient_id = 'c8c8c8c8-c8c8-4c8c-8c8c-c8c8c8c8c801'), 1, 'the admin is told');
select is(public.event_join_request_state('00000000-0000-4000-8000-0000000c8081', 'c8c8c8c8-c8c8-4c8c-8c8c-c8c8c8c8c811'), 'pending', 'the state reads pending');
select is(public.event_request_join('00000000-0000-4000-8000-0000000c8081', 'c8c8c8c8-c8c8-4c8c-8c8c-c8c8c8c8c811') ->> 'status', 'pending', 'asking again stays pending');
select is((select count(*)::int from public.notifications where type = 'join_request' and actor_id = 'c8c8c8c8-c8c8-4c8c-8c8c-c8c8c8c8c811'), 1, 'and tells nobody twice');
select is((select count(*)::int from public.community_members where account_id = 'c8c8c8c8-c8c8-4c8c-8c8c-c8c8c8c8c811'), 0, 'not a member while waiting');
select public.event_request_join('00000000-0000-4000-8000-0000000c8081', 'c8c8c8c8-c8c8-4c8c-8c8c-c8c8c8c8c812');

set local role authenticated;
set local request.jwt.claims to '{"sub":"c8c8c8c8-c8c8-4c8c-8c8c-c8c8c8c8c801","role":"authenticated"}';
select is(public.decide_join_request((select bar from cm), 'c8c8c8c8-c8c8-4c8c-8c8c-c8c8c8c8c811', true), 'approved', 'the admin approves');
select is(public.decide_join_request((select bar from cm), 'c8c8c8c8-c8c8-4c8c-8c8c-c8c8c8c8c812', false), 'rejected', 'and turns the other one down');
reset role;
reset request.jwt.claims;

select is((select role || '/' || joined_via || '/' || event_post_id from public.community_members where community_id = (select bar from cm) and account_id = 'c8c8c8c8-c8c8-4c8c-8c8c-c8c8c8c8c811'),
          'member/approval/00000000-0000-4000-8000-0000000c8081', 'a member, approved, through this event');
select is((select array_agg(prompt || ':' || body order by prompt) from public.posts where author_id = 'c8c8c8c8-c8c8-4c8c-8c8c-c8c8c8c8c811' and community_id = (select bar from cm) and deleted_at is null),
          array['now:nowの答え', 'past:pastの答え'], 'the answers became posts in the community');
select is(public.event_request_join('00000000-0000-4000-8000-0000000c8081', 'c8c8c8c8-c8c8-4c8c-8c8c-c8c8c8c8c811') ->> 'status', 'already', 'a member asking again is "already"');
select is(public.event_request_join('00000000-0000-4000-8000-0000000c8081', 'c8c8c8c8-c8c8-4c8c-8c8c-c8c8c8c8c812') ->> 'status', 'rejected', 'somebody turned down stays turned down');
select is(public.event_join_request_state('00000000-0000-4000-8000-0000000c8081', 'c8c8c8c8-c8c8-4c8c-8c8c-c8c8c8c8c812'), 'rejected', 'and the state says so');
select is((select count(*)::int from public.community_members where account_id = 'c8c8c8c8-c8c8-4c8c-8c8c-c8c8c8c8c812'), 0, 'not a member');
select is((select count(*)::int from public.posts where author_id = 'c8c8c8c8-c8c8-4c8c-8c8c-c8c8c8c8c812'), 0, 'and no posts');

select * from finish();
rollback;
