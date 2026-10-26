-- 2026-10-29: 「ほかのコミュニティにも出す」（同じ投稿の仲間 share_group と、先着人数の合計）。
-- Run with: supabase test db (CI does). Everybody here is made up.
--
-- 役: host（A と B。投稿する人）/ a_only（A だけ）/ ab（A と B）/ b_only（B だけ）/ b_two（B だけ）。
-- host の募集の投稿を A と B に1つずつ出し（同じ share_group）、先着2人を2つのコミュニティの合計で数える。
begin;
select no_plan();

insert into auth.users(id) values
  ('e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e501'),
  ('e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e502'),
  ('e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e503'),
  ('e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e504'),
  ('e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e505');
insert into public.accounts(id, display_name) values
  ('e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e501', 'host'),
  ('e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e502', 'a_only'),
  ('e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e503', 'ab'),
  ('e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e504', 'b_only'),
  ('e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e505', 'b_two')
on conflict (id) do nothing;

select public.create_community('SA', 'share-a', 'e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e501');
select public.create_community('SB', 'share-b', 'e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e501');
create temp table sc as
  select (select id from public.communities where slug = 'share-a') as a,
         (select id from public.communities where slug = 'share-b') as b;
grant select on sc to anon, authenticated, service_role;
insert into public.community_members(community_id, account_id, role)
select a, 'e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e502'::uuid, 'member' from sc
union all select a, 'e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e503'::uuid, 'member' from sc
union all select b, 'e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e503'::uuid, 'member' from sc
union all select b, 'e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e504'::uuid, 'member' from sc
union all select b, 'e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e505'::uuid, 'member' from sc;

select has_column('public', 'posts', 'share_group', 'posts carry the mark of the same post in other communities');
select has_column('public', 'posts', 'group_join_count', 'and the joins counted over all of them');

-- 1. 古い書き方（新しい列なし）のまま書ける。仲間がいなければ合計は null。
select lives_ok(
  $$insert into public.posts(id, author_id, body, x, y, cluster_id, vec, vec_c, community_id)
    values ('00000000-0000-4000-8000-0000000e5001', 'e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e501', 'old style', 1, 1, 0,
            array_fill(1.0, array[448])::vector(448), array_fill(1.0, array[448])::vector(448),
            (select a from sc))$$,
  'a post written without share_group still works');
select is((select group_join_count from public.posts where id = '00000000-0000-4000-8000-0000000e5001'),
          null, 'and has no group total');

-- 2. 募集の投稿を A と B に（同じ share_group、先着2人、期限は明日）。
insert into public.posts(id, author_id, body, x, y, cluster_id, vec, vec_c, tags,
                         recruit_deadline, recruit_capacity, community_id, share_group)
select v.id::uuid, 'e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e501', 'みんなで朝ラン', 2, 2, 0,
       array_fill(1.0, array[448])::vector(448), array_fill(1.0, array[448])::vector(448),
       array['参加者募集中'], current_date + 1, 2, v.cid, '00000000-0000-4000-8000-0000000e5a00'::uuid
  from (values ('00000000-0000-4000-8000-0000000e5a01', (select a from sc)),
               ('00000000-0000-4000-8000-0000000e5b01', (select b from sc))) v(id, cid);
select is((select array_agg(group_join_count order by id) from public.posts
            where share_group = '00000000-0000-4000-8000-0000000e5a00'),
          array[0, 0], 'both copies start with a group total of 0');

-- 同じコミュニティに、同じ投稿の生きている行は1つだけ。
select throws_ok(
  $$insert into public.posts(id, author_id, body, x, y, cluster_id, vec, vec_c, community_id, share_group)
    values ('00000000-0000-4000-8000-0000000e5a02', 'e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e501', 'みんなで朝ラン', 2, 2, 0,
            array_fill(1.0, array[448])::vector(448), array_fill(1.0, array[448])::vector(448),
            (select a from sc), '00000000-0000-4000-8000-0000000e5a00')$$,
  '23505', null, 'a second live copy in the same community is refused');

