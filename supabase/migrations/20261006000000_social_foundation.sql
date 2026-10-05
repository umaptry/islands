-- Stage 1 of the islands redesign: the data the people layer stands on.
--
--   * accounts grow four profile fields (topics, goal, seeking, offering) and
--     one hidden vector per field. The vectors are written by the API with
--     service_role at save time and never leave the server.
--   * comments can answer another comment (reply_to).
--   * notifications learn four more types: reply, connection, similar, island.
--   * a person chooses, per category, whether a notification may interrupt
--     them outside the app (push) and inside it (in_app). Every notification is
--     kept in the list regardless.
--   * islands keep an identity across re-clustering (islands_state) and leave a
--     public record of what happened to them (island_events).
--
-- Affinity (how alike two people are) is computed in Python only, from the
-- vectors this migration stores. There is deliberately no SQL copy of that
-- formula: two copies drift.
begin;

-- ===========================================================================
-- 1. Profile fields
-- ===========================================================================
create or replace function public.topics_ok(items text[])
returns boolean language sql immutable set search_path = public as $$
  select coalesce(bool_and(length(t) between 1 and 12), true) from unnest(items) t
$$;

alter table public.accounts
  add column if not exists topics       text[] not null default '{}',
  add column if not exists goal         text,
  add column if not exists seeking      text,
  add column if not exists offering     text,
  add column if not exists last_seen_at timestamptz,
  add column if not exists vec_topics   vector(384),
  add column if not exists vec_goal     vector(384),
  add column if not exists vec_seeking  vector(384),
  add column if not exists vec_offering vector(384);

alter table public.accounts
  drop constraint if exists accounts_topics_check,
  drop constraint if exists accounts_goal_check,
  drop constraint if exists accounts_seeking_check,
  drop constraint if exists accounts_offering_check;
alter table public.accounts
  add constraint accounts_topics_check
    check (cardinality(topics) <= 8 and public.topics_ok(topics)),
  add constraint accounts_goal_check     check (goal is null or length(goal) <= 60),
  add constraint accounts_seeking_check  check (seeking is null or length(seeking) <= 60),
  add constraint accounts_offering_check check (offering is null or length(offering) <= 60);

-- Column grants replace the table grants. The browser may read everything a
-- profile sheet shows, but not the vectors and not when somebody was last here.
-- The four profile fields are written by the API only, because their vectors
-- have to be computed in the same save.
revoke select, insert, update on public.accounts from anon, authenticated;
grant select (id, display_name, affiliation, bio, link_url, icon_id, avatar_path,
              created_at, updated_at, topics, goal, seeking, offering)
  on public.accounts to anon, authenticated;
grant insert (id, display_name, affiliation, bio, link_url, icon_id, avatar_path)
  on public.accounts to authenticated;
grant update (display_name, affiliation, bio, link_url, icon_id, avatar_path)
  on public.accounts to authenticated;

-- ===========================================================================
-- 2. Replies
-- ===========================================================================
alter table public.comments
  add column if not exists reply_to uuid references public.comments (id) on delete set null;
create index if not exists comments_reply_idx on public.comments (reply_to)
  where reply_to is not null;

-- ===========================================================================
-- 3. Notifications
-- ===========================================================================
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type in ('like', 'help', 'join', 'comment', 'reply', 'connection', 'similar', 'island'));
-- An island changing has no actor.
alter table public.notifications alter column actor_id drop not null;
alter table public.notifications
  add column if not exists island_id uuid,
  add column if not exists event_id  uuid,
  add column if not exists payload   jsonb;

-- How many times two people have interacted, in either direction, counting
-- reactions, comments on the other's post and replies to the other's comment.
-- Self-interaction is not an interaction.
create or replace function public.pair_interaction_count(a uuid, b uuid)
returns integer language sql stable security definer set search_path = public as $$
  select (
    (select count(*) from public.reactions r join public.posts p on p.id = r.post_id
      where (r.actor_id = a and p.author_id = b) or (r.actor_id = b and p.author_id = a))
    +
    (select count(*) from public.comments c
       join public.posts p on p.id = c.post_id
       left join public.comments parent on parent.id = c.reply_to
      where c.deleted_at is null
        and ((c.author_id = a and (p.author_id = b or parent.author_id = b))
          or (c.author_id = b and (p.author_id = a or parent.author_id = a))))
  )::int
