-- かさなり / islands — schema.
--
-- Run once in the Supabase SQL editor. Every statement is if-not-exists or
-- create-or-replace, so re-running it is safe.
--
-- SECURITY MODEL
-- --------------
-- The browser holds the anon key and, once signed in, a user JWT. RLS is what
-- keeps that safe, so every table below has RLS enabled AND policies written
-- for it. "RLS on, zero policies" was the old model, from when the browser held
-- no credential at all and one FastAPI process did every read and write with
-- service_role. That model does not survive real accounts, and it does not
-- scale: it puts a 2GiB container in front of every comment anybody reads.
--
-- Two things are still server-only, and they are the two that matter:
--
--   * INSERT on posts. A post's x/y/vec are the output of the frozen encoder.
--     Letting a client write them would let anyone put themselves anywhere on
--     the map, which is the one claim this app makes. There is no insert policy
--     for authenticated; only service_role (which bypasses RLS) can insert.
--   * SELECT on posts.vec / posts.vec_c. Column grants, not RLS - RLS cannot
--     narrow columns. The vectors never leave the server except through the
--     security-definer functions at the bottom, which return scores and never
--     the coordinates that produced them.

create extension if not exists pgcrypto;
create extension if not exists vector;

-- ---------------------------------------------------------------------------
-- 1. accounts — one row per auth.users row.
--
-- email lives in auth.users and is never copied here: this table is world
-- readable (you have to be able to see who wrote a post) and an email address
-- would be the one field on it that nobody agreed to publish.
-- ---------------------------------------------------------------------------
create table if not exists public.accounts (
  id            uuid primary key references auth.users (id) on delete cascade,
  display_name  text        not null check (length(display_name) between 1 and 16),
  affiliation   text        check (affiliation is null or length(affiliation) <= 32),
  bio           text        check (bio is null or length(bio) <= 300),
  link_url      text        check (link_url is null or length(link_url) <= 200),
  -- Index into web/js/avatars.js EMOJI. Kept as text because that is what the
  -- client has always sent and what the old icon_id column held.
  icon_id       text        not null default '0',
  -- Storage object path for an uploaded avatar. Null means use icon_id.
  avatar_path   text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 2. posts — islands' Post, standing on かさなり's coordinates.
--
-- body is 30..140 characters. 140 is islands' limit; 30 is the floor the
-- embedding needs to say anything (below it the sparse block is mostly empty
-- and two unrelated one-liners land on top of each other).
--
-- energy is islands' formula, generated rather than maintained: it can never
-- drift from the counts it is made of. islands used (likes + comments) * 5;
-- there are three reaction kinds here, so all three count.
-- ---------------------------------------------------------------------------
create table if not exists public.posts (
  id            uuid primary key default gen_random_uuid(),
  author_id     uuid not null references public.accounts (id) on delete cascade,
  body          text not null check (length(body) between 30 and 140),
  tags          text[] not null default '{}'::text[]
                  check (tags <@ array[
                    '気軽に話しかけて', '助けてほしい', '参加者募集中', '仲間募集中'
                  ]::text[]),
  motivation    smallint not null default 50 check (motivation between 0 and 100),
  image_path    text,

  -- Written by the server only. The frozen encoder's output.
  x             double precision not null,
  y             double precision not null,
  cluster_id    smallint not null,
  terms         jsonb not null default '[]'::jsonb,
  vec           vector(448) not null,
  vec_c         vector(448) not null,

  like_count    integer not null default 0,
  help_count    integer not null default 0,
  join_count    integer not null default 0,
  comment_count integer not null default 0,
  energy        real generated always as (
                  motivation
                  + (like_count + help_count + join_count + comment_count) * 5
                ) stored,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- Soft delete. A hard delete would cascade away comments other people wrote
  -- and reactions they gave, and those are their words, not the author's.
  deleted_at    timestamptz
);

create index if not exists posts_xy_idx     on public.posts using gist (point(x, y));
create index if not exists posts_author_idx on public.posts (author_id, created_at desc)
  where deleted_at is null;
create index if not exists posts_live_idx   on public.posts (created_at desc)
  where deleted_at is null;
-- Approximate nearest neighbour over the CENTRED vector. Plain cosine on vec_c
-- reproduces core.similarity.cosine_between(a, b, centroid) exactly, because
-- similarity_view returns a unit vector - so the index measures the same thing
-- the profile sheet prints.
create index if not exists posts_vec_c_idx  on public.posts
  using hnsw (vec_c vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- 3. reactions — islands' toggleLike / toggleHelp / toggleJoin.
--
-- The primary key IS the idempotency. Two taps racing each other both reach
-- PostgREST and the loser becomes a duplicate the client can ignore, rather
-- than a second row and a second notification.
-- ---------------------------------------------------------------------------
create table if not exists public.reactions (
  post_id    uuid not null references public.posts (id) on delete cascade,
  actor_id   uuid not null references public.accounts (id) on delete cascade,
  kind       text not null check (kind in ('like', 'help', 'join')),
  created_at timestamptz not null default now(),
  primary key (post_id, actor_id, kind)
);

create index if not exists reactions_actor_idx on public.reactions (actor_id);

-- ---------------------------------------------------------------------------
-- 4. comments — islands' PostChat.
-- ---------------------------------------------------------------------------
create table if not exists public.comments (
  id         uuid primary key default gen_random_uuid(),
  post_id    uuid not null references public.posts (id) on delete cascade,
  author_id  uuid not null references public.accounts (id) on delete cascade,
  body       text not null check (length(body) between 1 and 500),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists comments_post_idx on public.comments (post_id, created_at)
  where deleted_at is null;

-- ---------------------------------------------------------------------------
-- 5. notifications.
--
-- islands built these in the browser, which means they exist on one device and
-- the read state is a lie everywhere else. They are rows here, written by the
-- triggers below, so a phone and a laptop agree about what is unread.
-- ---------------------------------------------------------------------------
create table if not exists public.notifications (
  id           uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.accounts (id) on delete cascade,
  actor_id     uuid not null references public.accounts (id) on delete cascade,
  post_id      uuid references public.posts (id) on delete cascade,
  comment_id   uuid references public.comments (id) on delete cascade,
  type         text not null check (type in ('like', 'help', 'join', 'comment')),
  created_at   timestamptz not null default now(),
  read_at      timestamptz
);

create index if not exists notifications_inbox_idx
  on public.notifications (recipient_id, created_at desc);
create index if not exists notifications_unread_idx
  on public.notifications (recipient_id) where read_at is null;

-- ---------------------------------------------------------------------------
-- 6. reports. A public map with real accounts and uploaded images needs a way
-- to say "this should not be here" that is not "email the person who built it".
-- Nobody but service_role can read them.
-- ---------------------------------------------------------------------------
create table if not exists public.reports (
  id          uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.accounts (id) on delete cascade,
  post_id     uuid references public.posts (id) on delete cascade,
  comment_id  uuid references public.comments (id) on delete cascade,
  reason      text check (reason is null or length(reason) <= 500),
  created_at  timestamptz not null default now(),
  check (post_id is not null or comment_id is not null)
);

-- ---------------------------------------------------------------------------
-- 7. energy_cells — a coarse summary of where the land is.
--
-- The terrain is drawn from posts, and below a few hundred posts in view that
-- is exact. This table is what keeps the far-away land from vanishing once the
-- viewport holds more posts than the client is willing to fetch: one row per
-- 20x20 patch of the 1000x1000 world, so at most 2,500 rows for the whole map.
-- Maintained by trigger, one upsert per post change.
-- ---------------------------------------------------------------------------
create table if not exists public.energy_cells (
  cell_x     integer not null,
  cell_y     integer not null,
  sum_energy real    not null default 0,
  post_count integer not null default 0,
  primary key (cell_x, cell_y)
);

-- ===========================================================================
-- Triggers
-- ===========================================================================

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists accounts_touch on public.accounts;
create trigger accounts_touch before update on public.accounts
  for each row execute function public.touch_updated_at();

drop trigger if exists posts_touch on public.posts;
create trigger posts_touch before update on public.posts
  for each row execute function public.touch_updated_at();

-- --- reaction counts + notification ---------------------------------------
--
-- security definer because the row it writes belongs to the recipient, and the
-- actor has no business being able to write to somebody else's inbox directly.
create or replace function public.on_reaction_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  owner_id uuid;
begin
  if tg_op = 'INSERT' then
    update public.posts set
      like_count = like_count + (new.kind = 'like')::int,
      help_count = help_count + (new.kind = 'help')::int,
      join_count = join_count + (new.kind = 'join')::int
    where id = new.post_id
    returning author_id into owner_id;

    -- Reacting to your own post is not news.
    if owner_id is not null and owner_id <> new.actor_id then
      insert into public.notifications (recipient_id, actor_id, post_id, type)
      values (owner_id, new.actor_id, new.post_id, new.kind);
    end if;
    return new;
  end if;

  update public.posts set
    like_count = greatest(0, like_count - (old.kind = 'like')::int),
    help_count = greatest(0, help_count - (old.kind = 'help')::int),
    join_count = greatest(0, join_count - (old.kind = 'join')::int)
  where id = old.post_id;
  -- Un-reacting withdraws the notification too, but only if it has not been
  -- read: a notification somebody already saw is a thing that happened.
  delete from public.notifications
   where post_id = old.post_id and actor_id = old.actor_id
     and type = old.kind and read_at is null;
  return old;
end $$;

drop trigger if exists reactions_sync on public.reactions;
create trigger reactions_sync after insert or delete on public.reactions
  for each row execute function public.on_reaction_change();

-- --- comment counts + notification -----------------------------------------
create or replace function public.on_comment_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  owner_id uuid;
begin
  if tg_op = 'INSERT' then
    update public.posts set comment_count = comment_count + 1
     where id = new.post_id returning author_id into owner_id;
    if owner_id is not null and owner_id <> new.author_id then
      insert into public.notifications (recipient_id, actor_id, post_id, comment_id, type)
      values (owner_id, new.author_id, new.post_id, new.id, 'comment');
    end if;
    return new;
  end if;

  -- A comment is soft deleted, so the count moves on UPDATE, not on DELETE.
  if tg_op = 'UPDATE' then
    if old.deleted_at is null and new.deleted_at is not null then
      update public.posts set comment_count = greatest(0, comment_count - 1)
       where id = new.post_id;
    elsif old.deleted_at is not null and new.deleted_at is null then
      update public.posts set comment_count = comment_count + 1 where id = new.post_id;
    end if;
    return new;
  end if;

  update public.posts set comment_count = greatest(0, comment_count - 1)
   where id = old.post_id;
  return old;
end $$;

drop trigger if exists comments_sync on public.comments;
create trigger comments_sync after insert or update or delete on public.comments
  for each row execute function public.on_comment_change();

-- --- energy_cells ----------------------------------------------------------
--
-- CELL_SIZE must match ENERGY_CELL_SIZE in core/config.py. It is written here
-- as a literal because a generated column and an index both depend on it and
-- neither can call out to Python.
create or replace function public.energy_cell_apply(px double precision, py double precision,
                                                    delta_energy real, delta_count integer)
returns void language plpgsql security definer set search_path = public as $$
declare
  cx integer := floor(px / 20.0)::int;
  cy integer := floor(py / 20.0)::int;
begin
  insert into public.energy_cells (cell_x, cell_y, sum_energy, post_count)
  values (cx, cy, delta_energy, delta_count)
  on conflict (cell_x, cell_y) do update
    set sum_energy = greatest(0, public.energy_cells.sum_energy + excluded.sum_energy),
        post_count = greatest(0, public.energy_cells.post_count + excluded.post_count);
end $$;

create or replace function public.on_post_energy_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.deleted_at is null then
      perform public.energy_cell_apply(new.x, new.y, new.energy, 1);
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.deleted_at is null then
      perform public.energy_cell_apply(old.x, old.y, -old.energy, -1);
    end if;
    return old;
  end if;

  -- UPDATE. Withdraw the old contribution, add the new one. Doing it as two
  -- one-sided calls means a post that moved between cells is handled by the
  -- same code as one that only changed energy.
  if old.deleted_at is null then
    perform public.energy_cell_apply(old.x, old.y, -old.energy, -1);
  end if;
  if new.deleted_at is null then
    perform public.energy_cell_apply(new.x, new.y, new.energy, 1);
  end if;
  return new;
end $$;

drop trigger if exists posts_energy_cells on public.posts;
create trigger posts_energy_cells after insert or update or delete on public.posts
  for each row execute function public.on_post_energy_change();

-- ===========================================================================
-- Privileges. Supabase grants ALL on new tables to anon/authenticated by
-- default, so everything below starts by taking that back.
-- ===========================================================================

revoke all on public.accounts, public.posts, public.reactions, public.comments,
              public.notifications, public.reports, public.energy_cells
  from anon, authenticated;

grant select on public.accounts to anon, authenticated;
grant insert, update, delete on public.accounts to authenticated;

-- vec and vec_c are deliberately absent. So is deleted_at on the read side:
-- the RLS policy already hides deleted rows, and a client has no use for it.
grant select (id, author_id, body, tags, motivation, image_path, x, y, cluster_id,
              terms, like_count, help_count, join_count, comment_count, energy,
              created_at, updated_at)
  on public.posts to anon, authenticated;
-- No insert: x/y/vec come from the frozen encoder, so posts are created through
-- the API with service_role. Editing the body also has to go through the API
-- (it moves the post), which is why body is not in this list.
grant update (tags, motivation, image_path, deleted_at) on public.posts to authenticated;

grant select on public.reactions to anon, authenticated;
grant insert, delete on public.reactions to authenticated;

grant select on public.comments to anon, authenticated;
grant insert on public.comments to authenticated;
grant update (body, deleted_at) on public.comments to authenticated;

grant select on public.notifications to authenticated;
grant update (read_at) on public.notifications to authenticated;

grant insert on public.reports to authenticated;

grant select on public.energy_cells to anon, authenticated;

-- ===========================================================================
-- Row level security
-- ===========================================================================

alter table public.accounts      enable row level security;
alter table public.posts         enable row level security;
alter table public.reactions     enable row level security;
alter table public.comments      enable row level security;
alter table public.notifications enable row level security;
alter table public.reports       enable row level security;
alter table public.energy_cells  enable row level security;

drop policy if exists accounts_read      on public.accounts;
drop policy if exists accounts_insert    on public.accounts;
drop policy if exists accounts_update    on public.accounts;
drop policy if exists accounts_delete    on public.accounts;
create policy accounts_read   on public.accounts for select using (true);
create policy accounts_insert on public.accounts for insert to authenticated
  with check (auth.uid() = id);
create policy accounts_update on public.accounts for update to authenticated
  using (auth.uid() = id) with check (auth.uid() = id);
create policy accounts_delete on public.accounts for delete to authenticated
  using (auth.uid() = id);

drop policy if exists posts_read   on public.posts;
drop policy if exists posts_update on public.posts;
create policy posts_read   on public.posts for select using (deleted_at is null);
-- No insert policy, on purpose. See the header.
create policy posts_update on public.posts for update to authenticated
  using (auth.uid() = author_id) with check (auth.uid() = author_id);

drop policy if exists reactions_read   on public.reactions;
drop policy if exists reactions_insert on public.reactions;
drop policy if exists reactions_delete on public.reactions;
create policy reactions_read   on public.reactions for select using (true);
create policy reactions_insert on public.reactions for insert to authenticated
  with check (auth.uid() = actor_id);
create policy reactions_delete on public.reactions for delete to authenticated
  using (auth.uid() = actor_id);

drop policy if exists comments_read   on public.comments;
drop policy if exists comments_insert on public.comments;
drop policy if exists comments_update on public.comments;
create policy comments_read   on public.comments for select using (deleted_at is null);
create policy comments_insert on public.comments for insert to authenticated
  with check (auth.uid() = author_id);
create policy comments_update on public.comments for update to authenticated
  using (auth.uid() = author_id) with check (auth.uid() = author_id);

drop policy if exists notifications_read   on public.notifications;
drop policy if exists notifications_update on public.notifications;
create policy notifications_read on public.notifications for select to authenticated
  using (auth.uid() = recipient_id);
create policy notifications_update on public.notifications for update to authenticated
  using (auth.uid() = recipient_id) with check (auth.uid() = recipient_id);

drop policy if exists reports_insert on public.reports;
create policy reports_insert on public.reports for insert to authenticated
  with check (auth.uid() = reporter_id);

drop policy if exists energy_cells_read on public.energy_cells;
create policy energy_cells_read on public.energy_cells for select using (true);

-- ===========================================================================
-- Functions the client calls. All security definer, all returning scores and
-- never vectors.
-- ===========================================================================

-- Everything the map needs to draw one post, without the essay-sized columns
-- the map does not use. Ordered by energy so that a viewport holding more posts
-- than limit_n still shows the land that is actually visible - a 20-energy post
-- contributes a puddle, and dropping it changes nothing anybody can see.
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
  energy real, created_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select p.id, p.author_id, a.display_name, a.icon_id, a.avatar_path,
         p.body, p.tags, p.motivation, p.image_path,
         p.x, p.y, p.cluster_id,
         p.like_count, p.help_count, p.join_count, p.comment_count,
         p.energy, p.created_at
    from public.posts p
    join public.accounts a on a.id = p.author_id
   where p.deleted_at is null
     and point(p.x, p.y) <@ box(point(min_x, min_y), point(max_x, max_y))
   order by p.energy desc, p.created_at desc
   limit least(greatest(limit_n, 1), 2000);
$$;

-- The coarse layer. Only worth asking for when map_posts came back saturated.
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

-- Nearest neighbours in the 448-dim centred space. This is the ONLY thing that
-- decides who is "近い": the map is a 2-D shadow and this build's own gate
-- records that 34% of true neighbours survive the projection.
create or replace function public.nearest_posts(from_post uuid, k integer default 24)
returns table (id uuid, cosine double precision)
language sql stable security definer set search_path = public as $$
  with origin as (select vec_c from public.posts where id = from_post)
  select p.id, 1 - (p.vec_c <=> o.vec_c)
    from public.posts p, origin o
   where p.id <> from_post
     and p.deleted_at is null
   order by p.vec_c <=> o.vec_c
   limit least(greatest(k, 1), 100);
$$;

create or replace function public.pair_similarity(a uuid, b uuid)
returns double precision
language sql stable security definer set search_path = public as $$
  select 1 - (pa.vec_c <=> pb.vec_c)
    from public.posts pa, public.posts pb
   where pa.id = a and pb.id = b;
$$;

-- Terms for a set of posts, for naming a landmass. The API asks for the posts
-- it has already decided belong to one landmass; only the words come back.
create or replace function public.post_terms(ids uuid[])
returns table (id uuid, cluster_id smallint, terms jsonb)
language sql stable security definer set search_path = public as $$
  select p.id, p.cluster_id, p.terms
    from public.posts p
   where p.id = any(ids) and p.deleted_at is null;
$$;

revoke all on function public.map_posts(double precision, double precision,
                                        double precision, double precision, integer)
  from public;
revoke all on function public.map_cells(double precision, double precision,
                                        double precision, double precision) from public;
revoke all on function public.nearest_posts(uuid, integer) from public;
revoke all on function public.pair_similarity(uuid, uuid) from public;
revoke all on function public.post_terms(uuid[]) from public;

grant execute on function public.map_posts(double precision, double precision,
                                           double precision, double precision, integer)
  to anon, authenticated;
grant execute on function public.map_cells(double precision, double precision,
                                           double precision, double precision)
  to anon, authenticated;
grant execute on function public.nearest_posts(uuid, integer) to anon, authenticated;
grant execute on function public.pair_similarity(uuid, uuid) to anon, authenticated;
grant execute on function public.post_terms(uuid[]) to service_role;

-- ===========================================================================
-- Storage. One public bucket; a file may only be written under a folder named
-- with the uploader's own uid, so nobody can overwrite anybody else's image.
-- ===========================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('post-images', 'post-images', true, 1048576,
        array['image/webp', 'image/jpeg', 'image/png'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists post_images_read   on storage.objects;
drop policy if exists post_images_write  on storage.objects;
drop policy if exists post_images_update on storage.objects;
drop policy if exists post_images_delete on storage.objects;

create policy post_images_read on storage.objects for select
  using (bucket_id = 'post-images');
create policy post_images_write on storage.objects for insert to authenticated
  with check (bucket_id = 'post-images'
              and (storage.foldername(name))[1] = auth.uid()::text);
create policy post_images_update on storage.objects for update to authenticated
  using (bucket_id = 'post-images'
         and (storage.foldername(name))[1] = auth.uid()::text);
create policy post_images_delete on storage.objects for delete to authenticated
  using (bucket_id = 'post-images'
         and (storage.foldername(name))[1] = auth.uid()::text);

-- ===========================================================================
-- Sanity checks. Each of these must come back the way the comment says.
-- ===========================================================================
-- Every table has RLS on and at least one policy:
--   select c.relname, c.relrowsecurity, count(p.policyname)
--     from pg_class c
--     left join pg_policies p on p.tablename = c.relname and p.schemaname = 'public'
--    where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
--    group by 1, 2;
--
-- The vectors are not readable by the browser (expect 0 rows):
--   select * from information_schema.column_privileges
--    where table_name = 'posts' and column_name in ('vec', 'vec_c')
--      and grantee in ('anon', 'authenticated');
--
-- Nobody but service_role can insert a post (expect 0 rows):
--   select * from pg_policies where tablename = 'posts' and cmd = 'INSERT';
