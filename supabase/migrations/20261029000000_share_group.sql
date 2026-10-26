-- 2026-10-29: 「ほかのコミュニティにも出す」（B案）。
--
-- 投稿はコミュニティごとに別の行のまま（いいね・メッセージ・参加はコミュニティごとに別。壁は崩さない）。
-- 「同じ投稿」の行どうしを posts.share_group（同じ uuid）でつなぐ。
--
--   * posts.share_group      同じ投稿の仲間の印。null = ほかのコミュニティには出していない。
--                            書くのはサーバー（service_role）だけ。読めるのはログインしている人（列の権限）。
--                            行そのものは今までどおり posts_read（メンバーのコミュニティの投稿と自分の投稿）で守る:
--                            ほかのコミュニティの仲間の行は、そのメンバーでなければ読めない。
--   * 1つのコミュニティに同じ投稿の生きている行は1つだけ（一意の索引）。
--   * posts.group_join_count 参加者募集中の先着人数を、仲間のすべてで数えるための人数（参加した人を重複なしで数える。
--                            両方のコミュニティに入っている人が両方に参加しても1人）。仲間のいない投稿は null。
--                            トリガーが保つ（参加・取り消し・仲間が増える・外れる・消える たびに数え直す）。
--   * reactions_recruit_guard 参加の受付終了の安全装置。仲間がいる投稿は、仲間の行をまとめて鍵をかけてから合計で判定する。
--                            すでに仲間のどれかに参加している人は、人数が増えないので通す。
--   * map_posts / community_map_posts  受付終了（recruit_closed）を合計で出し、group_join_count も返す
--                            （返す列が増えるので、作り直す。権限は今と同じ）。
--   * 運営のコピー（10/26 に SQL で別のコミュニティへ写した投稿）: 同じ人・同じ本文・同じ書いた日時で、別々のコミュニティに
--                            1つずつある生きている投稿を、仲間につなぐ（下の 6.）。
--
-- 足すだけの変更で、何度流しても壊れない。**今の本番のコード（main）は新しい列を読まず、書かない**のでそのまま動く:
-- posts の select は列を名前で並べている。map_posts / community_map_posts は返す列が1つ増えるだけ（古い画面は使わない）。
-- 出す順番: ① この SQL → ② コード。戻すときはコードだけ戻す（列・トリガーは残してよい）。
begin;
-- 長く待たない: 他の処理に鍵を取られていたら、3秒で諦めて何も変えずに終わる（55P03 / 40P01 なら少し待ってもう一度流す）。
set local lock_timeout = '3s';
set local statement_timeout = '120s';

-- ===========================================================================
-- 1. 列と索引
-- ===========================================================================
alter table public.posts add column if not exists share_group uuid;
alter table public.posts add column if not exists group_join_count integer;

create index if not exists posts_share_group_idx on public.posts (share_group)
  where share_group is not null;
-- 1つのコミュニティに、同じ投稿の生きている行は1つだけ（2回押しても2つにならない）。
create unique index if not exists posts_share_group_community_uidx
  on public.posts (share_group, community_id)
  where share_group is not null and deleted_at is null;

-- 読むのはログインしている人だけ（anon は members_only で posts を読めない。足さない）。書く権限は足さない。
grant select (share_group, group_join_count) on public.posts to authenticated;

-- ===========================================================================
-- 2. 仲間の合計（参加した人を重複なしで）
-- ===========================================================================
create or replace function public.post_group_joiners(g uuid)
returns integer
language sql stable security definer set search_path = public as $$
  select count(distinct r.actor_id)::int
    from public.reactions r
    join public.posts p on p.id = r.post_id
   where p.share_group = g and p.deleted_at is null and r.kind = 'join'
$$;
revoke all on function public.post_group_joiners(uuid) from public, anon, authenticated;

-- 参加の数・仲間の印・消した印が変わったら、その仲間の group_join_count を数え直す。
-- 中で書くのは group_join_count だけ（この trigger の列に入っていないので、また呼ばれることはない）。
create or replace function public.posts_share_group_sync()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  groups uuid[] := array[]::uuid[];
  g      uuid;
  total  integer;
