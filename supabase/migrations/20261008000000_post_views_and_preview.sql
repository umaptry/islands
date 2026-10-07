-- 段5 (2026-10-07): footprints as a number, and a first post you can try out.
--
--   * post_views: who has opened a post, one row per (post, viewer). Q35 says
--     footprints are the number of views and nothing else, so nobody can read
--     the rows - not even the author. The author gets a count per post through
--     the server (post_view_counts), never the list of names.
--   * nearest_to_vector: neighbours of a text that has NOT been saved. The
--     first-post tutorial (Q40) places an example sentence to show where it
--     would stand, and saving it would leave a pile of identical example posts
--     on the map. nearest_posts needs a saved post, so this takes the vector.
--
-- Both are for the server's key only. Nothing existing is rewritten.

create table if not exists public.post_views (
  post_id    uuid not null references public.posts(id) on delete cascade,
  -- An account id, or a random key a signed-out browser keeps for itself.
  viewer     text not null check (length(viewer) between 1 and 80),
  created_at timestamptz not null default now(),
  primary key (post_id, viewer)
);

alter table public.post_views enable row level security;
-- No policies: with RLS on and nothing granted, the browser can neither read
-- nor write. The server writes with its own key after checking the viewer is
-- not the author.
revoke all on public.post_views from anon, authenticated;

create or replace function public.post_view_counts(author uuid)
returns table (post_id uuid, views integer)
language sql stable security definer set search_path = public as $$
  select v.post_id, count(*)::int
    from public.post_views v
    join public.posts p on p.id = v.post_id
   where p.author_id = author
     and p.deleted_at is null
   group by v.post_id
$$;

-- The vector arrives as pgvector's text form ("[0.1,0.2,...]"), which is what
-- PostgREST can carry.
create or replace function public.nearest_to_vector(origin text, k integer default 5)
returns table (id uuid, cosine double precision)
language sql stable security definer set search_path = public as $$
  select p.id, 1 - (p.vec_c <=> origin::vector(448))
    from public.posts p
   where p.deleted_at is null
   order by p.vec_c <=> origin::vector(448)
   limit least(greatest(k, 1), 100)
$$;

revoke all on function public.post_view_counts(uuid) from public, anon, authenticated;
revoke all on function public.nearest_to_vector(text, integer) from public, anon, authenticated;
grant execute on function public.post_view_counts(uuid) to service_role;
grant execute on function public.nearest_to_vector(text, integer) to service_role;
