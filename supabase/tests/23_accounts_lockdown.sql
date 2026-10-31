-- 2026-11-01: accounts を閉じる・フルネーム（20261101010000_accounts_lockdown_and_fullname.sql）。
-- Run with: supabase test db (CI does). Everybody here is made up.
--
-- 役（アカウント id の末尾）:
--   m1 member（A に入っている）/ m2 mate（A に入っている）/ ab（A と B）/ bb（B だけ）/ lone（どこにも入っていない）/
--   dm1・dm2（別々のコミュニティにいて、DM の部屋がある）/ dm3（dm1 と同じコミュニティだが、DM の部屋はない別の会）/
--   pend（承認待ち）。
begin;
select no_plan();

insert into auth.users(id) values
  ('f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a1'), ('f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a2'),
  ('f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a3'), ('f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a4'),
  ('f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a5'), ('f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a6'),
  ('f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a7'), ('f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a8'),
  ('f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a9');
insert into public.accounts(id, display_name, affiliation) values
  ('f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a1', 'm1', '会社A'),
  ('f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a2', 'm2', '会社A'),
  ('f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a3', 'ab', '会社A'),
  ('f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a4', 'bb', '会社B'),
  ('f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a5', 'lone', '会社C'),
  ('f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a6', 'dm1', '会社A'),
  ('f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a7', 'dm2', '会社B'),
  ('f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a8', 'dm3', '会社B'),
  ('f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a9', 'pend', '会社D');

