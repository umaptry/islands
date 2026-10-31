-- 2026-11-01: 承認制（20261101000000_join_approval.sql）。
-- Run with: supabase test db (CI does). Everybody here is made up.
--
-- 役（アカウント id の末尾）:
--   a1 admin（BAR の管理者）/ a2 admin2（BAR のもう1人の管理者）/ a3 member / a4 newbie（最初は accounts の行が無い）/
--   a5 off-link joiner / a6 removed-then-back / a7 spare / a8 other admin（OTHER の管理者）/ a9 applicant /
--   a10 trigger victim / a11 no-invite stranger / a12 no-account applicant / a13 removed（戻らない）/ a14 account-deleted。
begin;
select no_plan();

insert into auth.users(id, email, raw_app_meta_data) values
  ('e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a1', 'a1@example.test', '{"provider":"email"}'),
  ('e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a2', 'a2@example.test', '{"provider":"email"}'),
  ('e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a3', 'a3@example.test', '{"provider":"email"}'),
  ('e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a4', 'a4@example.test', '{"provider":"line"}'),
  ('e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a5', 'a5@example.test', '{"provider":"email"}'),
  ('e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a6', 'a6@example.test', '{"provider":"email"}'),
  ('e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a7', 'a7@example.test', '{"provider":"email"}'),
  ('e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a8', 'a8@example.test', '{"provider":"email"}'),
  ('e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a9', 'a9@example.test', '{"provider":"google"}'),
  ('e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2b0', 'a10@example.test', '{"provider":"email"}'),
  ('e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2b1', 'a11@example.test', '{"provider":"email"}'),
  ('e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2b2', 'a12@example.test', '{"provider":"email"}'),
  ('e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2b3', 'a13@example.test', '{"provider":"email"}'),
  ('e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2b4', 'a14@example.test', '{"provider":"email"}');
-- a4（newbie）・a11・a12 は accounts の行がまだ無い
insert into public.accounts(id, display_name, affiliation) values
  ('e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a1', 'admin', '店'),
  ('e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a2', 'admin2', '店'),
  ('e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a3', 'member', '会社'),
  ('e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a5', 'joiner', '会社'),
  ('e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a6', 'removed-back', '会社'),
  ('e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a7', 'spare', '会社'),
  ('e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a8', 'other-admin', '別の会'),
  ('e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a9', 'applicant', '会社'),
  ('e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2b0', 'victim', '会社'),
  ('e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2b3', 'removed-stay', '会社'),
  ('e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2b4', 'will-vanish', '会社');

