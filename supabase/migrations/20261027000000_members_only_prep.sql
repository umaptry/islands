-- 2026-10-27: 「コミュニティの投稿はそのメンバーだけが読める」の準備（足すだけ。FILE 1 / 2）。
--
-- この SQL は **今の動きを何も変えない**。新しい関数・列・索引・設定を足すだけで、今の本番のコード（main）は
-- そのまま動く。締める本体は 20261027010000_members_only_lockdown.sql（FILE 2）。
--
--   * app_settings.members_only   Python 側の門のスイッチ。ここでは false（=今までどおり）で作る。
--                                 FILE 2 が同じ transaction の最後で true にする。
--   * is_member_of_post(pid)      「その投稿のコミュニティに、いま入っているか」。メンバーかどうかだけ（投稿者かどうかは
--                                 見ない）。コメント・反応・通報・書き込み全部の基準。消された投稿は false。
--   * is_member_of_post_any(pid)  同じだが、消された投稿でも「そのコミュニティの人なら true」。通知の行を残すためだけに使う。
--   * in_community(uid, cid)      uid が cid に入っているか。DM／「話してみたい」の関数が中で使う。外からは呼べない。
--   * 索引                        コミュニティ単位の読みが遅くならないように。
--   * nearest_posts / nearest_to_vector / account_post_centroids
--                                 末尾に p_community uuid default null を足して作り直す（古い署名は消す＝1つだけ残る）。
--                                 今のコード（引数2〜3個）は default で同じ関数に届く。null のあいだは今までどおり全投稿が相手
--                                 （FILE 2 が null なら 0 件に替える）。呼べるのは service_role だけ。
--   * map_posts_for_community     サーバー専用の地図読み。Python のプレビューが使う（FILE 2 のあと map_posts は
--                                 ログイン中のメンバーの JWT がないと 0 件になるため）。null なら 0 件。
--   * post_terms / pair_similarity / energy_cell_apply
--                                 anon・authenticated から呼べないことを明示する（Supabase は新しい関数に既定で execute を付ける）。
--   * notifications / islands_state / island_events に community_id（null 可）を足す。Python が新しく書く行に入れる。
--
-- 出す順番: ① この SQL → ② コード（スイッチは false のまま、何も変わらない）→ ③ FILE 2。
-- FILE 2 のあとに、もう一度この SQL を流しても、FILE 2 が入れた関数の中身は戻らない（署名があれば作り直さない）。
begin;
-- 長く待たない: 他の処理に鍵を取られていたら、3秒で諦めて何も変えずに終わる（55P03 / 40P01 なら少し待ってもう一度流す）。
set local lock_timeout = '3s';
set local statement_timeout = '120s';

-- ===========================================================================
-- 1. スイッチ（最初は false = 今までどおり）
-- ===========================================================================
insert into public.app_settings (key, value) values ('members_only', 'false'::jsonb)
on conflict (key) do nothing;

-- ===========================================================================
-- 2. 判定の関数
-- ===========================================================================
-- auth.uid() を (select ...) で包んで、行ごとに呼ばれないようにする。署名と権限は変えない。
create or replace function public.my_community_ids()
returns setof uuid
language sql stable security definer set search_path = public as $$
  select m.community_id from public.community_members m where m.account_id = (select auth.uid())
$$;

-- 投稿者かどうかは見ない（メンバーだけ）。「抜けた人が自分の投稿を種にして読み続ける」穴を作らないため、
-- 自分の投稿の行を読む権利は posts_read の中だけに書く（FILE 2）。
create or replace function public.is_member_of_post(pid uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.posts p
                  where p.id = pid and p.deleted_at is null
                    and p.community_id in (select public.my_community_ids()))
$$;

-- 消された投稿でも、そのコミュニティのメンバーなら true（通知の行を残すため。投稿の中身は返さない）。
create or replace function public.is_member_of_post_any(pid uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.posts p
                  where p.id = pid
                    and p.community_id in (select public.my_community_ids()))
$$;