select public.create_community('A', 'lk-a', 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a1');
select public.create_community('B', 'lk-b', 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a4');
create temp table cm as
  select (select id from public.communities where slug = 'lk-a') as a,
         (select id from public.communities where slug = 'lk-b') as b;
grant select on cm to anon, authenticated, service_role;
insert into public.community_members(community_id, account_id) values
  ((select a from cm), 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a2'),
  ((select a from cm), 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a3'),
  ((select b from cm), 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a3'),
  ((select a from cm), 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a6'),
  ((select b from cm), 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a7'),
  ((select b from cm), 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a8');
insert into public.community_join_requests(community_id, account_id) values
  ((select a from cm), 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a9');
-- DM の部屋: dm1(A) と dm2(B)（user_a < user_b の順）
insert into public.dm_rooms(user_a, user_b) values
  ('f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a6', 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a7');

-- -----------------------------------------------------------------------
-- 1. 列・制約
-- -----------------------------------------------------------------------
select has_column('public', 'accounts', 'name_confirmed_at', 'accounts has name_confirmed_at');
select has_column('public', 'accounts', 'age_band', 'and age_band');
select has_column('public', 'accounts', 'job_title', 'and job_title');
select has_column('public', 'accounts', 'created_via', 'and created_via');
select col_is_null('public', 'accounts', 'name_confirmed_at', 'the new columns are optional (old rows have none)');
select lives_ok($$update public.accounts set age_band = '30s', job_title = 'デザイナー' where id = 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a1'$$,
                'a valid age band and job title are saved');
select throws_ok($$update public.accounts set age_band = '25' where id = 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a1'$$, '23514', null,
                 'an unknown age band is refused');
select throws_ok($$update public.accounts set job_title = repeat('あ', 33) where id = 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a1'$$, '23514', null,
                 'a job title is at most 32 characters');
select lives_ok($$update public.accounts set job_title = repeat('あ', 32) where id = 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a1'$$, 'and 32 is fine');
select lives_ok($$update public.accounts set created_via = 'event' where id = 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a1'$$, 'created_via takes event');
select throws_ok($$update public.accounts set created_via = 'other' where id = 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a1'$$, '23514', null,
                 'and nothing else');
select lives_ok($$update public.accounts set name_confirmed_at = now() where id = 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a1'$$, 'name_confirmed_at is a timestamp');
select lives_ok($$update public.accounts set display_name = repeat('あ', 24) where id = 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a2'$$,
                'a name of 24 characters is allowed now');
select throws_ok($$update public.accounts set display_name = repeat('あ', 25) where id = 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a2'$$, '23514', null,
                 'but not 25');
select throws_ok($$update public.accounts set display_name = '' where id = 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a2'$$, '23514', null,
                 'nor an empty name');
update public.accounts set display_name = 'm2' where id = 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a2';
update public.accounts set age_band = null, job_title = null, created_via = null, name_confirmed_at = null
 where id = 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a1';

-- -----------------------------------------------------------------------
-- 2. 権限
-- -----------------------------------------------------------------------
select is((select count(*)::int from information_schema.columns c
            where c.table_schema = 'public' and c.table_name = 'accounts'
              and has_column_privilege('anon', 'public.accounts', c.column_name, 'select')), 0,
          'anon can read no column of accounts');
select ok(not has_table_privilege('anon', 'public.accounts', 'select'), 'nor the table');
select ok(has_column_privilege('authenticated', 'public.accounts', 'display_name', 'select'), 'a signed-in person still reads names');
select ok(has_column_privilege('authenticated', 'public.accounts', 'topics', 'select'), 'and topics');
select ok(has_column_privilege('authenticated', 'public.accounts', 'name_confirmed_at', 'select'), 'and name_confirmed_at');
select ok(has_column_privilege('authenticated', 'public.accounts', 'age_band', 'select'), 'and age_band');
select ok(has_column_privilege('authenticated', 'public.accounts', 'job_title', 'select'), 'and job_title');
select ok(not has_column_privilege('authenticated', 'public.accounts', 'created_via', 'select'), 'but never created_via');
select ok(not has_column_privilege('authenticated', 'public.accounts', 'vec_topics', 'select'), 'nor a vector');
select ok(not has_column_privilege('authenticated', 'public.accounts', 'last_seen_at', 'select'), 'nor when someone was last here');
select is((select array_agg(c.column_name::text order by c.column_name) from information_schema.columns c
            where c.table_schema = 'public' and c.table_name = 'accounts'
              and has_column_privilege('authenticated', 'public.accounts', c.column_name, 'update')),
          array['affiliation', 'avatar_path', 'bio', 'display_name', 'icon_id', 'link_url'],
          'the browser writes the same six profile columns as before (none of the new ones)');
select is((select array_agg(c.column_name::text order by c.column_name) from information_schema.columns c
            where c.table_schema = 'public' and c.table_name = 'accounts'
              and has_column_privilege('authenticated', 'public.accounts', c.column_name, 'insert')),
          array['affiliation', 'avatar_path', 'bio', 'display_name', 'icon_id', 'id', 'link_url'],
          'and inserts the same seven');
select ok(has_table_privilege('service_role', 'public.accounts', 'select'), 'the server key reads everything');
select ok(has_column_privilege('service_role', 'public.accounts', 'created_via', 'update'), 'and writes the new columns');
select ok(not has_function_privilege('anon', 'public.account_visible(uuid)', 'execute'), 'anon cannot run account_visible');
select ok(not has_function_privilege('anon', 'public.shares_community_with(uuid)', 'execute'), 'nor shares_community_with');
select ok(has_function_privilege('authenticated', 'public.account_visible(uuid)', 'execute'), 'a signed-in person can (the policy runs as them)');
select ok(has_function_privilege('authenticated', 'public.shares_community_with(uuid)', 'execute'), 'and this one');
select is((select count(*)::int from pg_proc where pronamespace = 'public'::regnamespace
             and proname in ('account_visible', 'shares_community_with')), 2, 'each has exactly one signature');
select is((select roles::text from pg_policies where schemaname = 'public' and tablename = 'accounts' and policyname = 'accounts_read'),
          '{authenticated}', 'accounts_read is for signed-in people only');
select ok((select qual like '%account_visible%' from pg_policies where schemaname = 'public' and tablename = 'accounts' and policyname = 'accounts_read'),
          'and it asks account_visible');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'accounts' and cmd in ('SELECT', 'ALL')), 1,
          'there is no other policy that reads accounts');

-- -----------------------------------------------------------------------
-- 3. anon は読めない（招待の画面は check_invite で足りる）
-- -----------------------------------------------------------------------
set local role anon;
set local request.jwt.claims to '{"role":"anon"}';
select throws_ok($$select count(*) from public.accounts$$, '42501', null, 'anon: accounts cannot be read');
select throws_ok($$select display_name from public.accounts$$, '42501', null, 'anon: not even the names');
select throws_ok($$select id from public.accounts where id = 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a1'$$, '42501', null, 'anon: nor one account by its id');
select throws_ok($$select public.account_visible('f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a1')$$, '42501', null, 'anon: account_visible is not callable');
select lives_ok($$select public.check_invite('nothing')$$, 'anon: check_invite still works');
reset role;

-- -----------------------------------------------------------------------
-- 4. 同じコミュニティ・本人・DM の相手は読める。ほかは読めない
-- -----------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub":"f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a2","role":"authenticated"}';   -- m2（A）
select is((select array_agg(display_name order by display_name) from public.accounts),
          array['ab', 'dm1', 'm1', 'm2'], 'a member of A reads A''s people (m1, m2, ab, dm1) and nobody else');
select is((select count(*)::int from public.accounts where id = 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a4'), 0, 'not B''s admin');
select is((select count(*)::int from public.accounts where id = 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a5'), 0, 'not someone in no community');
select is((select count(*)::int from public.accounts where id = 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a9'), 0, 'not a pending applicant');
select is(public.shares_community_with('f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a1'), true, 'shares_community_with: a mate');
select is(public.shares_community_with('f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a4'), false, 'and not a stranger');
select is(public.account_visible('f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a2'), true, 'account_visible: myself');
select is(public.account_visible('f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a5'), false, 'and not a stranger');
select is((select display_name from public.accounts where id = 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a3'), 'ab', 'a person in two communities is visible from either');
select is((select count(*)::int from public.accounts where age_band is null and job_title is null), 4,
          'the new readable columns come with the same row filter');
set local request.jwt.claims to '{"sub":"f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a4","role":"authenticated"}';   -- bb（B）
select is((select array_agg(display_name order by display_name) from public.accounts),
          array['ab', 'bb', 'dm2', 'dm3'], 'a member of B reads B''s people');
set local request.jwt.claims to '{"sub":"f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a3","role":"authenticated"}';   -- ab（A と B）
select is((select count(*)::int from public.accounts), 7, 'a member of both reads both (all but lone and pend)');
-- DM の相手は、コミュニティが違っても読める（E の 9）
set local request.jwt.claims to '{"sub":"f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a6","role":"authenticated"}';   -- dm1（A。DM の相手 dm2 は B）
select is((select display_name from public.accounts where id = 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a7'), 'dm2',
          'a DM partner in another community is still readable (name and icon)');
select is((select count(*)::int from public.accounts where id = 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a8'), 0,
          'but the partner''s other community-mates are not');
select is(public.account_visible('f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a7'), true, 'account_visible: the DM partner');
set local request.jwt.claims to '{"sub":"f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a7","role":"authenticated"}';   -- dm2（B。DM の相手 dm1 は A）
select is((select display_name from public.accounts where id = 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a6'), 'dm1', 'and the other way round');
-- どこにも入っていない人・承認待ちの人は、自分だけ
set local request.jwt.claims to '{"sub":"f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a5","role":"authenticated"}';   -- lone
select is((select array_agg(display_name) from public.accounts), array['lone'], 'a person in no community reads only themselves');
set local request.jwt.claims to '{"sub":"f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a9","role":"authenticated"}';   -- pend
select is((select array_agg(display_name) from public.accounts), array['pend'], 'a pending applicant reads only themselves');
select is((select count(*)::int from public.accounts where id <> 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a9'), 0, 'and no admin of the community they asked');
-- ログインしているが sub が無い（壊れた JWT）→ 誰も読めない
set local request.jwt.claims to '{"role":"authenticated"}';
select is((select count(*)::int from public.accounts), 0, 'a token with no person reads nobody');

-- -----------------------------------------------------------------------
-- 5. 今のコードが accounts にすることは、今までどおり動く
-- -----------------------------------------------------------------------
set local request.jwt.claims to '{"sub":"f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a1","role":"authenticated"}';   -- m1
select lives_ok($$insert into public.accounts(id, display_name, affiliation)
                   values ('f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a1', 'm1 renamed', '会社A')
                   on conflict (id) do update set display_name = excluded.display_name, affiliation = excluded.affiliation$$,
                'the profile save (an upsert of your own row) works');
select is((select display_name from public.accounts where id = 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a1'), 'm1 renamed', 'and is saved');
select lives_ok($$update public.accounts set bio = 'こんにちは' where id = 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a1'$$, 'your own row can be updated');
update public.accounts set bio = 'cannot' where id = 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a2';
reset role;
select is((select bio from public.accounts where id = 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a2'), null, 'but not someone else''s');
set local role authenticated;
set local request.jwt.claims to '{"sub":"f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a1","role":"authenticated"}';
select throws_ok($$update public.accounts set name_confirmed_at = now() where id = 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a1'$$, '42501', null,
                 'the browser cannot write name_confirmed_at');
select throws_ok($$update public.accounts set age_band = '30s' where id = 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a1'$$, '42501', null, 'nor age_band');
select throws_ok($$update public.accounts set job_title = 'x' where id = 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a1'$$, '42501', null, 'nor job_title');
select throws_ok($$update public.accounts set created_via = 'event' where id = 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a1'$$, '42501', null, 'nor created_via');
select throws_ok($$select created_via from public.accounts$$, '42501', null, 'and it cannot be read');

-- 一覧の中の「作者の名前」: 見える人だけ。見えない作者は、結合で行ごと落ちる（flatten は row.accounts || {} で受ける）
reset role;
insert into public.posts(id, author_id, body, x, y, cluster_id, vec, vec_c, community_id) values
  ('00000000-0000-4000-8000-0000000f2001', 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a2', 'A の投稿', 1, 1, 0,
   array_fill(1.0, array[448])::vector(448), array_fill(1.0, array[448])::vector(448), (select a from cm));
set local role authenticated;
set local request.jwt.claims to '{"sub":"f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a1","role":"authenticated"}';
select is((select count(*)::int from public.community_map_posts((select a from cm), -10, -10, 10, 10, 100)
             where display_name = 'm2'), 1, 'the map (a definer function) still shows the author''s name to a member');
select is((select a.display_name from public.posts p left join public.accounts a on a.id = p.author_id), 'm2',
          'and a direct join works for a member');
reset role;

-- -----------------------------------------------------------------------
-- 6. 抜けたら見えなくなり、サーバーのキーは何も変わらない
-- -----------------------------------------------------------------------
delete from public.community_members where account_id = 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a2' and community_id = (select a from cm);
set local role authenticated;
set local request.jwt.claims to '{"sub":"f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a1","role":"authenticated"}';
select is((select count(*)::int from public.accounts where id = 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2a2'), 0, 'someone who left the community can no longer be read');
reset role;
set local role service_role;
select is((select count(*)::int from public.accounts), 9, 'the server key still reads every account');
reset role;

select * from finish();
rollback;