select public.create_community('BAR', 'ja-bar', 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a1');
select public.create_community('もう一つ', 'ja-other', 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a8');
select public.create_community('BAR', 'ja-bar', 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a2');
create temp table cm as
  select (select id from public.communities where slug = 'ja-bar')   as bar,
         (select id from public.communities where slug = 'ja-other') as other;
grant select on cm to anon, authenticated, service_role;

insert into public.community_members(community_id, account_id, role) values
  ((select bar from cm), 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a3', 'member'),
  ((select other from cm), 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a6', 'member');
-- a6 は BAR にも入っていて、入った日時は 10/01
insert into public.community_members(community_id, account_id, role, joined_at) values
  ((select bar from cm), 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a6', 'member', '2026-10-01 00:00+00'),
  ((select bar from cm), 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2b3', 'member', '2026-10-02 00:00+00');

create function pg_temp.vec() returns vector(448) language sql immutable as $$
  select array_fill(1.0, array[448])::vector(448) $$;

-- 投稿: p1(a3, BAR) / pOther(a8, OTHER) / a6 の投稿: p6a, p6b(share_group あり), p6c(OTHER), p6d(自分で消した)
-- p3b(a3, BAR, p6b と同じ share_group で生きている → p6b を戻すと一意の索引とぶつかる)
insert into public.posts(id, author_id, body, x, y, cluster_id, vec, vec_c, community_id, deleted_at, share_group) values
  ('00000000-0000-4000-8000-0000000e2001', 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a3', 'BAR の投稿', 1, 1, 0, pg_temp.vec(), pg_temp.vec(), (select bar from cm), null, null),
  ('00000000-0000-4000-8000-0000000e2002', 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a8', 'OTHER の投稿', 2, 2, 0, pg_temp.vec(), pg_temp.vec(), (select other from cm), null, null),
  ('00000000-0000-4000-8000-0000000e2003', 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a6', 'a6 の投稿その1', 3, 3, 0, pg_temp.vec(), pg_temp.vec(), (select bar from cm), null, null),
  ('00000000-0000-4000-8000-0000000e2004', 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a6', 'a6 の投稿その2', 4, 4, 0, pg_temp.vec(), pg_temp.vec(), (select bar from cm), null, 'e2e2e2e2-e2e2-4e2e-8e2e-0000000000f1'),
  ('00000000-0000-4000-8000-0000000e2005', 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a6', 'a6 の OTHER の投稿', 5, 5, 0, pg_temp.vec(), pg_temp.vec(), (select other from cm), null, null),
  ('00000000-0000-4000-8000-0000000e2006', 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a6', 'a6 が自分で消した投稿', 6, 6, 0, pg_temp.vec(), pg_temp.vec(), (select bar from cm), '2026-09-01 00:00+00', null);
update public.posts set deleted_at = '2026-10-29 10:00+00'
 where id in ('00000000-0000-4000-8000-0000000e2003', '00000000-0000-4000-8000-0000000e2004');
insert into public.posts(id, author_id, body, x, y, cluster_id, vec, vec_c, community_id, share_group) values
  ('00000000-0000-4000-8000-0000000e2007', 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a3', 'a3 の同じ仲間の投稿', 7, 7, 0, pg_temp.vec(), pg_temp.vec(),
   (select bar from cm), 'e2e2e2e2-e2e2-4e2e-8e2e-0000000000f1');
-- コメント: c1(a6 が BAR の p1 に。外したとき隠れた) / c2(a6 が OTHER の投稿に) / c3(a6 が自分で消した)
insert into public.comments(id, post_id, author_id, body, deleted_at) values
  ('e2e2e2e2-e2e2-4e2e-8e2e-0000000c0001', '00000000-0000-4000-8000-0000000e2001', 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a6', 'a6 のコメント', '2026-10-29 10:00+00'),
  ('e2e2e2e2-e2e2-4e2e-8e2e-0000000c0002', '00000000-0000-4000-8000-0000000e2002', 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a6', 'OTHER へのコメント', null),
  ('e2e2e2e2-e2e2-4e2e-8e2e-0000000c0003', '00000000-0000-4000-8000-0000000e2001', 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a6', '自分で消したコメント', '2026-09-01 00:00+00'),
  ('e2e2e2e2-e2e2-4e2e-8e2e-0000000c0004', '00000000-0000-4000-8000-0000000e2001', 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a3', '生きているコメント', null);

-- a6 は BAR から外されている（M5 の「外す」と同じ姿を直接作る）。a13 も外されていて、戻らない。
-- 外したあと a6 の BAR のメンバー行は消える（上の insert の BAR の行を消す）
delete from public.community_members
 where community_id = (select bar from cm)
   and account_id in ('e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a6', 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2b3');
insert into public.community_removals(community_id, account_id, removed_at, joined_at_before, hidden_post_ids, hidden_comment_ids) values
  ((select bar from cm), 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a6', '2026-10-29 10:00+00', '2026-10-01 00:00+00',
   array['00000000-0000-4000-8000-0000000e2003', '00000000-0000-4000-8000-0000000e2004']::uuid[],
   array['e2e2e2e2-e2e2-4e2e-8e2e-0000000c0001']::uuid[]),
  ((select bar from cm), 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2b3', '2026-10-30 10:00+00', '2026-10-02 00:00+00', '{}', '{}');

-- 招待（直接入れる。最初は承認オフ）
insert into public.community_invites(id, community_id, code, created_by, expires_at, needs_approval) values
  ('e2e2e2e2-e2e2-4e2e-8e2e-0000000f0001', (select bar from cm),   'ja-off-invite-code-0000000001', 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a1', now() + interval '1 day', false),
  ('e2e2e2e2-e2e2-4e2e-8e2e-0000000f0002', (select bar from cm),   'ja-on-invite-code-00000000002',  'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a1', now() + interval '1 day', true),
  ('e2e2e2e2-e2e2-4e2e-8e2e-0000000f0003', (select bar from cm),   'ja-old-invite-code-00000000003', 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a1', now() - interval '1 day', false),
  ('e2e2e2e2-e2e2-4e2e-8e2e-0000000f0004', (select other from cm), 'ja-other-invite-code-000000004', 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a8', now() + interval '1 day', false);
insert into public.community_invites(id, community_id, code, created_by, expires_at, revoked_at, needs_approval) values
  ('e2e2e2e2-e2e2-4e2e-8e2e-0000000f0005', (select bar from cm), 'ja-stop-invite-code-0000000005', 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a1', now() + interval '1 day', now(), false);

-- 通知は自動で出た行を消してから始める
delete from public.notifications;

-- -----------------------------------------------------------------------
-- 1. 表・列・関数の守り
-- -----------------------------------------------------------------------
select has_column('public', 'community_invites', 'needs_approval', 'invites have the approval switch');
select has_column('public', 'community_invites', 'post_id', 'invites can carry an event post');
select has_column('public', 'community_members', 'joined_via', 'members remember how they came in');
select has_column('public', 'community_members', 'invite_id', 'and by which link');
select has_column('public', 'community_members', 'event_post_id', 'and by which event');
select is((select joined_via from public.community_members
            where account_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a1' and community_id = (select bar from cm)),
          'founder', 'create_community records the admin as founder');
select is((select joined_via from public.community_members
            where account_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a3'), 'invite', 'a plain member row defaults to invite');
select throws_ok($$update public.community_members set joined_via = 'other'
                    where account_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a3'$$, '23514', null,
                 'joined_via accepts only the four known values');
select is((select needs_approval from public.community_invites where code = 'ja-off-invite-code-0000000001'), false,
          'an old-style invite is off');

select ok(not has_table_privilege('anon', 'public.community_join_requests', 'SELECT'), 'anon cannot read join requests');
select ok(not has_table_privilege('authenticated', 'public.community_join_requests', 'SELECT'), 'nor a signed-in person');
select ok(not has_table_privilege('authenticated', 'public.community_join_requests', 'INSERT'), 'nor write them');
select ok(not has_table_privilege('authenticated', 'public.community_join_requests', 'UPDATE'), 'nor change them');
select ok(not has_table_privilege('authenticated', 'public.community_join_requests', 'DELETE'), 'nor delete them');
select ok(has_table_privilege('service_role', 'public.community_join_requests', 'SELECT'), 'the server key can read them');
select ok(not has_table_privilege('anon', 'public.community_removals', 'SELECT'), 'anon cannot read removals');
select ok(not has_table_privilege('authenticated', 'public.community_removals', 'SELECT'), 'nor a signed-in person');
select ok(not has_table_privilege('authenticated', 'public.community_removals', 'INSERT'), 'nor write them');
select ok(not has_table_privilege('authenticated', 'public.community_removals', 'DELETE'), 'nor delete them');
select ok(has_table_privilege('service_role', 'public.community_removals', 'SELECT'), 'the server key can read them');
select ok(not has_table_privilege('anon', 'public.join_request_notices', 'SELECT'), 'anon cannot read the notice record');
select ok(not has_table_privilege('authenticated', 'public.join_request_notices', 'SELECT'), 'nor a signed-in person');
select ok(not has_table_privilege('authenticated', 'public.join_request_notices', 'INSERT'), 'nor write it');
select ok(has_table_privilege('service_role', 'public.join_request_notices', 'SELECT'), 'the server key can read it');
select is((select count(*)::int from pg_policies where schemaname = 'public'
              and tablename in ('community_join_requests', 'community_removals', 'join_request_notices') and qual = 'false'), 3,
          'all three new tables have the deny-everything policy');
select ok((select relrowsecurity from pg_class where oid = 'public.community_join_requests'::regclass), 'row level security is on (requests)');
select ok((select relrowsecurity from pg_class where oid = 'public.community_removals'::regclass), 'and on (removals)');

select is((select count(*)::int from pg_proc where pronamespace = 'public'::regnamespace
             and proname in ('claim_invite', 'create_invite', 'list_invites', 'check_invite')), 4,
          'each invite function has exactly one signature (no old overload left)');
select ok(not has_function_privilege('anon', 'public.claim_invite(text, text)', 'execute'), 'anon cannot claim');
select ok(not has_function_privilege('anon', 'public.create_invite(uuid, integer, boolean, boolean, uuid)', 'execute'), 'anon cannot make an invite');
select ok(not has_function_privilege('anon', 'public.list_invites(uuid)', 'execute'), 'anon cannot list invites');
select ok(not has_function_privilege('anon', 'public.set_invite_approval(uuid, boolean)', 'execute'), 'anon cannot flip the switch');
select ok(not has_function_privilege('anon', 'public.my_join_status()', 'execute'), 'anon has no join status');
select ok(not has_function_privilege('anon', 'public.cancel_join_request(uuid)', 'execute'), 'anon cannot cancel');
select ok(not has_function_privilege('anon', 'public.list_join_requests(uuid)', 'execute'), 'anon cannot list requests');
select ok(not has_function_privilege('anon', 'public.decide_join_request(uuid, uuid, boolean)', 'execute'), 'anon cannot decide');
select ok(has_function_privilege('anon', 'public.check_invite(text)', 'execute'), 'anon can still check an invite');
select ok(has_function_privilege('authenticated', 'public.claim_invite(text, text)', 'execute'), 'a signed-in person can claim');
select ok(has_function_privilege('authenticated', 'public.set_invite_approval(uuid, boolean)', 'execute'), 'and flip the switch (the function checks admin)');
select ok(has_function_privilege('authenticated', 'public.my_join_status()', 'execute'), 'and read their status');
select ok(has_function_privilege('authenticated', 'public.cancel_join_request(uuid)', 'execute'), 'and cancel');
select ok(has_function_privilege('authenticated', 'public.list_join_requests(uuid)', 'execute'), 'and list requests (admins only inside)');
select ok(has_function_privilege('authenticated', 'public.decide_join_request(uuid, uuid, boolean)', 'execute'), 'and decide (admins only inside)');
select ok(not has_function_privilege('anon', 'public.join_request_notify(uuid, uuid)', 'execute'), 'anon cannot run the notifier');
select ok(not has_function_privilege('authenticated', 'public.join_request_notify(uuid, uuid)', 'execute'),
          'a signed-in person cannot run the notifier (it takes any person id)');
select ok(not has_function_privilege('anon', 'public.accounts_join_request_notify()', 'execute'), 'anon cannot run the trigger function');
select ok(not has_function_privilege('authenticated', 'public.accounts_join_request_notify()', 'execute'), 'nor a signed-in person');
select ok(not has_function_privilege('authenticated', 'public.create_community(text, text, uuid)', 'execute'), 'create_community is still the server''s');
select ok(has_function_privilege('service_role', 'public.create_community(text, text, uuid)', 'execute'), 'the server key can run it');
select has_trigger('public', 'accounts', 'accounts_join_request_notify', 'accounts has the notifier trigger');

select lives_ok($$insert into public.notifications(recipient_id, actor_id, type, community_id)
                   values ('e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a1', 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a9', 'join_request', (select bar from cm))$$,
                'the join_request type is accepted');
select lives_ok($$insert into public.notifications(recipient_id, actor_id, type, community_id)
                   values ('e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a9', 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a1', 'join_approved', (select bar from cm))$$,
                'and join_approved');
select lives_ok($$insert into public.notifications(recipient_id, actor_id, type)
                   values ('e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a1', 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a9', 'match')$$,
                'the old types are still accepted (match was the last)');
select throws_ok($$insert into public.notifications(recipient_id, actor_id, type)
                    values ('e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a1', 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a9', 'nonsense')$$,
                 '23514', null, 'an unknown type is still refused');
delete from public.notifications;

-- -----------------------------------------------------------------------
-- 2. check_invite: 5つのキー
-- -----------------------------------------------------------------------
set local role anon;
set local request.jwt.claims to '{"role":"anon"}';
select is(public.check_invite('ja-off-invite-code-0000000001'),
          '{"valid": true, "community_name": "BAR", "reason": null, "needs_approval": false, "post_id": null}'::jsonb,
          'an off link: valid, not needing approval');
select is((public.check_invite('ja-on-invite-code-00000000002') ->> 'needs_approval')::boolean, true, 'an on link needs approval');
select is((select array_agg(k order by k) from jsonb_object_keys(public.check_invite('ja-on-invite-code-00000000002')) k),
          array['community_name', 'needs_approval', 'post_id', 'reason', 'valid'], 'exactly five keys');
select is(public.check_invite('ja-old-invite-code-00000000003'),
          '{"valid": false, "community_name": "BAR", "reason": "expired", "needs_approval": null, "post_id": null}'::jsonb,
          'an expired link: no approval info');
select is(public.check_invite('ja-stop-invite-code-0000000005') ->> 'reason', 'revoked', 'a stopped link says so');
select is(public.check_invite('nonsense'),
          '{"valid": false, "community_name": null, "reason": "unknown", "needs_approval": null, "post_id": null}'::jsonb,
          'an unknown link: no approval info');
-- 外された人・断られた人には、オフのリンクでも needs_approval が true
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a6","role":"authenticated"}';
select is((public.check_invite('ja-off-invite-code-0000000001') ->> 'needs_approval')::boolean, true,
          'a removed person is told approval is needed, even on an off link');
set local request.jwt.claims to '{"sub":"e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a5","role":"authenticated"}';
select is((public.check_invite('ja-off-invite-code-0000000001') ->> 'needs_approval')::boolean, false,
          'an ordinary person is not');

-- -----------------------------------------------------------------------
-- 3. 管理者が招待を作る・承認のスイッチ
-- -----------------------------------------------------------------------
set local request.jwt.claims to '{"sub":"e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a1","role":"authenticated"}';
create temp table made(label text, r jsonb);
grant all on made to authenticated;
insert into made select '3args', public.create_invite((select bar from cm), 60, false);
insert into made select '4args', public.create_invite((select bar from cm), 60, false, true);
insert into made select 'named', public.create_invite(community := (select bar from cm), minutes := 60, until_end_of_day := false);
insert into made select 'post', public.create_invite((select bar from cm), 60, false, true, '00000000-0000-4000-8000-0000000e2001');
select is((select (r ->> 'needs_approval')::boolean from made where label = '3args'), false, 'three arguments (the old code): approval is off');
select is((select (r ->> 'needs_approval')::boolean from made where label = '4args'), true, 'four arguments: on');
select is((select (r ->> 'needs_approval')::boolean from made where label = 'named'), false,
          'the old code''s named arguments still work and give off');
select is((select array_agg(k order by k) from made, jsonb_object_keys(r) k where label = '4args'),
          array['code', 'expires_at', 'id', 'needs_approval', 'post_id'], 'the answer has five keys');
select is((select r ->> 'post_id' from made where label = 'post'), '00000000-0000-4000-8000-0000000e2001', 'a link can carry an event post');
select is((select post_id from public.list_invites((select bar from cm)) where id = (select (r ->> 'id')::uuid from made where label = 'post')),
          '00000000-0000-4000-8000-0000000e2001'::uuid, 'and the list shows it');
select is((select needs_approval from public.list_invites((select bar from cm)) where code = 'ja-on-invite-code-00000000002'), true,
          'the list shows needs_approval');
select throws_ok($$select public.create_invite((select bar from cm), 60, false, false, '00000000-0000-4000-8000-0000000e2002')$$,
                 'P0001', 'この投稿はこのコミュニティのものではありません。', 'a post of another community cannot be attached');
select throws_ok($$select public.create_invite((select bar from cm), 60, false, false, '00000000-0000-4000-8000-0000000e2003')$$,
                 'P0001', 'この投稿はこのコミュニティのものではありません。', 'nor a hidden post');
select throws_ok($$select public.create_invite((select bar from cm), 60, false, false, gen_random_uuid())$$,
                 'P0001', 'この投稿はこのコミュニティのものではありません。', 'nor one that does not exist');
set local request.jwt.claims to '{"sub":"e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a3","role":"authenticated"}';
select throws_ok($$select public.create_invite((select bar from cm), 60, false, true)$$, 'P0001',
                 'このコミュニティの招待リンクは、管理者だけが作れます。', 'a member cannot make an invite');
set local request.jwt.claims to '{"sub":"e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a8","role":"authenticated"}';
select throws_ok($$select public.create_invite((select bar from cm), 60, false, true)$$, 'P0001', null,
                 'nor the admin of another community');

-- 承認のスイッチ（基準: BAR の使えるリンクは 0001=オフ 0002=オン、3args/named=オフ、4args/post=オン。0003=期限切れ 0005=止めた）
reset role;
update public.community_invites set needs_approval = false where code in ('ja-off-invite-code-0000000001');
set local role authenticated;
set local request.jwt.claims to '{"sub":"e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a1","role":"authenticated"}';
select lives_ok($$select public.set_invite_approval('e2e2e2e2-e2e2-4e2e-8e2e-0000000f0001', true)$$, 'an admin turns the switch on');
select is((select count(*)::int from public.community_invites
            where community_id = (select bar from cm) and revoked_at is null and expires_at > now() and not needs_approval), 0,
          'turning it on turns on every usable link of the community');
reset role;
select is((select needs_approval from public.community_invites where code = 'ja-old-invite-code-00000000003'), false,
          'but an expired link is left alone');
select is((select needs_approval from public.community_invites where code = 'ja-stop-invite-code-0000000005'), false,
          'and a stopped one');
select is((select needs_approval from public.community_invites where code = 'ja-other-invite-code-000000004'), false,
          'and another community''s');
set local role authenticated;
set local request.jwt.claims to '{"sub":"e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a1","role":"authenticated"}';
select lives_ok($$select public.set_invite_approval('e2e2e2e2-e2e2-4e2e-8e2e-0000000f0001', false)$$, 'turning one off');
select is((select count(*)::int from public.community_invites
            where community_id = (select bar from cm) and revoked_at is null and expires_at > now() and not needs_approval), 1,
          'turns off only that link');
select throws_ok($$select public.set_invite_approval('e2e2e2e2-e2e2-4e2e-8e2e-0000000f0004', true)$$, 'P0001', null,
                 'an admin cannot touch another community''s link');
select throws_ok($$select public.set_invite_approval(gen_random_uuid(), true)$$, 'P0001', null, 'nor one that does not exist');
set local request.jwt.claims to '{"sub":"e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a3","role":"authenticated"}';
select throws_ok($$select public.set_invite_approval('e2e2e2e2-e2e2-4e2e-8e2e-0000000f0001', true)$$, 'P0001', null,
                 'a member cannot flip it');
reset role;
-- ここから先の基準: 0001=オフ 0002=オン
update public.community_invites set needs_approval = (code = 'ja-on-invite-code-00000000002')
 where community_id = (select bar from cm);

-- -----------------------------------------------------------------------
-- 4. 使う（claim_invite）
-- -----------------------------------------------------------------------
set local role anon;
set local request.jwt.claims to '{"role":"anon"}';
select throws_ok($$select public.claim_invite('ja-off-invite-code-0000000001')$$, '42501', null, 'anon cannot claim');
reset role;
set local role authenticated;
set local request.jwt.claims to '{}';
select throws_ok($$select public.claim_invite('ja-off-invite-code-0000000001')$$, 'P0001', 'ログインしてください。', 'no login, no claim');

-- 元からメンバー: already。uses も joined_via も変わらない
set local request.jwt.claims to '{"sub":"e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a3","role":"authenticated"}';
select is(public.claim_invite('ja-off-invite-code-0000000001') ->> 'status', 'already', 'a member claiming gets already');
reset role;
select is((select uses from public.community_invites where code = 'ja-off-invite-code-0000000001'), 0, 'and uses is not increased');

-- オフのリンク: 今までどおりメンバーになる（古いコードは引数1つで呼ぶ）
set local role authenticated;
set local request.jwt.claims to '{"sub":"e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a5","role":"authenticated"}';
select is(public.claim_invite('ja-off-invite-code-0000000001'),
          jsonb_build_object('community_id', (select bar from cm), 'community_name', 'BAR', 'status', 'joined', 'post_id', null),
          'an off link, called with one argument (the old code): joined, with the old keys plus status and post_id');
select is(public.claim_invite('ja-off-invite-code-0000000001') ->> 'status', 'already', 'claiming again gives already');
reset role;
select is((select joined_via from public.community_members where account_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a5' and community_id = (select bar from cm)),
          'invite', 'joined_via is invite');
select is((select invite_id from public.community_members where account_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a5' and community_id = (select bar from cm)),
          'e2e2e2e2-e2e2-4e2e-8e2e-0000000f0001'::uuid, 'and the link is recorded');
select is((select uses from public.community_invites where code = 'ja-off-invite-code-0000000001'), 1, 'uses went up once, not twice');
select ok(exists (select 1 from public.invite_claims where account_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a5'), 'invite_claims is written');
select is((select count(*)::int from public.community_join_requests), 0, 'no request row for an off link');

-- 招待制をオンにする（承認待ちでもアカウントを作れることを見る）
update public.app_settings set value = 'true'::jsonb where key = 'invite_only';

-- オンのリンク: 承認待ち。a9 は accounts がある → その場で管理者に通知
set local role authenticated;
set local request.jwt.claims to '{"sub":"e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a9","role":"authenticated"}';
select is(public.claim_invite('ja-on-invite-code-00000000002', '2026-11-16'),
          jsonb_build_object('community_id', (select bar from cm), 'community_name', 'BAR', 'status', 'pending', 'post_id', null),
          'an on link: pending');
reset role;
select is((select status from public.community_join_requests where account_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a9'), 'pending', 'a pending row exists');
select is((select consent_version from public.community_join_requests where account_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a9'), '2026-11-16',
          'the agreed terms version is recorded');
select is((select invite_id from public.community_join_requests where account_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a9'),
          'e2e2e2e2-e2e2-4e2e-8e2e-0000000f0002'::uuid, 'with the link');
select is((select was_removed or rejected_before from public.community_join_requests where account_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a9'), false,
          'a fresh applicant is neither');
select ok(not exists (select 1 from public.community_members where account_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a9'), 'and is not a member');
select ok(exists (select 1 from public.invite_claims where account_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a9'), 'invite_claims is written (an account may be made)');
select is((select uses from public.community_invites where code = 'ja-on-invite-code-00000000002'), 1, 'uses went up once');
select is((select count(*)::int from public.notifications where type = 'join_request' and actor_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a9'), 2,
          'both admins were told');
select is((select count(*)::int from public.notifications where type = 'join_request' and recipient_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a3'), 0,
          'a plain member was not');
select is((select array_agg(k order by k) from public.notifications n, jsonb_object_keys(n.payload) k
            where n.type = 'join_request' and n.recipient_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a1'),
          array['community_id', 'community_name'], 'the payload holds only the community (no email)');
select is((select community_id from public.notifications where type = 'join_request' and recipient_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a1'),
          (select bar from cm), 'and the community_id column is filled');
select ok((select notified_at is not null from public.community_join_requests where account_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a9'), 'notified_at is set');
set local role authenticated;
set local request.jwt.claims to '{"sub":"e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a9","role":"authenticated"}';
select is(public.claim_invite('ja-on-invite-code-00000000002') ->> 'status', 'pending', 'claiming twice is still pending');
reset role;
select is((select count(*)::int from public.community_join_requests where account_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a9'), 1, 'one row, not two');
select is((select uses from public.community_invites where code = 'ja-on-invite-code-00000000002'), 1, 'uses did not go up again');
select is((select count(*)::int from public.notifications where type = 'join_request' and actor_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a9'), 2,
          'and no second notification');

-- 名前のある人がまだいない a4: 承認待ちだけ。通知は無い。招待制がオンでも accounts を作れる
set local role authenticated;
set local request.jwt.claims to '{"sub":"e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a4","role":"authenticated"}';
select is(public.claim_invite('ja-on-invite-code-00000000002', '2026-11-16') ->> 'status', 'pending', 'a newbie with no accounts row: pending');
reset role;
select is((select count(*)::int from public.notifications where actor_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a4'), 0, 'nobody is told yet (no name)');
select ok((select notified_at is null from public.community_join_requests where account_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a4'), 'notified_at stays empty');
-- 招待制でも、承認待ちの人は accounts を作れ、そのとき管理者に通知が行く
set local role authenticated;
set local request.jwt.claims to '{"sub":"e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a4","role":"authenticated"}';
select lives_ok($$insert into public.accounts(id, display_name) values ('e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a4', 'newbie')$$,
                'invite_only is on, and a pending applicant can still make the account');
reset role;
select is((select count(*)::int from public.notifications where type = 'join_request' and actor_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a4'), 2,
          'now both admins are told, once the name exists');
select ok((select notified_at is not null from public.community_join_requests where account_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a4'), 'and notified_at is set');
update public.accounts set display_name = 'newbie renamed' where id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a4';
select is((select count(*)::int from public.notifications where type = 'join_request' and actor_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a4'), 2,
          'renaming does not tell them again');
-- 申し込みも招待もない人は、招待制で止まる（対照）
set local role authenticated;
set local request.jwt.claims to '{"sub":"e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2b1","role":"authenticated"}';
select throws_ok($$insert into public.accounts(id, display_name) values ('e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2b1', 'stranger')$$,
                 'P0001', 'islands は招待制です。コミュニティの招待リンクから登録してください。', 'but a stranger with no claim is stopped');
reset role;

-- 間引き: 24時間以内は書かない。古ければ消して書き直す
select public.join_request_notify((select bar from cm), 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a9');
select is((select count(*)::int from public.notifications where type = 'join_request' and actor_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a9'), 2,
          'calling the notifier again within 24 hours writes nothing');
update public.join_request_notices set notified_at = now() - interval '25 hours'
 where account_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a9';
update public.notifications set created_at = now() - interval '25 hours'
 where type = 'join_request' and actor_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a9';
select public.join_request_notify((select bar from cm), 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a9');
select is((select count(*)::int from public.notifications where type = 'join_request' and actor_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a9'), 2,
          'after a day the old ones are replaced, not piled up (still one per admin)');
select ok((select min(created_at) > now() - interval '1 hour' from public.notifications
            where type = 'join_request' and actor_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a9'), 'and they are new');

-- 通知が失敗しても、名前の保存（＝登録）は止まらない
set local role authenticated;
set local request.jwt.claims to '{"sub":"e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2b0","role":"authenticated"}';
select is(public.claim_invite('ja-on-invite-code-00000000002') ->> 'status', 'pending', 'a10 (has an account) is pending');
reset role;
select is((select count(*)::int from public.notifications where actor_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2b0'), 2, 'and the admins were told');
delete from public.notifications where actor_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2b0';
update public.community_join_requests set notified_at = null where account_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2b0';
delete from public.join_request_notices where account_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2b0';   -- 間引きの記録も消す（失敗の道を通すため）
alter table public.notifications add constraint boom check (type <> 'join_request') not valid;
select lives_ok($$update public.accounts set display_name = 'victim saved' where id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2b0'$$,
                'a failing notification does not stop the profile save');
select is((select display_name from public.accounts where id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2b0'), 'victim saved', 'and the name was saved');
alter table public.notifications drop constraint boom;
select is((select count(*)::int from public.notifications where type = 'join_request' and actor_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2b0'), 0,
          'nothing half-written was left behind');

-- -----------------------------------------------------------------------
-- 5. 取り消し
-- -----------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub":"e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2b0","role":"authenticated"}';
select lives_ok($$select public.cancel_join_request((select bar from cm))$$, 'a pending person cancels');
reset role;
select is((select count(*)::int from public.community_join_requests where account_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2b0'), 0, 'the row is gone');
select is((select count(*)::int from public.notifications where actor_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2b0'), 0, 'and so are the admins'' notifications');
set local role authenticated;
set local request.jwt.claims to '{"sub":"e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2b0","role":"authenticated"}';
select is(public.claim_invite('ja-on-invite-code-00000000002') ->> 'status', 'pending', 'applying again after cancelling: pending');
reset role;
select is((select count(*)::int from public.notifications where type = 'join_request' and actor_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2b0'), 2,
          'the first successful notice (the earlier try failed and left no record): both admins are told');
set local role authenticated;
set local request.jwt.claims to '{"sub":"e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2b0","role":"authenticated"}';
select lives_ok($$select public.cancel_join_request((select bar from cm))$$, 'cancel again');
select is(public.claim_invite('ja-on-invite-code-00000000002') ->> 'status', 'pending', 'and apply again');
reset role;
select is((select count(*)::int from public.notifications where type = 'join_request' and actor_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2b0'), 0,
          'applying again right after cancelling does not notify again (once per 24 hours)');
select is((select count(*)::int from public.join_request_notices where account_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2b0'), 1,
          'because cancelling kept the record of the last notice');
update public.join_request_notices set notified_at = now() - interval '25 hours' where account_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2b0';
set local role authenticated;
set local request.jwt.claims to '{"sub":"e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2b0","role":"authenticated"}';
select lives_ok($$select public.cancel_join_request((select bar from cm))$$, 'cancel once more');
select is(public.claim_invite('ja-on-invite-code-00000000002') ->> 'status', 'pending', 'and apply a day later');
reset role;
select is((select count(*)::int from public.notifications where type = 'join_request' and actor_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2b0'), 2,
          'after 24 hours the admins are told again');
set local role authenticated;
select lives_ok($$select public.cancel_join_request((select bar from cm))$$, 'cancelling again');
select lives_ok($$select public.cancel_join_request((select other from cm))$$, 'cancelling where nothing is pending is harmless');
reset role;
-- 主催のスイッチを入れたまま、オフのリンクに替わった承認待ち: a7 がオンで待ち、オフのリンクを使うと入れる
set local role authenticated;
set local request.jwt.claims to '{"sub":"e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a7","role":"authenticated"}';
select is(public.claim_invite('ja-on-invite-code-00000000002') ->> 'status', 'pending', 'a7 waits on the on link');
reset role;
select is((select count(*)::int from public.notifications where actor_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a7'), 2, 'the admins were told');
set local role authenticated;
set local request.jwt.claims to '{"sub":"e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a7","role":"authenticated"}';
select is(public.claim_invite('ja-off-invite-code-0000000001') ->> 'status', 'joined', 'then uses an off link: joined');
reset role;
select is((select count(*)::int from public.community_join_requests where account_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a7'), 0, 'the pending row is gone');
select is((select count(*)::int from public.notifications where actor_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a7'), 0, 'and the admins'' notifications');
select ok(exists (select 1 from public.community_members where account_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a7' and community_id = (select bar from cm)),
          'and they are a member');

-- -----------------------------------------------------------------------
-- 6. 状態の確認 my_join_status
-- -----------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub":"e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a9","role":"authenticated"}';
select is((select status from public.my_join_status()), 'pending', 'a9: pending');
select is((select community_name from public.my_join_status()), 'BAR', 'with the community name');
set local request.jwt.claims to '{"sub":"e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2b3","role":"authenticated"}';
select is((select status from public.my_join_status()), 'removed', 'a13: removed (no request row)');
select is((select count(*)::int from public.my_join_status()), 1, 'and only that');
set local request.jwt.claims to '{"sub":"e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a3","role":"authenticated"}';
select is((select count(*)::int from public.my_join_status()), 0, 'a member has nothing');
set local role anon;
set local request.jwt.claims to '{"role":"anon"}';
select throws_ok($$select * from public.my_join_status()$$, '42501', null, 'anon cannot read a status');
reset role;

-- -----------------------------------------------------------------------
-- 7. 承認待ち・外された人には、中が見えない
-- -----------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub":"e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a9","role":"authenticated"}';
select is((select count(*)::int from public.posts), 0, 'pending: no post');
select is((select count(*)::int from public.comments), 0, 'pending: no comment');
select is((select count(*)::int from public.reactions), 0, 'pending: no reaction');
select is((select count(*)::int from public.communities), 0, 'pending: no community, not even the name');
select is((select count(*)::int from public.community_map_posts((select bar from cm), -100, -100, 100, 100, 100)), 0, 'pending: community_map_posts is empty');
select is((select count(*)::int from public.map_posts(-100, -100, 100, 100, 100)), 0, 'pending: map_posts is empty');
select is((select count(*)::int from public.notification_feed(50)), 0, 'pending: nothing of BAR in the feed');
select throws_ok($$insert into public.comments(post_id, author_id, body)
                    values ('00000000-0000-4000-8000-0000000e2001', 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a9', 'こんにちは')$$,
                 '42501', null, 'pending: cannot comment');
select throws_ok($$insert into public.reactions(post_id, actor_id, kind)
                    values ('00000000-0000-4000-8000-0000000e2001', 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a9', 'like')$$,
                 '42501', null, 'pending: cannot react');
select throws_ok($$select * from public.community_join_requests$$, '42501', null, 'pending: cannot read the requests table');
select throws_ok($$select * from public.community_removals$$, '42501', null, 'pending: nor the removals table');
-- 外された人（a13）
set local request.jwt.claims to '{"sub":"e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2b3","role":"authenticated"}';
select is((select count(*)::int from public.posts), 0, 'removed: no post');
select is((select count(*)::int from public.comments), 0, 'removed: no comment');
select is((select count(*)::int from public.communities), 0, 'removed: no community');
select is((select count(*)::int from public.community_map_posts((select bar from cm), -100, -100, 100, 100, 100)), 0, 'removed: the map is empty');
select is((select count(*)::int from public.notification_feed(50)), 0, 'removed: nothing in the feed');
select throws_ok($$insert into public.comments(post_id, author_id, body)
                    values ('00000000-0000-4000-8000-0000000e2001', 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2b3', 'こんにちは')$$,
                 '42501', null, 'removed: cannot comment');
-- 対照: メンバー（a3）には見える
set local request.jwt.claims to '{"sub":"e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a3","role":"authenticated"}';
select is((select count(*)::int from public.community_map_posts((select bar from cm), -100, -100, 100, 100, 100)), 2,
          'control: a member sees the two live posts of BAR');
select is((select count(*)::int from public.communities), 1, 'control: and their community');
reset role;

-- -----------------------------------------------------------------------
-- 8. 管理者の承認待ち一覧
-- -----------------------------------------------------------------------
-- a12 は accounts の行が無いまま申し込む
set local role authenticated;
set local request.jwt.claims to '{"sub":"e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2b2","role":"authenticated"}';
select is(public.claim_invite('ja-on-invite-code-00000000002') ->> 'status', 'pending', 'a12 (no accounts row) is pending');
set local request.jwt.claims to '{"sub":"e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a1","role":"authenticated"}';
select is((select array_agg(account_id order by account_id) from public.list_join_requests((select bar from cm))),
          array['e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a4', 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a9']::uuid[],
          'the list holds the pending people who have a name (a12 has none; a10 cancelled; a7 got in)');
select is((select email from public.list_join_requests((select bar from cm)) where account_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a9'),
          'a9@example.test', 'an admin sees the email');
select is((select provider from public.list_join_requests((select bar from cm)) where account_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a4'),
          'line', 'and how they log in');
select is((select affiliation from public.list_join_requests((select bar from cm)) where account_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a9'),
          '会社', 'and the affiliation');
set local request.jwt.claims to '{"sub":"e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a3","role":"authenticated"}';
select throws_ok($$select * from public.list_join_requests((select bar from cm))$$, 'P0001', null, 'a member cannot read the list');
set local request.jwt.claims to '{"sub":"e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a8","role":"authenticated"}';
select throws_ok($$select * from public.list_join_requests((select bar from cm))$$, 'P0001', null, 'nor the admin of another community');
set local role anon;
set local request.jwt.claims to '{"role":"anon"}';
select throws_ok($$select * from public.list_join_requests((select bar from cm))$$, '42501', null, 'nor anon');
reset role;

-- -----------------------------------------------------------------------
-- 9. 承認する・断る
-- -----------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub":"e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a3","role":"authenticated"}';
select throws_ok($$select public.decide_join_request((select bar from cm), 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a9', true)$$, 'P0001',
                 'このコミュニティの承認は、管理者だけが行えます。', 'a member cannot decide');
set local request.jwt.claims to '{"sub":"e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a8","role":"authenticated"}';
select throws_ok($$select public.decide_join_request((select bar from cm), 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a9', true)$$, 'P0001', null,
                 'nor another community''s admin');
set local request.jwt.claims to '{"sub":"e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a1","role":"authenticated"}';
select is(public.decide_join_request((select bar from cm), 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a9', true), 'approved', 'an admin approves');
set local request.jwt.claims to '{"sub":"e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a2","role":"authenticated"}';
select is(public.decide_join_request((select bar from cm), 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a9', true), 'already', 'the second admin gets already');
select is(public.decide_join_request((select bar from cm), 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a9', false), 'already', 'even if they try to refuse');
select is(public.decide_join_request((select bar from cm), 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a3', true), 'already', 'a person with no request: already');
reset role;
select is((select joined_via from public.community_members where account_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a9'), 'approval', 'approved: joined_via is approval');
select is((select invite_id from public.community_members where account_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a9'),
          'e2e2e2e2-e2e2-4e2e-8e2e-0000000f0002'::uuid, 'with the applying link');
select is((select role from public.community_members where account_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a9'), 'member', 'as an ordinary member');
select is((select count(*)::int from public.community_join_requests where account_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a9'), 0,
          'the request row is gone (the email can no longer be fetched)');
select is((select count(*)::int from public.notifications where type = 'join_approved' and recipient_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a9'), 1,
          'the person got join_approved');
select is((select actor_id from public.notifications where type = 'join_approved' and recipient_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a9'),
          'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a1'::uuid, 'from the admin who approved');
select is((select payload ->> 'community_name' from public.notifications where type = 'join_approved' and recipient_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a9'),
          'BAR', 'with the community name');
select is((select count(*)::int from public.notifications where type = 'join_request' and actor_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a9'), 0,
          'the admins'' "waiting" notifications about them are gone');
select is((select count(*)::int from public.join_request_notices where account_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a9'), 0,
          'and so is the record of the last notice (decided)');
set local role authenticated;
set local request.jwt.claims to '{"sub":"e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a9","role":"authenticated"}';
select is((select count(*)::int from public.community_map_posts((select bar from cm), -100, -100, 100, 100, 100)), 2, 'now they see the map');
select is((select count(*)::int from public.notification_feed(50) where type = 'join_approved'), 1, 'and the news in the feed');
set local request.jwt.claims to '{"sub":"e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a1","role":"authenticated"}';
select ok(not exists (select 1 from public.list_join_requests((select bar from cm)) where account_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a9'),
          'the list no longer shows them');

-- 断る
set local request.jwt.claims to '{"sub":"e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a2","role":"authenticated"}';
select is(public.decide_join_request((select bar from cm), 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a4', false), 'rejected', 'an admin refuses a4');
set local request.jwt.claims to '{"sub":"e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a1","role":"authenticated"}';
select is(public.decide_join_request((select bar from cm), 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a4', true), 'already', 'the other admin cannot undo it by approving');
select ok(not exists (select 1 from public.list_join_requests((select bar from cm)) where account_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a4'),
          'a refused person leaves the list (and the email with it)');
reset role;
select is((select status from public.community_join_requests where account_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a4'), 'rejected', 'the row stays as rejected');
select is((select decided_by from public.community_join_requests where account_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a4'),
          'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a2'::uuid, 'with who decided');
select ok(not exists (select 1 from public.community_members where account_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a4'), 'and they are not a member');
select is((select count(*)::int from public.notifications where actor_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a4'), 0, 'their notifications are gone');
select is((select count(*)::int from public.notifications where recipient_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a4'), 0, 'and no join_approved was sent');
-- 断られた人: 見えない・どのリンクでも承認待ちに戻る
set local role authenticated;
set local request.jwt.claims to '{"sub":"e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a4","role":"authenticated"}';
select is((select status from public.my_join_status()), 'rejected', 'a4 sees rejected');
select is((select count(*)::int from public.posts), 0, 'rejected: no post');
select is((select count(*)::int from public.community_map_posts((select bar from cm), -100, -100, 100, 100, 100)), 0, 'rejected: the map is empty');
select is((public.check_invite('ja-off-invite-code-0000000001') ->> 'needs_approval')::boolean, true, 'an off link now says approval is needed for them');
select is(public.claim_invite('ja-off-invite-code-0000000001') ->> 'status', 'pending', 'and claiming it only puts them back to pending');
reset role;
select is((select rejected_before from public.community_join_requests where account_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a4'), true, 'rejected_before is set');
select is((select status from public.community_join_requests where account_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a4'), 'pending', 'pending again');
select ok((select decided_at is null and decided_by is null from public.community_join_requests where account_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a4'), 'the old decision is cleared');
select is((select count(*)::int from public.notifications where type = 'join_request' and actor_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a4'), 2,
          'and the admins are told again (a refusal cleared the notice record, so an application after it notifies)');
select ok(not exists (select 1 from public.community_members where account_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a4'), 'they did not get in');
select is((select uses from public.community_invites where code = 'ja-off-invite-code-0000000001'), 3, 'uses counts the new request (a5 and a7 joined, a4 asked)');
-- 取り消しても断りは帳消しにならない
set local role authenticated;
set local request.jwt.claims to '{"sub":"e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a4","role":"authenticated"}';
select lives_ok($$select public.cancel_join_request((select bar from cm))$$, 'a4 cancels the second request');
select is(public.claim_invite('ja-off-invite-code-0000000001') ->> 'status', 'pending', 'cancelling does not launder the refusal: still pending after claiming');
reset role;

-- 名前の無い人を承認しても誤りにならない（join_approved は送らない）
set local role authenticated;
set local request.jwt.claims to '{"sub":"e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a1","role":"authenticated"}';
select is(public.decide_join_request((select bar from cm), 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2b2', true), 'approved',
          'approving a person with no accounts row works');
reset role;
select is((select count(*)::int from public.notifications where recipient_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2b2'), 0, 'and sends nothing');
select ok(exists (select 1 from public.community_members where account_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2b2'), 'but they are in');
-- 申し込んだあとに accounts の行を消した人（a14）
set local role authenticated;
set local request.jwt.claims to '{"sub":"e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2b4","role":"authenticated"}';
select is(public.claim_invite('ja-on-invite-code-00000000002') ->> 'status', 'pending', 'a14 applies');
reset role;
delete from public.accounts where id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2b4';
set local role authenticated;
set local request.jwt.claims to '{"sub":"e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a1","role":"authenticated"}';
select is(public.decide_join_request((select bar from cm), 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2b4', true), 'approved',
          'approving after the accounts row was deleted is not an error');
reset role;

-- -----------------------------------------------------------------------
-- 10. 外した人: 申し込み→承認で、投稿とコメントが戻る
-- -----------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub":"e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a6","role":"authenticated"}';
select is((public.check_invite('ja-off-invite-code-0000000001') ->> 'needs_approval')::boolean, true, 'a6 (removed) is told approval is needed');
select is(public.claim_invite('ja-off-invite-code-0000000001') ->> 'status', 'pending', 'and an off link makes them pending');
select is((select count(*)::int from public.my_join_status()), 1, 'their status is one row (pending), not also removed');
select is((select status from public.my_join_status()), 'pending', 'pending');
reset role;
select is((select was_removed from public.community_join_requests where account_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a6'), true, 'was_removed is set');
select ok(not exists (select 1 from public.community_members where account_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a6' and community_id = (select bar from cm)),
          'and they are not back in BAR');
set local role authenticated;
set local request.jwt.claims to '{"sub":"e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a1","role":"authenticated"}';
select is((select was_removed from public.list_join_requests((select bar from cm)) where account_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a6'), true,
          'the admin''s list says they were removed before');
select is(public.decide_join_request((select bar from cm), 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a6', true), 'approved', 'the admin approves them');
reset role;
select is((select joined_at from public.community_members where account_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a6' and community_id = (select bar from cm)),
          '2026-10-01 00:00+00'::timestamptz, 'they come back with the old joined_at');
select is((select joined_via from public.community_members where account_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a6' and community_id = (select bar from cm)),
          'approval', 'joined_via approval');
select ok((select deleted_at is null from public.posts where id = '00000000-0000-4000-8000-0000000e2003'), 'a hidden post is back');
select ok((select deleted_at is not null from public.posts where id = '00000000-0000-4000-8000-0000000e2004'),
          'a hidden post that would collide with its live copy stays hidden (skipped, not an error)');
select ok((select deleted_at is not null from public.posts where id = '00000000-0000-4000-8000-0000000e2006'), 'a post they deleted themselves stays deleted');
select ok((select deleted_at is null from public.posts where id = '00000000-0000-4000-8000-0000000e2005'), 'the post in the other community was never hidden');
select ok((select deleted_at is null from public.comments where id = 'e2e2e2e2-e2e2-4e2e-8e2e-0000000c0001'), 'a hidden comment is back');
select ok((select deleted_at is not null from public.comments where id = 'e2e2e2e2-e2e2-4e2e-8e2e-0000000c0003'), 'a comment they deleted themselves stays deleted');
select ok((select deleted_at is null from public.comments where id = 'e2e2e2e2-e2e2-4e2e-8e2e-0000000c0002'), 'the comment in the other community is untouched');
select is((select count(*)::int from public.community_removals where account_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a6'), 0, 'the removal record is cleared');
select is((select count(*)::int from public.community_removals where account_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2b3'), 1, 'while the other removed person''s record stays');
select is((select count(*)::int from public.community_join_requests where account_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a6'), 0, 'and the request row');

-- -----------------------------------------------------------------------
-- 11. 10/29 の手作業の記録（app_settings の removed:<id>）を移す（migration の 9 と同じ塊）
-- -----------------------------------------------------------------------
-- 手作業で外された x を作る: BAR と OTHER の両方に入っていて、投稿とコメントを at の時刻で隠した
insert into auth.users(id, email) values ('e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2c1', 'x@example.test');
insert into public.invite_claims(account_id) values ('e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2c1');  -- 招待制がオンでも作れるように
insert into public.accounts(id, display_name) values ('e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2c1', 'manual-removed');
insert into public.posts(id, author_id, body, x, y, cluster_id, vec, vec_c, community_id, deleted_at) values
  ('00000000-0000-4000-8000-0000000e2101', 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2c1', 'x の BAR の投稿', 8, 8, 0, pg_temp.vec(), pg_temp.vec(), (select bar from cm), '2026-10-29 12:34:56.789012+00'),
  ('00000000-0000-4000-8000-0000000e2102', 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2c1', 'x の OTHER の投稿', 9, 9, 0, pg_temp.vec(), pg_temp.vec(), (select other from cm), '2026-10-29 12:34:56.789012+00'),
  ('00000000-0000-4000-8000-0000000e2103', 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2c1', 'x が前に消した投稿', 10, 10, 0, pg_temp.vec(), pg_temp.vec(), (select bar from cm), '2026-09-01 00:00+00');
insert into public.comments(id, post_id, author_id, body, deleted_at) values
  ('e2e2e2e2-e2e2-4e2e-8e2e-0000000c0101', '00000000-0000-4000-8000-0000000e2001', 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2c1', 'x のコメント', '2026-10-29 12:34:56.789012+00');
insert into public.app_settings(key, value) values
  ('removed:e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2c1',
   jsonb_build_object('at', '2026-10-29 12:34:56.789012+00'::timestamptz,
                      'communities', jsonb_build_array(
                        jsonb_build_object('community_id', (select bar from cm), 'joined_at', '2026-10-05 00:00+00'::timestamptz),
                        jsonb_build_object('community_id', (select other from cm), 'joined_at', '2026-10-06 00:00+00'::timestamptz)),
                      'posts', 2, 'comments', 1));
create function pg_temp.move_manual_removals() returns void language plpgsql as $f$
declare
  s record; kid uuid; at_ts timestamptz; c jsonb; cid uuid; pids uuid[]; cids uuid[];
begin
  for s in select a.key, a.value from public.app_settings a where a.key like 'removed:%' loop
    begin
      kid   := substr(s.key, 9)::uuid;
      at_ts := (s.value ->> 'at')::timestamptz;
    exception when others then
      continue;
    end;
    if exists (select 1 from auth.users u where u.id = kid) then
      for c in select e from jsonb_array_elements(coalesce(s.value -> 'communities', '[]'::jsonb)) e loop
        cid := (c ->> 'community_id')::uuid;
        if exists (select 1 from public.communities m where m.id = cid)
           and not exists (select 1 from public.community_members cm
                            where cm.community_id = cid and cm.account_id = kid) then
          select coalesce(array_agg(p.id), '{}') into pids from public.posts p
           where p.author_id = kid and p.community_id = cid and p.deleted_at = at_ts;
          select coalesce(array_agg(k.id), '{}') into cids
            from public.comments k join public.posts p on p.id = k.post_id
           where k.author_id = kid and p.community_id = cid and k.deleted_at = at_ts;
          insert into public.community_removals
            (community_id, account_id, removed_at, removed_by, joined_at_before, hidden_post_ids, hidden_comment_ids)
          values (cid, kid, at_ts, null, coalesce((c ->> 'joined_at')::timestamptz, at_ts), pids, cids)
          on conflict (community_id, account_id) do nothing;
        end if;
      end loop;
    end if;
    delete from public.app_settings where key = s.key;
  end loop;
end $f$;
select pg_temp.move_manual_removals();
select is((select count(*)::int from public.community_removals where account_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2c1'), 2,
          'a record per community moved');
select is((select hidden_post_ids from public.community_removals where account_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2c1' and community_id = (select bar from cm)),
          array['00000000-0000-4000-8000-0000000e2101']::uuid[], 'BAR keeps only BAR''s hidden post (not the other community''s copy, not the one they deleted)');
select is((select hidden_comment_ids from public.community_removals where account_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2c1' and community_id = (select bar from cm)),
          array['e2e2e2e2-e2e2-4e2e-8e2e-0000000c0101']::uuid[], 'and the hidden comment on BAR''s post');
select is((select hidden_post_ids from public.community_removals where account_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2c1' and community_id = (select other from cm)),
          array['00000000-0000-4000-8000-0000000e2102']::uuid[], 'the other community keeps its own');
select is((select hidden_comment_ids from public.community_removals where account_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2c1' and community_id = (select other from cm)),
          '{}'::uuid[], 'and no comment');
select is((select joined_at_before from public.community_removals where account_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2c1' and community_id = (select bar from cm)),
          '2026-10-05 00:00+00'::timestamptz, 'the joined time is kept');
select is((select removed_at from public.community_removals where account_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2c1' and community_id = (select bar from cm)),
          '2026-10-29 12:34:56.789012+00'::timestamptz, 'and when they were removed');
select is((select count(*)::int from public.app_settings where key like 'removed:%'), 0, 'the handwork row is deleted');
select pg_temp.move_manual_removals();
select is((select count(*)::int from public.community_removals where account_id = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2c1'), 2,
          'running it again changes nothing (and with no row it does nothing)');
select is((select value from public.app_settings where key = 'invite_only'), 'true'::jsonb, 'other settings are left alone');
-- 取り込んだ記録で承認すると、ちゃんと戻る
set local role authenticated;
set local request.jwt.claims to '{"sub":"e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2c1","role":"authenticated"}';
select is(public.claim_invite('ja-off-invite-code-0000000001') ->> 'status', 'pending', 'the handwork-removed person is pending on an off link');
set local request.jwt.claims to '{"sub":"e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2a1","role":"authenticated"}';
select is(public.decide_join_request((select bar from cm), 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2c1', true), 'approved', 'approved');
reset role;
select ok((select deleted_at is null from public.posts where id = '00000000-0000-4000-8000-0000000e2101'), 'their BAR post is back');
select ok((select deleted_at is not null from public.posts where id = '00000000-0000-4000-8000-0000000e2102'), 'the other community''s stays hidden (they are still removed there)');
select ok((select deleted_at is not null from public.posts where id = '00000000-0000-4000-8000-0000000e2103'), 'and what they deleted themselves stays deleted');

select * from finish();
rollback;