begin
  if new.share_group is not null then
    groups := groups || new.share_group;
  end if;
  if tg_op = 'UPDATE' then
    if old.share_group is not null and old.share_group is distinct from new.share_group then
      groups := groups || old.share_group;
    end if;
  end if;
  foreach g in array groups loop
    total := public.post_group_joiners(g);
    update public.posts set group_join_count = total
     where share_group = g and deleted_at is null
       and group_join_count is distinct from total;
  end loop;
  -- 仲間のいない行・消えた行は、合計を持たない。
  if (new.share_group is null or new.deleted_at is not null) and new.group_join_count is not null then
    update public.posts set group_join_count = null where id = new.id;
  end if;
  return null;
end $$;
revoke all on function public.posts_share_group_sync() from public, anon, authenticated;

drop trigger if exists posts_share_group_sync on public.posts;
create trigger posts_share_group_sync
  after insert or update of join_count, share_group, deleted_at on public.posts
  for each row execute function public.posts_share_group_sync();

-- ===========================================================================
-- 3. 参加の受付終了の安全装置（20261027010000 の版に、仲間の合計を足したもの）
-- ===========================================================================
-- メンバーでない人には、期限切れ・満員かどうかを教えず、ロックも取らずに素通りさせる（そのあと RLS が断る）。
-- 仲間がいる投稿は、仲間の生きている行を id の順にまとめて鍵をかける（2つのコミュニティで同時に押されても、
-- 先着人数を超えない。順番をそろえるので、お互いに待ち合って止まることもない）。
create or replace function public.reactions_recruit_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  deadline date;
  capacity integer;
  joins    integer;
  closed   text;
  grp      uuid;
begin
  if new.kind <> 'join' then
    return new;
  end if;
  if auth.uid() is not null and not public.is_member_of_post(new.post_id) then
    return new;
  end if;
  -- すでに参加している人の重複 insert は、ここでは断らない。
  if exists (select 1 from public.reactions r
              where r.post_id = new.post_id and r.actor_id = new.actor_id and r.kind = 'join') then
    return new;
  end if;
  select p.share_group into grp from public.posts p where p.id = new.post_id;
  if not found then
    return new;
  end if;
  if grp is null then
    select p.recruit_deadline, p.recruit_capacity, p.join_count
      into deadline, capacity, joins
      from public.posts p
     where p.id = new.post_id
       for update;
    if not found then
      return new;
    end if;
  else
    perform 1 from public.posts q
      where q.share_group = grp and q.deleted_at is null
      order by q.id
        for update;
    select p.recruit_deadline, p.recruit_capacity into deadline, capacity
      from public.posts p where p.id = new.post_id;
    -- 仲間のどれかにすでに参加している人は、人数が増えないので先着人数では断らない（申込期限は確かめる）。
    if exists (select 1 from public.reactions r
                 join public.posts q on q.id = r.post_id
                where q.share_group = grp and q.deleted_at is null
                  and r.actor_id = new.actor_id and r.kind = 'join') then
      capacity := null;
    end if;
    joins := public.post_group_joiners(grp);
  end if;
  closed := public.post_recruit_closed(deadline, capacity, joins);
  if closed = 'deadline' then
    raise exception 'recruit_closed' using errcode = 'P0001', hint = '申込期限を過ぎています';
  elsif closed = 'full' then
    raise exception 'recruit_full' using errcode = 'P0001', hint = '先着人数に達しています';
  end if;
  return new;
end;
$$;
revoke all on function public.reactions_recruit_guard() from public, anon, authenticated;

-- 参加の取り消し（DELETE）も、仲間がいる投稿なら、参加と同じ順番（id の順）で仲間の行に先に鍵をかける。
-- （かけないと、取り消しは自分の行→仲間の行の順で鍵を取るので、別のコミュニティで同時に押された参加・取り消しと
-- お互いに待ち合い、片方が 40P01 で失敗する。数が狂うことはないが、押した人には失敗に見える。）
create or replace function public.reactions_share_lock()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  grp uuid;
begin
  if old.kind <> 'join' then
    return old;
  end if;
  select p.share_group into grp from public.posts p where p.id = old.post_id;
  if grp is not null then
    perform 1 from public.posts q
      where q.share_group = grp and q.deleted_at is null
      order by q.id
        for update;
  end if;
  return old;