-- 3. a_only が A に参加 → 両方の合計が 1。
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e502","role":"authenticated"}';
select lives_ok($$insert into public.reactions(post_id, actor_id, kind)
                   values ('00000000-0000-4000-8000-0000000e5a01', 'e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e502', 'join')$$,
                'a_only joins the copy in A');
select is((select share_group from public.posts where id = '00000000-0000-4000-8000-0000000e5a01'),
          '00000000-0000-4000-8000-0000000e5a00'::uuid, 'a member reads the share_group of a post of A');
select is((select group_join_count from public.posts where id = '00000000-0000-4000-8000-0000000e5a01'),
          1, 'a member reads the group total');
select is((select count(*)::int from public.posts where share_group = '00000000-0000-4000-8000-0000000e5a00'),
          1, 'but not the copy in B (not a member of B)');
select is((select group_join_count from public.community_map_posts((select a from sc), -100, -100, 100, 100)
            where id = '00000000-0000-4000-8000-0000000e5a01'),
          1, 'the map of A answers the group total too');

reset role;
select is((select array_agg(group_join_count order by id) from public.posts
            where share_group = '00000000-0000-4000-8000-0000000e5a00'),
          array[1, 1], 'both copies count the join in A');
select is((select join_count from public.posts where id = '00000000-0000-4000-8000-0000000e5b01'),
          0, 'the copy in B keeps its own join count');

-- 4. ab が B に参加 → 合計 2（先着2人に達する）。
set local role authenticated;
set local request.jwt.claims to '{"sub":"e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e503","role":"authenticated"}';
select lives_ok($$insert into public.reactions(post_id, actor_id, kind)
                   values ('00000000-0000-4000-8000-0000000e5b01', 'e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e503', 'join')$$,
                'ab joins the copy in B');
-- ab は A にも参加できる（仲間にすでに参加しているので、人数は増えない）。
select lives_ok($$insert into public.reactions(post_id, actor_id, kind)
                   values ('00000000-0000-4000-8000-0000000e5a01', 'e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e503', 'join')$$,
                'ab also joins the copy in A although it is full: one person, counted once');
select is((select recruit_closed from public.community_map_posts((select b from sc), -100, -100, 100, 100)
            where id = '00000000-0000-4000-8000-0000000e5b01'),
          'full', 'the map of B says full: one in A and one in B make two');

reset role;
select is((select array_agg(group_join_count order by id) from public.posts
            where share_group = '00000000-0000-4000-8000-0000000e5a00'),
          array[2, 2], 'a person in both copies is counted once');
select is((select array_agg(join_count order by id) from public.posts
            where share_group = '00000000-0000-4000-8000-0000000e5a00'),
          array[2, 1], 'each copy still counts its own joins');

-- 5. b_only は B に参加できない（合計で満員）。
set local role authenticated;
set local request.jwt.claims to '{"sub":"e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e504","role":"authenticated"}';
select throws_ok($$insert into public.reactions(post_id, actor_id, kind)
                    values ('00000000-0000-4000-8000-0000000e5b01', 'e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e504', 'join')$$,
                 'P0001', 'recruit_full', 'b_only cannot join in B: the places were taken in A and B together');

-- 6. a_only が取り消す → 合計 1 → b_only が参加できる。
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e502","role":"authenticated"}';
select lives_ok($$delete from public.reactions
                   where post_id = '00000000-0000-4000-8000-0000000e5a01'
                     and actor_id = 'e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e502' and kind = 'join'$$,
                'a_only withdraws');
reset role;
select is((select group_join_count from public.posts where id = '00000000-0000-4000-8000-0000000e5b01'),
          1, 'the copy in B sees the place come free');
set local role authenticated;
set local request.jwt.claims to '{"sub":"e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e504","role":"authenticated"}';
select lives_ok($$insert into public.reactions(post_id, actor_id, kind)
                   values ('00000000-0000-4000-8000-0000000e5b01', 'e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e504', 'join')$$,
                'b_only now joins in B');