$$;
revoke all on function public.pair_interaction_count(uuid, uuid) from public, anon, authenticated;

-- The first interaction between two people tells both of them, once. Undoing
-- it later removes the line on the map but not this notification: it happened.
create or replace function public.notify_new_connection(a uuid, b uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if a is null or b is null or a = b then return; end if;
  if public.pair_interaction_count(a, b) <> 1 then return; end if;
  if exists (select 1 from public.notifications
              where type = 'connection'
                and ((recipient_id = a and actor_id = b) or (recipient_id = b and actor_id = a))) then
    return;
  end if;
  insert into public.notifications (recipient_id, actor_id, type)
  values (b, a, 'connection'), (a, b, 'connection');
end $$;
revoke all on function public.notify_new_connection(uuid, uuid) from public, anon, authenticated;

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
      perform public.notify_new_connection(new.actor_id, owner_id);
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

-- A reply tells the person replied to ('reply'). The post's owner hears about
-- it as a 'comment' only when they are somebody else, so nobody gets two
-- notifications for one sentence.
create or replace function public.on_comment_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  owner_id  uuid;
  parent_post uuid;
  parent_author uuid;
begin
  if tg_op = 'INSERT' then
    if new.reply_to is not null then
      select post_id, author_id into parent_post, parent_author
        from public.comments where id = new.reply_to;
      if parent_post is distinct from new.post_id then
        raise exception 'reply_to must be a comment on the same post' using errcode = '23514';
      end if;
    end if;

    update public.posts set comment_count = comment_count + 1
     where id = new.post_id returning author_id into owner_id;

    if parent_author is not null and parent_author <> new.author_id then
      insert into public.notifications (recipient_id, actor_id, post_id, comment_id, type)
      values (parent_author, new.author_id, new.post_id, new.id, 'reply');
      perform public.notify_new_connection(new.author_id, parent_author);
    end if;
    if owner_id is not null and owner_id <> new.author_id
       and owner_id is distinct from parent_author then
      insert into public.notifications (recipient_id, actor_id, post_id, comment_id, type)
      values (owner_id, new.author_id, new.post_id, new.id, 'comment');
    end if;
    if owner_id is not null and owner_id <> new.author_id then
      perform public.notify_new_connection(new.author_id, owner_id);
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

-- ===========================================================================
-- 4. New tables
-- ===========================================================================
create table if not exists public.notification_settings (
  account_id uuid not null references public.accounts (id) on delete cascade,
  category   text not null check (category in ('reply', 'reaction', 'connection', 'similar', 'island')),
  push       boolean not null default true,
  in_app     boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (account_id, category)
);

create table if not exists public.push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id) on delete cascade,
  endpoint   text not null unique check (length(endpoint) <= 1000),
  p256dh     text not null check (length(p256dh) <= 200),
  auth       text not null check (length(auth) <= 100),
  user_agent text check (user_agent is null or length(user_agent) <= 300),
  created_at timestamptz not null default now()
);
create index if not exists push_subscriptions_account_idx on public.push_subscriptions (account_id);

