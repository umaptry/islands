-- 2026-11-06: イベント申し込み（20261106000000_events.sql）。
-- Run with: supabase test db (CI does). Everybody here is made up.
--
-- 役（アカウント id の末尾）:
--   h 主催者（BAR の管理者）/ m1 m2 m3 メンバー（BAR）/ oa OTHER の管理者 / om OTHER のメンバー /
--   g1〜g10 ゲスト（最初は auth.users だけ。accounts の行が無い）:
--   g1 LINE で申し込む / g2 メールで申し込む / g3 定員で断られる / g4 お断りされる / g5 外された人 / g6 断られた人 /
--   g7 community 限定の会に来る人 / g8 中止になる会の LINE の人 / g9 期限切れで断られる人 / g10 先に友だち追加していた人。
-- 会: pe（BAR 限定・定員3）/ pe2（公開・定員2・質問3）/ pe3（期限切れ）/ pe4（中止になる）/ pe5（公開・定員10）。
begin;
select no_plan();

insert into auth.users(id, email) values
  ('a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a401', 'h@example.test'), ('a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a402', 'm1@example.test'), ('a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a403', 'm2@example.test'), ('a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a404', 'm3@example.test'),
  ('a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a405', 'oa@example.test'), ('a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a406', 'om@example.test'),
  ('a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a411', 'g1@example.test'), ('a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a412', 'g2@example.test'), ('a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a413', 'g3@example.test'), ('a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a414', 'g4@example.test'),
  ('a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a415', 'g5@example.test'), ('a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a416', 'g6@example.test'), ('a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a417', 'g7@example.test'), ('a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a418', 'g8@example.test'),
  ('a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a419', 'g9@example.test'), ('a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a420', 'g10@example.test'), ('a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a421', 'g11@example.test');
insert into public.accounts(id, display_name, affiliation, name_confirmed_at) values
  ('a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a401', 'host', '店', now()), ('a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a402', 'member1', '会社', now()), ('a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a403', 'member2', '会社', now()), ('a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a404', 'member3', '会社', now()),
  ('a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a405', 'other-admin', '別', now());
-- om だけフルネームの確認がまだ
insert into public.accounts(id, display_name, affiliation) values ('a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a406', 'other-member', '別');

