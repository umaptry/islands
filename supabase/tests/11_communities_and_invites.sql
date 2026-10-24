-- 2026-10-26: コミュニティ・招待・コミュニティごとの地図・招待制の登録。
-- Run with: supabase test db (CI does). Everybody here is made up.
begin;
select no_plan();

-- 管理者(admin)・メンバー(member)・外の人(outsider)・まだ accounts の行が無い新しい人(newbie)。
insert into auth.users(id) values
  ('c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1a1'),
  ('c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1a2'),
  ('c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1a3'),
  ('c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1a4'),
  ('c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1a5');
insert into public.accounts(id, display_name) values
  ('c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1a1', 'admin'),
  ('c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1a2', 'member'),
  ('c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1a3', 'outsider')
on conflict (id) do nothing;

-- 運営が SQL エディタで作る。コミュニティ2つ（BAR と、もう1つ）。
select public.create_community('BAR', 'bar-test', 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1a1');
select public.create_community('もう一つの会', 'other-test', 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1a2');
create temp table comm as
  select (select id from public.communities where slug = 'bar-test')   as bar,
         (select id from public.communities where slug = 'other-test') as other;
grant select on comm to anon, authenticated;

-- 運営の塊を2回流しても壊れない: 同じスラッグの会はそのまま使い、管理者を足すだけ
select is(public.create_community('BAR', 'bar-test', 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1a1'), (select bar from comm),
          'making the same community again gives the same one');
select is((select count(*)::int from public.communities where slug = 'bar-test'), 1, 'and no second one');
select is((select count(*)::int from public.community_members where community_id = (select bar from comm)), 1,
          'and the admin is not added twice');

insert into public.posts(id, author_id, body, x, y, cluster_id, vec, vec_c, community_id)
select '00000000-0000-4000-8000-000000002001', 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1a1', 'BAR の投稿',
       1, 1, 0, array_fill(1.0, array[448])::vector(448), array_fill(1.0, array[448])::vector(448), bar
  from comm;
insert into public.posts(id, author_id, body, x, y, cluster_id, vec, vec_c, community_id)
select '00000000-0000-4000-8000-000000002002', 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1a2', 'もう一つの会の投稿',
       2, 2, 0, array_fill(1.0, array[448])::vector(448), array_fill(1.0, array[448])::vector(448), other
  from comm;
insert into public.posts(id, author_id, body, x, y, cluster_id, vec, vec_c)
values ('00000000-0000-4000-8000-000000002003', 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1a1', 'どこにも属さない投稿',
        3, 3, 0, array_fill(1.0, array[448])::vector(448), array_fill(1.0, array[448])::vector(448));

-- -----------------------------------------------------------------------
-- 1. 誰からも読めない表・呼べない関数・最初の設定
-- -----------------------------------------------------------------------
select is((select value from public.app_settings where key = 'invite_only'), 'false'::jsonb,
          'invite_only starts as false');
select ok(not has_table_privilege('anon', 'public.invite_claims', 'SELECT'), 'anon cannot read invite_claims');
select ok(not has_table_privilege('authenticated', 'public.invite_claims', 'SELECT'),
          'nor can a signed-in person');
select ok(not has_table_privilege('authenticated', 'public.invite_claims', 'INSERT'),
          'nor write it');
select ok(not has_table_privilege('anon', 'public.app_settings', 'SELECT'), 'anon cannot read app_settings');
select ok(not has_table_privilege('authenticated', 'public.app_settings', 'SELECT'),
          'nor can a signed-in person');
select ok(not has_table_privilege('authenticated', 'public.app_settings', 'UPDATE'),
          'nor change it');
select ok(not has_table_privilege('authenticated', 'public.communities', 'INSERT'),
          'a client cannot make a community');
select ok(not has_table_privilege('authenticated', 'public.communities', 'UPDATE'), 'nor edit one');
select ok(not has_table_privilege('authenticated', 'public.communities', 'DELETE'), 'nor delete one');
select ok(has_table_privilege('anon', 'public.communities', 'SELECT'), 'names are public');
select ok(not has_table_privilege('authenticated', 'public.community_members', 'INSERT'),
          'members are added by functions only');
select ok(not has_table_privilege('authenticated', 'public.community_members', 'UPDATE'),
          'a member cannot make themselves an admin');
select ok(not has_table_privilege('authenticated', 'public.community_invites', 'INSERT'),
          'invites are made by functions only');
select ok(not has_table_privilege('authenticated', 'public.community_invites', 'UPDATE'),
          'and stopped by functions only');
select ok(not has_table_privilege('anon', 'public.community_members', 'SELECT'), 'anon reads no members');
select ok(not has_table_privilege('anon', 'public.community_invites', 'SELECT'), 'anon reads no invites');
select ok(not has_function_privilege('anon', 'public.claim_invite(text)', 'execute'), 'anon cannot claim');
select ok(not has_function_privilege('anon', 'public.create_invite(uuid, integer, boolean)', 'execute'),
          'anon cannot make an invite');
select ok(not has_function_privilege('anon', 'public.list_invites(uuid)', 'execute'), 'anon cannot list invites');
select ok(not has_function_privilege('anon', 'public.revoke_invite(uuid)', 'execute'), 'anon cannot stop one');
select ok(not has_function_privilege('anon', 'public.my_communities()', 'execute'), 'anon has no communities');
select ok(has_function_privilege('anon', 'public.check_invite(text)', 'execute'), 'anon can check an invite');
select ok(has_function_privilege('anon', 'public.community_map_posts(uuid, double precision, double precision, double precision, double precision, integer)', 'execute'),
          'anon can read a community map');
select ok(not has_function_privilege('authenticated', 'public.create_community(text, text, uuid)', 'execute'),
          'only the operator makes communities');
select ok(has_function_privilege('service_role', 'public.create_community(text, text, uuid)', 'execute'),
          'the server key can');
select ok(not has_function_privilege('authenticated', 'public.make_invite_code()', 'execute'),
          'the code maker is not callable from outside');
select is((select count(*)::int from pg_publication_tables
            where pubname = 'supabase_realtime' and schemaname = 'public'
              and tablename in ('invite_claims', 'app_settings', 'community_invites')), 0,
          'none of them is in the realtime publication');
select has_column('public', 'posts', 'community_id', 'posts.community_id exists');
select is((select count(*)::int from public.posts where community_id is null), 1,
          'a post written without a community stays null (the old code does this)');

-- -----------------------------------------------------------------------
-- 2. 管理者が招待を作る
-- -----------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub":"c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1a1","role":"authenticated"}';

select is((select count(*)::int from public.my_communities()), 1, 'the admin is in one community');
select is((select role from public.my_communities()), 'admin', 'as admin');
select ok((select length(r ->> 'code') >= 22 and (r ->> 'expires_at') is not null and (r ->> 'id') is not null
             from (select public.create_invite((select bar from comm), 60, false) r) q),
          'an admin makes an invite: a code of 22+ characters, an expiry and an id');
select is((select count(*)::int from public.list_invites((select bar from comm))), 1, 'and sees it in the list');
select ok((select expires_at > now() + interval '59 minutes' and expires_at < now() + interval '61 minutes'
             and uses = 0 and revoked_at is null
             from public.list_invites((select bar from comm))),
          'sixty minutes means sixty minutes');
select ok((select (r ->> 'expires_at')::timestamptz > now() and (r ->> 'expires_at')::timestamptz <= now() + interval '25 hours'
             from (select public.create_invite((select bar from comm), 0, true) r) q),
          'until the end of the day ends within a day (minutes are ignored)');
select ok((select (((r ->> 'expires_at')::timestamptz at time zone 'UTC') + interval '9 hours')::time = time '23:59'
             from (select public.create_invite((select bar from comm), 1, true) r) q),
          'and it ends at 23:59 Japan time');
select throws_ok($$select public.create_invite((select bar from comm), 0, false)$$, 'P0001', null,
                 'zero minutes is refused');
select throws_ok($$select public.create_invite((select bar from comm), 100000, false)$$, 'P0001', null,
                 'and so is more than thirty days');
select throws_ok($$select public.create_invite((select other from comm), 60, false)$$, 'P0001', null,
                 'the admin of BAR cannot make an invite for the other community');
select throws_ok($$select * from public.list_invites((select other from comm))$$, 'P0001', null,
                 'nor read its list');

-- 試験用の招待（24時間 / 期限切れ / 止めた）を作る
reset role;
insert into public.community_invites(community_id, code, created_by, expires_at, revoked_at)
select bar, 'good-invite-code-0000000001', 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1a1'::uuid, now() + interval '1 day', null::timestamptz from comm
union all
select bar, 'old-invite-code-00000000002', 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1a1', now() - interval '1 minute', null::timestamptz from comm
union all
select bar, 'stopped-invite-code-00000003', 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1a1', now() + interval '1 day', now() from comm;

-- -----------------------------------------------------------------------
-- 3. check_invite はそれだけを返す
-- -----------------------------------------------------------------------
set local role anon;
reset request.jwt.claims;
select is(public.check_invite('good-invite-code-0000000001'),
          '{"valid": true, "community_name": "BAR", "reason": null}'::jsonb,
          'a good code: valid, the name, nothing else');
select is((select array_agg(k order by k) from jsonb_object_keys(public.check_invite('good-invite-code-0000000001')) k),
          array['community_name', 'reason', 'valid'], 'exactly those three keys (no id, no counts)');
select is(public.check_invite('old-invite-code-00000000002') ->> 'reason', 'expired', 'an expired code says so');
select is((public.check_invite('old-invite-code-00000000002') ->> 'valid')::boolean, false, 'and is not valid');
select is(public.check_invite('stopped-invite-code-00000003') ->> 'reason', 'revoked', 'a stopped code says so');
select is(public.check_invite('nonsense'),
          '{"valid": false, "community_name": null, "reason": "unknown"}'::jsonb, 'an unknown code is unknown');
select throws_ok($$select * from public.community_invites$$, '42501', null, 'anon cannot read the invites table');
select throws_ok($$select public.claim_invite('good-invite-code-0000000001')$$, '42501', null,
                 'anon cannot claim');

-- -----------------------------------------------------------------------
-- 4. 管理者でない人
-- -----------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub":"c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1a3","role":"authenticated"}';
select throws_ok($$select public.create_invite((select bar from comm), 60, false)$$, 'P0001', null,
                 'an outsider cannot make an invite');
select throws_ok($$select * from public.list_invites((select bar from comm))$$, 'P0001', null,
                 'nor list them');
select is((select count(*)::int from public.community_invites), 0, 'nor read the table');
select throws_ok($$select public.revoke_invite((select id from public.community_invites limit 1))$$, 'P0001', null,
                 'nor stop one (nothing visible, and not an admin)');
select is((select count(*)::int from public.community_members), 0, 'an outsider sees no member rows');
select is((select count(*)::int from public.my_communities()), 0, 'and is in no community');
select throws_ok($$select * from public.invite_claims$$, '42501', null, 'invite_claims cannot be read');
select throws_ok($$select * from public.app_settings$$, '42501', null, 'app_settings cannot be read');
select throws_ok($$update public.community_members set role = 'admin'$$, '42501', null,
                 'nobody promotes themselves');
select throws_ok($$insert into public.community_members(community_id, account_id, role)
                    select bar, 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1a3', 'admin' from comm$$,
                 '42501', null, 'nor writes themselves into a community');
select throws_ok($$insert into public.communities(name) values ('勝手な会')$$, '42501', null,
                 'nor makes a community');

-- -----------------------------------------------------------------------
-- 5. claim_invite
-- -----------------------------------------------------------------------
select throws_ok($$select public.claim_invite('old-invite-code-00000000002')$$, 'P0001', null,
                 'an expired invite cannot be used');
select throws_ok($$select public.claim_invite('stopped-invite-code-00000003')$$, 'P0001', null,
                 'a stopped invite cannot be used');
select throws_ok($$select public.claim_invite('nonsense')$$, 'P0001', null, 'an unknown code cannot be used');
select is((select count(*)::int from public.my_communities()), 0, 'and nobody joined by failing');

select is((select public.claim_invite('good-invite-code-0000000001') ->> 'community_name'), 'BAR',
          'a good invite answers the community name');
select is((select (public.claim_invite('good-invite-code-0000000001') ->> 'community_id')::uuid), (select bar from comm),
          'and its id');
select is((select count(*)::int from public.my_communities()), 1, 'the outsider is now in one community');
select is((select role from public.my_communities()), 'member', 'as a member');
select is((select count(*)::int from public.community_members), 2,
          'a member sees the member rows of their community (the admin and themselves)');

reset role;
select is((select uses from public.community_invites where code = 'good-invite-code-0000000001'), 1,
          'uses went up once (claiming again does nothing)');
select is((select count(*)::int from public.invite_claims
            where account_id = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1a3'), 1, 'and the claim is recorded once');

-- 管理者は止められる。止めたあとは使えない
set local role authenticated;
set local request.jwt.claims to '{"sub":"c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1a1","role":"authenticated"}';
select lives_ok($$select public.revoke_invite((select id from public.community_invites where code = 'good-invite-code-0000000001'))$$,
                'an admin stops an invite');
select ok((select revoked_at is not null from public.list_invites((select bar from comm)) where code = 'good-invite-code-0000000001'),
          'the list shows it stopped');
set local request.jwt.claims to '{"sub":"c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1a4","role":"authenticated"}';
select throws_ok($$select public.claim_invite('good-invite-code-0000000001')$$, 'P0001', null,
                 'a stopped invite cannot be used by the next person');

-- 一覧は管理者のコミュニティだけ。別のコミュニティの管理者は読めない
set local request.jwt.claims to '{"sub":"c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1a2","role":"authenticated"}';
select throws_ok($$select * from public.list_invites((select bar from comm))$$, 'P0001', null,
                 'the admin of another community cannot list BAR''s invites');
select throws_ok($$select public.revoke_invite((select id from public.community_invites limit 1))$$, 'P0001', null,
                 'nor stop them');

-- -----------------------------------------------------------------------
-- 6. 抜ける
-- -----------------------------------------------------------------------
set local request.jwt.claims to '{"sub":"c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1a3","role":"authenticated"}';
select lives_ok($$delete from public.community_members where account_id = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1a3'$$,
                'a member leaves');
select is((select count(*)::int from public.my_communities()), 0, 'and is out');
reset role;
select is((select count(*)::int from public.community_members
            where account_id = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1a1'), 1, 'while the admin is still in');
set local role authenticated;
set local request.jwt.claims to '{"sub":"c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1a3","role":"authenticated"}';
select lives_ok($$delete from public.community_members where account_id = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1a1'$$,
                'trying to remove somebody else removes nothing (not an error: nothing is visible)');
reset role;
select is((select count(*)::int from public.community_members
            where account_id = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1a1'), 1, 'the admin is still there');

-- 最後の管理者は抜けられない（管理者が0人になると、招待を作る・止める人がいなくなる）
set local role authenticated;
set local request.jwt.claims to '{"sub":"c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1a1","role":"authenticated"}';
select ok(not public.can_leave_community((select bar from comm)), 'the only admin may not leave');
select lives_ok($$delete from public.community_members where account_id = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1a1'
                    and community_id = (select bar from comm)$$,
                'trying to leave as the only admin removes nothing (no error)');
reset role;
select is((select count(*)::int from public.community_members
            where account_id = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1a1'
              and community_id = (select bar from comm)), 1, 'the only admin is still in');
-- もう1人管理者がいれば抜けられる（そのあと元に戻す）
insert into public.community_members (community_id, account_id, role)
select bar, 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1a2', 'admin' from comm
on conflict (community_id, account_id) do update set role = 'admin';
set local role authenticated;
set local request.jwt.claims to '{"sub":"c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1a1","role":"authenticated"}';
select ok(public.can_leave_community((select bar from comm)), 'with a second admin, an admin may leave');
select lives_ok($$delete from public.community_members where account_id = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1a1'
                    and community_id = (select bar from comm)$$, 'and does');
reset role;
select is((select count(*)::int from public.community_members
            where account_id = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1a1'
              and community_id = (select bar from comm)), 0, 'the first admin is out');
delete from public.community_members
 where community_id = (select bar from comm) and account_id = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1a2';
insert into public.community_members (community_id, account_id, role)
select bar, 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1a1', 'admin' from comm;

-- -----------------------------------------------------------------------
-- 7. コミュニティごとの地図
-- -----------------------------------------------------------------------
set local role anon;
select is((select count(*)::int from public.community_map_posts((select bar from comm), -10, -10, 10, 10, 100)), 1,
          'BAR''s map has BAR''s post only');
select is((select body from public.community_map_posts((select bar from comm), -10, -10, 10, 10, 100)), 'BAR の投稿',
          'the right one');
select is((select count(*)::int from public.community_map_posts((select other from comm), -10, -10, 10, 10, 100)), 1,
          'the other map has its own post only');
select is((select count(*)::int from public.community_map_posts(gen_random_uuid(), -10, -10, 10, 10, 100)), 0,
          'a community that does not exist has an empty map');
select is((select count(*)::int from public.map_posts(-10, -10, 10, 10, 100)), 3,
          'the old map_posts is unchanged and still shows everything');
select is((select count(*)::int from public.community_map_posts((select bar from comm), 5, 5, 10, 10, 100)), 0,
          'the box still limits it');
reset role;
update public.posts set deleted_at = now() where id = '00000000-0000-4000-8000-000000002001';
set local role anon;
select is((select count(*)::int from public.community_map_posts((select bar from comm), -10, -10, 10, 10, 100)), 0,
          'a deleted post leaves the map');
reset role;
update public.posts set deleted_at = null where id = '00000000-0000-4000-8000-000000002001';

-- -----------------------------------------------------------------------
-- 8. 招待制: invite_only が false の間は、今までどおり登録できる
-- -----------------------------------------------------------------------
select lives_ok($$insert into public.accounts(id, display_name)
                   values ('c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1a4', 'free signup')$$,
                'while invite_only is false anybody can register (the old code)');
delete from public.accounts where id = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1a4';

-- -----------------------------------------------------------------------
-- 9. invite_only が true
-- -----------------------------------------------------------------------
update public.app_settings set value = 'true'::jsonb where key = 'invite_only';

select throws_ok($$insert into public.accounts(id, display_name)
                    values ('c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1a4', 'no invite')$$,
                 'P0001', 'islands は招待制です。コミュニティの招待リンクから登録してください。',
                 'a new account without an invite is stopped, in Japanese (even for the server key)');
select is((select count(*)::int from public.accounts where id = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1a4'), 0,
          'and nothing was written');

-- 今あるアカウントの更新（merge-duplicates の upsert）は通る
select lives_ok($$insert into public.accounts(id, display_name)
                   values ('c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1a3', 'outsider renamed')
                   on conflict (id) do update set display_name = excluded.display_name$$,
                'an existing account can still be upserted (the profile save)');
select is((select display_name from public.accounts where id = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1a3'),
          'outsider renamed', 'and it was saved');
select lives_ok($$insert into public.accounts(id, display_name, bio)
                   values ('c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1a1', 'admin', 'hello')
                   on conflict (id) do update set bio = excluded.bio$$,
                'also for the admin');

-- 同じ人が招待を使えば、新しい人でも作れる
insert into public.community_invites(community_id, code, created_by, expires_at)
select bar, 'second-invite-code-000000004', 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1a1', now() + interval '1 day' from comm;
set local role authenticated;
set local request.jwt.claims to '{"sub":"c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1a4","role":"authenticated"}';
select throws_ok($$insert into public.accounts(id, display_name)
                    values ('c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1a4', 'no invite')$$,
                 'P0001', null, 'a signed-in person without an invite cannot insert their own row either');
select lives_ok($$select public.claim_invite('second-invite-code-000000004')$$, 'the new person claims an invite');
select lives_ok($$insert into public.accounts(id, display_name)
                   values ('c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1a4', 'invited')$$,
                'and then the account can be made');
reset role;
select is((select count(*)::int from public.accounts where id = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1a4'), 1,
          'it exists');
select is((select count(*)::int from public.community_members
            where account_id = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1a4' and community_id = (select bar from comm)), 1,
          'and the person is in the community');

-- 招待の印は、その人の id にだけ効く
select throws_ok($$insert into public.accounts(id, display_name)
                    values ('c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1a5', 'someone else')$$,
                 'P0001', null, 'another person is still stopped');

-- 戻す
update public.app_settings set value = 'false'::jsonb where key = 'invite_only';
select lives_ok($$insert into public.accounts(id, display_name)
                   values ('c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1a5', 'open again')$$,
                'back to false, anybody can register again');

select * from finish();
rollback;
