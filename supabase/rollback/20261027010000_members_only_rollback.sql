-- 戻し用: 20261027010000_members_only_lockdown.sql（FILE 2）を流す前の動きに戻す。
--
-- **supabase/migrations の外に置いている**（CLI は migrations の中のファイルを全部流してしまうため）。
-- 本番では Supabase の SQL エディタで、必要なときだけ流す。コードの出し直しはいらない:
-- 最後に app_settings.members_only を false にするので、Python の門も同じ瞬間に開く。
--
-- 戻すもの: posts / comments / reactions / reports / notifications / communities の policy と anon の権限、
-- 地図の関数（map_posts・community_map_posts・map_cells）、energy_cells / islands_state / island_events の policy、
-- nearest_posts / nearest_to_vector / account_post_centroids（null = 全投稿）、notification_feed、
-- 話してみたい・DM の関数、画像の一覧の policy、reactions_recruit_guard、posts.community_id の外部キー。
-- 戻さないもの: FILE 1 が足した関数・列・索引（足しただけで無害）、FILE 2 が消した古い島・通知（作り直される）。
--
-- 何度流しても壊れない。流したあと、もう一度締めるには FILE 2 を流し直す（FILE 2 も何度流しても壊れない）。
--
-- 2026-10-29 の 20261029000000_share_group.sql（ほかのコミュニティにも出す）のあとでも流せる: 地図の関数は返す列が
-- 変わったので、消してから作り直す（4.）。そのあとは「出す」機能が止まり（features.share は members_only が true の
-- ときだけ）、参加者募集中の先着人数は投稿ごとに数える。仲間の印（share_group）は残る。もう一度締めるときは
-- FILE 2 を流したあと、20261029000000_share_group.sql も流し直す（地図の関数と参加の安全装置が合計の版に戻る）。
begin;
-- 長く待たない: 他の処理に鍵を取られていたら、3秒で諦めて何も変えずに終わる（55P03 / 40P01 なら少し待ってもう一度流す）。
set local lock_timeout = '3s';
set local statement_timeout = '120s';

-- 1. posts
drop policy if exists posts_read on public.posts;
create policy posts_read on public.posts for select using (deleted_at is null);
grant select (id, author_id, body, tags, motivation, image_path, x, y, cluster_id,
              terms, like_count, help_count, join_count, comment_count, energy,
              created_at, updated_at, community_id, prompt, recruit_deadline, recruit_capacity)
  on public.posts to anon, authenticated;

-- 2. comments
drop policy if exists comments_read   on public.comments;
drop policy if exists comments_insert on public.comments;
drop policy if exists comments_update on public.comments;
create policy comments_read   on public.comments for select using (deleted_at is null);
create policy comments_insert on public.comments for insert to authenticated
  with check (auth.uid() = author_id);
create policy comments_update on public.comments for update to authenticated
  using (auth.uid() = author_id) with check (auth.uid() = author_id);
grant select on public.comments to anon, authenticated;

-- 3. reactions
drop policy if exists reactions_read   on public.reactions;
drop policy if exists reactions_insert on public.reactions;
create policy reactions_read   on public.reactions for select using (true);
create policy reactions_insert on public.reactions for insert to authenticated
  with check (auth.uid() = actor_id);
grant select on public.reactions to anon, authenticated;

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

-- 4. 地図の関数（20261029 のあとは返す列が1つ多いので、上書きではなく消してから作る。権限も付け直す）
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

create or replace function public.map_cells(
  min_x double precision, min_y double precision,
  max_x double precision, max_y double precision
)
returns table (cell_x integer, cell_y integer, sum_energy real, post_count integer)
language sql stable security definer set search_path = public as $$
  select c.cell_x, c.cell_y, c.sum_energy, c.post_count
    from public.energy_cells c
   where c.post_count > 0
     and c.cell_x between floor(min_x / 20.0)::int and floor(max_x / 20.0)::int
     and c.cell_y between floor(min_y / 20.0)::int and floor(max_y / 20.0)::int;