-- One row per island that has ever existed. id survives re-clustering because
-- island_tracking matches each new island to the old one it overlaps most.
create table if not exists public.islands_state (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  label        text,
  tier         smallint not null default 0 check (tier between 0 and 4),
  score_total  real not null default 0,
  score_recent real not null default 0,
  score_shown  real not null default 0,
  post_ids     uuid[] not null default '{}',
  author_ids   uuid[] not null default '{}',
  cx           double precision,
  cy           double precision,
  landmarks    jsonb not null default '[]',
  challenger   jsonb,
  quiet        boolean not null default false,
  active       boolean not null default true,
  last_activity_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists public.island_events (
  id         uuid primary key default gen_random_uuid(),
  island_id  uuid not null,
  kind       text not null check (kind in ('birth', 'merge', 'split', 'rename', 'tier', 'quiet', 'landmark')),
  cause      text not null check (length(cause) <= 200),
  place      jsonb not null default '{}',
  before     jsonb not null default '{}',
  after      jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists island_events_recent_idx on public.island_events (created_at desc);
create index if not exists island_events_island_idx on public.island_events (island_id, created_at desc);

-- Whoever claims this row runs the island update; everybody else skips it.
create table if not exists public.island_runs (
  singleton   boolean primary key default true check (singleton),
  last_run_at timestamptz not null default 'epoch'
);
insert into public.island_runs (singleton) values (true) on conflict do nothing;

revoke all on public.notification_settings, public.push_subscriptions,
              public.islands_state, public.island_events, public.island_runs
  from anon, authenticated;
grant all on public.notification_settings, public.push_subscriptions,
             public.islands_state, public.island_events, public.island_runs
  to service_role;

grant select, insert on public.notification_settings to authenticated;
grant update (push, in_app, updated_at) on public.notification_settings to authenticated;
grant select, insert, delete on public.push_subscriptions to authenticated;
grant select on public.islands_state, public.island_events to anon, authenticated;

alter table public.notification_settings enable row level security;
alter table public.push_subscriptions    enable row level security;
alter table public.islands_state         enable row level security;
alter table public.island_events         enable row level security;
alter table public.island_runs           enable row level security;

drop policy if exists notification_settings_read   on public.notification_settings;
drop policy if exists notification_settings_insert on public.notification_settings;
drop policy if exists notification_settings_update on public.notification_settings;
create policy notification_settings_read on public.notification_settings for select to authenticated
  using (auth.uid() = account_id);
create policy notification_settings_insert on public.notification_settings for insert to authenticated
  with check (auth.uid() = account_id);
create policy notification_settings_update on public.notification_settings for update to authenticated
  using (auth.uid() = account_id) with check (auth.uid() = account_id);

drop policy if exists push_subscriptions_read   on public.push_subscriptions;
drop policy if exists push_subscriptions_insert on public.push_subscriptions;
drop policy if exists push_subscriptions_delete on public.push_subscriptions;
create policy push_subscriptions_read on public.push_subscriptions for select to authenticated
  using (auth.uid() = account_id);
create policy push_subscriptions_insert on public.push_subscriptions for insert to authenticated
  with check (auth.uid() = account_id);
create policy push_subscriptions_delete on public.push_subscriptions for delete to authenticated
  using (auth.uid() = account_id);

drop policy if exists islands_state_read on public.islands_state;
drop policy if exists island_events_read on public.island_events;
drop policy if exists island_runs_deny_clients on public.island_runs;
create policy islands_state_read on public.islands_state for select using (true);
create policy island_events_read on public.island_events for select using (true);
create policy island_runs_deny_clients on public.island_runs for select to anon, authenticated
  using (false);

drop trigger if exists notification_settings_maintenance on public.notification_settings;
drop trigger if exists push_subscriptions_maintenance on public.push_subscriptions;
drop trigger if exists islands_state_maintenance on public.islands_state;
drop trigger if exists island_events_maintenance on public.island_events;
create trigger notification_settings_maintenance before insert or update or delete on public.notification_settings
  for each statement execute function public.check_map_maintenance();
create trigger push_subscriptions_maintenance before insert or update or delete on public.push_subscriptions
  for each statement execute function public.check_map_maintenance();
create trigger islands_state_maintenance before insert or update or delete on public.islands_state
  for each statement execute function public.check_map_maintenance();
create trigger island_events_maintenance before insert or update or delete on public.island_events
  for each statement execute function public.check_map_maintenance();

-- ===========================================================================
-- 5. Functions
-- ===========================================================================

-- Every interaction since a date, flattened for core/connections.py and
-- core/growth.py. reply_author_id is the author of the comment answered.
create or replace function public.interaction_events(since timestamptz)
returns table (actor_id uuid, post_author_id uuid, post_id uuid, kind text,
               reply_author_id uuid, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select r.actor_id, p.author_id, r.post_id, r.kind, null::uuid, r.created_at
    from public.reactions r join public.posts p on p.id = r.post_id
   where r.created_at >= since and p.deleted_at is null and r.actor_id <> p.author_id
  union all
  select c.author_id, p.author_id, c.post_id,
         case when c.reply_to is null then 'comment' else 'reply' end,
         parent.author_id, c.created_at
    from public.comments c
    join public.posts p on p.id = c.post_id
    left join public.comments parent on parent.id = c.reply_to
   where c.created_at >= since and c.deleted_at is null and p.deleted_at is null
     and (c.author_id <> p.author_id
          or (parent.author_id is not null and c.author_id <> parent.author_id))
$$;

-- The four profile vectors as text, for core/affinity.py. Server only.
create or replace function public.profile_vectors()
returns table (id uuid, topics text[], goal text, seeking text, offering text,
               vec_topics text, vec_goal text, vec_seeking text, vec_offering text)
language sql stable security definer set search_path = public as $$
  select id, topics, goal, seeking, offering,
         vec_topics::text, vec_goal::text, vec_seeking::text, vec_offering::text
    from public.accounts
$$;

-- Each person's mean centred post vector. Server only.
create or replace function public.account_post_centroids()
returns table (author_id uuid, centroid text, post_count integer)
language sql stable security definer set search_path = public as $$
  select author_id, avg(vec_c)::text, count(*)::int
    from public.posts where deleted_at is null group by author_id
$$;

-- The signed-in person's notifications as the list shows them: reactions to
-- the same post that follow each other within 10 minutes become one row
-- ("A さん ほか2人"). Mirrors core/notifications.py.
create or replace function public.notification_feed(limit_n integer default 50)
returns table (id uuid, type text, category text, post_id uuid, comment_id uuid,
               island_id uuid, event_id uuid, payload jsonb, actor_id uuid,
               others integer, created_at timestamptz, unread boolean, ids uuid[])
language sql stable security definer set search_path = public as $$
  with mine as (
    select n.*,
           case when n.type in ('like', 'help', 'join') then 'reaction'
                when n.type in ('comment', 'reply') then 'reply'
                else n.type end as cat
      from public.notifications n
     where n.recipient_id = auth.uid()
  ), chained as (
    select m.*,
           case when m.cat = 'reaction'
                 and lag(m.created_at) over w is not null
                 and m.created_at - lag(m.created_at) over w <= interval '10 minutes'
                then 0 else 1 end as starts
      from mine m
    window w as (partition by m.cat, m.post_id order by m.created_at)
  ), grouped as (
    select c.*,
           case when c.cat = 'reaction'
                then sum(c.starts) over (partition by c.cat, c.post_id order by c.created_at)
                else null end as chain,
           case when c.cat = 'reaction' then null else c.id end as solo
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
         (count(distinct g.actor_id) - 1)::int,
         max(g.created_at),
         bool_or(g.read_at is null),
         array_agg(g.id order by g.created_at desc)
    from grouped g
   group by g.cat, g.post_id, g.chain, g.solo
   order by max(g.created_at) desc
   limit greatest(1, least(limit_n, 200))
$$;

-- True for exactly one caller per min_seconds.
create or replace function public.claim_island_run(min_seconds integer default 600)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  update public.island_runs set last_run_at = now()
   where singleton and last_run_at <= now() - make_interval(secs => min_seconds);
  return found;
end $$;

-- Returns the previous visit (for the "while you were away" list) and records this one.
create or replace function public.touch_last_seen()
returns timestamptz language plpgsql security definer set search_path = public as $$
declare previous timestamptz;
begin
  select last_seen_at into previous from public.accounts where id = auth.uid();
  update public.accounts set last_seen_at = now() where id = auth.uid();
  return previous;
end $$;

revoke all on function public.interaction_events(timestamptz) from public, anon, authenticated;
revoke all on function public.profile_vectors() from public, anon, authenticated;
revoke all on function public.account_post_centroids() from public, anon, authenticated;
revoke all on function public.notification_feed(integer) from public, anon;
revoke all on function public.claim_island_run(integer) from public, anon, authenticated;
revoke all on function public.touch_last_seen() from public, anon;
grant execute on function public.interaction_events(timestamptz) to service_role;
grant execute on function public.profile_vectors() to service_role;
grant execute on function public.account_post_centroids() to service_role;
grant execute on function public.claim_island_run(integer) to service_role;
grant execute on function public.notification_feed(integer) to authenticated;
grant execute on function public.touch_last_seen() to authenticated;

commit;
