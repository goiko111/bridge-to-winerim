-- 1. Helper functions (security definer, avoid RLS recursion on user_roles)
CREATE OR REPLACE FUNCTION public.is_platform_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid()
      AND role = 'admin'
      AND connection_id IS NULL
  );
$$;

CREATE OR REPLACE FUNCTION public.can_access_connection(_connection_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.is_platform_admin()
     OR (
       _connection_id IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM public.user_roles
         WHERE user_id = auth.uid()
           AND connection_id = _connection_id
       )
     );
$$;

REVOKE ALL ON FUNCTION public.is_platform_admin() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.can_access_connection(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_platform_admin() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_access_connection(uuid) TO authenticated, service_role;

-- 2. Seed platform admin for the existing operator account (otherwise the console locks itself out)
INSERT INTO public.user_roles (user_id, role, connection_id)
SELECT u.id, 'admin', NULL
FROM auth.users u
WHERE u.email = 'acceso@winerim.app'
  AND NOT EXISTS (
    SELECT 1 FROM public.user_roles r
    WHERE r.user_id = u.id AND r.role = 'admin' AND r.connection_id IS NULL
  );

-- 3. Per-connection isolation on every operational table
DO $do$
DECLARE
  t text;
  p record;
  tables text[] := ARRAY[
    'agora_master_data','agora_sales_variant_mappings','agora_dispatch_locks',
    'catalog_readback_snapshots','catalog_review_decisions','qtomas_review_decisions',
    'classification_config','connection_alerts','connection_health_checks',
    'connection_notification_contacts','outbound_tasks','product_mappings',
    'provider_capabilities','provider_products','sales_events','sales_line_items',
    'stock_sync_log','webhook_events','wine_family_rules','wine_type_family_mappings',
    'winerim_push_tracking','winerim_wine_formats','winerim_wines'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename=t LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', p.policyname, t);
    END LOOP;

    EXECUTE format($f$
      CREATE POLICY %I ON public.%I FOR SELECT TO authenticated
      USING (public.can_access_connection(connection_id))
    $f$, 'tenant_select_' || t, t);

    EXECUTE format($f$
      CREATE POLICY %I ON public.%I FOR INSERT TO authenticated
      WITH CHECK (public.can_access_connection(connection_id))
    $f$, 'tenant_insert_' || t, t);

    EXECUTE format($f$
      CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated
      USING (public.can_access_connection(connection_id))
      WITH CHECK (public.can_access_connection(connection_id))
    $f$, 'tenant_update_' || t, t);

    EXECUTE format($f$
      CREATE POLICY %I ON public.%I FOR DELETE TO authenticated
      USING (public.can_access_connection(connection_id))
    $f$, 'tenant_delete_' || t, t);
  END LOOP;
END
$do$;

-- 4. pos_connections: row scoped by its own id; create/delete admin-only
DROP POLICY IF EXISTS auth_select_pos_connections ON public.pos_connections;
DROP POLICY IF EXISTS auth_insert_pos_connections ON public.pos_connections;
DROP POLICY IF EXISTS auth_update_pos_connections ON public.pos_connections;
DROP POLICY IF EXISTS auth_delete_pos_connections ON public.pos_connections;

CREATE POLICY tenant_select_pos_connections ON public.pos_connections
  FOR SELECT TO authenticated USING (public.can_access_connection(id));
CREATE POLICY tenant_update_pos_connections ON public.pos_connections
  FOR UPDATE TO authenticated
  USING (public.can_access_connection(id))
  WITH CHECK (public.can_access_connection(id));
CREATE POLICY admin_insert_pos_connections ON public.pos_connections
  FOR INSERT TO authenticated WITH CHECK (public.is_platform_admin());
CREATE POLICY admin_delete_pos_connections ON public.pos_connections
  FOR DELETE TO authenticated USING (public.is_platform_admin());

-- 5. provider_credentials: admin only
DROP POLICY IF EXISTS auth_select_provider_credentials ON public.provider_credentials;
DROP POLICY IF EXISTS auth_insert_provider_credentials ON public.provider_credentials;
DROP POLICY IF EXISTS auth_update_provider_credentials ON public.provider_credentials;
DROP POLICY IF EXISTS auth_delete_provider_credentials ON public.provider_credentials;

CREATE POLICY admin_all_provider_credentials ON public.provider_credentials
  FOR ALL TO authenticated
  USING (public.is_platform_admin())
  WITH CHECK (public.is_platform_admin());

-- 6. user_roles: own rows readable; only admins manage
DROP POLICY IF EXISTS user_roles_select_own ON public.user_roles;
DROP POLICY IF EXISTS user_roles_admin_all ON public.user_roles;

CREATE POLICY user_roles_select_own ON public.user_roles
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_platform_admin());
CREATE POLICY user_roles_admin_insert ON public.user_roles
  FOR INSERT TO authenticated WITH CHECK (public.is_platform_admin());
CREATE POLICY user_roles_admin_update ON public.user_roles
  FOR UPDATE TO authenticated
  USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());
CREATE POLICY user_roles_admin_delete ON public.user_roles
  FOR DELETE TO authenticated USING (public.is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;
REVOKE ALL ON public.provider_credentials FROM anon;
REVOKE ALL ON public.pos_connections FROM anon;