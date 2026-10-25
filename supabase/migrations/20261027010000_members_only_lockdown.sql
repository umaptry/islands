-- 2026-10-27: コミュニティの投稿は、そのコミュニティのメンバーだけが読める（締める本体。FILE 2）。
--
-- 先に 20261027000000_members_only_prep.sql（FILE 1）を流し、コード（スイッチ members_only = false のまま）を
-- 出してから、これを流す。**1つの transaction で、いちばん最後に app_settings.members_only を true にする**ので、
-- DB の鍵と Python の門が同じ瞬間に閉まる。戻すときは supabase/rollback/20261027010000_members_only_rollback.sql
-- （今の動きに戻し、members_only を false にする。コードの出し直しはいらない）。
--
-- 守りたいこと: コミュニティに属する投稿は、そのメンバーだけが、どの経路でも読めない:
--   ログインしていない人・メンバーでない人は、表（PostgREST）・関数（RPC）・Realtime・画像の一覧から。
--   抜けた人は「自分の投稿の行」だけ読める・直せる（自分のページ）。そのコミュニティの他のもの
--   （他人の投稿、コメント、反応、通知、近くの投稿）は読めない。
--   community_id が null の投稿は、書いた本人にだけ見える（null を公開扱いにしない）。
--
-- 判定は2つだけ（prep の関数）:
--   * posts_read だけが「自分の投稿の行」の例外を持つ（author_id = 自分）。
--   * それ以外（コメント・反応・通報・書き込み・通知・話してみたい）は is_member_of_post = メンバーであること。
--
-- 画像: 第1段では「一覧」を自分のフォルダだけに絞る。URL を知っている人は開ける（公開の入れ物のまま。
-- 非公開の入れ物は後日）。
--
-- ここでは変えないもの（古い画面でエラーにならないよう、空を返すだけにする）: map_cells / energy_cells /
-- islands_state / island_events は取り上げずに 0 件にする。取り上げるのは古い画面が無くなってから。
--
-- 何度流しても壊れない（policy は作り直し、関数は create or replace）。
begin;
-- 長く待たない: 他の処理に鍵を取られていたら、3秒で諦めて何も変えずに終わる（55P03 / 40P01 なら少し待ってもう一度流す）。
set local lock_timeout = '3s';
set local statement_timeout = '120s';

-- ===========================================================================
-- 0. 流してよいか: community_id が null の投稿が残っていると、その投稿は本人以外の誰にも見えなくなる。
--    古いコードが書いた投稿を、先に BAR（最初のコミュニティ）へ移す。
-- ===========================================================================
do $mo$
declare
  orphans integer;
begin
  select count(*) into orphans from public.posts where community_id is null and deleted_at is null;
  if orphans > 0 then
    raise exception 'members_only: community_id が null の投稿が % 件あります。先に最初のコミュニティへ移してから流してください（20261026010000 の④の update）。', orphans
      using errcode = 'P0001';
  end if;
end $mo$;

-- ===========================================================================
-- 1. posts: ログインしている人だけ。メンバーのコミュニティの投稿と、自分の投稿。
-- ===========================================================================
drop policy if exists posts_read on public.posts;
create policy posts_read on public.posts for select to authenticated
  using (deleted_at is null
         and (community_id in (select public.my_community_ids())
              or author_id = (select auth.uid())));

-- anon は表も列も読めない（あとから足された community_id / prompt / recruit_* も含めて全部）。
revoke select on public.posts from anon;
do $mo$
declare
  c record;
begin
  for c in select column_name from information_schema.columns
            where table_schema = 'public' and table_name = 'posts' loop
    execute format('revoke select (%I) on public.posts from anon', c.column_name);
  end loop;
end $mo$;
-- authenticated の列の権限はそのまま（vec / vec_c / deleted_at は元から無い）。
-- 書く権限（update(community_id) など）は足さない。

