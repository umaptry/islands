begin;
select no_plan();
insert into auth.users(id) values ('11111111-1111-4111-8111-111111111111'), ('22222222-2222-4222-8222-222222222222');
insert into public.accounts(id,display_name) values ('11111111-1111-4111-8111-111111111111','author'), ('22222222-2222-4222-8222-222222222222','reader') on conflict (id) do nothing;
insert into public.posts(id,author_id,body,x,y,cluster_id,vec,vec_c,image_path)
select ('00000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid,
 '11111111-1111-4111-8111-111111111111', repeat('A',40), i, i, 0,
 array_fill(1.0,ARRAY[448])::vector(448), array_fill(1.0,ARRAY[448])::vector(448), 'retained/image.png'
from generate_series(1,2) i;
insert into public.reactions(post_id,actor_id,kind) values ('00000000-0000-4000-8000-000000000001','22222222-2222-4222-8222-222222222222','like');
insert into public.comments(post_id,author_id,body) values ('00000000-0000-4000-8000-000000000001','22222222-2222-4222-8222-222222222222','retained comment');
create temp table migration_snapshot as select jsonb_agg(jsonb_build_object('id',id,'body',body,'updated_at',updated_at,'x',x+10,'y',y+10,'cluster_id',cluster_id,'terms',terms,'vec',vec::text,'vec_c',vec_c::text) order by id) as rows from public.posts where deleted_at is null;
update public.map_runtime set maintenance=true where singleton;
select throws_ok($$select public.apply_map_version('kotoba-map-v1','gemini-test','[]'::jsonb)$$, 'P0001','Post count changed','missing/deleted snapshot rows abort');
select throws_ok($$select public.apply_map_version('kotoba-map-v1','gemini-test', rows || jsonb_build_array(rows->0)) from migration_snapshot$$, 'P0001','Post count changed','extra snapshot rows abort');
select throws_ok($$select public.apply_map_version('kotoba-map-v1','gemini-test',jsonb_build_array(rows->0,rows->0)) from migration_snapshot$$, 'P0001','Duplicate post IDs','duplicate IDs abort');
select throws_ok($$select public.apply_map_version('kotoba-map-v1','gemini-test',jsonb_set(rows,'{1,body}','"changed"')) from migration_snapshot$$, 'P0001','Post changed during migration: 00000000-0000-4000-8000-000000000002','late mismatch rolls back earlier updates');
select is((select x::int from public.posts where id='00000000-0000-4000-8000-000000000001'),1,'earlier update rolled back');
select is((select active_version from public.map_runtime),'kotoba-map-v1','failed migration preserves runtime');
select is(public.apply_map_version('kotoba-map-v1','gemini-test',rows),2,'all posts migrated') from migration_snapshot;
select is((select active_version from public.map_runtime),'gemini-test','version changes atomically');
select ok((select maintenance from public.map_runtime),'maintenance stays enabled');
select is((select count(*)::int from public.posts where body=repeat('A',40) and image_path='retained/image.png'),2,'body and image references retained');
select is((select count(*)::int from public.reactions),1,'reactions retained');
select is((select count(*)::int from public.comments),1,'comments retained');
select is((select count(*)::int from public.accounts),2,'accounts retained');
select * from finish();
rollback;
