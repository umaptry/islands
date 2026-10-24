-- 2026-10-26: コミュニティの名前を管理者が変える（rename_community）。
-- Run with: supabase test db (CI does). Everybody here is made up.
begin;
select no_plan();

-- 管理者(admin)・メンバー(member)・外の人(outsider)・別の会の管理者(other_admin)。
insert into auth.users(id) values
  ('c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2a1'),
  ('c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2a2'),
  ('c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2a3'),
  ('c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2a4');
insert into public.accounts(id, display_name) values
  ('c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2a1', 'admin'),
  ('c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2a2', 'member'),
  ('c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2a3', 'outsider'),
  ('c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2a4', 'other_admin')
on conflict (id) do nothing;

select public.create_community('名前を変える会', 'rename-test', 'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2a1');
select public.create_community('別の会', 'rename-other-test', 'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2a4');
insert into public.community_members(community_id, account_id, role)
select id, 'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2a2', 'member' from public.communities where slug = 'rename-test';
create temp table comm as
  select (select id from public.communities where slug = 'rename-test')       as mine,
         (select id from public.communities where slug = 'rename-other-test') as other;
grant select on comm to anon, authenticated;

-- -----------------------------------------------------------------------
-- 1. 呼べる人
-- -----------------------------------------------------------------------
select ok(not has_function_privilege('anon', 'public.rename_community(uuid, text)', 'execute'),
          'anon cannot rename');
select ok(has_function_privilege('authenticated', 'public.rename_community(uuid, text)', 'execute'),
          'a signed-in person can call it (the function checks the role itself)');

-- -----------------------------------------------------------------------
-- 2. 管理者
-- -----------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub":"c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2a1","role":"authenticated"}';

select is(public.rename_community((select mine from comm), '新しい名前'), '新しい名前',
          'an admin renames the community and gets the new name back');
select is((select name from public.communities where id = (select mine from comm)), '新しい名前',
          'and it is saved');
select is((select name from public.my_communities()), '新しい名前', 'my_communities shows the new name');

-- 前後の空白は取る（半角も全角も）
select is(public.rename_community((select mine from comm), E'  \u3000 週末の会 \t\u3000 '), '週末の会',
          'spaces around the name are trimmed, full-width ones too');
select is((select name from public.communities where id = (select mine from comm)), '週末の会',
          'and the trimmed name is what is saved');
-- 真ん中の空白は残す
select is(public.rename_community((select mine from comm), 'Saturday Morning Run'), 'Saturday Morning Run',
          'a space in the middle stays');

-- 長さ: 1〜40字
select is(public.rename_community((select mine from comm), 'あ'), 'あ', 'one character is allowed');
select is(public.rename_community((select mine from comm), repeat('あ', 40)), repeat('あ', 40),
          'forty characters are allowed (Japanese ones count as one each)');
select throws_ok($$select public.rename_community((select mine from comm), repeat('あ', 41))$$, 'P0001', null,
                 'forty-one are not');
select throws_ok($$select public.rename_community((select mine from comm), '')$$, 'P0001', null,
                 'an empty name is not');
select throws_ok($$select public.rename_community((select mine from comm), E' \u3000 ')$$, 'P0001', null,
                 'nor one made only of spaces');
select throws_ok($$select public.rename_community((select mine from comm), null)$$, 'P0001', null,
                 'nor a null');
select is((select name from public.communities where id = (select mine from comm)), repeat('あ', 40),
          'a refused rename leaves the name as it was');

-- 別の会は変えられない
select throws_ok($$select public.rename_community((select other from comm), '乗っ取り')$$, 'P0001', null,
                 'the admin of one community cannot rename another');
select throws_ok($$select public.rename_community(null, '名無し')$$, 'P0001', null,
                 'a null community is refused');

-- -----------------------------------------------------------------------
-- 3. メンバー・外の人・別の会の管理者
-- -----------------------------------------------------------------------
set local request.jwt.claims to '{"sub":"c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2a2","role":"authenticated"}';
select throws_ok($$select public.rename_community((select mine from comm), '勝手な名前')$$, 'P0001', null,
                 'a plain member cannot rename');

set local request.jwt.claims to '{"sub":"c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2a3","role":"authenticated"}';
select throws_ok($$select public.rename_community((select mine from comm), '勝手な名前')$$, 'P0001', null,
                 'an outsider cannot rename');

set local request.jwt.claims to '{"sub":"c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2a4","role":"authenticated"}';
select throws_ok($$select public.rename_community((select mine from comm), '勝手な名前')$$, 'P0001', null,
                 'the admin of another community cannot rename this one');

-- -----------------------------------------------------------------------
-- 4. 入っていない（ログインしていない）人
-- -----------------------------------------------------------------------
set local request.jwt.claims to '{"role":"authenticated"}';
select throws_ok($$select public.rename_community((select mine from comm), '誰か')$$, 'P0001', null,
                 'a token without a person is refused');

set local role anon;
reset request.jwt.claims;
select throws_ok($$select public.rename_community((select mine from comm), '誰か')$$, '42501', null,
                 'anon is refused by the database itself');

reset role;
select is((select name from public.communities where id = (select mine from comm)), repeat('あ', 40),
          'after all of that the name is the last good one');

select * from finish();
rollback;