set local request.jwt.claims to '{"sub":"e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e505","role":"authenticated"}';
select throws_ok($$insert into public.reactions(post_id, actor_id, kind)
                    values ('00000000-0000-4000-8000-0000000e5b01', 'e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e505', 'join')$$,
                 'P0001', 'recruit_full', 'b_two cannot: full again');

-- 7. A の分だけ外す（消す）→ B の合計は B に参加した人だけ（ab, b_only）、消した行は合計を持たない。
reset role;
update public.posts set deleted_at = now() where id = '00000000-0000-4000-8000-0000000e5a01';
select is((select group_join_count from public.posts where id = '00000000-0000-4000-8000-0000000e5b01'),
          2, 'after A is taken out, B counts the people who joined in B');
select is((select group_join_count from public.posts where id = '00000000-0000-4000-8000-0000000e5a01'),
          null, 'the removed copy keeps no group total');
-- 外したあとなら、A にもう一度出せる（一意なのは生きている行だけ）。
select lives_ok(
  $$insert into public.posts(id, author_id, body, x, y, cluster_id, vec, vec_c, community_id, share_group)
    values ('00000000-0000-4000-8000-0000000e5a03', 'e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e501', 'みんなで朝ラン', 2, 2, 0,
            array_fill(1.0, array[448])::vector(448), array_fill(1.0, array[448])::vector(448),
            (select a from sc), '00000000-0000-4000-8000-0000000e5a00')$$,
  'a removed copy can be shared to the same community again');
select is((select group_join_count from public.posts where id = '00000000-0000-4000-8000-0000000e5a03'),
          2, 'and the new copy starts from the group total');

-- 8. ログインしていない人は share_group を読めない（posts そのものが読めない）。
set local role anon;
set local request.jwt.claims to '{"role":"anon"}';
select throws_ok($$select share_group from public.posts$$, '42501', null, 'anon: share_group cannot be read');
reset role;

-- 9. 運営が写した投稿をつなぐ文（移行の 5.）: 同じ人・同じ本文・同じ書いた日時で、別々のコミュニティに1つずつ。
insert into public.posts(id, author_id, body, x, y, cluster_id, vec, vec_c, community_id, created_at)
select v.id::uuid, 'e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e501', v.body, 3, 3, 0,
       array_fill(1.0, array[448])::vector(448), array_fill(1.0, array[448])::vector(448),
       v.cid, '2026-10-20 12:00:00+09'::timestamptz
  from (values ('00000000-0000-4000-8000-0000000e5c01', 'コピーした投稿', (select a from sc)),
               ('00000000-0000-4000-8000-0000000e5c02', 'コピーした投稿', (select b from sc)),
               ('00000000-0000-4000-8000-0000000e5d01', '同じコミュニティに2つ', (select a from sc)),
               ('00000000-0000-4000-8000-0000000e5d02', '同じコミュニティに2つ', (select a from sc))) v(id, body, cid);
with pairs as (
  select (array_agg(p.id order by p.id))[1] as gid,
         array_agg(p.id) as ids
    from public.posts p
   where p.deleted_at is null and p.community_id is not null
   group by p.author_id, p.body, p.created_at
  having count(*) > 1
     and count(*) = count(distinct p.community_id)
     and count(p.share_group) = 0
)
update public.posts p
   set share_group = pairs.gid
  from pairs
 where p.id = any(pairs.ids);
select is((select array_agg(share_group order by id) from public.posts
            where id in ('00000000-0000-4000-8000-0000000e5c01', '00000000-0000-4000-8000-0000000e5c02')),
          array['00000000-0000-4000-8000-0000000e5c01'::uuid, '00000000-0000-4000-8000-0000000e5c01'::uuid],
          'the copy and its original are joined under the smaller id');
select is((select array_agg(group_join_count order by id) from public.posts
            where id in ('00000000-0000-4000-8000-0000000e5c01', '00000000-0000-4000-8000-0000000e5c02')),
          array[0, 0], 'and get a group total');
select is((select count(share_group)::int from public.posts
            where id in ('00000000-0000-4000-8000-0000000e5d01', '00000000-0000-4000-8000-0000000e5d02')),
          0, 'two in the same community are left alone');

select * from finish();
rollback;