create or replace function public.in_community(uid uuid, cid uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select uid is not null and cid is not null
     and exists (select 1 from public.community_members m
                  where m.community_id = cid and m.account_id = uid)
$$;

revoke all on function public.is_member_of_post(uuid)     from public, anon;
revoke all on function public.is_member_of_post_any(uuid) from public, anon;
grant execute on function public.is_member_of_post(uuid)     to authenticated;
grant execute on function public.is_member_of_post_any(uuid) to authenticated;
revoke all on function public.in_community(uuid, uuid) from public, anon, authenticated;

-- ===========================================================================
-- 3. 索引
-- ===========================================================================
create index if not exists posts_community_live_idx
  on public.posts (community_id, created_at desc) where deleted_at is null;
create index if not exists posts_community_xy_idx
  on public.posts (community_id, x, y) where deleted_at is null;
-- comments(post_id, created_at) と reactions(post_id, ...) の索引は初期の SQL にある。

-- ===========================================================================
-- 4. community_id を持つ派生データ（足すだけ。古いコードは読まない・書かない）
-- ===========================================================================
alter table public.notifications
  add column if not exists community_id uuid references public.communities (id) on delete cascade;
alter table public.islands_state
  add column if not exists community_id uuid references public.communities (id) on delete cascade;
alter table public.island_events
  add column if not exists community_id uuid references public.communities (id) on delete cascade;
create index if not exists islands_state_community_idx on public.islands_state (community_id);
create index if not exists island_events_community_idx on public.island_events (community_id, created_at desc);

-- ===========================================================================
-- 5. サーバー専用の関数（署名の最後に p_community を足して作り直す）
-- ===========================================================================
-- 古い署名は消すので、名前ごとに関数は1つだけ残る（PGRST203 の「どちらか選べない」が起きない）。
-- 古い呼び方（from_post, k だけ など）は default で新しい関数に届く。
-- p_community があるときは、そのコミュニティの投稿だけを相手に、正確に並べ替える（HNSW の近似検索は
-- 絞り込みと相性が悪く、小さなコミュニティで件数が足りなくなるため）。
do $mo$
begin
  if to_regprocedure('public.nearest_posts(uuid,integer,uuid)') is null then
    drop function if exists public.nearest_posts(uuid, integer);
    execute $f$
      create function public.nearest_posts(from_post uuid, k integer default 24, p_community uuid default null)
      returns table (id uuid, cosine double precision)
      language plpgsql stable security definer set search_path = public as $body$
      #variable_conflict use_column
      begin
        if p_community is null then
          return query
            with origin as (select q.vec_c from public.posts q where q.id = from_post)
            select p.id, 1 - (p.vec_c <=> o.vec_c)
              from public.posts p, origin o
             where p.id <> from_post and p.deleted_at is null
             order by p.vec_c <=> o.vec_c
             limit least(greatest(k, 1), 100);
        else
          return query
            with origin as (select q.vec_c from public.posts q
                             where q.id = from_post and q.community_id = p_community),
                 pool as materialized (select q.id, q.vec_c from public.posts q
                                        where q.community_id = p_community and q.deleted_at is null
                                          and q.id <> from_post)
            select p.id, 1 - (p.vec_c <=> o.vec_c)
              from pool p, origin o
             order by p.vec_c <=> o.vec_c
             limit least(greatest(k, 1), 100);
        end if;
      end $body$
    $f$;
  end if;

  if to_regprocedure('public.nearest_to_vector(text,integer,uuid)') is null then
    drop function if exists public.nearest_to_vector(text, integer);
    execute $f$
      create function public.nearest_to_vector(origin text, k integer default 5, p_community uuid default null)
      returns table (id uuid, cosine double precision)
      language plpgsql stable security definer set search_path = public as $body$
      #variable_conflict use_column
      begin
        if p_community is null then
          return query
            select p.id, 1 - (p.vec_c <=> origin::vector(448))
              from public.posts p
             where p.deleted_at is null
             order by p.vec_c <=> origin::vector(448)
             limit least(greatest(k, 1), 100);
        else
          return query
            with pool as materialized (select q.id, q.vec_c from public.posts q
                                        where q.community_id = p_community and q.deleted_at is null)
            select p.id, 1 - (p.vec_c <=> origin::vector(448))
              from pool p
             order by p.vec_c <=> origin::vector(448)
             limit least(greatest(k, 1), 100);
        end if;
      end $body$
    $f$;
  end if;

  if to_regprocedure('public.account_post_centroids(uuid)') is null then
    drop function if exists public.account_post_centroids();
    execute $f$
      create function public.account_post_centroids(p_community uuid default null)
      returns table (author_id uuid, centroid text, post_count integer)
      language sql stable security definer set search_path = public as $body$
        select p.author_id, avg(p.vec_c)::text, count(*)::int
          from public.posts p
         where p.deleted_at is null
           and (account_post_centroids.p_community is null
                or p.community_id = account_post_centroids.p_community)
         group by p.author_id
      $body$
    $f$;
  end if;
end $mo$;

revoke all on function public.nearest_posts(uuid, integer, uuid)        from public, anon, authenticated;
revoke all on function public.nearest_to_vector(text, integer, uuid)    from public, anon, authenticated;
revoke all on function public.account_post_centroids(uuid)              from public, anon, authenticated;
grant execute on function public.nearest_posts(uuid, integer, uuid)     to service_role;
grant execute on function public.nearest_to_vector(text, integer, uuid) to service_role;
grant execute on function public.account_post_centroids(uuid)           to service_role;

-- 署名は同じ。権限だけ明示する（初期の SQL は public からしか外していなかった）。
revoke all on function public.pair_similarity(uuid, uuid) from public, anon, authenticated;
revoke all on function public.post_terms(uuid[])          from public, anon, authenticated;
revoke all on function public.interaction_events(timestamptz) from public, anon, authenticated;
revoke all on function public.profile_vectors()           from public, anon, authenticated;
revoke all on function public.energy_cell_apply(double precision, double precision, real, integer)
  from public, anon, authenticated;
grant execute on function public.pair_similarity(uuid, uuid) to service_role;
grant execute on function public.post_terms(uuid[])          to service_role;
grant execute on function public.interaction_events(timestamptz) to service_role;
grant execute on function public.profile_vectors()           to service_role;

-- 地図の読み（サーバー専用）。列は map_posts と同じ。p_community が null なら 0 件（最初から閉じている）。
create or replace function public.map_posts_for_community(
  p_community uuid,
  min_x double precision, min_y double precision,
  max_x double precision, max_y double precision,
  limit_n integer default 800
)
returns table (
  id uuid, author_id uuid, display_name text, icon_id text, avatar_path text,
  body text, tags text[], motivation smallint, image_path text,
  x double precision, y double precision, cluster_id smallint,
  like_count integer, help_count integer, join_count integer, comment_count integer,
  energy real, created_at timestamptz,
  prompt text, recruit_deadline date, recruit_capacity integer, recruit_closed text
)
language sql stable security definer set search_path = public as $$
  select p.id, p.author_id, a.display_name, a.icon_id, a.avatar_path,
         p.body, p.tags, p.motivation, p.image_path,
         p.x, p.y, p.cluster_id,
         p.like_count, p.help_count, p.join_count, p.comment_count,
         p.energy, p.created_at,
         p.prompt, p.recruit_deadline, p.recruit_capacity,
         public.post_recruit_closed(p.recruit_deadline, p.recruit_capacity, p.join_count)
    from public.posts p
    join public.accounts a on a.id = p.author_id
   where p_community is not null
     and p.deleted_at is null
     and p.community_id = p_community
     and point(p.x, p.y) <@ box(point(min_x, min_y), point(max_x, max_y))
   order by p.energy desc, p.created_at desc
   limit least(greatest(limit_n, 1), 2000);
$$;
revoke all on function public.map_posts_for_community(uuid, double precision, double precision,
                                                      double precision, double precision, integer)
  from public, anon, authenticated;
grant execute on function public.map_posts_for_community(uuid, double precision, double precision,
                                                         double precision, double precision, integer)
  to service_role;

commit;