-- ===========================================================================
-- 2. comments
-- ===========================================================================
drop policy if exists comments_read   on public.comments;
drop policy if exists comments_insert on public.comments;
drop policy if exists comments_update on public.comments;
create policy comments_read on public.comments for select to authenticated
  using (deleted_at is null and public.is_member_of_post(post_id));
create policy comments_insert on public.comments for insert to authenticated
  with check ((select auth.uid()) = author_id and public.is_member_of_post(post_id));
create policy comments_update on public.comments for update to authenticated
  using ((select auth.uid()) = author_id and public.is_member_of_post(post_id))
  with check ((select auth.uid()) = author_id and public.is_member_of_post(post_id));
revoke select on public.comments from anon;

-- ===========================================================================
-- 3. reactions
-- ===========================================================================
-- 自分の行は常に読める: 取り消しの DELETE ... WHERE post_id=.. and actor_id=自分 は、WHERE で列を読むので
-- select の policy も通る必要がある（通らないと、抜けた人の取り消しが黙って 0 行になり、参加の数が残る）。
drop policy if exists reactions_read   on public.reactions;
drop policy if exists reactions_insert on public.reactions;
create policy reactions_read on public.reactions for select to authenticated
  using (actor_id = (select auth.uid()) or public.is_member_of_post(post_id));
create policy reactions_insert on public.reactions for insert to authenticated
  with check (actor_id = (select auth.uid()) and public.is_member_of_post(post_id));
-- reactions_delete は今のまま（自分の行だけ）。
revoke select on public.reactions from anon;

-- 参加の受付終了の安全装置は、RLS の WITH CHECK より先に動き、投稿の行を for update で読む。
-- メンバーでない人には、期限切れ・満員かどうかを教えず、ロックも取らずに素通りさせる
-- （そのあと RLS が、存在しない投稿と同じ 42501 で断る）。auth.uid() が null（サーバーのキー・SQL エディタ）
-- のときは今までどおり確かめる。
create or replace function public.reactions_recruit_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  deadline date;
  capacity integer;
  joins integer;
  closed text;
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
  select p.recruit_deadline, p.recruit_capacity, p.join_count
    into deadline, capacity, joins
    from public.posts p
   where p.id = new.post_id
     for update;
  if not found then
    return new;
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

