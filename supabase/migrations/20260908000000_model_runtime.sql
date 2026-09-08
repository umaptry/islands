-- Apply before the model-runtime release. Default remains the existing E5 map.
begin;
create table public.map_runtime (
  singleton boolean primary key default true check (singleton),
  maintenance boolean not null default false,
  active_version text not null default 'kotoba-map-v1',
  updated_at timestamptz not null default now()
);
insert into public.map_runtime(singleton) values(true);
alter table public.map_runtime enable row level security;
grant select on public.map_runtime to anon, authenticated;
grant all on public.map_runtime to service_role;
create policy map_runtime_read on public.map_runtime for select using(true);

create table public.embedding_cache (
  cache_key text primary key check(length(cache_key)=64),
  embedding jsonb not null check(jsonb_typeof(embedding)='array' and jsonb_array_length(embedding)=384),
  created_at timestamptz not null default now()
);
alter table public.embedding_cache enable row level security;
revoke all on public.embedding_cache from anon, authenticated;
grant all on public.embedding_cache to service_role;
create policy embedding_cache_deny_clients on public.embedding_cache
for select to anon, authenticated using(false);

create function public.check_map_maintenance() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if (select maintenance from public.map_runtime where singleton)
     and coalesce(current_setting('app.map_migration',true),'') <> 'on' then
    raise exception 'Map maintenance in progress' using errcode='55000';
  end if;
  if TG_OP='DELETE' then return OLD; end if;
  return NEW;
end $$;
revoke all on function public.check_map_maintenance() from public;
create trigger posts_maintenance before insert or update or delete on public.posts
for each statement execute function public.check_map_maintenance();
create trigger reactions_maintenance before insert or update or delete on public.reactions
for each statement execute function public.check_map_maintenance();
create trigger comments_maintenance before insert or update or delete on public.comments
for each statement execute function public.check_map_maintenance();
create trigger accounts_maintenance before insert or update or delete on public.accounts
for each statement execute function public.check_map_maintenance();
create trigger notifications_maintenance before insert or update or delete on public.notifications
for each statement execute function public.check_map_maintenance();
create trigger reports_maintenance before insert or update or delete on public.reports
for each statement execute function public.check_map_maintenance();

-- Restrictive policies combine with the existing owner checks. Public images remain readable.
create policy post_images_maintenance_insert on storage.objects as restrictive
for insert to authenticated with check (
  bucket_id <> 'post-images' or not (select maintenance from public.map_runtime where singleton));
create policy post_images_maintenance_update on storage.objects as restrictive
for update to authenticated using (
  bucket_id <> 'post-images' or not (select maintenance from public.map_runtime where singleton))
with check (bucket_id <> 'post-images' or not (select maintenance from public.map_runtime where singleton));
create policy post_images_maintenance_delete on storage.objects as restrictive
for delete to authenticated using (
  bucket_id <> 'post-images' or not (select maintenance from public.map_runtime where singleton));

-- A migration changes only calculated fields, retaining social and user data.
create function public.apply_map_version(expected_version text, next_version text, rows jsonb)
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare item jsonb; total integer := 0; expected_count integer;
begin
  perform 1 from public.map_runtime where singleton for update;
  if not (select maintenance from public.map_runtime where singleton) then
    raise exception 'Enable maintenance before changing map version';
  end if;
  if (select active_version from public.map_runtime where singleton) <> expected_version then
    raise exception 'Unexpected active map version';
  end if;
  lock table public.posts in exclusive mode;
  select count(*) into expected_count from public.posts where deleted_at is null;
  if jsonb_array_length(rows) <> expected_count then raise exception 'Post count changed'; end if;
  if (select count(distinct value->>'id') from jsonb_array_elements(rows)) <> expected_count then
    raise exception 'Duplicate post IDs';
  end if;
  perform set_config('app.map_migration','on',true);
  for item in select value from jsonb_array_elements(rows) loop
    update public.posts set x=(item->>'x')::double precision, y=(item->>'y')::double precision,
      cluster_id=(item->>'cluster_id')::smallint, terms=item->'terms',
      vec=(item->>'vec')::vector(448), vec_c=(item->>'vec_c')::vector(448)
      where id=(item->>'id')::uuid and deleted_at is null
        and body=item->>'body' and updated_at=(item->>'updated_at')::timestamptz;
    if not found then raise exception 'Post changed during migration: %',item->>'id'; end if;
    total := total + 1;
  end loop;
  update public.map_runtime set active_version=next_version, updated_at=now() where singleton;
  return total;
end $$;
revoke all on function public.apply_map_version(text,text,jsonb) from public,anon,authenticated;
grant execute on function public.apply_map_version(text,text,jsonb) to service_role;
commit;
