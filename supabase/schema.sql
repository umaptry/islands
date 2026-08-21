-- Run once in the Supabase SQL editor.
--
-- RLS is enabled with NO policies, which means the anon key can do nothing at
-- all. Every read and write goes through the FastAPI server using the
-- service_role key (which bypasses RLS and is held only as a Space secret), so
-- the browser never holds a Supabase credential.

create table if not exists profiles (
  id          uuid primary key default gen_random_uuid(),
  edit_token  uuid not null default gen_random_uuid(),
  icon_id     text not null,
  name        text not null,
  text        text not null,
  x           double precision not null,
  y           double precision not null,
  cluster_id  int  not null,
  terms       jsonb not null default '[]'::jsonb,
  vec         jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists profiles_created_at_idx on profiles (created_at);

alter table profiles enable row level security;

-- Sanity check: this must return 0 rows.
-- select * from pg_policies where tablename = 'profiles';

-- ---------------------------------------------------------------------------
-- Likes. Added after the first deploy, so this file is safe to re-run: every
-- statement is if-not-exists.
--
-- The unique pair is load bearing, not a tidiness rule. Two taps racing each
-- other both reach PostgREST, and the constraint is what turns the loser into a
-- duplicate the server can ignore instead of a second "いいねが届きました".
--
-- on delete cascade: if a profile goes away, the likes pointing at it have no
-- meaning and would otherwise be rows nobody can ever resolve to a name.
create table if not exists likes (
  id          uuid primary key default gen_random_uuid(),
  from_id     uuid not null references profiles (id) on delete cascade,
  to_id       uuid not null references profiles (id) on delete cascade,
  created_at  timestamptz not null default now(),
  unique (from_id, to_id)
);

create index if not exists likes_to_id_idx on likes (to_id, created_at);
create index if not exists likes_from_id_idx on likes (from_id);

alter table likes enable row level security;
