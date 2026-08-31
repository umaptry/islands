-- Storage policy tests.
--
-- Verify the post-images bucket exists and has correct policies.

begin;
select plan(3);

-- -----------------------------------------------------------------------
-- 1. post-images bucket exists and is public
-- -----------------------------------------------------------------------
select is(
  (select public::text from storage.buckets where id = 'post-images'),
  'true',
  'post-images bucket is public'
);

-- -----------------------------------------------------------------------
-- 2. File size limit is 1MB
-- -----------------------------------------------------------------------
select is(
  (select file_size_limit from storage.buckets where id = 'post-images'),
  1048576,
  'post-images file_size_limit is 1MB'
);

-- -----------------------------------------------------------------------
-- 3. Storage has write/update/delete policies
-- -----------------------------------------------------------------------
select cmp_ok(
  (select count(*)::int from pg_policies
    where tablename = 'objects' and schemaname = 'storage'
      and policyname like 'post_images_%'),
  '>=', 4,
  'post-images has at least 4 storage policies (read/write/update/delete)'
);

select * from finish();
rollback;