-- ===========================================================================
-- 4. 地図の関数（署名と権限は今のまま。古い画面でもエラーにならず、メンバーでなければ空）
-- ===========================================================================
create or replace function public.community_map_posts(
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
   where p.deleted_at is null
     and p.community_id = community_map_posts.community
     and p.community_id in (select public.my_community_ids())
     and point(p.x, p.y) <@ box(point(min_x, min_y), point(max_x, max_y))
   order by p.energy desc, p.created_at desc
   limit least(greatest(limit_n, 1), 2000);
$$;

-- 全コミュニティ版: 自分が入っているコミュニティの投稿だけ。
create or replace function public.map_posts(
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
   where p.deleted_at is null
     and p.community_id in (select public.my_community_ids())
     and point(p.x, p.y) <@ box(point(min_x, min_y), point(max_x, max_y))
   order by p.energy desc, p.created_at desc
   limit least(greatest(limit_n, 1), 2000);
$$;

-- 全体を集めた表（光の強さ・島）は、コミュニティを混ぜた値なので、中身を返さない。
-- 0 件を返す（古い画面が 42501 のエラーにならないように）。コミュニティごとに作り直すのは次の段。
create or replace function public.map_cells(
  min_x double precision, min_y double precision,
  max_x double precision, max_y double precision
)
returns table (cell_x integer, cell_y integer, sum_energy real, post_count integer)
language sql stable security definer set search_path = public as $$
  select c.cell_x, c.cell_y, c.sum_energy, c.post_count
    from public.energy_cells c
   where false
$$;

drop policy if exists energy_cells_read on public.energy_cells;
create policy energy_cells_read on public.energy_cells for select to authenticated using (false);
revoke select on public.energy_cells from anon;

drop policy if exists islands_state_read on public.islands_state;
create policy islands_state_read on public.islands_state for select to authenticated using (false);
revoke select on public.islands_state from anon;

drop policy if exists island_events_read on public.island_events;
create policy island_events_read on public.island_events for select to authenticated using (false);
revoke select on public.island_events from anon;

-- 3つの検索の関数: コミュニティを指定しない（null）呼び方は 0 件にする（混ざった世界を返さない）。
-- 署名と権限（service_role だけ）は prep のまま。
create or replace function public.nearest_posts(from_post uuid, k integer default 24, p_community uuid default null)
returns table (id uuid, cosine double precision)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  if p_community is null then
    return;
  end if;
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
end $$;

create or replace function public.nearest_to_vector(origin text, k integer default 5, p_community uuid default null)
returns table (id uuid, cosine double precision)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  if p_community is null then
    return;
  end if;
  return query
    with pool as materialized (select q.id, q.vec_c from public.posts q
                                where q.community_id = p_community and q.deleted_at is null)
    select p.id, 1 - (p.vec_c <=> origin::vector(448))
      from pool p
     order by p.vec_c <=> origin::vector(448)
     limit least(greatest(k, 1), 100);
end $$;

create or replace function public.account_post_centroids(p_community uuid default null)
returns table (author_id uuid, centroid text, post_count integer)
language sql stable security definer set search_path = public as $$
  select p.author_id, avg(p.vec_c)::text, count(*)::int
    from public.posts p
   where p.deleted_at is null
     and account_post_centroids.p_community is not null
     and p.community_id = account_post_centroids.p_community
   group by p.author_id
$$;

-- ===========================================================================
-- 5. 通知
-- ===========================================================================
-- 古い（コミュニティを知らなかった）島・似た投稿の通知と記録の始末。一番投稿の多いコミュニティ（BAR）のものとして残す。
-- どのコミュニティのものか: 投稿がいちばん多い（生きている）コミュニティ。同数なら slug 'bar'、それも無ければ最初のもの。
-- コミュニティがいくつあっても、古い行を消さずに残す（島の名前・履歴を失わない）。コミュニティが1つも無いときだけ消える。
create temp table _mo_legacy_owner on commit drop as
  select c.id from public.communities c
   order by (select count(*) from public.posts p where p.community_id = c.id and p.deleted_at is null) desc,
            (c.slug = 'bar') desc, c.created_at, c.id
   limit 1;
update public.islands_state set community_id = (select id from _mo_legacy_owner) where community_id is null;
update public.island_events set community_id = (select id from _mo_legacy_owner) where community_id is null;
update public.notifications set community_id = (select id from _mo_legacy_owner)
 where community_id is null and post_id is null and type in ('island', 'quiet_post', 'similar');
delete from public.island_events where community_id is null;
delete from public.islands_state where community_id is null;
delete from public.notifications
 where community_id is null and post_id is null and type in ('island', 'quiet_post', 'similar');

-- 読めるのは: 自分宛て、かつ、投稿つきなら（消された投稿でも）そのコミュニティのメンバー、かつ、
-- コミュニティつきならそのメンバー。投稿も community_id も無い通知（DM・話してみたい）は今までどおり。
drop policy if exists notifications_read on public.notifications;
create policy notifications_read on public.notifications for select to authenticated
  using ((select auth.uid()) = recipient_id
         and (post_id is null or public.is_member_of_post_any(post_id))
         and (community_id is null or community_id in (select public.my_community_ids()))
         -- 島・静かな投稿・似た投稿の通知は community_id が必須（古い画面・インスタンスが書いた無印の行は読めない）
         and (type not in ('island', 'quiet_post', 'similar') or community_id is not null));
-- notifications_update（既読にする）は recipient_id だけで、今のまま。

-- notification_feed は security definer（RLS を通らない）ので、同じ絞り込みを中に書く。
create or replace function public.notification_feed(limit_n integer default 50)
returns table (id uuid, type text, category text, post_id uuid, comment_id uuid,
               island_id uuid, event_id uuid, payload jsonb, actor_id uuid,
               others integer, created_at timestamptz, unread boolean, ids uuid[])
language sql stable security definer set search_path = public as $$
  with mine as (
    select n.*,
           case when n.type in ('like', 'help', 'join', 'talk_wish', 'talk_match') then 'reaction'
                when n.type in ('comment', 'reply', 'dm') then 'reply'
                when n.type = 'quiet_post' then 'similar'
                else n.type end as cat,
           n.type in ('like', 'help', 'join') as chainable
      from public.notifications n
     where n.recipient_id = auth.uid()
       and (n.post_id is null or public.is_member_of_post_any(n.post_id))
       and (n.community_id is null or n.community_id in (select public.my_community_ids()))
       and (n.type not in ('island', 'quiet_post', 'similar') or n.community_id is not null)
  ), chained as (
    select m.*,
           case when m.chainable
                 and lag(m.created_at) over w is not null
                 and m.created_at - lag(m.created_at) over w <= interval '10 minutes'
                then 0 else 1 end as starts
      from mine m
    window w as (partition by m.cat, m.post_id, m.chainable order by m.created_at)
  ), grouped as (
    select c.*,
           case when c.chainable
                then sum(c.starts) over (partition by c.cat, c.post_id, c.chainable order by c.created_at)
                else null end as chain,
           case when c.chainable then null else c.id end as solo
      from chained c
  )
  select (array_agg(g.id order by g.created_at desc))[1],
         (array_agg(g.type order by g.created_at desc))[1],
         g.cat,
         (array_agg(g.post_id order by g.created_at desc))[1],
         (array_agg(g.comment_id order by g.created_at desc))[1],
         (array_agg(g.island_id order by g.created_at desc))[1],
         (array_agg(g.event_id order by g.created_at desc))[1],
         (array_agg(g.payload order by g.created_at desc))[1],
         (array_agg(g.actor_id order by g.created_at desc))[1],
         greatest(count(distinct g.actor_id) - 1, 0)::int,
         max(g.created_at),
         bool_or(g.read_at is null),
         array_agg(g.id order by g.created_at desc)
    from grouped g
   group by g.cat, g.post_id, g.chainable, g.chain, g.solo
   order by max(g.created_at) desc
   limit greatest(1, least(limit_n, 200))
$$;

-- ===========================================================================
-- 6. コミュニティ・通報
-- ===========================================================================
-- 名前も、入っている人にだけ。招待の画面は check_invite（名前だけを返す関数）を使う。
drop policy if exists communities_read on public.communities;
create policy communities_read on public.communities for select to authenticated
  using (id in (select public.my_community_ids()));
revoke select on public.communities from anon;

-- 投稿があるコミュニティは消せない（消すと投稿の community_id が null になり、本人以外から見えなくなる）。
do $fk$
begin
  -- すでに restrict なら触らない（流し直しのたびに全件の検証をしない）
  if not exists (select 1 from pg_constraint
                  where conname = 'posts_community_id_fkey' and conrelid = 'public.posts'::regclass and confdeltype = 'r') then
    alter table public.posts drop constraint if exists posts_community_id_fkey;
    alter table public.posts add constraint posts_community_id_fkey
      foreign key (community_id) references public.communities (id) on delete restrict;
  end if;
end $fk$;

-- 通報: 読めない投稿・コメントは、存在しない id と同じ 42501 で断る（外部キーのエラーで有無が分からないように）。
drop policy if exists reports_insert on public.reports;
create policy reports_insert on public.reports for insert to authenticated
  with check ((select auth.uid()) = reporter_id
              and (post_id is null or public.is_member_of_post(post_id))
              and (comment_id is null
                   or exists (select 1 from public.comments c
                               where c.id = comment_id and public.is_member_of_post(c.post_id))));

-- ===========================================================================
-- 7. 話してみたい・DM: 会の投稿のコミュニティに、2人とも入っていること
-- ===========================================================================
-- 既存の dm_rooms は消さない（コミュニティをまたいでいた組も部屋は残る）。会の抜粋が出なくなるだけ。
create or replace function public.talk_shared_event(a uuid, b uuid)
returns uuid
language sql stable security definer set search_path = public as $$
  select p.id
    from public.posts p
   where a is not null and b is not null
     and p.deleted_at is null
     and '参加者募集中' = any(p.tags)
     and public.in_community(a, p.community_id)
     and public.in_community(b, p.community_id)
     and (p.author_id = a
          or exists (select 1 from public.reactions r
                      where r.post_id = p.id and r.actor_id = a and r.kind = 'join'))
     and (p.author_id = b
          or exists (select 1 from public.reactions r
                      where r.post_id = p.id and r.actor_id = b and r.kind = 'join'))
   order by p.created_at desc, p.id
   limit 1
$$;

create or replace function public.talk_peers()
returns table (account_id uuid)
language sql stable security definer set search_path = public as $$
  with mine as (
    select p.id as event_id, p.author_id, p.community_id
      from public.posts p
     where auth.uid() is not null
       and p.deleted_at is null
       and '参加者募集中' = any(p.tags)
       and public.in_community(auth.uid(), p.community_id)
       and (p.author_id = auth.uid()
            or exists (select 1 from public.reactions r
                        where r.post_id = p.id and r.actor_id = auth.uid() and r.kind = 'join'))
  ), others as (
    select m.author_id as person, m.community_id from mine m
    union
    select r.actor_id, m.community_id from mine m
      join public.reactions r on r.post_id = m.event_id and r.kind = 'join'
  )
  select distinct o.person
    from others o
   where o.person <> auth.uid()
     and public.in_community(o.person, o.community_id)
     and not public.talk_blocked(auth.uid(), o.person)
$$;

create or replace function public.dm_room_list()
returns table (room_id uuid, other_id uuid, other_name text, other_icon_id text,
               other_avatar_path text, event_post_id uuid, event_excerpt text,
               last_body text, last_at timestamptz, blocked_by_me boolean,
               created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select r.id, o.id, o.display_name, o.icon_id, o.avatar_path,
         case when public.is_member_of_post(p.id) then p.id end,
         case when public.is_member_of_post(p.id) then left(p.body, 30) end,
         left(lm.body, 60), lm.created_at,
         exists (select 1 from public.dm_blocks k
                  where k.blocker_id = auth.uid() and k.blocked_id = o.id),
         r.created_at
    from public.dm_rooms r
    join public.accounts o
      on o.id = case when r.user_a = auth.uid() then r.user_b else r.user_a end
    left join public.posts p on p.id = r.event_post_id
    left join lateral (select mm.body, mm.created_at
                         from public.dm_messages mm
                        where mm.room_id = r.id
                        order by mm.created_at desc, mm.id desc
                        limit 1) lm on true
   where auth.uid() = r.user_a or auth.uid() = r.user_b
   order by coalesce(lm.created_at, r.created_at) desc
$$;

-- ===========================================================================
-- 8. 画像の一覧（storage）: 自分のフォルダだけ
-- ===========================================================================
-- ログインしただけの部外者にも、他人のフォルダの一覧が見えないようにする。アップロードは upsert しないので
-- select は要らない。URL を知っている人は開ける（公開の入れ物のまま。後日に非公開へ）。
drop policy if exists post_images_read on storage.objects;
create policy post_images_read on storage.objects for select to authenticated
  using (bucket_id = 'post-images'
         and (storage.foldername(name))[1] = (select auth.uid())::text);

-- ===========================================================================
-- 9. スイッチ（最後）
-- ===========================================================================
insert into public.app_settings (key, value) values ('members_only', 'true'::jsonb)
on conflict (key) do update set value = excluded.value;

commit;