select public.create_community('BAR', 'ev-bar', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a401');
select public.create_community('もう一つ', 'ev-other', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a405');
create temp table cm as
  select (select id from public.communities where slug = 'ev-bar')   as bar,
         (select id from public.communities where slug = 'ev-other') as other;
grant select on cm to anon, authenticated, service_role;
insert into public.community_members(community_id, account_id, role) values
  ((select bar from cm), 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a402', 'member'), ((select bar from cm), 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a403', 'member'),
  ((select bar from cm), 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a404', 'member'), ((select other from cm), 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a406', 'member');
-- g5 は BAR から外されている／g6 は BAR に断られている
insert into public.community_removals(community_id, account_id) values ((select bar from cm), 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a415');
insert into public.community_join_requests(community_id, account_id, status) values ((select bar from cm), 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a416', 'rejected');

create function pg_temp.vecs() returns text language sql immutable as $$
  select array_fill(0.1::real, array[448])::vector(448)::text $$;
create function pg_temp.ans(prompts text[]) returns jsonb language sql as $$
  select coalesce(jsonb_agg(jsonb_build_object('prompt', p, 'body', p || 'の答え', 'vec', pg_temp.vecs(), 'vec_c', pg_temp.vecs(),
                                               'x', 1.5, 'y', 2.5, 'cluster_id', 3, 'terms', '["a"]'::jsonb)), '[]'::jsonb)
    from unnest(prompts) p $$;
create function pg_temp.prof(nm text) returns jsonb language sql as $$
  select jsonb_build_object('display_name', nm, 'affiliation', '会社X', 'age_band', '30s', 'job_title', '設計') $$;
-- 失敗したときの hint（hint が英小文字のコードでなければ message）。成功なら 'none'
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
-- 会の投稿（先に投稿を入れてから event_create）
insert into public.posts(id, author_id, body, tags, x, y, cluster_id, vec, vec_c, community_id, recruit_capacity, recruit_deadline) values
  ('00000000-0000-4000-8000-0000000a4001', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a401', '会 pe',  array['参加者募集中'], 1, 1, 0, pg_temp.vec(), pg_temp.vec(), (select bar from cm), 3, null),
  ('00000000-0000-4000-8000-0000000a4002', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a401', '会 pe2', array['参加者募集中'], 2, 2, 0, pg_temp.vec(), pg_temp.vec(), (select bar from cm), 2, null),
  ('00000000-0000-4000-8000-0000000a4003', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a401', '会 pe3', array['参加者募集中'], 3, 3, 0, pg_temp.vec(), pg_temp.vec(), (select bar from cm), 5, current_date - 2),
  ('00000000-0000-4000-8000-0000000a4004', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a401', '会 pe4', array['参加者募集中'], 4, 4, 0, pg_temp.vec(), pg_temp.vec(), (select bar from cm), 5, null),
  ('00000000-0000-4000-8000-0000000a4005', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a401', '会 pe5', array['参加者募集中'], 5, 5, 0, pg_temp.vec(), pg_temp.vec(), (select bar from cm), 10, null),
  ('00000000-0000-4000-8000-0000000a4010', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a401', 'ふつうの投稿', array['参加者募集中'], 6, 6, 0, pg_temp.vec(), pg_temp.vec(), (select bar from cm), 5, null),
  ('00000000-0000-4000-8000-0000000a4011', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a402', 'タグなしの投稿', array[]::text[], 7, 7, 0, pg_temp.vec(), pg_temp.vec(), (select bar from cm), null, null),
  ('00000000-0000-4000-8000-0000000a4012', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a401', '定員なしの投稿', array['参加者募集中'], 8, 8, 0, pg_temp.vec(), pg_temp.vec(), (select bar from cm), null, null);
insert into public.posts(id, author_id, body, tags, x, y, cluster_id, vec, vec_c, community_id, recruit_capacity, share_group) values
  ('00000000-0000-4000-8000-0000000a4013', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a401', '共有した投稿', array['参加者募集中'], 9, 9, 0, pg_temp.vec(), pg_temp.vec(), (select bar from cm), 5,
   '00000000-0000-4000-8000-00000000f4f4');

create temp table q3 as
  select '[{"prompt":"now","label":"最近やってること"},{"prompt":"past","label":"昔やってたこと"},{"prompt":"future","label":"これからやりたいこと"}]'::jsonb as q;
grant select on q3 to anon, authenticated, service_role;
create temp table t0 as select now() + interval '10 days' as s, now() + interval '10 days 2 hours' as e;
grant select on t0 to anon, authenticated, service_role;

-- -----------------------------------------------------------------------
-- 1. 新しい表は誰にも直接読み書きさせない
-- -----------------------------------------------------------------------
select is((select count(*)::int from unnest(array['events', 'event_registrations', 'event_answers', 'event_meetings', 'line_links',
                                                   'outbound_messages', 'line_webhook_events', 'event_probe_hits', 'line_pending_friends']) t
            where has_table_privilege('anon', 'public.' || t, 'select') or has_table_privilege('anon', 'public.' || t, 'insert')
               or has_table_privilege('authenticated', 'public.' || t, 'select') or has_table_privilege('authenticated', 'public.' || t, 'insert')
               or has_table_privilege('authenticated', 'public.' || t, 'update') or has_table_privilege('authenticated', 'public.' || t, 'delete')),
          0, 'anon and signed-in people can read or write none of the 9 new tables');
select is((select count(*)::int from unnest(array['events', 'event_registrations', 'event_answers', 'event_meetings', 'line_links',
                                                   'outbound_messages', 'line_webhook_events', 'event_probe_hits', 'line_pending_friends']) t
            where has_table_privilege('service_role', 'public.' || t, 'select') and has_table_privilege('service_role', 'public.' || t, 'insert')),
          9, 'the server key can use all 9');
select is((select count(*)::int from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname in
            ('events', 'event_registrations', 'event_answers', 'event_meetings', 'line_links', 'outbound_messages',
             'line_webhook_events', 'event_probe_hits', 'line_pending_friends') and c.relrowsecurity), 9, 'row level security is on for all 9');
select is((select count(*)::int from pg_policies p where p.schemaname = 'public' and p.tablename in
            ('events', 'event_registrations', 'event_answers', 'event_meetings', 'line_links', 'outbound_messages',
             'line_webhook_events', 'event_probe_hits', 'line_pending_friends') and p.qual = 'false'), 9, 'each has one let-nobody-in policy');
set local role authenticated;
set local request.jwt.claims to '{"sub":"a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a402","role":"authenticated"}';
select is(pg_temp.state_of($$select * from public.events$$), '42501', 'a member cannot read events directly');
select is(pg_temp.state_of($$select * from public.event_registrations$$), '42501', 'nor registrations');
reset role;
reset request.jwt.claims;

-- ②の関数は authenticated・anon から呼べない。サーバー（service_role）は呼べる
select is((select array_agg(p.proname::text order by p.proname) from pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and p.proname in ('event_create', 'event_update', 'event_apply', 'event_cancel_registration', 'event_set_late', 'event_decline',
                                'event_answer_vectors', 'account_by_line_sub', 'line_link_save', 'line_link_attach', 'line_link_unfollow',
                                'line_webhook_seen', 'outbound_claim', 'outbound_done', 'event_probe_hit', 'my_event_registrations')
              and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))),
          null::text[], 'the server-only functions cannot be run by anon or signed-in people');
select is((select count(*)::int from pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and p.proname in ('event_create', 'event_update', 'event_apply', 'event_cancel_registration', 'event_set_late', 'event_decline',
                                'event_answer_vectors', 'account_by_line_sub', 'line_link_save', 'line_link_attach', 'line_link_unfollow',
                                'line_webhook_seen', 'outbound_claim', 'outbound_done', 'event_probe_hit', 'my_event_registrations')
              and has_function_privilege('service_role', p.oid, 'execute')), 16, 'the server key can run all 16');
select is((select array_agg(p.proname::text order by p.proname) from pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and p.proname in ('has_live_registration', 'event_queue_reminders', 'event_questions_valid', 'reactions_event_join_guard',
                                'events_on_post_delete')
              and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))),
          null::text[], 'the inside-only functions and trigger functions cannot be run by anon or signed-in people');
set local role authenticated;
set local request.jwt.claims to '{"sub":"a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a402","role":"authenticated"}';
select is(pg_temp.state_of($$select public.event_apply('00000000-0000-4000-8000-0000000a4001', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a402', '{}', 'email', null, '[]', null)$$),
          '42501', 'a member cannot call event_apply (permission denied)');
reset role;
reset request.jwt.claims;
select has_column('public', 'event_registrations', 'consent_version', 'registrations remember the terms version');

-- -----------------------------------------------------------------------
-- 2. 会を作る
-- -----------------------------------------------------------------------
select is(pg_temp.hint_of($$select public.event_create('00000000-0000-4000-8000-0000000a4001', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a402', '会', (select s from t0), (select e from t0), '場所', 'community', '[]')$$),
          'event_not_host', 'only the author can make the post an event');
select is(pg_temp.hint_of($$select public.event_create('00000000-0000-4000-8000-0000000a4999', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a401', '会', (select s from t0), (select e from t0), '場所', 'community', '[]')$$),
          'event_not_found', 'an unknown post is not found');
select is(pg_temp.hint_of($$select public.event_create('00000000-0000-4000-8000-0000000a4011', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a402', '会', (select s from t0), (select e from t0), '場所', 'community', '[]')$$),
          'event_invalid', 'a post without the recruiting tag is refused');
select is(pg_temp.hint_of($$select public.event_create('00000000-0000-4000-8000-0000000a4012', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a401', '会', (select s from t0), (select e from t0), '場所', 'community', '[]')$$),
          'event_invalid', 'a post without a capacity is refused');
select is(pg_temp.hint_of($$select public.event_create('00000000-0000-4000-8000-0000000a4013', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a401', '会', (select s from t0), (select e from t0), '場所', 'community', '[]')$$),
          'event_invalid', 'a post shared with other communities is refused');
select is(pg_temp.hint_of($$select public.event_create('00000000-0000-4000-8000-0000000a4010', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a401', '会', (select s from t0), (select e from t0), '場所', 'community',
                '[{"prompt":"talk","label":"x"}]')$$), 'event_invalid', 'the talk question is not allowed');
select is(pg_temp.hint_of($$select public.event_create('00000000-0000-4000-8000-0000000a4010', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a401', '会', (select s from t0), (select e from t0), '場所', 'community',
                '[{"prompt":"now","label":"a"},{"prompt":"past","label":"b"},{"prompt":"future","label":"c"},{"prompt":"help","label":"d"}]')$$),
          'event_invalid', 'at most 3 questions');
select is(pg_temp.hint_of($$select public.event_create('00000000-0000-4000-8000-0000000a4010', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a401', '会', (select e from t0), (select s from t0), '場所', 'community', '[]')$$),
          'event_invalid', 'the end must be after the start');
select is(pg_temp.hint_of($$select public.event_create('00000000-0000-4000-8000-0000000a4010', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a401', repeat('あ', 41), (select s from t0), (select e from t0), '場所', 'community', '[]')$$),
          'event_invalid', 'a title is at most 40 characters');
select is(pg_temp.state_of($$insert into public.events(post_id, community_id, title, starts_at, ends_at, questions, public_code, checkin_code)
                             values ('00000000-0000-4000-8000-0000000a4010', (select bar from cm), 'x', now(), now() + interval '1 hour',
                                     '[{"prompt":"talk","label":"x"}]', repeat('a', 24), repeat('b', 24))$$),
          '23514', 'the table itself refuses a talk question too');
select is(pg_temp.hint_of($$select public.event_create('00000000-0000-4000-8000-0000000a4001', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a401', '会 pe', (select s from t0), (select e from t0), '場所', 'public', '[]')$$),
          'none', 'the host (an admin) can make a public event');
update public.events set visibility = 'community' where post_id = '00000000-0000-4000-8000-0000000a4001';
-- 管理者でない主催者は公開の会を作れない
update public.posts set author_id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a402' where id = '00000000-0000-4000-8000-0000000a4011';
update public.posts set tags = array['参加者募集中'], recruit_capacity = 4 where id = '00000000-0000-4000-8000-0000000a4011';
select is(pg_temp.hint_of($$select public.event_create('00000000-0000-4000-8000-0000000a4011', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a402', '会', (select s from t0), (select e from t0), '場所', 'public', '[]')$$),
          'public_admin_only', 'only an admin can make a public event');
select public.event_create('00000000-0000-4000-8000-0000000a4002', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a401', '会 pe2', (select s from t0), (select e from t0), '場所2', 'public', (select q from q3));
select public.event_create('00000000-0000-4000-8000-0000000a4003', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a401', '会 pe3', (select s from t0), (select e from t0), '場所3', 'public', (select q from q3));
select public.event_create('00000000-0000-4000-8000-0000000a4004', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a401', '会 pe4', (select s from t0), (select e from t0), '場所4', 'public', (select q from q3));
select public.event_create('00000000-0000-4000-8000-0000000a4005', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a401', '会 pe5', (select s from t0), (select e from t0), '場所5', 'public', (select q from q3));
select ok((select length(public_code) >= 22 and length(checkin_code) >= 22 and public_code <> checkin_code from public.events
            where post_id = '00000000-0000-4000-8000-0000000a4001'), 'two different long codes are made');
select is((select public.event_create('00000000-0000-4000-8000-0000000a4001', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a401', '別の名前', (select s from t0), (select e from t0), '', 'community', '[]') ->> 'public_code'),
          (select public_code from public.events where post_id = '00000000-0000-4000-8000-0000000a4001'),
          'calling it again returns the same codes (and changes nothing)');
select is((select title from public.events where post_id = '00000000-0000-4000-8000-0000000a4001'), '会 pe', 'the title is untouched by the second call');
select is((select visibility from public.events where post_id = '00000000-0000-4000-8000-0000000a4001'), 'community', 'pe is for the community only');

-- ここから招待制をオンにする（申し込みの行があれば accounts を作れることを確かめる）
insert into public.app_settings(key, value) values ('invite_only', 'true'::jsonb)
  on conflict (key) do update set value = 'true'::jsonb;
select is(pg_temp.hint_of($$insert into public.accounts(id, display_name) values ('a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a421', 'nobody')$$),
          'invite_required', 'invite only: no registration, no account');

-- -----------------------------------------------------------------------
-- 3. 申し込みの筋書き
-- -----------------------------------------------------------------------
select is(pg_temp.hint_of($$select public.event_apply('00000000-0000-4000-8000-0000000a4001', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a417', pg_temp.prof('山田 花子'), 'line', null, pg_temp.ans(array[]::text[]), '2026-11-16')$$),
          'event_members_only', 'a community-only event refuses a guest');
select is((select count(*)::int from public.accounts where id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a417') + (select count(*)::int from public.event_registrations where account_id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a417'),
          0, 'and nothing was created for them');
select is(pg_temp.hint_of($$select public.event_apply('00000000-0000-4000-8000-0000000a4999', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a411', pg_temp.prof('山田 花子'), 'line', null, '[]', null)$$),
          'event_not_found', 'an unknown event is not found');
select is(pg_temp.hint_of($$select public.event_apply('00000000-0000-4000-8000-0000000a4002', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a411', pg_temp.prof('山田 花子'), 'line', null, pg_temp.ans(array['now']), null)$$),
          'answers_required', 'a guest has to answer two questions');
select is(pg_temp.hint_of($$select public.event_apply('00000000-0000-4000-8000-0000000a4002', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a411', '{}', 'line', null, pg_temp.ans(array['now', 'past']), null)$$),
          'name_required', 'a new person needs a full name and affiliation');
select is((select count(*)::int from public.accounts where id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a411') + (select count(*)::int from public.event_registrations where account_id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a411'),
          0, 'the refused tries left nothing behind');
create temp table posts_before as select count(*)::int as n from public.posts;
create temp table r1 as
  select public.event_apply('00000000-0000-4000-8000-0000000a4002', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a411', pg_temp.prof('山田 花子'), 'line', '友人の紹介', pg_temp.ans(array['now', 'past']), '2026-11-16') as j;
select is((select j ->> 'status' from r1), 'applied', 'a guest with two answers can apply');
select is((select j ->> 'was_guest' from r1) || (select j ->> 'created_account' from r1) || (select j ->> 'is_member' from r1), 'truetruefalse', 'guest, account created, not a member');
select is((select j ->> 'remaining' from r1), '1', 'one place left (capacity 2)');
select is((select display_name || '/' || affiliation || '/' || age_band || '/' || job_title || '/' || created_via || '/' || (name_confirmed_at is not null)
             from public.accounts where id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a411'), '山田 花子/会社X/30s/設計/event/true', 'the account was made with the profile');
select is((select consent_version || '/' || referral || '/' || channel || '/' || status from public.event_registrations
            where event_id = '00000000-0000-4000-8000-0000000a4002' and account_id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a411'), '2026-11-16/友人の紹介/line/applied', 'the registration remembers consent and referral');
select is((select join_count from public.posts where id = '00000000-0000-4000-8000-0000000a4002'), 1, 'one join');
select is((select count(*)::int from public.event_answers where event_id = '00000000-0000-4000-8000-0000000a4002' and account_id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a411'), 2, 'two answers are held');
select is((select n from posts_before), (select count(*)::int from public.posts), 'the answers did not become posts (nothing on the map before check-in)');
select is((select count(*)::int from public.event_answer_vectors('00000000-0000-4000-8000-0000000a4002')), 2, 'the answer vectors can be read by the server');
select is((select array_agg(kind order by kind) from public.outbound_messages where account_id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a411' and event_id = '00000000-0000-4000-8000-0000000a4002'),
          array['after', 'day_of', 'week_before'], 'three notices are planned for a LINE applicant');
select is((select scheduled_at from public.outbound_messages where account_id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a411' and kind = 'day_of'),
          (select s - interval '3 hours' from t0), 'the day-of notice is 3 hours before the start');
select is((select scheduled_at from public.outbound_messages where account_id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a411' and kind = 'week_before'),
          (select s - interval '7 days' from t0), 'the week-before notice is 7 days before');
select is((select count(*)::int from public.notifications where recipient_id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a401' and type = 'join' and actor_id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a411'), 1, 'the host heard about the join');
select is(public.event_apply('00000000-0000-4000-8000-0000000a4002', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a411', '{}', 'line', null, '[]', null) ->> 'status', 'already', 'applying again is "already"');
select is((select join_count from public.posts where id = '00000000-0000-4000-8000-0000000a4002'), 1, 'and does not add a join');

-- メールで申し込む人には案内を作らない
select is(public.event_apply('00000000-0000-4000-8000-0000000a4002', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a412', pg_temp.prof('鈴木 一郎'), 'email', null, pg_temp.ans(array['future', 'now', 'bogus']), null) ->> 'remaining', '0',
          'a second guest fills the capacity (a made-up answer is ignored)');
select is((select count(*)::int from public.outbound_messages where account_id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a412'), 0, 'an email applicant gets no notices');
-- 定員いっぱいは全部なし
select is(pg_temp.hint_of($$select public.event_apply('00000000-0000-4000-8000-0000000a4002', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a413', pg_temp.prof('佐藤 三郎'), 'line', null, pg_temp.ans(array['now', 'past']), null)$$),
          'recruit_full', 'a full event refuses (the existing recruit_full code)');
select is((select count(*)::int from public.accounts where id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a413') + (select count(*)::int from public.event_registrations where account_id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a413')
          + (select count(*)::int from public.event_answers where account_id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a413'), 0, 'and a refused guest leaves nothing at all');
-- 期限切れは全部なし
select is(pg_temp.hint_of($$select public.event_apply('00000000-0000-4000-8000-0000000a4003', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a419', pg_temp.prof('高橋 四郎'), 'line', null, pg_temp.ans(array['now', 'past']), null)$$),
          'recruit_closed', 'a past deadline refuses');
select is((select count(*)::int from public.accounts where id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a419') + (select count(*)::int from public.event_registrations where account_id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a419'), 0, 'and leaves nothing');
-- 外された人・断られた人
select is(pg_temp.hint_of($$select public.event_apply('00000000-0000-4000-8000-0000000a4005', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a415', pg_temp.prof('外 された'), 'line', null, pg_temp.ans(array['now', 'past']), null)$$),
          'event_banned', 'a removed person cannot apply');
select is(pg_temp.hint_of($$select public.event_apply('00000000-0000-4000-8000-0000000a4005', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a416', pg_temp.prof('断 られた'), 'line', null, pg_temp.ans(array['now', 'past']), null)$$),
          'event_banned', 'a person the community turned down cannot apply');
-- メンバーは回答なしで申し込める（BAR 限定の会）
create temp table r2 as select public.event_apply('00000000-0000-4000-8000-0000000a4001', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a402', '{}', 'email', null, '[]', '2026-11-16') as j;
select is((select j ->> 'status' || '/' || (j ->> 'is_member') || '/' || (j ->> 'was_guest') || '/' || (j ->> 'created_account') from r2), 'applied/true/false/false', 'a member applies with no answers');
select is((select display_name from public.accounts where id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a402'), 'member1', 'a member''s existing profile is not overwritten');
-- 取り消し → 再申し込み
select is(public.event_cancel_registration('00000000-0000-4000-8000-0000000a4002', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a411') ->> 'status', 'cancelled', 'cancelling works');
select is((select join_count from public.posts where id = '00000000-0000-4000-8000-0000000a4002'), 1, 'the join is gone (one left)');
select is((select count(*)::int from public.outbound_messages where account_id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a411' and event_id = '00000000-0000-4000-8000-0000000a4002' and sent_at is null), 0, 'unsent notices are gone');
select is((select count(*)::int from public.event_answers where account_id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a411'), 0, 'and the held answers');
select is((select count(*)::int from public.notifications where recipient_id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a401' and type = 'event_cancel' and actor_id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a411'), 1, 'the host heard about the cancel');
select is((select count(*)::int from public.notifications where recipient_id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a401' and type = 'join' and actor_id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a411'), 0, 'and the unread join notice went away');
select is(pg_temp.hint_of($$select public.event_cancel_registration('00000000-0000-4000-8000-0000000a4002', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a411')$$), 'event_not_applied', 'cancelling twice is refused');
select is(pg_temp.hint_of($$select public.event_set_late('00000000-0000-4000-8000-0000000a4002', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a411', 10)$$), 'event_not_applied', 'a cancelled person cannot say they are late');
select is(public.event_apply('00000000-0000-4000-8000-0000000a4002', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a411', '{}', 'line', null, pg_temp.ans(array['now', 'past']), null) ->> 'status', 'applied', 'after cancelling, applying again works');
select is((select status || '/' || (cancelled_at is null) || '/' || created_account from public.event_registrations where event_id = '00000000-0000-4000-8000-0000000a4002' and account_id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a411'),
          'applied/true/true', 'the same row is revived (still known as an account made by the event)');
select is((select count(*)::int from public.outbound_messages where account_id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a411' and event_id = '00000000-0000-4000-8000-0000000a4002' and sent_at is null), 3, 'and the notices are planned again');
-- 遅れる
select is(public.event_set_late('00000000-0000-4000-8000-0000000a4001', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a402', 30) ->> 'late_minutes', '30', 'saying "30 minutes late" works');
select is((select payload ->> 'minutes' from public.notifications where recipient_id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a401' and type = 'event_late' and actor_id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a402'), '30', 'the host is told');
select public.event_set_late('00000000-0000-4000-8000-0000000a4001', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a402', 60);
select is((select count(*)::int from public.notifications where recipient_id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a401' and type = 'event_late' and actor_id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a402'), 1, 'an old unread late notice is replaced');
select is(pg_temp.state_of($$select public.event_set_late('00000000-0000-4000-8000-0000000a4001', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a402', 15)$$), '23514', 'only 10 / 30 / 60 minutes');
-- お断り
select public.event_apply('00000000-0000-4000-8000-0000000a4005', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a414', pg_temp.prof('田中 五郎'), 'line', null, pg_temp.ans(array['now', 'past']), null);
select is(pg_temp.hint_of($$select public.event_decline('00000000-0000-4000-8000-0000000a4005', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a402', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a414')$$), 'event_not_host', 'only the host can decline');
select is(public.event_decline('00000000-0000-4000-8000-0000000a4005', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a401', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a414') ->> 'status', 'declined', 'the host declines');
select is((select array_agg(kind) from public.outbound_messages where account_id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a414'), array['declined'], 'only the "declined" LINE message remains, due now');
select is((select join_count from public.posts where id = '00000000-0000-4000-8000-0000000a4005'), 0, 'the join is gone');
select is(pg_temp.hint_of($$select public.event_apply('00000000-0000-4000-8000-0000000a4005', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a414', '{}', 'line', null, pg_temp.ans(array['now', 'past']), null)$$),
          'event_banned', 'after being declined, applying again is refused');
select is(pg_temp.hint_of($$select public.event_cancel_registration('00000000-0000-4000-8000-0000000a4005', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a414')$$), 'event_not_applied', 'and cancelling a declined registration is refused');
update public.event_registrations set status = 'attended', checked_in_at = now()
 where event_id = '00000000-0000-4000-8000-0000000a4001' and account_id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a402';
select is(pg_temp.hint_of($$select public.event_cancel_registration('00000000-0000-4000-8000-0000000a4001', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a402')$$), 'event_attended', 'after check-in a registration cannot be cancelled');
select is(pg_temp.hint_of($$select public.event_decline('00000000-0000-4000-8000-0000000a4001', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a401', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a402')$$), 'event_attended', 'nor declined');
update public.event_registrations set status = 'applied', checked_in_at = null
 where event_id = '00000000-0000-4000-8000-0000000a4001' and account_id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a402';

-- -----------------------------------------------------------------------
-- 4. 会の投稿を消すと中止になる
-- -----------------------------------------------------------------------
select public.event_apply('00000000-0000-4000-8000-0000000a4004', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a418', pg_temp.prof('伊藤 八郎'), 'line', null, pg_temp.ans(array['now', 'past']), null);
select public.event_apply('00000000-0000-4000-8000-0000000a4004', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a403', '{}', 'email', null, '[]', null);
select public.event_apply('00000000-0000-4000-8000-0000000a4004', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a401', '{}', 'line', null, '[]', null);
select is((select count(*)::int from public.outbound_messages where event_id = '00000000-0000-4000-8000-0000000a4004' and sent_at is null), 6, 'before: 6 planned notices (the guest and the host)');
update public.posts set deleted_at = now() where id = '00000000-0000-4000-8000-0000000a4004';
select ok((select cancelled_at is not null from public.events where post_id = '00000000-0000-4000-8000-0000000a4004'), 'deleting the post cancels the event');
select is((select array_agg(account_id::text || ':' || kind order by account_id) from public.outbound_messages where event_id = '00000000-0000-4000-8000-0000000a4004'),
          array['a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a401:event_cancelled', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a418:event_cancelled'], 'unsent notices are gone; a cancel message is due for the LINE applicants');
select is((select count(*)::int from public.notifications where type = 'event_cancelled' and recipient_id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a403' and post_id = '00000000-0000-4000-8000-0000000a4004'), 1,
          'a member who applied gets an in-app "cancelled" notice');
select is((select count(*)::int from public.notifications where type = 'event_cancelled' and recipient_id in ('a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a418', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a401')), 0, 'the guest (no app) and the host do not');
select is(pg_temp.hint_of($$select public.event_apply('00000000-0000-4000-8000-0000000a4004', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a404', '{}', 'email', null, '[]', null)$$), 'event_cancelled', 'a cancelled event takes no more applications');
select is(pg_temp.hint_of($$select public.event_update('00000000-0000-4000-8000-0000000a4004', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a401', '{"title":"新"}')$$), 'event_cancelled', 'and cannot be edited');
select is(pg_temp.hint_of($$select public.event_set_late('00000000-0000-4000-8000-0000000a4004', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a403', 10)$$), 'event_cancelled', 'nor told about lateness');

-- -----------------------------------------------------------------------
-- 5. 送る予定の取り出し
-- -----------------------------------------------------------------------
select public.line_link_save('a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a418', 'U-g8', true);
select public.line_link_save('a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a401', 'U-host', false);
select is((select count(*)::int from public.outbound_claim(10, 300)), 1, 'only the friend''s due notice is taken (the other person is not a friend)');
select is((select attempts from public.outbound_messages where account_id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a418' and kind = 'event_cancelled'), 1::smallint, 'taking it counts an attempt');
select is((select count(*)::int from public.outbound_claim(10, 300)), 0, 'asking again takes nothing (no double taking while leased)');
update public.outbound_messages set claimed_at = now() - interval '10 minutes' where account_id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a418' and kind = 'event_cancelled';
select is((select line_user_id || '/' || kind || '/' || title || '/' || place || '/' || (near_count is null) from public.outbound_claim(10, 300)),
          'U-g8/event_cancelled/会 pe4/場所4/true', 'after the lease runs out it is taken again, with the event details');
select public.outbound_done((select id from public.outbound_messages where account_id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a418' and kind = 'event_cancelled'), false, 'boom');
select is((select last_error from public.outbound_messages where account_id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a418' and kind = 'event_cancelled'), 'boom', 'a failure is recorded');
select public.outbound_done((select id from public.outbound_messages where account_id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a418' and kind = 'event_cancelled'), true);
select ok((select sent_at is not null and last_error is null from public.outbound_messages where account_id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a418' and kind = 'event_cancelled'), 'a success is recorded');
update public.outbound_messages set sent_at = null, claimed_at = null, scheduled_at = now() - interval '25 hours' where account_id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a418' and kind = 'event_cancelled';
select is((select count(*)::int from public.outbound_claim(10, 300)), 0, 'a notice more than 24 hours late is not sent');
update public.outbound_messages set scheduled_at = now() - interval '1 hour', attempts = 5 where account_id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a418' and kind = 'event_cancelled';
select is((select count(*)::int from public.outbound_claim(10, 300)), 0, 'and one tried 5 times is not taken again');
select is((select count(*)::int from public.outbound_claim(0, 300)), 0, 'a limit of 0 takes nothing');

-- LINE: webhook の二重・先に友だち追加していた人
select is(public.line_webhook_seen('evt-1'), true, 'a new webhook event is new');
select is(public.line_webhook_seen('evt-1'), false, 'and the same one again is a repeat');
select public.line_link_unfollow('U-g8');
select is((select is_friend from public.line_links where account_id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a418'), false, 'unfollowing marks the person as not a friend');
select public.line_link_save(null, 'U-early', true);
select is((select is_friend from public.line_pending_friends where line_user_id = 'U-early'), true, 'a friend whose account is unknown yet is remembered');
select is((select count(*)::int from public.line_links where line_user_id = 'U-early'), 0, 'without being tied to anyone');
select public.event_apply('00000000-0000-4000-8000-0000000a4005', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a420', pg_temp.prof('小林 十郎'), 'line', null, pg_temp.ans(array['now', 'past']), null);
select is(public.line_link_attach('a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a420', 'U-early'), true, 'attaching after applying ties them, and they are a friend');
select is((select is_friend::text || '/' || line_user_id from public.line_links where account_id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a420'), 'true/U-early', 'the link is saved');
select is((select count(*)::int from public.line_pending_friends where line_user_id = 'U-early'), 0, 'and the waiting record is gone');
select is(public.line_link_attach('a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a411', 'U-never-seen'), false, 'with no earlier record, the person is not marked as a friend');
select public.line_link_unfollow('U-early-2');
select is((select is_friend from public.line_pending_friends where line_user_id = 'U-early-2'), false, 'an unlinked person who blocks is remembered as not a friend');
select is(public.line_link_attach('a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a412', 'U-early-2'), false, 'and attaching keeps them as not a friend');
select public.line_link_save('a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a411', 'U-g1', true);
select is(public.line_link_attach('a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a411', 'U-g1'), true, 're-attaching the same link keeps the state');
select is((select count(*)::int from public.my_event_registrations('a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a411')), 1, 'my_event_registrations lists the person''s events');
select is((select public_code from public.my_event_registrations('a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a411')), (select public_code from public.events where post_id = '00000000-0000-4000-8000-0000000a4002'), 'with the public code');

-- -----------------------------------------------------------------------
-- 6. 会を変える
-- -----------------------------------------------------------------------
select is(pg_temp.hint_of($$select public.event_update('00000000-0000-4000-8000-0000000a4002', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a402', '{"title":"x"}')$$), 'event_not_host', 'only the host edits');
select is(public.event_update('00000000-0000-4000-8000-0000000a4002', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a401', '{"title":"会 pe2"}') ->> 'changed', 'false', 'no change reports false');
select is(public.event_update('00000000-0000-4000-8000-0000000a4002', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a401', '{"title":"新しい名前"}') ->> 'notified', '0', 'a new title alone tells nobody');
create temp table u1 as select public.event_update('00000000-0000-4000-8000-0000000a4002', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a401',
  jsonb_build_object('starts_at', (select s + interval '1 day' from t0), 'ends_at', (select e + interval '1 day' from t0), 'place', '新しい場所')) as j;
select is((select j ->> 'changed' || '/' || (j ->> 'notified') from u1), 'true/1', 'a new time and place tells the LINE applicant');
select is((select scheduled_at from public.outbound_messages where account_id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a411' and event_id = '00000000-0000-4000-8000-0000000a4002' and kind = 'day_of'),
          (select s + interval '1 day' - interval '3 hours' from t0), 'the planned notices moved with the start');
select ok(exists (select 1 from public.outbound_messages where account_id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a411' and event_id = '00000000-0000-4000-8000-0000000a4002' and kind = 'event_changed' and sent_at is null),
          'and a "changed" message is due');
select is(pg_temp.hint_of($$select public.event_update('00000000-0000-4000-8000-0000000a4002', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a401', '{"questions":[{"prompt":"talk","label":"x"}]}')$$), 'event_invalid', 'bad questions are refused on edit too');

-- -----------------------------------------------------------------------
-- 7. 見える人
-- -----------------------------------------------------------------------
select ok(exists (select 1 from public.event_registrations where status = 'applied' and account_id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a411'), 'g1 is applied');
set local role authenticated;
set local request.jwt.claims to '{"sub":"a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a401","role":"authenticated"}';
select is((select count(*)::int from public.accounts where id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a411'), 1, 'the host can read the name of someone registered for their event');
select is((select count(*)::int from public.accounts where id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a414'), 0, 'but not of someone they turned away (declined)');
select is((select count(*)::int from public.accounts where id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a412'), 1, 'another registered guest is visible');
set local request.jwt.claims to '{"sub":"a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a402","role":"authenticated"}';
select is((select count(*)::int from public.accounts where id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a411'), 0, 'a member who is not the host cannot read the guest');
select is(public.account_visible('a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a401'), true, 'members still see each other');
set local request.jwt.claims to '{"sub":"a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a406","role":"authenticated"}';
select is((select count(*)::int from public.accounts where id in ('a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a411', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a412')), 0, 'and another community''s member sees neither');
reset role;
reset request.jwt.claims;
select is((select count(*)::int from public.accounts where id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a420' and created_via = 'event'), 1, 'the guest account made by the event is marked');

-- -----------------------------------------------------------------------
-- 8. 会の投稿の join は申し込みからだけ
-- -----------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub":"a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a404","role":"authenticated"}';
select is(pg_temp.hint_of($$insert into public.reactions(post_id, actor_id, kind) values ('00000000-0000-4000-8000-0000000a4005', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a404', 'join')$$),
          'event_use_apply', 'a member cannot join an event by pressing the join button');
select is(pg_temp.state_of($$insert into public.reactions(post_id, actor_id, kind) values ('00000000-0000-4000-8000-0000000a4010', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a404', 'join')$$),
          'none', 'but joining an ordinary post still works');
select is(pg_temp.state_of($$insert into public.reactions(post_id, actor_id, kind) values ('00000000-0000-4000-8000-0000000a4005', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a404', 'like')$$),
          'none', 'and liking an event post still works');
set local request.jwt.claims to '{"sub":"a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a406","role":"authenticated"}';
select is(pg_temp.state_of($$insert into public.reactions(post_id, actor_id, kind) values ('00000000-0000-4000-8000-0000000a4005', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a406', 'join')$$),
          '42501', 'a person outside the community just gets the usual refusal (the event is not revealed)');
set local request.jwt.claims to '{"sub":"a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a402","role":"authenticated"}';
select is(pg_temp.hint_of($$delete from public.reactions where post_id = '00000000-0000-4000-8000-0000000a4001' and actor_id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a402' and kind = 'join'$$),
          'event_use_apply', 'and an applied member cannot un-join by hand');
reset role;
reset request.jwt.claims;
select is((select count(*)::int from public.reactions where post_id = '00000000-0000-4000-8000-0000000a4001' and actor_id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a402' and kind = 'join'), 1, 'the join is still there');

-- 退会の連鎖削除で、join の守りが止めない（D 7 章 25）
select public.event_apply('00000000-0000-4000-8000-0000000a4001', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a404', '{}', 'email', null, '[]', null);
select is((select count(*)::int from public.reactions where actor_id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a404' and kind = 'join' and post_id = '00000000-0000-4000-8000-0000000a4001'), 1, 'm3 has an event join');
set local request.jwt.claims to '{"sub":"a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a404","role":"authenticated"}';
select lives_ok($$delete from auth.users where id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a404'$$, 'withdrawing (the account and what hangs on it are deleted) is not stopped by the join guard');
set local request.jwt.claims to '';
select is((select count(*)::int from public.reactions where actor_id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a404'), 0, 'the join went with the account');
select is((select count(*)::int from public.event_registrations where account_id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a404'), 0, 'and the registration');
delete from auth.users where id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a420';
select is((select count(*)::int from public.event_registrations where account_id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a420') + (select count(*)::int from public.line_links where account_id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a420')
          + (select count(*)::int from public.outbound_messages where account_id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a420'), 0, 'deleting the auth user removes the registrations, LINE link and notices');

-- -----------------------------------------------------------------------
-- 9. probe・補助
-- -----------------------------------------------------------------------
select is((select public.event_probe_hit('00000000-0000-4000-8000-0000000a4005', 'dev-a', '1.2.3.4') ->> 'remaining'), '4', 'the first probe leaves 4 for that device');
select public.event_probe_hit('00000000-0000-4000-8000-0000000a4005', 'dev-a', '1.2.3.4');
select public.event_probe_hit('00000000-0000-4000-8000-0000000a4005', 'dev-a', '1.2.3.4');
select public.event_probe_hit('00000000-0000-4000-8000-0000000a4005', 'dev-a', '1.2.3.4');
select is((select public.event_probe_hit('00000000-0000-4000-8000-0000000a4005', 'dev-a', '1.2.3.4') ->> 'ok'), 'true', 'the 5th one is fine');
select is((select public.event_probe_hit('00000000-0000-4000-8000-0000000a4005', 'dev-a', '1.2.3.4') ->> 'ok'), 'false', 'the 6th the same day is not');
select is((select public.event_probe_hit('00000000-0000-4000-8000-0000000a4005', 'dev-b', '1.2.3.4') ->> 'ok'), 'false', 'a new cookie from the same IP is not either');
select is((select public.event_probe_hit('00000000-0000-4000-8000-0000000a4005', 'dev-b', '9.9.9.9') ->> 'ok'), 'true', 'a different cookie and IP is fine');
select is((select public.event_probe_hit('00000000-0000-4000-8000-0000000a4005', 'dev-c', '8.8.8.8', 5, 3) ->> 'ok'), 'false', 'the whole-event limit (here 3) stops everyone');
select is((select n from public.event_probe_hits where event_id = '00000000-0000-4000-8000-0000000a4005' and device = '*'), 6, 'denied tries are not counted');
select ok(not exists (select 1 from public.event_probe_hits where device like '%1.2.3.4%'), 'the raw IP is never stored');
-- フルネームの確認がまだの人（om）
select is(pg_temp.hint_of($$select public.event_apply('00000000-0000-4000-8000-0000000a4005', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a406', '{}', 'email', null, pg_temp.ans(array['now', 'past']), null)$$),
          'name_required', 'a person who has not confirmed their full name has to give it');
select is(public.event_apply('00000000-0000-4000-8000-0000000a4005', 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a406', pg_temp.prof('大野 みどり'), 'email', null, pg_temp.ans(array['now', 'past']), null) ->> 'created_account',
          'false', 'then they apply (the account was not made by the event)');
select is((select display_name || '/' || (name_confirmed_at is not null) || '/' || coalesce(created_via, '-') from public.accounts where id = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a406'),
          '大野 みどり/true/-', 'and the full name is saved and confirmed');
select is(public.has_live_registration('a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a411'), true, 'g1 has a live registration');
select is(public.has_live_registration('a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a414'), false, 'a declined person does not');
select is(public.has_live_registration('a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a418'), false, 'nor does someone whose event was cancelled');
select is(public.has_live_registration('a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a421'), false, 'nor someone who never applied');

select * from finish();
rollback;
