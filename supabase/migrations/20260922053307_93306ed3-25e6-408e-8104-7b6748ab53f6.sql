DROP POLICY IF EXISTS "Allow all select on hiopos-imports" ON storage.objects;
DROP POLICY IF EXISTS "Allow all insert on hiopos-imports" ON storage.objects;
DROP POLICY IF EXISTS "Allow all delete on hiopos-imports" ON storage.objects;

CREATE POLICY "hiopos_imports_select_scoped" ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'hiopos-imports'
  AND (
    (select public.is_platform_admin())
    OR (storage.foldername(name))[1] IN (
      select r.connection_id::text from public.user_roles r
      where r.user_id = (select auth.uid()) and r.connection_id is not null
    )
  )
);

CREATE POLICY "hiopos_imports_insert_scoped" ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'hiopos-imports'
  AND (
    (select public.is_platform_admin())
    OR (storage.foldername(name))[1] IN (
      select r.connection_id::text from public.user_roles r
      where r.user_id = (select auth.uid()) and r.connection_id is not null
    )
  )
);

CREATE POLICY "hiopos_imports_delete_scoped" ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'hiopos-imports'
  AND (
    (select public.is_platform_admin())
    OR (storage.foldername(name))[1] IN (
      select r.connection_id::text from public.user_roles r
      where r.user_id = (select auth.uid()) and r.connection_id is not null
    )
  )
);