begin;
-- Wait for in-flight writes when entering maintenance, and serialize new writers
-- against runtime changes. This also covers direct PostgREST writes.
create or replace function public.check_map_maintenance() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare paused boolean;
begin
  select maintenance into paused from public.map_runtime where singleton for share;
  if paused and coalesce(current_setting('app.map_migration',true),'') <> 'on' then
    raise exception 'Map maintenance in progress' using errcode='55000';
  end if;
  if TG_LEVEL='STATEMENT' then return null; end if;
  if TG_OP='DELETE' then return OLD; end if;
  return NEW;
end $$;
revoke all on function public.check_map_maintenance() from public;
commit;
