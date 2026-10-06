-- Posts are 60 characters at most, with no floor beyond "not empty" (Q36, 2026-10-07).
--
-- Two parts, because a CHECK constraint is re-tested on EVERY update of a row,
-- whichever column changed. A plain `check (length(body) <= 60)` - even NOT
-- VALID - would make a reaction or a comment count bump on an older 61-140
-- character post fail. So:
--
--   1. the column check only drops its floor of 30 (1..140 holds for every row
--      written under the old rule, so it validates without touching data);
--   2. a trigger holds the 60 limit, and fires only when the body itself is
--      written: on insert, and on an update that sets body.
--
-- Nothing is rewritten or deleted.

alter table public.posts drop constraint if exists posts_body_check;

alter table public.posts
  add constraint posts_body_check check (length(body) between 1 and 140);

create or replace function public.posts_body_limit()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if length(new.body) > 60 then
    raise exception 'post body is limited to 60 characters' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function public.posts_body_limit() from public, anon, authenticated;

drop trigger if exists posts_body_limit on public.posts;
create trigger posts_body_limit
  before insert or update of body on public.posts
  for each row execute function public.posts_body_limit();
