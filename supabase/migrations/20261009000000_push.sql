-- 段6 (2026-10-07): notifications that reach a closed app (items 22-23, Q34).
--
--   * Web Push. A notification row is written by a trigger (reactions,
--     comments) or by the server (islands, similar people). A statement-level
--     trigger then pokes the server's /api/push/dispatch through pg_net with
--     an empty body. The server claims the unsent rows itself (pushed_at), so
--     a forged poke from anywhere else sends nothing new.
--   * push_config holds the VAPID key pair, made by the server the first time
--     it needs one, and the dispatch address. Only the server's key reads it.
--     The address is NOT written here: production sets it with one UPDATE, so
--     a local or CI database never calls out.
--   * push_presence: "this person has the app on screen until ...". While it
--     is in the future the server sends no push - the in-app band is enough.
--   * quiet_post (Q34): a post nobody has answered yet, shown quietly in the
--     app to people on nearby islands. Never pushed; the wording never says
--     that nobody answered.
--   * Push subscriptions are written through the server only now. Inserting an
--     endpoint straight from the browser let anybody make the server POST to
--     any address it named.
--   * notifications join the supabase_realtime publication, so an open app
--     hears a new row at once instead of on the next 30-second check.

begin;

create extension if not exists pg_net with schema extensions;

-- ===========================================================================
-- 1. Notifications
-- ===========================================================================
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type in ('like', 'help', 'join', 'comment', 'reply', 'connection', 'similar', 'island',
                  'quiet_post'));

-- Set when the dispatcher has taken the row (sent or decided not to send).
alter table public.notifications add column if not exists pushed_at timestamptz;
-- Everything already there is old news; nobody should get a push for it.
update public.notifications set pushed_at = created_at where pushed_at is null;
create index if not exists notifications_push_pending_idx
  on public.notifications (created_at) where pushed_at is null;

-- quiet_post reads as a recommendation (おすすめ), like similar.
create or replace function public.notification_feed(limit_n integer default 50)
returns table (id uuid, type text, category text, post_id uuid, comment_id uuid,
               island_id uuid, event_id uuid, payload jsonb, actor_id uuid,
               others integer, created_at timestamptz, unread boolean, ids uuid[])
language sql stable security definer set search_path = public as $$
  with mine as (
    select n.*,
           case when n.type in ('like', 'help', 'join') then 'reaction'
                when n.type in ('comment', 'reply') then 'reply'
                when n.type = 'quiet_post' then 'similar'
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

-- ===========================================================================
-- 2. Server-only tables
-- ===========================================================================
create table if not exists public.push_config (
  singleton     boolean primary key default true check (singleton),
  vapid_public  text check (vapid_public is null or length(vapid_public) <= 200),
  vapid_private text check (vapid_private is null or length(vapid_private) <= 200),
  dispatch_url  text check (dispatch_url is null or dispatch_url ~ '^https://'),
  updated_at    timestamptz not null default now()
);
insert into public.push_config (singleton) values (true) on conflict do nothing;

create table if not exists public.push_presence (
  account_id   uuid primary key references public.accounts (id) on delete cascade,
  active_until timestamptz not null
);

alter table public.push_config   enable row level security;
alter table public.push_presence enable row level security;
-- One policy each that lets nobody in. The server's key skips RLS.
drop policy if exists push_config_none   on public.push_config;
drop policy if exists push_presence_none on public.push_presence;
create policy push_config_none   on public.push_config   for all using (false) with check (false);
create policy push_presence_none on public.push_presence for all using (false) with check (false);
revoke all on public.push_config, public.push_presence from anon, authenticated;
grant all on public.push_config, public.push_presence to service_role;

-- ===========================================================================
-- 3. Subscriptions go through the server
-- ===========================================================================
-- The server checks the endpoint's host against the push services before
-- saving it. Reading and removing your own rows stays open.
revoke insert on public.push_subscriptions from authenticated;
drop policy if exists push_subscriptions_insert on public.push_subscriptions;

-- ===========================================================================
-- 4. Functions
-- ===========================================================================
-- "I have the app on screen for the next N seconds." 0 (or less) clears it.
-- Capped so a stuck tab cannot silence pushes for long.
create or replace function public.mark_active(seconds integer default 45)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    return;
  end if;
  if coalesce(seconds, 0) <= 0 then
    delete from public.push_presence where account_id = auth.uid();
    return;
  end if;
  insert into public.push_presence (account_id, active_until)
  select auth.uid(), now() + make_interval(secs => least(seconds, 120))
   where exists (select 1 from public.accounts where id = auth.uid())
  on conflict (account_id) do update set active_until = excluded.active_until;
end $$;

-- One empty POST per insert statement, and only when production has set the
-- address. pg_net queues the request and sends it after commit; a failure
-- here must never take the notification (or the reaction behind it) down.
create or replace function public.poke_push_dispatch()
returns trigger language plpgsql security definer set search_path = public as $$
declare target text;
begin
  if not exists (select 1 from fresh where type <> 'quiet_post') then
    return null;
  end if;
  select dispatch_url into target from public.push_config where singleton;
  if coalesce(target, '') = '' then
    return null;
  end if;
  perform net.http_post(url := target, body := '{}'::jsonb, timeout_milliseconds := 5000);
  return null;
exception when others then
  return null;
end $$;

drop trigger if exists notifications_push on public.notifications;
create trigger notifications_push after insert on public.notifications
  referencing new table as fresh
  for each statement execute function public.poke_push_dispatch();

revoke all on function public.mark_active(integer) from public, anon;
revoke all on function public.poke_push_dispatch() from public, anon, authenticated;
grant execute on function public.mark_active(integer) to authenticated;

-- ===========================================================================
-- 5. Realtime
-- ===========================================================================
-- Realtime applies notifications_read, so each person hears only their own.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                      where pubname = 'supabase_realtime'
                        and schemaname = 'public' and tablename = 'notifications') then
    alter publication supabase_realtime add table public.notifications;
  end if;
end $$;

commit;
