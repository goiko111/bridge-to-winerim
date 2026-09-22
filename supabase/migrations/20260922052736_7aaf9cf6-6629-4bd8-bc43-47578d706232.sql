CREATE INDEX IF NOT EXISTS user_roles_user_id_idx ON public.user_roles (user_id);
CREATE INDEX IF NOT EXISTS user_roles_user_conn_idx ON public.user_roles (user_id, connection_id);

DO $do$
DECLARE
  t text;
  p record;
  pred text := '((select public.is_platform_admin()) OR %I IN (select r.connection_id from public.user_roles r where r.user_id = (select auth.uid())))';
  expr text;
  tables text[] := ARRAY[
    'agora_master_data','agora_sales_variant_mappings','agora_dispatch_locks',
    'catalog_readback_snapshots','catalog_review_decisions','qtomas_review_decisions',
    'classification_config','connection_alerts','connection_health_checks',
    'connection_notification_contacts','outbound_tasks','product_mappings',
    'provider_capabilities','provider_products','sales_events','sales_line_items',
    'stock_sync_log','webhook_events','wine_family_rules','wine_type_family_mappings',
    'winerim_push_tracking','winerim_wine_formats','winerim_wines','pos_connections'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF t = 'pos_connections' THEN
      expr := format(pred, 'id');
    ELSE
      expr := format(pred, 'connection_id');
    END IF;

    FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename=t AND policyname LIKE 'tenant_%' LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', p.policyname, t);
    END LOOP;

    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (%s)', 'tenant_select_' || t, t, expr);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (%s) WITH CHECK (%s)', 'tenant_update_' || t, t, expr, expr);

    IF t <> 'pos_connections' THEN
      EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (%s)', 'tenant_insert_' || t, t, expr);
      EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (%s)', 'tenant_delete_' || t, t, expr);
    END IF;
  END LOOP;
END
$do$;

DROP POLICY IF EXISTS admin_all_provider_credentials ON public.provider_credentials;
CREATE POLICY admin_all_provider_credentials ON public.provider_credentials
  FOR ALL TO authenticated
  USING ((select public.is_platform_admin()))
  WITH CHECK ((select public.is_platform_admin()));

DROP POLICY IF EXISTS user_roles_select_own ON public.user_roles;
CREATE POLICY user_roles_select_own ON public.user_roles
  FOR SELECT TO authenticated
  USING (user_id = (select auth.uid()) OR (select public.is_platform_admin()));