-- 2026-10-27: コミュニティの投稿は、そのコミュニティのメンバーだけが読める（FILE 1 + FILE 2 のあとの姿）。
-- Run with: supabase test db (CI does). Everybody here is made up.
--
-- 役: anon（ログインしていない）/ outsider（登録しただけでどこにも入っていない）/ member（コミュニティ A）/
--     admin（A の管理者）/ member_AB（A と B）/ member_B（B だけ）/ ex（A に入っていて、抜けた人）。
-- どの経路も確かめる: 表（PostgREST）、関数（RPC）、Realtime の publication、画像の一覧、列の権限、
-- 古い関数の呼び方（署名が1つだけ残ること）。「読めない」の確認には、必ず「読める」の対照を並べる。
begin;
select no_plan();

insert into auth.users(id) values
  ('d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d301'),
  ('d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d302'),
  ('d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d303'),
  ('d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d304'),
  ('d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d305'),
  ('d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d306'),
  ('d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d307');
insert into public.accounts(id, display_name) values
  ('d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d301', 'admin_A'),
  ('d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d302', 'member_A'),
  ('d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d303', 'member_AB'),
  ('d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d304', 'outsider'),
  ('d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d305', 'ex_member'),
  ('d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d306', 'member_B'),
  ('d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d307', 'no_community')
on conflict (id) do nothing;