end $$;
revoke all on function public.reactions_share_lock() from public, anon, authenticated;

drop trigger if exists reactions_share_lock on public.reactions;
create trigger reactions_share_lock before delete on public.reactions
  for each row execute function public.reactions_share_lock();

-- ===========================================================================
-- 4. 地図の関数（20261027010000 の版に group_join_count を足し、受付終了を合計で出す）
-- ===========================================================================
-- 返す列が増えるので、create or replace ではなく作り直す（1つの transaction の中なので、途中の姿は誰にも見えない）。
drop function if exists public.community_map_posts(uuid, double precision, double precision,
                                                   double precision, double precision, integer);
create function public.community_map_posts(
  community uuid,
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
  prompt text, recruit_deadline date, recruit_capacity integer, recruit_closed text,
  group_join_count integer
)
language sql stable security definer set search_path = public as $$
  select p.id, p.author_id, a.display_name, a.icon_id, a.avatar_path,
         p.body, p.tags, p.motivation, p.image_path,
         p.x, p.y, p.cluster_id,
         p.like_count, p.help_count, p.join_count, p.comment_count,
         p.energy, p.created_at,
         p.prompt, p.recruit_deadline, p.recruit_capacity,
         public.post_recruit_closed(p.recruit_deadline, p.recruit_capacity,
                                    coalesce(p.group_join_count, p.join_count)),
         p.group_join_count
    from public.posts p
    join public.accounts a on a.id = p.author_id
   where p.deleted_at is null
     and p.community_id = community_map_posts.community
     and p.community_id in (select public.my_community_ids())
     and point(p.x, p.y) <@ box(point(min_x, min_y), point(max_x, max_y))
   order by p.energy desc, p.created_at desc
   limit least(greatest(limit_n, 1), 2000);
$$;
revoke all on function public.community_map_posts(uuid, double precision, double precision,
                                                  double precision, double precision, integer)
  from public;
grant execute on function public.community_map_posts(uuid, double precision, double precision,
                                                     double precision, double precision, integer)
  to anon, authenticated, service_role;

drop function if exists public.map_posts(double precision, double precision,
                                         double precision, double precision, integer);
create function public.map_posts(
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
  prompt text, recruit_deadline date, recruit_capacity integer, recruit_closed text,
  group_join_count integer
)
language sql stable security definer set search_path = public as $$
  select p.id, p.author_id, a.display_name, a.icon_id, a.avatar_path,
         p.body, p.tags, p.motivation, p.image_path,
         p.x, p.y, p.cluster_id,
         p.like_count, p.help_count, p.join_count, p.comment_count,
         p.energy, p.created_at,
         p.prompt, p.recruit_deadline, p.recruit_capacity,
         public.post_recruit_closed(p.recruit_deadline, p.recruit_capacity,
                                    coalesce(p.group_join_count, p.join_count)),
         p.group_join_count
    from public.posts p
    join public.accounts a on a.id = p.author_id
   where p.deleted_at is null
     and p.community_id in (select public.my_community_ids())
     and point(p.x, p.y) <@ box(point(min_x, min_y), point(max_x, max_y))
   order by p.energy desc, p.created_at desc
   limit least(greatest(limit_n, 1), 2000);
$$;
revoke all on function public.map_posts(double precision, double precision,
                                        double precision, double precision, integer)
  from public;
grant execute on function public.map_posts(double precision, double precision,
                                           double precision, double precision, integer)
  to anon, authenticated, service_role;

-- ===========================================================================
-- 5. 運営が SQL で写した投稿を仲間につなぐ
-- ===========================================================================
-- 同じ人・同じ本文・同じ書いた日時の生きている投稿が、別々のコミュニティに1つずつある組だけ（同じコミュニティに
-- 2つあるもの、どれかがすでに仲間を持つものはつながない）。仲間の印は、組の中でいちばん小さい id。
-- share_group を書くと 2. のトリガーが group_join_count を数える。何度流しても、2回目は何もしない。
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

commit;