$$;

drop policy if exists energy_cells_read on public.energy_cells;
create policy energy_cells_read on public.energy_cells for select using (true);
grant select on public.energy_cells to anon, authenticated;
drop policy if exists islands_state_read on public.islands_state;
create policy islands_state_read on public.islands_state for select using (true);
grant select on public.islands_state to anon, authenticated;
drop policy if exists island_events_read on public.island_events;
create policy island_events_read on public.island_events for select using (true);
grant select on public.island_events to anon, authenticated;

-- 5. 検索の関数（null = 全投稿。service_role だけが呼べるのは変えない）
create or replace function public.nearest_posts(from_post uuid, k integer default 24, p_community uuid default null)
returns table (id uuid, cosine double precision)
language plpgsql stable security definer set search_path = public as $$
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
end $$;

create or replace function public.nearest_to_vector(origin text, k integer default 5, p_community uuid default null)
returns table (id uuid, cosine double precision)
language plpgsql stable security definer set search_path = public as $$
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
end $$;

create or replace function public.account_post_centroids(p_community uuid default null)
returns table (author_id uuid, centroid text, post_count integer)
language sql stable security definer set search_path = public as $$
  select p.author_id, avg(p.vec_c)::text, count(*)::int
    from public.posts p
   where p.deleted_at is null
     and (account_post_centroids.p_community is null
          or p.community_id = account_post_centroids.p_community)
   group by p.author_id
$$;

-- 6. 通知
drop policy if exists notifications_read on public.notifications;
create policy notifications_read on public.notifications for select to authenticated
  using (auth.uid() = recipient_id);

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

-- 7. コミュニティ・通報
drop policy if exists communities_read on public.communities;
create policy communities_read on public.communities for select using (true);
grant select on public.communities to anon, authenticated;

alter table public.posts drop constraint if exists posts_community_id_fkey;
alter table public.posts add constraint posts_community_id_fkey
  foreign key (community_id) references public.communities (id) on delete set null;

drop policy if exists reports_insert on public.reports;
create policy reports_insert on public.reports for insert to authenticated
  with check (auth.uid() = reporter_id);

-- 8. 話してみたい・DM
create or replace function public.talk_shared_event(a uuid, b uuid)
returns uuid
language sql stable security definer set search_path = public as $$
  select p.id
    from public.posts p
   where a is not null and b is not null
     and p.deleted_at is null
     and '参加者募集中' = any(p.tags)
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
    select p.id as event_id, p.author_id
      from public.posts p
     where auth.uid() is not null
       and p.deleted_at is null
       and '参加者募集中' = any(p.tags)
       and (p.author_id = auth.uid()
            or exists (select 1 from public.reactions r
                        where r.post_id = p.id and r.actor_id = auth.uid() and r.kind = 'join'))
  ), others as (
    select m.author_id as person from mine m
    union
    select r.actor_id from mine m
      join public.reactions r on r.post_id = m.event_id and r.kind = 'join'
  )
  select o.person
    from others o
   where o.person <> auth.uid()
     and not public.talk_blocked(auth.uid(), o.person)
$$;

create or replace function public.dm_room_list()
returns table (room_id uuid, other_id uuid, other_name text, other_icon_id text,
               other_avatar_path text, event_post_id uuid, event_excerpt text,
               last_body text, last_at timestamptz, blocked_by_me boolean,
               created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select r.id, o.id, o.display_name, o.icon_id, o.avatar_path,
         case when p.deleted_at is null then p.id end,
         case when p.deleted_at is null then left(p.body, 30) end,
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

-- 9. 画像の一覧
drop policy if exists post_images_read on storage.objects;
create policy post_images_read on storage.objects for select
  using (bucket_id = 'post-images');

-- 10. スイッチ（最後）
insert into public.app_settings (key, value) values ('members_only', 'false'::jsonb)
on conflict (key) do update set value = excluded.value;

commit;