-- コミュニティ A, B。admin は A の管理者。ex は A に入っている（あとで抜ける）。
select public.create_community('A', 'mo-a', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d301');
select public.create_community('B', 'mo-b', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d306');
create temp table cm as
  select (select id from public.communities where slug = 'mo-a') as a,
         (select id from public.communities where slug = 'mo-b') as b;
grant select on cm to anon, authenticated, service_role;
insert into public.community_members(community_id, account_id, role)
select a, 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d302'::uuid, 'member' from cm
union all select a, 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d303'::uuid, 'member' from cm
union all select b, 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d303'::uuid, 'member' from cm
union all select a, 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d305'::uuid, 'member' from cm;

-- ベクトル: 先頭 n 個が 1、残りが 0。n が大きいほど「全部 1」に近い（近さの順が決まる）。
create function pg_temp.vec(n integer) returns vector(448) language sql immutable as $$
  select (array_agg(case when i <= n then 1.0::real else 0.0::real end order by i))::vector(448)
    from generate_series(1, 448) i
$$;

-- 投稿: pA(A) pB(B) pNull(どこにも属さない) pDel(A・消した) pEx(A・exの投稿) pRec(A・期限切れの募集) pTalk(A・募集)
insert into public.posts(id, author_id, body, x, y, cluster_id, vec, vec_c, community_id, deleted_at)
select v.id::uuid, v.author::uuid, v.body, v.x, v.y, 0,
       pg_temp.vec(v.n), pg_temp.vec(v.n),
       v.cid, v.del
  from (values
    ('00000000-0000-4000-8000-0000000d3001', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d302', 'A の投稿', 1.0, 1.0, 448,
       (select a from cm), null::timestamptz),
    ('00000000-0000-4000-8000-0000000d3002', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d306', 'B の投稿', 2.0, 2.0, 50,
       (select b from cm), null),
    ('00000000-0000-4000-8000-0000000d3003', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d307', 'どこにも属さない投稿', 3.0, 3.0, 20,
       null::uuid, null),
    ('00000000-0000-4000-8000-0000000d3004', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d302', '消した投稿', 4.0, 4.0, 10,
       (select a from cm), now()),
    ('00000000-0000-4000-8000-0000000d3005', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d305', 'ex の投稿', 5.0, 5.0, 300,
       (select a from cm), null)
  ) as v(id, author, body, x, y, n, cid, del);
insert into public.posts(id, author_id, body, x, y, cluster_id, vec, vec_c, community_id, tags, recruit_deadline)
select '00000000-0000-4000-8000-0000000d3006', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d301', '期限切れの会', 6, 6, 0,
       pg_temp.vec(200), pg_temp.vec(200),
       a, array['参加者募集中'], current_date - 2
  from cm;
insert into public.posts(id, author_id, body, x, y, cluster_id, vec, vec_c, community_id, tags)
select '00000000-0000-4000-8000-0000000d3007', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d301', '集まる会', 7, 7, 0,
       pg_temp.vec(100), pg_temp.vec(100),
       a, array['参加者募集中']
  from cm;

-- コメント（c1: pA に member。c2: ex の投稿 pEx に member）と反応（ex が pA に like）
insert into public.comments(id, post_id, author_id, body) values
  ('d3d3d3d3-d3d3-4d3d-8d3d-0000000c0001', '00000000-0000-4000-8000-0000000d3001',
   'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d302', 'A のコメント'),
  ('d3d3d3d3-d3d3-4d3d-8d3d-0000000c0002', '00000000-0000-4000-8000-0000000d3005',
   'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d302', 'ex の投稿へのコメント');
-- 消したコメント（読めない。通報もできない）
insert into public.comments(id, post_id, author_id, body, deleted_at) values
  ('d3d3d3d3-d3d3-4d3d-8d3d-0000000c0009', '00000000-0000-4000-8000-0000000d3001',
   'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d302', '消したコメント', now());
insert into public.reactions(post_id, actor_id, kind) values
  ('00000000-0000-4000-8000-0000000d3001', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d305', 'like'),
  ('00000000-0000-4000-8000-0000000d3001', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d303', 'help'),
  ('00000000-0000-4000-8000-0000000d3007', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d302', 'join'),
  ('00000000-0000-4000-8000-0000000d3007', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d303', 'join'),
  ('00000000-0000-4000-8000-0000000d3007', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d306', 'join'),
  ('00000000-0000-4000-8000-0000000d3007', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d305', 'join');

-- 通知は自動で出た行を消してから、決めた行だけを入れる。
delete from public.notifications;
insert into public.notifications(id, recipient_id, actor_id, post_id, type, community_id, payload) values
  ('d3d3d3d3-d3d3-4d3d-8d3d-00000000a001', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d302', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d303',
   '00000000-0000-4000-8000-0000000d3001', 'like', null, null),
  ('d3d3d3d3-d3d3-4d3d-8d3d-00000000a002', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d305', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d302',
   '00000000-0000-4000-8000-0000000d3005', 'comment', null, null),
  ('d3d3d3d3-d3d3-4d3d-8d3d-00000000a004', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d302', null,
   null, 'island', (select b from cm), '{"name":"B の島"}'),
  ('d3d3d3d3-d3d3-4d3d-8d3d-00000000a005', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d302', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d303',
   null, 'dm', null, null),
  ('d3d3d3d3-d3d3-4d3d-8d3d-00000000a006', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d302', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d303',
   '00000000-0000-4000-8000-0000000d3004', 'like', null, null),
  ('d3d3d3d3-d3d3-4d3d-8d3d-00000000a007', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d304', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d302',
   '00000000-0000-4000-8000-0000000d3001', 'comment', null, null),
  ('d3d3d3d3-d3d3-4d3d-8d3d-00000000a008', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d302', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d306',
   '00000000-0000-4000-8000-0000000d3002', 'like', null, null);
-- 古いインスタンスが書いた「コミュニティ無しの島の通知」: 誰にも読めない
insert into public.notifications(id, recipient_id, actor_id, post_id, type, community_id, payload) values
  ('d3d3d3d3-d3d3-4d3d-8d3d-00000000a009', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d302', null,
   null, 'island', null, '{"name":"どこの島か分からない"}');
insert into public.notifications(id, recipient_id, actor_id, post_id, type, community_id, payload) values
  ('d3d3d3d3-d3d3-4d3d-8d3d-00000000a003', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d302', null,
   null, 'island', (select a from cm), '{"name":"A の島"}');

-- 島の記録（クライアントには 0 件）
insert into public.islands_state(id, name, community_id)
select 'd3d3d3d3-d3d3-4d3d-8d3d-0000000e0001', 'A の島', a from cm;
insert into public.island_events(island_id, kind, cause, community_id)
select 'd3d3d3d3-d3d3-4d3d-8d3d-0000000e0001', 'birth', 'x', a from cm;

-- 画像（storage）
insert into storage.objects(bucket_id, name, owner) values
  ('post-images', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d302/a.webp', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d302'),
  ('post-images', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d303/b.webp', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d303');

-- 話してみたい・DM の部屋（member と member_AB。outsider と member_AB。どちらも会 pTalk から）
insert into public.dm_rooms(user_a, user_b, event_post_id)
values ('d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d302', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d303', '00000000-0000-4000-8000-0000000d3007'),
       ('d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d303', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d304', '00000000-0000-4000-8000-0000000d3007');

-- like_count の記録（ex が自分の反応を消したとき減ること）
create temp table snap as
  select like_count as likes from public.posts where id = '00000000-0000-4000-8000-0000000d3001';
grant select on snap to authenticated;

-- ===========================================================================
-- 1. カタログ: 署名は1つ、権限、列、Realtime、スイッチ
-- ===========================================================================
select is((select count(*)::int from pg_proc where pronamespace = 'public'::regnamespace and proname = 'nearest_posts'), 1,
          'nearest_posts has exactly one signature');
select is((select count(*)::int from pg_proc where pronamespace = 'public'::regnamespace and proname = 'nearest_to_vector'), 1,
          'nearest_to_vector has exactly one signature');
select is((select count(*)::int from pg_proc where pronamespace = 'public'::regnamespace and proname = 'account_post_centroids'), 1,
          'account_post_centroids has exactly one signature');
select is((select count(*)::int from pg_proc where pronamespace = 'public'::regnamespace
             and proname in ('map_posts', 'map_cells', 'community_map_posts', 'map_posts_for_community',
                             'in_community', 'is_member_of_post', 'is_member_of_post_any',
                             'talk_shared_event', 'talk_peers', 'dm_room_list', 'notification_feed')), 11,
          'every function the lockdown touches exists once (no overloads left behind)');
select is((select value from public.app_settings where key = 'members_only'), 'true'::jsonb,
          'the lockdown file turned the switch on');

select ok(not has_function_privilege('anon', 'public.nearest_posts(uuid, integer, uuid)', 'execute'), 'anon cannot run nearest_posts');
select ok(not has_function_privilege('authenticated', 'public.nearest_posts(uuid, integer, uuid)', 'execute'), 'nor a signed-in person');
select ok(has_function_privilege('service_role', 'public.nearest_posts(uuid, integer, uuid)', 'execute'), 'the server key can');
select ok(not has_function_privilege('anon', 'public.nearest_to_vector(text, integer, uuid)', 'execute'), 'anon cannot run nearest_to_vector');
select ok(not has_function_privilege('authenticated', 'public.nearest_to_vector(text, integer, uuid)', 'execute'), 'nor a signed-in person');
select ok(has_function_privilege('service_role', 'public.nearest_to_vector(text, integer, uuid)', 'execute'), 'the server key can');
select ok(not has_function_privilege('anon', 'public.account_post_centroids(uuid)', 'execute'), 'anon cannot run account_post_centroids');
select ok(not has_function_privilege('authenticated', 'public.account_post_centroids(uuid)', 'execute'), 'nor a signed-in person');
select ok(has_function_privilege('service_role', 'public.account_post_centroids(uuid)', 'execute'), 'the server key can');
select ok(not has_function_privilege('anon', 'public.pair_similarity(uuid, uuid)', 'execute'), 'anon cannot run pair_similarity');
select ok(not has_function_privilege('authenticated', 'public.pair_similarity(uuid, uuid)', 'execute'), 'nor a signed-in person');
select ok(has_function_privilege('service_role', 'public.pair_similarity(uuid, uuid)', 'execute'), 'the server key can');
select ok(not has_function_privilege('anon', 'public.post_terms(uuid[])', 'execute'), 'anon cannot run post_terms');
select ok(not has_function_privilege('authenticated', 'public.post_terms(uuid[])', 'execute'), 'nor a signed-in person');
select ok(not has_function_privilege('anon', 'public.interaction_events(timestamptz)', 'execute'), 'anon cannot run interaction_events');
select ok(not has_function_privilege('authenticated', 'public.profile_vectors()', 'execute'), 'nor profile_vectors');
select ok(not has_function_privilege('anon', 'public.in_community(uuid, uuid)', 'execute'), 'anon cannot run in_community');
select ok(not has_function_privilege('authenticated', 'public.in_community(uuid, uuid)', 'execute'), 'nor a signed-in person');
select ok(not has_function_privilege('anon', 'public.is_member_of_post(uuid)', 'execute'), 'anon cannot run is_member_of_post');
select ok(has_function_privilege('authenticated', 'public.is_member_of_post(uuid)', 'execute'),
          'a signed-in person can (the policies run as them)');
select ok(not has_function_privilege('anon', 'public.is_member_of_post_any(uuid)', 'execute'), 'anon cannot run is_member_of_post_any');
select ok(not has_function_privilege('anon', 'public.map_posts_for_community(uuid, double precision, double precision, double precision, double precision, integer)', 'execute'),
          'anon cannot run map_posts_for_community');
select ok(not has_function_privilege('authenticated', 'public.map_posts_for_community(uuid, double precision, double precision, double precision, double precision, integer)', 'execute'),
          'nor a signed-in person');
select ok(has_function_privilege('service_role', 'public.map_posts_for_community(uuid, double precision, double precision, double precision, double precision, integer)', 'execute'),
          'the server key can');
select ok(not has_function_privilege('anon', 'public.energy_cell_apply(double precision, double precision, real, integer)', 'execute'),
          'nobody writes the energy cells by hand');
select ok(not has_function_privilege('authenticated', 'public.energy_cell_apply(double precision, double precision, real, integer)', 'execute'),
          'not even a signed-in person');

-- 定義者権限（security definer）の関数で anon が呼べるのは、次の4つだけ。
select is((select array_agg(p.proname::text order by p.proname) from pg_proc p
            where p.pronamespace = 'public'::regnamespace and p.prosecdef
              and p.prorettype not in ('trigger'::regtype, 'event_trigger'::regtype)
              and has_function_privilege('anon', p.oid, 'execute')
              and p.proname not in ('check_invite', 'community_map_posts', 'map_posts', 'map_cells')),
          null::text[], 'anon can run no other security definer function');
-- ログインした人が呼べる定義者権限の関数は、画面が使うものだけ。
select is((select array_agg(p.proname::text order by p.proname) from pg_proc p
            where p.pronamespace = 'public'::regnamespace and p.prosecdef
              and p.prorettype not in ('trigger'::regtype, 'event_trigger'::regtype)
              and has_function_privilege('authenticated', p.oid, 'execute')
              and p.proname not in ('check_invite', 'claim_invite', 'create_invite', 'list_invites', 'revoke_invite',
                                    'my_communities', 'my_community_ids', 'is_community_admin', 'can_leave_community',
                                    'rename_community',
                                    'is_member_of_post', 'is_member_of_post_any',
                                    'community_map_posts', 'map_posts', 'map_cells',
                                    'notification_feed', 'touch_last_seen', 'mark_active',
                                    'talk_peers', 'press_talk', 'withdraw_talk', 'my_talk_state', 'dm_room_list',
                                    'react_dm', 'mark_dm_read', 'dm_partner_read_at',
                                    -- 2026-11-01 承認制（M1）と accounts を閉じる（M2）。画面が呼ぶ①の関数。
                                    -- 中だけの join_request_notify・accounts_join_request_notify は足さない（見張りの役目）
                                    'set_invite_approval', 'my_join_status', 'cancel_join_request',
                                    'list_join_requests', 'decide_join_request',
                                    'shares_community_with', 'account_visible')),
          null::text[], 'a signed-in person can run no security definer function other than the screens'' own');

-- posts の列: anon はどの列も読めない（あとから足された列も）。authenticated の vec は読めず、書ける列は4つだけ。
select is((select count(*)::int from information_schema.columns c
            where c.table_schema = 'public' and c.table_name = 'posts'
              and has_column_privilege('anon', 'public.posts', c.column_name, 'select')), 0,
          'anon can read no column of posts (community_id, prompt and recruit_* included)');
select ok(not has_table_privilege('anon', 'public.posts', 'select'), 'nor the table');
select ok(has_column_privilege('authenticated', 'public.posts', 'community_id', 'select'), 'a signed-in person reads community_id (their rows)');
select ok(not has_column_privilege('authenticated', 'public.posts', 'vec', 'select'), 'vec stays hidden');
select ok(not has_column_privilege('authenticated', 'public.posts', 'vec_c', 'select'), 'vec_c stays hidden');
select is((select array_agg(c.column_name::text order by c.column_name) from information_schema.columns c
            where c.table_schema = 'public' and c.table_name = 'posts'
              and has_column_privilege('authenticated', 'public.posts', c.column_name, 'update')),
          array['deleted_at', 'image_path', 'motivation', 'tags'],
          'a signed-in person can write only tags, motivation, image_path and deleted_at of a post (never community_id)');
select is((select count(*)::int from information_schema.columns c
            where c.table_schema = 'public' and c.table_name = 'posts'
              and has_column_privilege('authenticated', 'public.posts', c.column_name, 'insert')), 0,
          'and cannot insert a post');
select is((select array_agg(roles::text) from pg_policies where schemaname = 'public' and tablename = 'posts' and policyname = 'posts_read'),
          array['{authenticated}'], 'the posts read policy is for signed-in people only');

select ok(not has_table_privilege('anon', 'public.comments', 'select'), 'anon reads no comments');
select ok(not has_table_privilege('anon', 'public.reactions', 'select'), 'anon reads no reactions');
select ok(not has_table_privilege('anon', 'public.communities', 'select'), 'anon reads no communities');
select ok(not has_table_privilege('anon', 'public.energy_cells', 'select'), 'anon reads no energy cells');
select ok(not has_table_privilege('anon', 'public.islands_state', 'select'), 'anon reads no islands');
select ok(not has_table_privilege('anon', 'public.island_events', 'select'), 'anon reads no island events');
select ok(not has_table_privilege('anon', 'public.notifications', 'select'), 'anon reads no notifications');

-- Realtime: 公開されているのは notifications だけ（そして notifications_read が人ごとに絞る）。
select is((select count(*)::int from pg_publication_tables
            where pubname = 'supabase_realtime' and schemaname = 'public' and tablename <> 'notifications'), 0,
          'the realtime publication holds no table but notifications');
select is((select count(*)::int from pg_publication_tables
            where pubname = 'supabase_realtime' and schemaname = 'public'
              and tablename in ('posts', 'comments', 'reactions', 'communities', 'community_members', 'islands_state', 'island_events', 'energy_cells')), 0,
          'in particular posts, comments and reactions are not streamed');

-- 画像: 一覧の policy は、ログインした人の自分のフォルダだけ。
select is((select array_agg(roles::text) from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'post_images_read'),
          array['{authenticated}'], 'the image list policy is for signed-in people only');

-- 索引: コミュニティ単位の読みが全件を舐めない。
select ok(exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'posts'
                    and indexdef ~ '\(community_id, created_at'), 'posts has a (community_id, created_at) index');
select ok(exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'posts'
                    and indexdef ~ '\(community_id, x, y\)'), 'and a (community_id, x, y) index');
select ok(exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'comments' and indexdef ~ '\(post_id'),
          'comments has a post_id index');
select ok(exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'reactions' and indexdef ~ '\(post_id'),
          'reactions has a post_id index');

-- 判定の関数（メンバーだけ。投稿者かどうかは見ない）
select is(public.is_member_of_post('00000000-0000-4000-8000-0000000d3001'), false,
          'with no login, nobody is a member of anything');

-- ===========================================================================
-- 2. anon（ログインしていない）
-- ===========================================================================
reset role;
set local role anon;
set local request.jwt.claims to '{"role":"anon"}';
select throws_ok($$select count(*) from public.posts$$, '42501', null, 'anon: posts cannot be read (permission denied)');
select throws_ok($$select id from public.posts where id = '00000000-0000-4000-8000-0000000d3001'$$, '42501', null,
                 'anon: nor one post by its id');
select throws_ok($$select community_id from public.posts$$, '42501', null, 'anon: nor community_id');
select throws_ok($$select * from public.comments$$, '42501', null, 'anon: comments cannot be read');
select throws_ok($$select * from public.reactions$$, '42501', null, 'anon: reactions cannot be read');
select throws_ok($$select * from public.communities$$, '42501', null, 'anon: communities cannot be read');
select throws_ok($$select * from public.notifications$$, '42501', null, 'anon: notifications cannot be read');
select throws_ok($$select * from public.energy_cells$$, '42501', null, 'anon: energy_cells cannot be read');
select throws_ok($$select * from public.islands_state$$, '42501', null, 'anon: islands cannot be read');
select throws_ok($$select * from public.island_events$$, '42501', null, 'anon: island events cannot be read');
select is((select count(*)::int from public.community_map_posts((select a from cm), -100, -100, 100, 100, 100)), 0,
          'anon: the community map is empty (an old tab gets nothing, not an error)');
select is((select count(*)::int from public.map_posts(-100, -100, 100, 100, 100)), 0, 'anon: map_posts is empty');
select is((select count(*)::int from public.map_cells(-100, -100, 100, 100)), 0, 'anon: map_cells is empty');
select throws_ok($$select * from public.nearest_posts('00000000-0000-4000-8000-0000000d3001'::uuid, 5)$$, '42501', null,
                 'anon: nearest_posts is not callable');
select throws_ok($$select public.in_community('d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d302', null)$$, '42501', null,
                 'anon: in_community is not callable');
select throws_ok($$select public.is_member_of_post('00000000-0000-4000-8000-0000000d3001')$$, '42501', null,
                 'anon: is_member_of_post is not callable');
select is((select count(*)::int from storage.objects where bucket_id = 'post-images'), 0,
          'anon: the image list is empty');

-- ===========================================================================
-- 3. outsider（登録しただけ。どこにも入っていない）
-- ===========================================================================
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d304","role":"authenticated"}';
select is((select count(*)::int from public.posts), 0, 'outsider: no post at all (count(*) leaks nothing)');
select is((select count(*)::int from public.posts where id = '00000000-0000-4000-8000-0000000d3001'), 0,
          'outsider: nor one post by its id (same as a missing id)');
select is((select count(*)::int from public.posts where community_id = (select a from cm)), 0, 'outsider: nor by community');
select is((select count(*)::int from public.comments), 0, 'outsider: no comment');
select is((select count(*)::int from public.reactions), 0, 'outsider: no reaction');
select is((select count(*)::int from public.communities), 0, 'outsider: no community (not even the name)');
select is((select count(*)::int from public.notifications), 0,
          'outsider: the notification about a post of A is hidden (it should not exist for them)');
select is((select count(*)::int from public.notification_feed(50)), 0, 'outsider: nor in the feed');
select is((select count(*)::int from public.community_map_posts((select a from cm), -100, -100, 100, 100, 100)), 0,
          'outsider: community_map_posts is empty');
select is((select count(*)::int from public.map_posts(-100, -100, 100, 100, 100)), 0, 'outsider: map_posts is empty');
select is((select count(*)::int from public.map_cells(-100, -100, 100, 100)), 0, 'outsider: map_cells is empty');
select is((select count(*)::int from public.energy_cells), 0, 'outsider: energy_cells is empty');
select is((select count(*)::int from public.islands_state), 0, 'outsider: islands_state is empty');
select is((select count(*)::int from public.island_events), 0, 'outsider: island_events is empty');
select is((select count(*)::int from storage.objects where bucket_id = 'post-images'), 0,
          'outsider: the image list shows nothing of other people''s folders');
select throws_ok($$select * from public.nearest_posts('00000000-0000-4000-8000-0000000d3001'::uuid, 5, (select a from cm))$$,
                 '42501', null, 'outsider: nearest_posts is not callable');
select throws_ok($$select * from public.nearest_to_vector(array_fill(1.0, array[448])::vector(448)::text, 5, (select a from cm))$$,
                 '42501', null, 'outsider: nor nearest_to_vector');
select throws_ok($$select * from public.account_post_centroids((select a from cm))$$, '42501', null,
                 'outsider: nor account_post_centroids');
select throws_ok($$select * from public.map_posts_for_community((select a from cm), -100, -100, 100, 100, 100)$$, '42501', null,
                 'outsider: nor map_posts_for_community');
select is(public.is_member_of_post('00000000-0000-4000-8000-0000000d3001'), false, 'outsider: is_member_of_post is false');
-- 書けない
select throws_ok($$insert into public.comments(post_id, author_id, body)
                    values ('00000000-0000-4000-8000-0000000d3001', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d304', 'こんにちは')$$,
                 '42501', null, 'outsider: cannot comment on a post of A');
select throws_ok($$insert into public.reactions(post_id, actor_id, kind)
                    values ('00000000-0000-4000-8000-0000000d3001', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d304', 'like')$$,
                 '42501', null, 'outsider: cannot react to a post of A');
select throws_ok($$insert into public.reactions(post_id, actor_id, kind)
                    values ('00000000-0000-4000-8000-0000000d3006', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d304', 'join')$$,
                 '42501', null, 'outsider: joining an EXPIRED meeting of A is refused as 42501 (the guard does not tell it is expired)');
select throws_ok($$insert into public.reactions(post_id, actor_id, kind)
                    values (gen_random_uuid(), 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d304', 'join')$$,
                 '42501', null, 'outsider: joining a post that does not exist gives the same 42501');
select throws_ok($$insert into public.reports(reporter_id, post_id, reason)
                    values ('d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d304', '00000000-0000-4000-8000-0000000d3001', 'x')$$,
                 '42501', null, 'outsider: cannot report a post of A');
select throws_ok($$insert into public.reports(reporter_id, comment_id, reason)
                    values ('d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d304', 'd3d3d3d3-d3d3-4d3d-8d3d-0000000c0001', 'x')$$,
                 '42501', null, 'outsider: reporting a comment of A is refused');
select throws_ok($$insert into public.reports(reporter_id, comment_id, reason)
                    values ('d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d304', gen_random_uuid(), 'x')$$,
                 '42501', null, 'outsider: and a comment that does not exist gives the very same answer');
select throws_ok($$insert into public.posts(author_id, body, x, y, cluster_id, vec, vec_c)
                    values ('d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d304', 'x', 0, 0, 0,
                            array_fill(1.0, array[448])::vector(448), array_fill(1.0, array[448])::vector(448))$$,
                 '42501', null, 'outsider: cannot write a post');
select throws_ok($$insert into storage.objects(bucket_id, name, owner)
                    values ('post-images', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d302/evil.webp', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d304')$$,
                 '42501', null, 'outsider: cannot write into somebody else''s image folder');
select lives_ok($$insert into storage.objects(bucket_id, name, owner)
                  values ('post-images', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d304/mine.webp', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d304')$$,
                'outsider: but can write into their own folder');
select is((select count(*)::int from storage.objects where bucket_id = 'post-images'), 1,
          'outsider: and the image list shows only their own folder');

-- ===========================================================================
-- 4. member（A）: 読める。B のものは読めない
-- ===========================================================================
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d302","role":"authenticated"}';
select is((select count(*)::int from public.posts), 4,
          'member: sees the four live posts of A (pA, ex''s post, the expired meeting, the meeting) and nothing else');
select is((select count(*)::int from public.posts where id = '00000000-0000-4000-8000-0000000d3001'), 1, 'member: reads pA');
select is((select count(*)::int from public.posts where id = '00000000-0000-4000-8000-0000000d3002'), 0, 'member: not B''s post');
select is((select count(*)::int from public.posts where id = '00000000-0000-4000-8000-0000000d3003'), 0,
          'member: not the post with no community');
select is((select count(*)::int from public.posts where id = '00000000-0000-4000-8000-0000000d3004'), 0,
          'member: not even their own deleted post');
select is((select body from public.posts where id = '00000000-0000-4000-8000-0000000d3001'), 'A の投稿', 'member: the text is there');
select is((select count(*)::int from public.comments), 2, 'member: sees the comments on posts of A');
select is((select count(*)::int from public.reactions where post_id = '00000000-0000-4000-8000-0000000d3001'), 2,
          'member: sees the reactions on pA');
select is((select count(*)::int from public.communities), 1, 'member: sees their community');
select is((select count(*)::int from public.community_map_posts((select a from cm), -100, -100, 100, 100, 100)), 4,
          'member: community_map_posts for A shows A''s four live posts');
select is((select count(*)::int from public.community_map_posts((select b from cm), -100, -100, 100, 100, 100)), 0,
          'member: B''s map is empty for them');
select is((select count(*)::int from public.map_posts(-100, -100, 100, 100, 100)), 4, 'member: map_posts shows only A');
select is((select count(*)::int from public.map_cells(-100, -100, 100, 100)), 0,
          'member: map_cells returns nothing (the mixed-world summary is closed)');
select is((select count(*)::int from public.energy_cells), 0, 'member: energy_cells is closed too');
select is((select count(*)::int from public.islands_state), 0, 'member: islands_state returns nothing (no error)');
select is((select count(*)::int from public.island_events), 0, 'member: island_events returns nothing (no error)');
select is(public.is_member_of_post('00000000-0000-4000-8000-0000000d3001'), true, 'member: is_member_of_post(pA)');
select is(public.is_member_of_post('00000000-0000-4000-8000-0000000d3002'), false, 'member: not B''s');
select is(public.is_member_of_post('00000000-0000-4000-8000-0000000d3004'), false, 'member: not a deleted post');
select is(public.is_member_of_post('00000000-0000-4000-8000-0000000d3003'), false, 'member: not a post with no community');
select is(public.is_member_of_post_any('00000000-0000-4000-8000-0000000d3004'), true,
          'member: but a deleted post of A still counts for notification rows');
-- 書ける
select lives_ok($$insert into public.comments(post_id, author_id, body)
                   values ('00000000-0000-4000-8000-0000000d3001', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d302', '二つ目のコメント')$$,
                'member: comments on a post of A');
select throws_ok($$insert into public.comments(post_id, author_id, body)
                    values ('00000000-0000-4000-8000-0000000d3002', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d302', 'B には書けない')$$,
                 '42501', null, 'member: not on a post of B');
select throws_ok($$insert into public.comments(post_id, author_id, body)
                    values ('00000000-0000-4000-8000-0000000d3004', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d302', '消した投稿には書けない')$$,
                 '42501', null, 'member: not on a deleted post');
select throws_ok($$insert into public.comments(post_id, author_id, body)
                    values ('00000000-0000-4000-8000-0000000d3001', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d303', 'なりすまし')$$,
                 '42501', null, 'member: not in somebody else''s name');
select lives_ok($$insert into public.reactions(post_id, actor_id, kind)
                   values ('00000000-0000-4000-8000-0000000d3001', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d302', 'like')$$,
                'member: reacts to a post of A');
select throws_ok($$insert into public.reactions(post_id, actor_id, kind)
                    values ('00000000-0000-4000-8000-0000000d3002', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d302', 'like')$$,
                 '42501', null, 'member: not to a post of B');
select throws_ok($$insert into public.reactions(post_id, actor_id, kind)
                    values ('00000000-0000-4000-8000-0000000d3006', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d302', 'join')$$,
                 'P0001', 'recruit_closed', 'member: an expired meeting still says recruit_closed (the members keep the old answer)');
select lives_ok($$update public.comments set body = '直した' where id = 'd3d3d3d3-d3d3-4d3d-8d3d-0000000c0001'$$,
                'member: edits their own comment');
select lives_ok($$insert into public.reports(reporter_id, post_id, reason)
                   values ('d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d302', '00000000-0000-4000-8000-0000000d3001', 'x')$$,
                'member: reports a post of A');
select lives_ok($$insert into public.reports(reporter_id, comment_id, reason)
                   values ('d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d302', 'd3d3d3d3-d3d3-4d3d-8d3d-0000000c0001', 'x')$$,
                'member: reports a comment on a post of A');
select throws_ok($$insert into public.reports(reporter_id, comment_id, reason)
                    values ('d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d302', 'd3d3d3d3-d3d3-4d3d-8d3d-0000000c0009', 'x')$$,
                 '42501', null, 'member: a deleted comment cannot be reported (it is not readable)');
select throws_ok($$insert into public.reports(reporter_id, post_id, reason)
                    values ('d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d302', '00000000-0000-4000-8000-0000000d3002', 'x')$$,
                 '42501', null, 'member: not a post of B');
select throws_ok($$update public.posts set community_id = (select b from cm) where id = '00000000-0000-4000-8000-0000000d3001'$$,
                 '42501', null, 'member: cannot move a post to another community');
select lives_ok($$update public.posts set motivation = 70 where id = '00000000-0000-4000-8000-0000000d3001'$$,
                'member: can change what the author may change on their own post');
-- 通知
select is((select count(*)::int from public.notifications), 4,
          'member: sees their notifications for A (a like on pA, A''s island, the DM, the like on a deleted post of A); not B''s island or B''s post');
select is((select count(*)::int from public.notifications where id = 'd3d3d3d3-d3d3-4d3d-8d3d-00000000a004'), 0,
          'member: B''s island notification is hidden');
select is((select count(*)::int from public.notifications where id = 'd3d3d3d3-d3d3-4d3d-8d3d-00000000a008'), 0,
          'member: a notification that points at a post of B is hidden');
select is((select count(*)::int from public.notification_feed(50)), 4, 'member: the feed shows the same four');
select is((select count(*)::int from public.notifications where id = 'd3d3d3d3-d3d3-4d3d-8d3d-00000000a009'), 0,
          'member: an island notification with no community is not readable');
select is((select count(*)::int from public.notification_feed(50) where id = 'd3d3d3d3-d3d3-4d3d-8d3d-00000000a009'), 0,
          'member: nor in the feed');
select ok(exists (select 1 from public.notification_feed(50) where post_id = '00000000-0000-4000-8000-0000000d3004'),
          'member: the row about a deleted post of A is kept (the screen shows a placeholder)');
select lives_ok($$update public.notifications set read_at = now() where id = 'd3d3d3d3-d3d3-4d3d-8d3d-00000000a001'$$,
                'member: marks a notification as read');
select lives_ok($$update public.notifications set read_at = now() where id = 'd3d3d3d3-d3d3-4d3d-8d3d-00000000a008'$$,
                'member: marking a hidden notification does nothing (no error)');
-- 画像
select is((select count(*)::int from storage.objects where bucket_id = 'post-images'), 1,
          'member: the image list shows their own folder only');
reset role;
select ok((select read_at is not null from public.notifications where id = 'd3d3d3d3-d3d3-4d3d-8d3d-00000000a001'),
          'the read mark was saved');
select ok((select read_at is null from public.notifications where id = 'd3d3d3d3-d3d3-4d3d-8d3d-00000000a008'),
          'and the hidden one was not touched');
select is((select motivation from public.posts where id = '00000000-0000-4000-8000-0000000d3001'), 70::smallint,
          'and the post change was saved');
select is((select like_count from public.posts where id = '00000000-0000-4000-8000-0000000d3001'),
          (select likes from snap) + 1, 'and the member''s like is counted');

-- ===========================================================================
-- 5. admin（A の管理者）: A だけ
-- ===========================================================================
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d301","role":"authenticated"}';
select is((select count(*)::int from public.posts), 4, 'admin: sees A''s posts (pA, expired, talk, ex''s) and nothing of B');
select is((select count(*)::int from public.posts where community_id = (select b from cm)), 0, 'admin: nothing of B');
select is((select count(*)::int from public.community_map_posts((select a from cm), -100, -100, 100, 100, 100)), 4,
          'admin: the map of A');
select is((select count(*)::int from public.community_map_posts((select b from cm), -100, -100, 100, 100, 100)), 0,
          'admin: B''s map is empty');
select is((select count(*)::int from public.comments), 3, 'admin: sees A''s comments');

-- ===========================================================================
-- 6. member_AB（A と B）
-- ===========================================================================
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d303","role":"authenticated"}';
select is((select count(*)::int from public.posts), 5, 'member_AB: sees A''s four and B''s one');
select is((select count(*)::int from public.posts where id = '00000000-0000-4000-8000-0000000d3003'), 0,
          'member_AB: still not the post with no community');
select is((select count(*)::int from public.map_posts(-100, -100, 100, 100, 100)), 5, 'member_AB: map_posts shows both communities');
select is((select count(*)::int from public.communities), 2, 'member_AB: both communities');
select lives_ok($$insert into public.comments(post_id, author_id, body)
                   values ('00000000-0000-4000-8000-0000000d3002', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d303', 'B にも書ける')$$,
                'member_AB: comments in B too');

-- ===========================================================================
-- 7. member_B（B だけ）
-- ===========================================================================
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d306","role":"authenticated"}';
select is((select count(*)::int from public.posts), 1, 'member_B: only B''s post');
select is((select count(*)::int from public.posts where community_id = (select a from cm)), 0, 'member_B: nothing of A');
select is((select count(*)::int from public.comments where post_id = '00000000-0000-4000-8000-0000000d3001'), 0,
          'member_B: not the comments on A''s post');
select is((select count(*)::int from public.reactions where post_id = '00000000-0000-4000-8000-0000000d3001'), 0,
          'member_B: not the reactions on A''s post');
select throws_ok($$insert into public.reactions(post_id, actor_id, kind)
                    values ('00000000-0000-4000-8000-0000000d3006', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d306', 'join')$$,
                 '42501', null, 'member_B: an expired meeting of A looks like a missing post (42501)');

-- ===========================================================================
-- 8. community_id が null の投稿は、書いた人にだけ見える
-- ===========================================================================
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d307","role":"authenticated"}';
select is((select count(*)::int from public.posts), 1, 'no-community author: sees only their own post');
select is((select body from public.posts), 'どこにも属さない投稿', 'and it is the one with no community');
select is((select count(*)::int from public.community_map_posts((select a from cm), -100, -100, 100, 100, 100)), 0,
          'and no map shows it');
select is((select count(*)::int from public.map_posts(-100, -100, 100, 100, 100)), 0, 'not even map_posts');
select lives_ok($$update public.posts set motivation = 60 where id = '00000000-0000-4000-8000-0000000d3003'$$,
                'and they can still edit it');

-- ===========================================================================
-- 9. ex（A に入っていて、抜けた人）: 自分の投稿の行だけ
-- ===========================================================================
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d305","role":"authenticated"}';
select is((select count(*)::int from public.posts), 4, 'ex (still a member): reads A like anybody');
select lives_ok($$delete from public.community_members where account_id = 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d305'$$, 'ex leaves A');
select is((select count(*)::int from public.my_communities()), 0, 'and is in no community');
select is((select count(*)::int from public.posts), 1, 'ex: sees only their own post row now');
select is((select body from public.posts), 'ex の投稿', 'ex: the own page works');
select is((select count(*)::int from public.posts where id = '00000000-0000-4000-8000-0000000d3001'), 0, 'ex: not pA any more');
select is((select count(*)::int from public.comments), 0,
          'ex: not even the comment on their own post (access ends with the membership)');
select is((select count(*)::int from public.comments where post_id = '00000000-0000-4000-8000-0000000d3005'), 0,
          'ex: nor by asking for their own post''s comments');
select throws_ok($$insert into public.comments(post_id, author_id, body)
                    values ('00000000-0000-4000-8000-0000000d3005', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d305', '抜けたあとのコメント')$$,
                 '42501', null, 'ex: cannot comment on their own post');
select throws_ok($$insert into public.reactions(post_id, actor_id, kind)
                    values ('00000000-0000-4000-8000-0000000d3005', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d305', 'help')$$,
                 '42501', null, 'ex: cannot react to their own post either');
select is(public.is_member_of_post('00000000-0000-4000-8000-0000000d3005'), false,
          'ex: is_member_of_post has no author clause (their own post is not "theirs" to the helpers)');
select is(public.is_member_of_post_any('00000000-0000-4000-8000-0000000d3005'), false, 'ex: nor the _any one');
select is((select count(*)::int from public.notifications), 0, 'ex: the notification about their own post is hidden');
select is((select count(*)::int from public.notification_feed(50)), 0, 'ex: nor in the feed');
select is((select count(*)::int from public.community_map_posts((select a from cm), -100, -100, 100, 100, 100)), 0,
          'ex: the map of A is empty');
select is((select count(*)::int from public.map_posts(-100, -100, 100, 100, 100)), 0, 'ex: map_posts is empty');
select is((select count(*)::int from public.communities), 0, 'ex: no community');
-- 自分の投稿は直せる。他人の投稿は直せない
select lives_ok($$update public.posts set motivation = 80 where id = '00000000-0000-4000-8000-0000000d3005'$$,
                'ex: edits their own post row');
select lives_ok($$update public.posts set motivation = 99 where id = '00000000-0000-4000-8000-0000000d3001'$$,
                'ex: trying another person''s post changes nothing (no error)');
-- 自分の反応は取り消せる（DELETE ... WHERE は select の policy も通る必要がある）
select is((select count(*)::int from public.reactions), 2,
          'ex: sees only their own reaction rows (the like on pA and the join of the meeting), none of the others''');
select lives_ok($$delete from public.reactions
                   where post_id = '00000000-0000-4000-8000-0000000d3001'
                     and actor_id = 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d305' and kind = 'like'$$,
                'ex: withdraws their own reaction');
select is((select count(*)::int from public.reactions), 1, 'ex: and it is gone (the join is still theirs)');
select is((select count(*)::int from public.posts where id = '00000000-0000-4000-8000-0000000d3001'), 0, 'ex: still cannot read pA');
reset role;
select is((select motivation from public.posts where id = '00000000-0000-4000-8000-0000000d3005'), 80::smallint,
          'ex''s own post was changed');
select isnt((select motivation from public.posts where id = '00000000-0000-4000-8000-0000000d3001'), 99::smallint,
            'and the other post was not');
select is((select like_count from public.posts where id = '00000000-0000-4000-8000-0000000d3001'),
          (select likes from snap),
          'the like count went down by the withdrawn reaction (back to what it was before the member''s like)');
select is((select count(*)::int from public.notifications
            where recipient_id = 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d305'), 1, 'the notification row still exists (it is only hidden)');

-- ===========================================================================
-- 10. 抜けると読めなくなる（member A2 が抜ける）
-- ===========================================================================
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d302","role":"authenticated"}';
select is((select count(*)::int from public.posts), 4, 'before leaving: member reads A');
select lives_ok($$delete from public.community_members where account_id = 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d302'$$, 'member leaves');
select is((select count(*)::int from public.posts), 1, 'after leaving: only their own live post (pA); the rest of A is closed at once');
select is((select count(*)::int from public.comments), 0, 'after leaving: no comment, not even the ones they wrote');
select is((select count(*)::int from public.map_posts(-100, -100, 100, 100, 100)), 0, 'after leaving: nothing on the map');
select is((select count(*)::int from public.notifications), 1,
          'after leaving: the notifications of A are hidden; only the DM (which points at no community) is left');
reset role;

-- ===========================================================================
-- 11. サーバーのキー（service_role）: 古い呼び方も、コミュニティつきの呼び方も、1つの関数に届く
-- ===========================================================================
reset role;
set local role service_role;
set local request.jwt.claims to '{"role":"service_role"}';
select lives_ok($$select * from public.nearest_posts('00000000-0000-4000-8000-0000000d3001'::uuid, 5)$$,
                'server: the old two-argument call still resolves (no ambiguity)');
select is((select count(*)::int from public.nearest_posts('00000000-0000-4000-8000-0000000d3001'::uuid, 5)), 0,
          'server: without a community it returns nothing (fail closed)');
select lives_ok($$select * from public.nearest_to_vector(array_fill(1.0, array[448])::vector(448)::text, 5)$$,
                'server: the old nearest_to_vector call still resolves');
select is((select count(*)::int from public.nearest_to_vector(array_fill(1.0, array[448])::vector(448)::text, 5)), 0,
          'server: without a community it returns nothing');
select lives_ok($$select * from public.account_post_centroids()$$, 'server: the old no-argument call still resolves');
select is((select count(*)::int from public.account_post_centroids()), 0, 'server: without a community it returns nothing');
select ok((select array_agg(id order by id) from public.nearest_posts('00000000-0000-4000-8000-0000000d3001'::uuid, 10, (select a from cm)))
          = array['00000000-0000-4000-8000-0000000d3005', '00000000-0000-4000-8000-0000000d3006', '00000000-0000-4000-8000-0000000d3007']::uuid[],
          'server: nearest_posts inside A returns A''s other live posts only (not B, not the post with no community, not a deleted one)');
select is((select count(*)::int from public.nearest_posts('00000000-0000-4000-8000-0000000d3002'::uuid, 10, (select a from cm))), 0,
          'server: an origin post of B asked inside A returns nothing');
select is((select id from public.nearest_posts('00000000-0000-4000-8000-0000000d3001'::uuid, 1, (select a from cm))),
          '00000000-0000-4000-8000-0000000d3005'::uuid, 'server: the closest comes first');
select ok(not exists (select 1 from public.nearest_to_vector(array_fill(1.0, array[448])::vector(448)::text, 100, (select a from cm))
                       where id in ('00000000-0000-4000-8000-0000000d3002', '00000000-0000-4000-8000-0000000d3003', '00000000-0000-4000-8000-0000000d3004')),
          'server: nearest_to_vector inside A never returns B, no-community or deleted posts');
select is((select count(*)::int from public.nearest_to_vector(array_fill(1.0, array[448])::vector(448)::text, 100, (select a from cm))), 4,
          'server: and returns all four live posts of A');
select ok((select array_agg(author_id order by author_id) from public.account_post_centroids((select a from cm)))
          = array['d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d301', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d302', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d305']::uuid[],
          'server: account_post_centroids inside A counts A''s authors only');
select is((select count(*)::int from public.map_posts_for_community((select a from cm), -100, -100, 100, 100, 100)), 4,
          'server: map_posts_for_community reads A''s live posts');
select is((select count(*)::int from public.map_posts_for_community(null, -100, -100, 100, 100, 100)), 0,
          'server: with no community it returns nothing');
select is((select count(*)::int from public.map_posts_for_community((select b from cm), -100, -100, 100, 100, 100)), 1,
          'server: and B''s only B''s');
select ok((select recruit_closed from public.map_posts_for_community((select a from cm), -100, -100, 100, 100, 100)
            where id = '00000000-0000-4000-8000-0000000d3006') = 'deadline', 'server: with the recruit columns');
select ok(public.pair_similarity('00000000-0000-4000-8000-0000000d3001', '00000000-0000-4000-8000-0000000d3005') is not null,
          'server: pair_similarity still works for the server');
select lives_ok($$select * from public.post_terms(array['00000000-0000-4000-8000-0000000d3001']::uuid[])$$, 'server: post_terms works');
reset role;

-- ===========================================================================
-- 12. 話してみたい・DM: 2人とも投稿のコミュニティに入っていること
-- ===========================================================================
-- いまの状態: A のメンバーは admin, member_AB（member は10章で抜けた）。pTalk(A) の参加者: member(抜けた), member_AB,
-- member_B(Aに入ったことがない), ex(抜けた)。
select is(public.talk_shared_event('d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d301', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d303'),
          '00000000-0000-4000-8000-0000000d3007'::uuid, 'admin and member_AB share the meeting');
select is(public.talk_shared_event('d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d301', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d306'), null::uuid,
          'admin and member_B (joined, but never in A) share nothing');
select is(public.talk_shared_event('d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d301', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d302'), null::uuid,
          'admin and the member who left share nothing any more');
select is(public.talk_shared_event('d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d301', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d305'), null::uuid,
          'nor with ex');
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d301","role":"authenticated"}';
select is((select array_agg(account_id order by account_id) from public.talk_peers()),
          array['d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d303']::uuid[],
          'admin''s peers: member_AB only (not member_B, nor the two who left)');
select throws_ok($$select public.press_talk('d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d306')$$, 'P0001', 'この相手には押せません。',
                 'admin cannot press member_B, with the usual words');
select throws_ok($$select public.press_talk('d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d305')$$, 'P0001', 'この相手には押せません。',
                 'nor ex');
select lives_ok($$select public.press_talk('d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d303')$$, 'but can press member_AB');
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d306","role":"authenticated"}';
-- 2026-10-26: peers are everyone in a shared community (20261028010000), not only the people of a shared meeting.
select is((select count(*)::int from public.talk_peers()), 1, 'member_B: member_AB only (they share B; nobody of A)');
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d305","role":"authenticated"}';
select is((select count(*)::int from public.talk_peers()), 0, 'ex has no peers either');
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d303","role":"authenticated"}';
select is((select count(*)::int from public.talk_peers()), 2, 'member_AB has admin (A) and member_B (B)');
select is((select event_excerpt from public.dm_room_list() where other_name = 'member_A'), '集まる会',
          'member_AB: the room with member_A shows the meeting (member_AB is in A)');
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d304","role":"authenticated"}';
select is((select count(*)::int from public.dm_room_list()), 1, 'outsider: the old room is still listed (nothing is removed)');
select is((select event_excerpt from public.dm_room_list()), null::text, 'outsider: but the meeting''s text is not shown');
select is((select event_post_id from public.dm_room_list()), null::uuid, 'outsider: nor its id');
reset role;

-- ===========================================================================
-- 13. 招待で入ると、すぐ読める。抜けるとすぐ読めない。コミュニティは投稿があると消せない
-- ===========================================================================
insert into public.community_invites(community_id, code, created_by, expires_at)
select a, 'mo-test-invite-code-000000001', 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d301', now() + interval '1 day' from cm;
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d304","role":"authenticated"}';
select is((select count(*)::int from public.posts where community_id = (select a from cm)), 0, 'before the invite: nothing of A');
select lives_ok($$select public.claim_invite('mo-test-invite-code-000000001')$$, 'the outsider claims an invite');
select lives_ok($$select public.claim_invite('mo-test-invite-code-000000001')$$, 'claiming again is harmless');
select is((select count(*)::int from public.posts where community_id = (select a from cm)), 4,
          'right after: A''s four live posts are readable');
select is((select count(*)::int from public.communities), 1, 'and the community name');
select lives_ok($$delete from public.community_members where account_id = 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d304'$$, 'and leaves');
select is((select count(*)::int from public.posts where community_id = (select a from cm)), 0, 'right after leaving: nothing again');
reset role;
select throws_ok($$delete from public.communities where id = (select a from cm)$$, '23503', null,
                 'a community with posts cannot be deleted (their posts would lose their community)');

select * from finish();
rollback;
