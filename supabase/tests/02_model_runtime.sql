begin;
select plan(6);
select ok(not has_table_privilege('anon','public.embedding_cache','select'), 'anon cannot read embedding cache');
select ok(not has_table_privilege('authenticated','public.embedding_cache','select'), 'users cannot read embedding cache');
select ok(not has_function_privilege('authenticated','public.apply_map_version(text,text,jsonb)','execute'), 'users cannot migrate maps');
select is((select count(*)::int from pg_policies where schemaname='storage' and policyname like 'post_images_maintenance_%' and permissive='RESTRICTIVE'), 3, 'storage writes require maintenance to be off');
update public.map_runtime set maintenance=true where singleton;
set local role authenticated;
select throws_ok($$update public.accounts set bio='' where false$$, '55000', 'Map maintenance in progress', 'direct account writes stop in maintenance');
reset role;
select throws_ok($$select public.apply_map_version('wrong','candidate','[]'::jsonb)$$,
  'P0001', 'Unexpected active map version', 'migration rejects a stale base version');
select * from finish();
rollback;
